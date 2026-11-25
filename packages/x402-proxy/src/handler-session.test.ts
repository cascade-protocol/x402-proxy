import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Challenge, Credential } from "mppx";
import { Session } from "mppx/tempo";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, expect, it, vi } from "vitest";
import { createMppProxyHandler } from "./handler.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("signs open, voucher and close credentials for the same session", async ({ onTestFinished }) => {
  const configDir = mkdtempSync(join(tmpdir(), "x402-session-"));
  onTestFinished(() => rmSync(configDir, { recursive: true, force: true }));
  vi.stubEnv("XDG_CONFIG_HOME", configDir);
  vi.stubEnv("X402_PROXY_MPP_VOUCHER_HEADROOM_USDC", "0.005");
  const evmKey = generatePrivateKey();
  const payer = privateKeyToAccount(evmKey).address;
  const url = "https://example.test/chat";
  const chainId = 4217;
  const escrow = Session.Precompile.Constants.tip20ChannelEscrow;
  const challenge = Challenge.from({
    id: "session-test",
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
    const auth = req.headers.get("Authorization");
    if (!auth) {
      const response = new Response(null, {
        status: 402,
        headers: { "WWW-Authenticate": Challenge.serialize(challenge) },
      });
      Object.defineProperty(response, "url", { value: url });
      return response;
    }
    const credential = Credential.deserialize<Session.Precompile.SessionCredentialPayload>(auth);
    const payload = credential.payload;
    if (payload.action === "topUp") throw new Error("Unexpected top-up");
    expect(credential.challenge.id).toBe(challenge.id);
    const { channelId, signature, cumulativeAmount } = payload;
    const voucher = { channelId, signature, cumulativeAmount: BigInt(cumulativeAmount) };
    expect(Session.Precompile.Voucher.verifyVoucher(escrow, chainId, voucher, payer)).toBe(true);
    actions.push([payload.action, cumulativeAmount]);
    const receipt = Session.Precompile.Receipt.createSessionReceipt({
      channelId,
      challengeId: challenge.id,
      acceptedCumulative: payload.action === "close" ? 4n : 5004n,
      spent: 4n,
      units: 2,
    });
    if (payload.action === "open") {
      opened = channelId;
      expect(Session.Precompile.Channel.computeId({ ...payload.descriptor, chainId, escrow })).toBe(
        channelId,
      );
      expect(await req.text()).toBe("chat");
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
    expect(channelId).toBe(opened);
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
    return new Response(null, {
      headers: { "Payment-Receipt": Session.Precompile.Receipt.serializeSessionReceipt(receipt) },
    });
  });
  const handler = await createMppProxyHandler({ evmKey });
  const output = [];
  for await (const message of await handler.sse(url, { method: "POST", body: "chat" }))
    output.push(message);
  await handler.close();
  expect(output).toEqual(["ok"]);
  expect(actions).toEqual([
    ["open", "2"],
    ["voucher", "5004"],
    ["close", "4"],
  ]);
  handler.shiftPayment();
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
