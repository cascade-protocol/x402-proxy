import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Challenge, Credential } from "mppx";
import { Session } from "mppx/tempo";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createMppProxyHandler } from "./handler.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each([
  "ordinary stream",
  "503 after open",
  "expired challenge",
  "inflated receipt",
  "expired close",
  "two channels with a failed close",
  "close timeout",
])("settles a signed session with %s", async (scenario) => {
  const configDir = mkdtempSync(join(tmpdir(), "x402-session-"));
  onTestFinished(() => rmSync(configDir, { recursive: true, force: true }));
  vi.stubEnv("XDG_CONFIG_HOME", configDir);
  vi.stubEnv("X402_PROXY_MPP_VOUCHER_HEADROOM_USDC", "0.005");
  const evmKey = generatePrivateKey();
  const payer = privateKeyToAccount(evmKey).address;
  const url = "https://example.test/chat";
  const chainId = 4217;
  const escrow = Session.Precompile.Constants.tip20ChannelEscrow;
  const expires = new Date(Date.now() + 300_000).toISOString();
  const challenge = Challenge.from({
    id: "session-test",
    expires,
    method: "tempo",
    intent: "session",
    realm: "example.test",
    request: {
      amount: "2",
      suggestedDeposit: "6000",
      currency: "0x20c0000000000000000000000000000000000000",
      recipient: "0x0000000000000000000000000000000000000001",
      methodDetails: { chainId, sessionProtocol: "v2" },
    },
  });
  let refreshed = false;
  const channels = new Set<Hex>();
  const closeStarted = Promise.withResolvers<AbortSignal>();
  let opened: Hex | undefined;
  const actions: [string, string][] = [];
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const req = new Request(input, init);
    if (new URL(req.url).hostname === "rpc.tempo.xyz") {
      const { method, id, params } = (await req.json()) as {
        method: string;
        id: number;
        params: Record<string, unknown>[];
      };
      expect(["eth_fillTransaction", "eth_chainId"]).toContain(method);
      const result =
        method === "eth_chainId"
          ? "0x1079"
          : {
              tx: {
                ...params[0],
                chainId: "0x1079",
                gas: "0x20000",
                maxFeePerGas: "0x2",
                maxPriorityFeePerGas: "0x1",
              },
            };
      return Response.json({ jsonrpc: "2.0", id, result });
    }
    expect(req.url).toBe(url);
    const auth = req.headers.get("Authorization") ?? req.headers.get("Payment-Authorization");
    if (!auth) {
      if (req.headers.has("Payment-Session")) {
        expect(req.method).toBe("POST");
        expect(req.body).toBeNull();
        expect(req.headers.get("Payment-Session")).toBe(opened);
        refreshed = true;
      }
      const offer = refreshed
        ? {
            ...challenge,
            id: "renewed",
            header: "Payment-Authorization" as const,
            expires: new Date(Date.now() + 300_000).toISOString(),
          }
        : challenge;
      const response = new Response(null, {
        status: 402,
        headers: { "WWW-Authenticate": Challenge.serialize(offer) },
      });
      Object.defineProperty(response, "url", { value: url });
      return response;
    }
    const credential = Credential.deserialize<Session.Precompile.SessionCredentialPayload>(auth);
    if (refreshed) expect(req.headers.has("Payment-Authorization")).toBe(true);
    const payload = credential.payload;
    if (payload.action === "topUp") throw new Error("Unexpected top-up");
    expect(credential.challenge.id).toBe(refreshed ? "renewed" : challenge.id);
    const { channelId, signature, cumulativeAmount } = payload;
    const voucher = { channelId, signature, cumulativeAmount: BigInt(cumulativeAmount) };
    expect(Session.Precompile.Voucher.verifyVoucher(escrow, chainId, voucher, payer)).toBe(true);
    actions.push([payload.action, cumulativeAmount]);
    const receipt = Session.Precompile.Receipt.createSessionReceipt({
      channelId,
      challengeId: challenge.id,
      acceptedCumulative: payload.action === "close" ? 4n : 5004n,
      spent: scenario === "inflated receipt" && payload.action !== "close" ? 99999n : 4n,
      units: 2,
    });
    if (payload.action === "open") {
      opened = channelId;
      channels.add(channelId);
      expect(Session.Precompile.Channel.computeId({ ...payload.descriptor, chainId, escrow })).toBe(
        channelId,
      );
      expect(await req.text()).toBe("chat");
      if (scenario === "503 after open") return new Response("upstream failed", { status: 503 });
      if (scenario === "expired challenge") {
        vi.spyOn(Date, "now").mockReturnValue(Date.parse(expires));
        onTestFinished(() => {
          vi.restoreAllMocks();
        });
      }
      const wire = Session.Precompile.SseProtocol;
      return new Response(
        wire.formatNeedVoucherEvent({
          channelId,
          requiredCumulative: "4",
          acceptedCumulative: "2",
          deposit: "6000",
        }) +
          wire.formatReceiptEvent(receipt) +
          wire.formatMessageEvent("ok"),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }
    expect(channels.has(channelId)).toBe(true);
    expect(req.method).toBe("POST");
    expect(req.body).toBeNull();
    if (payload.action === "close") {
      expect(
        Session.Precompile.Voucher.verifyCloseAuthorization(
          escrow,
          chainId,
          {
            ...voucher,
            signature: payload.closeSignature,
          },
          [payer],
        ),
      ).toBe(true);
    }
    if (
      payload.action === "close" &&
      scenario === "two channels with a failed close" &&
      channelId === [...channels][0]
    )
      throw new Error("unavailable");
    if (payload.action === "close" && scenario === "close timeout") {
      closeStarted.resolve(req.signal);
      return new Promise<Response>(() => {});
    }
    return new Response(null, {
      headers: { "Payment-Receipt": Session.Precompile.Receipt.serializeSessionReceipt(receipt) },
    });
  });
  const handler = await createMppProxyHandler({ evmKey });
  const stream = handler.sse(url, { method: "POST", body: "chat" });
  if (scenario === "503 after open") {
    await expect(stream).rejects.toThrow("503: upstream failed");
    expect(existsSync(join(configDir, "x402-proxy", "session.json"))).toBe(false);
    await handler.close();
    expect(actions).toEqual([
      ["open", "2"],
      ["close", "0"],
    ]);
    return;
  }
  const output = [];
  for await (const message of await stream) output.push(message);
  if (scenario === "two channels with a failed close") {
    for await (const message of await handler.sse(url, { method: "POST", body: "chat" }))
      output.push(message);
    await handler.close();
    expect(channels.size).toBe(2);
    expect(actions.filter(([action]) => action === "close")).toHaveLength(2);
    expect(handler.shiftPayment()?.intent).toBe("session");
    expect(handler.shiftPayment()?.intent).toBe("session");
    expect(handler.shiftPayment()?.channelId).toBe(opened);
    return;
  }
  if (scenario === "close timeout") {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const closing = handler.close();
    const signal = await closeStarted.promise;
    await vi.advanceTimersByTimeAsync(5000);
    await closing;
    expect(signal.aborted).toBe(true);
    return;
  }
  if (scenario === "expired close") {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(expires));
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
  }
  await handler.close();
  expect(output).toEqual(["ok"]);
  expect(actions).toEqual([
    ["open", "2"],
    ["voucher", "5004"],
    ["close", scenario === "inflated receipt" ? "5004" : "4"],
  ]);
  expect(refreshed).toBe(scenario === "expired challenge" || scenario === "expired close");
  expect(handler.shiftPayment()).toMatchObject({ protocol: "mpp", intent: "session" });
  expect(handler.shiftPayment()).toMatchObject({ amount: "0.000004", channelId: opened });
});

