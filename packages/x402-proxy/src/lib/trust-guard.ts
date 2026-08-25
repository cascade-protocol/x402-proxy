/**
 * Optional, opt-in pre-payment trust check.
 *
 * Off by default. Enabled with `--guard`. This adds NO dependency: it is a single
 * `fetch` to a free, keyless endpoint, and it FAILS SOFT — if the check is
 * unreachable, slow, or unsupported for the network, it never blocks a payment.
 *
 * The check is provider-agnostic in spirit; the default endpoint is merona
 * (https://merona.io), an independent x402 settlement index whose verdicts are
 * PASS / FAIL / UNCERTAIN and recomputable from public on-chain data. Only an
 * explicit FAIL (or, with `--guard-strict`, an UNCERTAIN) aborts a payment.
 */

export type GuardVerdict = "allow" | "review" | "deny";

const MERONA_ENDPOINT = "https://api.merona.io/v1/trust/evaluate";

/**
 * Map an x402 network id to a chain merona indexes. x402 uses CAIP-2
 * (`eip155:8453`, `solana:...`); merona covers base / polygon / solana. Anything
 * else (Monad, Tempo, testnets) has no coverage and the guard no-ops.
 */
export function meronaChain(network: string | undefined): string | undefined {
  if (!network) return undefined;
  const n = network.toLowerCase();
  if (n === "eip155:8453") return "base";
  if (n === "eip155:137") return "polygon";
  if (n.startsWith("solana:")) return "solana";
  if (n === "base" || n === "polygon" || n === "solana") return n;
  return undefined;
}

/**
 * Map a merona `decision` to a guard verdict. Exported for testing.
 */
export function verdictFromDecision(decision: unknown): GuardVerdict {
  const d = String(decision ?? "").toUpperCase();
  if (d === "FAIL") return "deny";
  if (d === "UNCERTAIN") return "review";
  return "allow";
}

export type CheckSellerOptions = {
  strict?: boolean;
  endpoint?: string;
  timeoutMs?: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
};

/**
 * Check a seller wallet before paying it. Never throws. Returns `allow` on any
 * error, timeout, or missing coverage so a check being down cannot brick a
 * payment. `review` is returned for merona UNCERTAIN.
 */
export async function checkSeller(
  payTo: string | undefined,
  network: string | undefined,
  opts: CheckSellerOptions = {},
): Promise<{ verdict: GuardVerdict; reason: string }> {
  const chain = meronaChain(network);
  if (!payTo || !chain) {
    return { verdict: "allow", reason: `no coverage for ${network ?? "this network"}` };
  }
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 2500);
  try {
    const res = await fetchImpl(opts.endpoint ?? MERONA_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject: { wallet: payTo, chain }, direction: "seller" }),
      signal: controller.signal,
    });
    if (res.status !== 200) {
      return { verdict: "allow", reason: `merona unavailable (${res.status})` };
    }
    const j = (await res.json()) as {
      decision?: string;
      reason_code?: string;
      null_reason?: string;
    };
    const verdict = verdictFromDecision(j.decision);
    if (verdict === "deny") return { verdict, reason: j.reason_code || "recorded issue" };
    if (verdict === "review") return { verdict, reason: j.null_reason || "no evidence on file" };
    return { verdict, reason: j.reason_code || "ok" };
  } catch {
    return { verdict: "allow", reason: "merona unreachable" };
  } finally {
    clearTimeout(timer);
  }
}
