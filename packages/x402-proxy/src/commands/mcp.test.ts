import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Challenge, Credential, Mcp } from "mppx";
import { tempo } from "mppx/client";
import { McpClient } from "mppx/mcp/client";
import { describe, expect, it, vi } from "vitest";
import { appendHistory, readHistory } from "../history.js";
import { getHistoryPath } from "../lib/config.js";
import {
  callMppTool,
  callX402ToolWithAutoPayment,
  cloneResource,
  cloneTool,
  createMppToolPayment,
  extractPaymentRequiredFromResult,
  normalizeCallToolResult,
  trustedMcpRealms,
} from "./mcp.js";

describe("cloneTool", () => {
  it("strips outputSchema and preserves other tool metadata", () => {
    const tool = {
      name: "surf_web_search",
      title: "Web Search",
      description: "Search the web",
      inputSchema: { type: "object" },
      outputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      annotations: { readOnlyHint: true },
      execution: { taskSupport: "optional" },
    };

    const cloned = cloneTool(tool);
    expect(cloned).not.toHaveProperty("outputSchema");
    expect(cloned).toEqual({
      name: "surf_web_search",
      title: "Web Search",
      description: "Search the web",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
      execution: { taskSupport: "optional" },
    });
  });
});

describe("cloneResource", () => {
  it("preserves extra resource metadata", () => {
    const resource = {
      uri: "docs://search-operators",
      name: "Search Operators",
      description: "Operator reference",
      mimeType: "text/markdown",
      size: 1234,
    };

    expect(cloneResource(resource)).toEqual(resource);
  });
});

describe("normalizeCallToolResult", () => {
  it("preserves structuredContent and _meta", () => {
    const result = {
      content: [{ type: "text" as const, text: '{"ok":true}' }],
      structuredContent: { ok: true },
      isError: false,
      _meta: { "x402/payment-response": { transaction: "0xabc" } },
    };

    expect(normalizeCallToolResult(result)).toEqual(result);
  });
});

describe("extractPaymentRequiredFromResult", () => {
  it("extracts payment requirements from structuredContent", () => {
    expect(
      extractPaymentRequiredFromResult({
        content: [],
        isError: true,
        structuredContent: {
          x402Version: 2,
          accepts: [{ network: "eip155:8453", amount: "1000" }],
        },
      }),
    ).toEqual({
      x402Version: 2,
      accepts: [{ network: "eip155:8453", amount: "1000" }],
    });
  });

  it("extracts payment requirements from wrapped JSON error text", () => {
    expect(
      extractPaymentRequiredFromResult({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              "x402/error": {
                code: 402,
                data: {
                  x402Version: 2,
                  accepts: [{ network: "solana:mainnet", amount: "2500" }],
                },
              },
            }),
          },
        ],
        isError: true,
      }),
    ).toEqual({
      x402Version: 2,
      accepts: [{ network: "solana:mainnet", amount: "2500" }],
    });
  });
});

describe("callX402ToolWithAutoPayment", () => {
  it("retries with payment and preserves the paid tool result shape", async () => {
    const paymentPayload = {
      accepted: { network: "eip155:8453", payTo: "0xpay", amount: "1000" },
    };
    const onPaymentRequested = vi.fn();
    const onPaymentSettled = vi.fn();
    const createPaymentPayload = vi.fn(async () => paymentPayload);
    const callTool = vi
      .fn()
      .mockResolvedValueOnce({
        content: [],
        isError: true,
        structuredContent: {
          x402Version: 2,
          accepts: [{ network: "eip155:8453", amount: "1000" }],
        },
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: '{"query":"x402","results":[],"count":0}' }],
        structuredContent: { query: "x402", results: [], count: 0 },
        _meta: { "x402/payment-response": { transaction: "0xsettled" } },
      });

    const result = await callX402ToolWithAutoPayment({
      remoteClient: { callTool },
      name: "surf_web_search",
      args: { query: "x402" },
      x402PaymentClient: { createPaymentPayload },
      onPaymentRequested,
      onPaymentSettled,
    });

    expect(createPaymentPayload).toHaveBeenCalledWith({
      x402Version: 2,
      accepts: [{ network: "eip155:8453", amount: "1000" }],
    });
    expect(callTool).toHaveBeenNthCalledWith(2, {
      name: "surf_web_search",
      arguments: { query: "x402" },
      _meta: { "x402/payment": paymentPayload },
    });
    expect(onPaymentRequested).toHaveBeenCalledWith(
      { x402Version: 2, accepts: [{ network: "eip155:8453", amount: "1000" }] },
      "surf_web_search",
    );
    expect(onPaymentSettled).toHaveBeenCalledWith({
      toolName: "surf_web_search",
      paymentPayload,
      settleResponse: { transaction: "0xsettled" },
    });
    expect(result).toEqual({
      content: [{ type: "text", text: '{"query":"x402","results":[],"count":0}' }],
      structuredContent: { query: "x402", results: [], count: 0 },
      _meta: { "x402/payment-response": { transaction: "0xsettled" } },
    });
  });
});

