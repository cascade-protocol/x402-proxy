import { Challenge, Credential } from "mppx";
import { Session } from "mppx/tempo";
import { zeroAddress, zeroHash } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { afterEach, expect, it, vi } from "vitest";
import { createMppProxyHandler } from "./handler.js";

vi.mock("./lib/config.js", () => ({ saveSession: vi.fn(), clearSession: vi.fn() }));

// Exercise mppx's real challenge selection, credential caching and HTTP transport with an offline signer.
vi.mock("mppx/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("mppx/client")>();
  return {
    ...actual,
    tempo(options: Parameters<typeof actual.tempo>[0]) {
      const [charge, session] = actual.tempo(options);
      return [
        charge,
        {
          ...session,
          canHandleChallenge: () => true,
          async createCredential({
            challenge,
            context,
          }: Parameters<typeof session.createCredential>[0]) {
            const descriptor = {
              payer: zeroAddress,
              payee: zeroAddress,
              operator: zeroAddress,
              token: zeroAddress,
              salt: zeroHash,
              authorizedSigner: zeroAddress,
              expiringNonceHash: zeroHash,
            };
            if (!context?.action) {
              options?.onChannelUpdate?.({
                channelId: zeroHash,
                cumulativeAmount: 2n,
                opened: true,
                descriptor,
                deposit: 6000n,
                chainId: 4217,
                escrow: zeroAddress,
              });
            } else {
              expect(context.descriptor).toEqual(descriptor);
            }
            return Credential.serialize({
              challenge,
              payload: {
                action: context?.action ?? "open",
                amount: context?.cumulativeAmountRaw,
              },
            });
          },
        },
      ];
    },
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("posts distinct voucher and close credentials for the opening session", async () => {
  const url = "https://example.test/chat";
  const challenge = Challenge.from({
    id: "session-test",
    method: "tempo",
    intent: "session",
    realm: "example.test",
    request: { amount: "2", currency: zeroAddress },
  });
  const receipt = Session.Precompile.Receipt.createSessionReceipt({
    channelId: zeroHash,
    challengeId: challenge.id,
    acceptedCumulative: 5002n,
    spent: 2n,
    units: 1,
  });
  const payloads: unknown[] = [];
  vi.stubEnv("X402_PROXY_MPP_VOUCHER_HEADROOM_USDC", "0.005");
  vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const req = new Request(input, init);
    const auth = req.headers.get("Authorization");
    if (!auth) {
      const response = new Response(null, {
        status: 402,
        headers: { "WWW-Authenticate": Challenge.serialize(challenge) },
      });
      Object.defineProperty(response, "url", { value: url });
      return response;
    }
    const { payload } = Credential.deserialize<{ action: string; amount?: string }>(auth);
    payloads.push(payload);
    if (payload.action === "open") {
      expect(await req.text()).toBe("chat");
      const wire = Session.Precompile.SseProtocol;
      return new Response(
        wire.formatNeedVoucherEvent({
          channelId: zeroHash,
          requiredCumulative: "2",
          acceptedCumulative: "0",
          deposit: "6000",
        }) +
          wire.formatReceiptEvent(receipt) +
          wire.formatMessageEvent("ok"),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    }
    expect(req.url).toBe(url);
    expect(req.method).toBe("POST");
    expect(req.body).toBeNull();
    return new Response(null, {
      headers: { "Payment-Receipt": Session.Precompile.Receipt.serializeSessionReceipt(receipt) },
    });
  });
  const handler = await createMppProxyHandler({ evmKey: generatePrivateKey() });
  const output = [];
  for await (const message of await handler.sse(url, { method: "POST", body: "chat" }))
    output.push(message);
  await handler.close();
  expect(output).toEqual(["ok"]);
  expect(payloads).toEqual([
    { action: "open" },
    { action: "voucher", amount: "5002" },
    { action: "close", amount: "2" },
  ]);
  handler.shiftPayment();
  expect(handler.shiftPayment()?.amount).toBe("0.000002");
});
