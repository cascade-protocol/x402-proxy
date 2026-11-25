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

function challengeResponse(...offers: Challenge.Challenge[]) {
  return new Response(null, {
    status: 402,
    headers: { "WWW-Authenticate": offers.map(Challenge.serialize).join(", ") },
  });
}

function stubSessionServer(
  scenario = "ordinary stream",
  hooks: {
    refresh?: (offer: Challenge.Challenge) => Response;
    management?: (action: "close" | "voucher", offer: Challenge.Challenge) => Response | undefined;
  } = {},
) {
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
  const renewed = () => ({
    ...challenge,
    id: "renewed",
    header: "Payment-Authorization" as const,
    expires: new Date(Date.now() + 300_000).toISOString(),
  });
  let probes = 0;
  const challengeIds: string[] = [];
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
        expect(req.redirect).toBe("manual");
        probes++;
        return hooks.refresh?.(renewed()) ?? challengeResponse(renewed());
      }
      const response = challengeResponse(challenge);
      Object.defineProperty(response, "url", { value: url });
      return response;
    }
    const credential = Credential.deserialize<Session.Precompile.SessionCredentialPayload>(auth);
    if (credential.challenge.id === "renewed")
      expect(req.headers.has("Payment-Authorization")).toBe(true);
    const payload = credential.payload;
    if (payload.action === "topUp") throw new Error("Unexpected top-up");
    challengeIds.push(credential.challenge.id);
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
    expect(req.redirect).toBe("manual");
    const rejection = hooks.management?.(payload.action, renewed());
    if (rejection) return rejection;
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
  return {
    evmKey,
    url,
    expires,
    configDir,
    actions,
    channels,
    closeStarted,
    challengeIds,
    get opened() {
      return opened;
    },
    get probes() {
      return probes;
    },
  };
}

it.each([
  "ordinary stream",
  "503 after open",
  "expired challenge",
  "inflated receipt",
  "expired close",
  "two channels with a failed close",
  "close timeout",
])("settles a signed session with %s", async (scenario) => {
  const server = stubSessionServer(scenario);
  const { evmKey, url, expires, configDir, actions, channels, closeStarted } = server;
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
    expect(handler.shiftPayment()?.channelId).toBe(server.opened);
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
  const refreshed = scenario === "expired challenge" || scenario === "expired close";
  expect(server.probes).toBe(refreshed ? 1 : 0);
  expect(server.challengeIds).toEqual([
    "session-test",
    scenario === "expired challenge" ? "renewed" : "session-test",
    refreshed ? "renewed" : "session-test",
  ]);
  expect(handler.shiftPayment()).toMatchObject({ protocol: "mpp", intent: "session" });
  expect(handler.shiftPayment()).toMatchObject({ amount: "0.000004", channelId: server.opened });
});

async function consumeSession(server: ReturnType<typeof stubSessionServer>) {
  const handler = await createMppProxyHandler({ evmKey: server.evmKey });
  const messages = [];
  for await (const message of await handler.sse(server.url, { method: "POST", body: "chat" }))
    messages.push(message);
  expect(messages).toEqual(["ok"]);
  return handler;
}

function managementOffers(offer: Challenge.Challenge) {
  return challengeResponse(
    {
      ...offer,
      id: "wrong-recipient",
      request: { ...offer.request, recipient: "0x0000000000000000000000000000000000000002" },
    },
    {
      ...offer,
      id: "wrong-currency",
      request: { ...offer.request, currency: "0x0000000000000000000000000000000000000003" },
    },
    {
      ...offer,
      request: { ...offer.request, currency: "0x20C0000000000000000000000000000000000000" },
    },
  );
}

it.each([
  "voucher",
  "close",
] as const)("retries a rejected %s once using the 402 offers", async (action) => {
  let rejected = false;
  const server = stubSessionServer("inflated receipt", {
    management(post, offer) {
      if (post !== action || rejected) return;
      rejected = true;
      return managementOffers(offer);
    },
  });
  const handler = await consumeSession(server);
  await handler.close();
  expect(server.probes).toBe(0);
  expect(server.actions).toEqual([
    ["open", "2"],
    ["voucher", "5004"],
    [action, "5004"],
    ["close", "5004"],
  ]);
  expect(server.challengeIds).toEqual([
    "session-test",
    "session-test",
    action === "close" ? "session-test" : "renewed",
    "renewed",
  ]);
  expect(handler.shiftPayment()?.intent).toBe("session");
  expect(handler.shiftPayment()?.channelId).toBe(server.opened);
});

it("probes within 30 seconds of expiry and selects the matching recipient and currency", async () => {
  const server = stubSessionServer("ordinary stream", {
    refresh: managementOffers,
  });
  const handler = await consumeSession(server);
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(server.expires) - 30_000);
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
  await handler.close();
  expect(server.probes).toBe(1);
  expect(server.challengeIds).toEqual(["session-test", "session-test", "renewed"]);
});

it.each([
  ["probe", "foreign realm"],
  ["402", "foreign realm"],
  ["probe", "foreign channel"],
  ["402", "foreign channel"],
  ["402", "foreign snapshot"],
  ["402", "near expiry"],
  ["probe", "wrong recipient"],
  ["probe", "wrong currency"],
  ["probe", "non-402"],
  ["402", "second 402"],
] as const)("refuses a %s with %s during close", async (source, problem) => {
  vi.stubEnv("X402_PROXY_DEBUG", "1");
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
  function replacement(offer: Challenge.Challenge) {
    switch (problem) {
      case "non-402":
        return new Response(null, { status: 503 });
      case "foreign realm":
        return challengeResponse({ ...offer, realm: "elsewhere.test" });
      case "near expiry":
        return challengeResponse({ ...offer, expires: new Date(Date.now() + 5_000).toISOString() });
      case "foreign snapshot":
      case "foreign channel":
        return challengeResponse({
          ...offer,
          request: {
            ...offer.request,
            methodDetails: {
              chainId: 4217,
              sessionProtocol: "v2",
              ...(problem === "foreign channel"
                ? { channelId: `0x${"ff".repeat(32)}` }
                : { sessionSnapshot: { channelId: `0x${"ff".repeat(32)}` } }),
            },
          },
        });
      case "wrong recipient":
      case "wrong currency":
        return challengeResponse({
          ...offer,
          request: {
            ...offer.request,
            [problem === "wrong currency" ? "currency" : "recipient"]:
              "0x0000000000000000000000000000000000000002",
          },
        });
      case "second 402":
        return challengeResponse(offer);
    }
  }
  const server = stubSessionServer("ordinary stream", {
    refresh: replacement,
    management: (post, offer) =>
      source === "402" && post === "close" ? replacement(offer) : undefined,
  });
  const handler = await consumeSession(server);
  if (source === "probe") vi.spyOn(Date, "now").mockReturnValue(Date.parse(server.expires));
  await handler.close();
  expect(server.probes).toBe(source === "probe" ? 1 : 0);
  const closeIds =
    source === "probe"
      ? []
      : problem === "second 402"
        ? ["session-test", "renewed"]
        : ["session-test"];
  expect(server.challengeIds).toEqual(["session-test", "session-test", ...closeIds]);
  const error =
    problem === "non-402"
      ? "refresh returned HTTP 503"
      : problem === "second 402"
        ? "Close POST failed with status 402"
        : "No matching unexpired Tempo session challenge";
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining(error));
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