it("includes at most 200 UTF-8 bytes of the upstream stream error", async () => {
  const prefix = "\u00e9".repeat(100);
  vi.stubGlobal("fetch", async () => new Response(`${prefix}omitted`, { status: 503 }));
  const handler = await createMppProxyHandler({ evmKey: generatePrivateKey() });
  await expect(handler.sse("https://example.test/chat")).rejects.toEqual(
    new Error(`MPP SSE request failed with status 503: ${prefix}`),
  );
});

it("cancels the upstream stream when the consumer stops", async () => {
  const cancel = vi.fn();
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: one\n\n"));
          },
          cancel,
        }),
      ),
  );
  const handler = await createMppProxyHandler({ evmKey: generatePrivateKey() });
  for await (const message of await handler.sse("https://example.test")) {
    expect(message).toBe("one");
    break;
  }
  expect(cancel).toHaveBeenCalledOnce();
});

it("preserves tuple headers and replaces the caller's payer address", async () => {
  const evmKey = generatePrivateKey();
  const payer = privateKeyToAccount(evmKey).address;
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const { headers } = new Request(input, init);
    expect(headers.get("X-Custom")).toBe("test");
    expect(headers.get("X-Payer-Address")).toBe(payer);
    return new Response();
  });
  const handler = await createMppProxyHandler({ evmKey });
  await handler.fetch("https://example.test", {
    headers: [
      ["X-Custom", "test"],
      ["x-payer-address", "override"],
    ],
  });
});