describe("MPP tool payment approval", () => {
  const charge = { intent: "charge", request: { amount: "600000" } };

  it("allows one payment per call and enforces the per-transaction limit", () => {
    const pending = new Map<symbol, number>();
    expect(() => createMppToolPayment({ spendLimitPerTx: 0.5 }, pending).approve(charge)).toThrow(
      "per-transaction",
    );
    const call = createMppToolPayment({ spendLimitPerTx: 0.6 }, pending);
    expect(call.approve(charge)).toBe(true);
    expect(() => call.approve(charge)).toThrow("one payment");
    expect(() =>
      createMppToolPayment({ spendLimitPerTx: 0.6 }, pending).approve({
        intent: "session",
        request: { amount: "2", suggestedDeposit: "1000000" },
      }),
    ).toThrow("per-transaction");
  });

  it("counts history and other in-flight approvals toward the daily limit", ({
    onTestFinished,
  }) => {
    const dir = mkdtempSync(join(tmpdir(), "x402-mcp-limit-"));
    vi.stubEnv("XDG_CONFIG_HOME", dir);
    onTestFinished(() => {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    });
    appendHistory(getHistoryPath(), {
      t: Date.now(),
      ok: true,
      kind: "mpp_payment",
      net: "tempo",
      from: "test",
      amount: 0.4,
      token: "USDC",
    });
    const pending = new Map<symbol, number>();
    const approve = () => createMppToolPayment({ spendLimitDaily: 1 }, pending);
    expect(() => approve().approve({ ...charge, request: { amount: "600001" } })).toThrow(
      "Daily spend limit",
    );
    const first = approve();
    expect(first.approve(charge)).toBe(true);
    expect(() => approve().approve(charge)).toThrow("Daily spend limit");
    first.release();
    expect(approve().approve(charge)).toBe(true);
  });

  it("allows a zero-cost proof at the daily cap and still refuses a second approval", () => {
    const payment = createMppToolPayment({ spendLimitDaily: 0 }, new Map());
    const proof = { ...charge, request: { amount: "0" } };
    expect(payment.approve(proof)).toBe(true);
    expect(() => payment.approve(proof)).toThrow("Only one payment");
  });

  it("handles repeated challenges and receiptless settlement through the wrapped callTool", async ({
    onTestFinished,
  }) => {
    const dir = mkdtempSync(join(tmpdir(), "x402-mcp-call-"));
    vi.stubEnv("XDG_CONFIG_HOME", dir);
    onTestFinished(() => {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    });
    const challenge = Challenge.from({
      ...charge,
      id: "test-charge",
      method: "tempo",
      realm: "example.test",
      request: {
        ...charge.request,
        currency: "0x20c0000000000000000000000000000000000000",
        recipient: "0x0000000000000000000000000000000000000001",
      },
    });
    const required = {
      content: [],
      _meta: { [Mcp.paymentRequiredMetaKey]: { challenges: [challenge] } },
    };
    const success = { content: [{ type: "text", text: "ok" }] };
    const callTool = vi
      .fn()
      .mockResolvedValueOnce(required)
      .mockResolvedValueOnce(required)
      .mockResolvedValueOnce(required)
      .mockResolvedValueOnce(success)
      .mockResolvedValue(required);
    const method = tempo.charge();
    const sign = vi
      .spyOn(method, "createCredential")
      .mockImplementation(async ({ challenge }) =>
        Credential.serialize({ challenge, payload: {} }),
      );
    const client = McpClient.wrap({ callTool }, { methods: [method] });
    const pending = new Map<symbol, number>();
    const call = () =>
      callMppTool(
        client,
        { name: "lookup", arguments: {} },
        { spendLimitDaily: 0.6 },
        pending,
        "test",
      );

    await expect(call()).rejects.toThrow("Only one payment");
    expect(sign).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(callTool.mock.calls[1]?.[0]._meta[Mcp.credentialMetaKey]).toBeDefined();
    expect(pending.size).toBe(0);
    expect(readHistory(getHistoryPath())).toEqual([]);

    await expect(call()).resolves.toMatchObject(success);
    expect(pending.size).toBe(0);
    const history = readHistory(getHistoryPath());
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ kind: "mpp_payment", amount: 0.6, label: "mcp:lookup" });
    expect(history[0]).not.toHaveProperty("tx");
    await expect(call()).rejects.toThrow("Daily spend limit");
    expect(sign).toHaveBeenCalledTimes(2);
    expect(callTool).toHaveBeenCalledTimes(5);
  });

  it("accepts case variants of the pinned hostname only", () => {
    const realms = trustedMcpRealms("example.test");
    expect(realms.includes("Example.TEST")).toBe(true);
    expect(realms.includes("other.test")).toBe(false);
  });
});
