import { describe, expect, it, vi } from "vitest";
import {
  callX402ToolWithAutoPayment,
  cloneResource,
  cloneTool,
  extractPaymentRequiredFromResult,
  normalizeCallToolResult,
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
