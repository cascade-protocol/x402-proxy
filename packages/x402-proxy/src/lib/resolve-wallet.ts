import { toClientEvmSigner } from "@x402/evm";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { type PaymentPolicy, type SelectPaymentRequirements, x402Client } from "@x402/fetch";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { calcSpend, displayNetwork, formatUsdcValue, readHistory } from "../history.js";
import { getHistoryPath } from "./config.js";
import { OptimizedSvmScheme } from "./optimized-svm-scheme.js";
import type { WalletResolution } from "./wallet-resolution.js";

export { resolveWallet, type WalletResolution, type WalletSource } from "./wallet-resolution.js";

export function networkToCaipPrefix(name: string): string {
  switch (name.toLowerCase()) {
    case "base":
      return "eip155:8453";
    case "monad":
      return "eip155:143";
    case "tempo":
      return "eip155:4217";
    case "solana":
      return "solana:";
    default:
      return name;
  }
}

/**
 * Validate that payTo addresses match the network format.
 * Filters out malformed entries (e.g. EVM hex address on a Solana network).
 */
export function createAddressValidationPolicy(): PaymentPolicy {
  return (_version, reqs) => {
    const malformed: string[] = [];
    const valid = reqs.filter((r) => {
      if (r.network.startsWith("solana:") && r.payTo.startsWith("0x")) {
        malformed.push(`Solana option has EVM-format payTo (${r.payTo})`);
        return false;
      }
      if (r.network.startsWith("eip155:") && !r.payTo.startsWith("0x")) {
        malformed.push(`EVM option has non-EVM payTo (${r.payTo})`);
        return false;
      }
      return true;
    });
    if (valid.length === 0 && malformed.length > 0) {
      throw new Error(
        `Server returned only malformed payment options:\n  ${malformed.join("\n  ")}\nThe server's payTo addresses don't match the advertised networks.`,
      );
    }
    return valid;
  };
}

export function createNetworkFilter(network: string): PaymentPolicy {
  const prefix = networkToCaipPrefix(network);
  return (_version, reqs) => {
    const filtered = reqs.filter((r) => r.network.startsWith(prefix));
    if (filtered.length === 0) {
      const available = [...new Set(reqs.map((r) => displayNetwork(r.network)))].join(", ");
      throw new Error(`Network '${network}' not accepted. Available: ${available}`);
    }
    return filtered;
  };
}

export function createNetworkPreference(network: string): SelectPaymentRequirements {
  const prefix = networkToCaipPrefix(network);
  return (_version, accepts) => {
    return accepts.find((r) => r.network.startsWith(prefix)) || accepts[0];
  };
}

export type BuildClientOptions = {
  preferredNetwork?: string;
  /** Hard filter: fail if server doesn't accept this network */
  network?: string;
  spendLimitDaily?: number;
  spendLimitPerTx?: number;
  /** Counterparty allow/deny by payTo address (deny wins on conflict). */
  allowPayTo?: string[];
  denyPayTo?: string[];
};

/**
 * Refuse (or restrict) payment by COUNTERPARTY.
 *
 * Spend limits answer "how much may I pay"; this answers "whom may I pay at
 * all". Both are pre-sign: a policy that throws stops the client before the
 * payment payload is built, so nothing is signed and no funds move.
 *
 * `deny` wins over `allow` when an address appears in both, because a denial is
 * the safer interpretation of contradictory config.
 *
 * Matching is exact and case-sensitive for Solana (base58 is case-significant)
 * and case-insensitive for EVM `0x` addresses (hex checksumming varies).
 */
export function createCounterpartyPolicy(opts: {
  allow?: string[];
  deny?: string[];
}): PaymentPolicy {
  const norm = (a: string) => (a.startsWith("0x") ? a.toLowerCase() : a);
  const deny = new Set((opts.deny ?? []).map(norm));
  const allow = new Set((opts.allow ?? []).map(norm));

  return (_version, reqs) => {
    const before = reqs.length;
    const refused: string[] = [];

    let kept = reqs.filter((r) => {
      if (deny.has(norm(r.payTo))) {
        refused.push(`${r.payTo} (denied)`);
        return false;
      }
      return true;
    });

    if (allow.size > 0) {
      kept = kept.filter((r) => {
        if (!allow.has(norm(r.payTo))) {
          refused.push(`${r.payTo} (not in allow list)`);
          return false;
        }
        return true;
      });
    }

    if (kept.length === 0 && before > 0) {
      throw new Error(
        `No acceptable counterparty. Refused:\n  ${refused.join("\n  ")}\n` +
          `Update allowPayTo / denyPayTo with: x402-proxy config set`,
      );
    }
    return kept;
  };
}

/**
 * Build a configured x402Client from resolved wallet keys.
 */
export async function buildX402Client(
  wallet: WalletResolution,
  opts?: BuildClientOptions,
): Promise<x402Client> {
  const selector = opts?.preferredNetwork
    ? createNetworkPreference(opts.preferredNetwork)
    : undefined;

  const client = new x402Client(selector);

  if (wallet.evmKey) {
    const hex = wallet.evmKey as `0x${string}`;
    const account = privateKeyToAccount(hex);
    const publicClient = createPublicClient({ chain: base, transport: http() });
    const signer = toClientEvmSigner(account, publicClient);
    registerExactEvmScheme(client, { signer });
  }

  if (wallet.solanaKey) {
    const { createKeyPairSignerFromBytes } = await import("@solana/kit");
    const signer = await createKeyPairSignerFromBytes(wallet.solanaKey);
    client.register("solana:*", new OptimizedSvmScheme(signer));
  }

  client.registerPolicy(createAddressValidationPolicy());

  if (opts?.network) {
    client.registerPolicy(createNetworkFilter(opts.network));
  }

  // Counterparty policy: refuse WHO, independent of HOW MUCH.
  if (opts?.allowPayTo?.length || opts?.denyPayTo?.length) {
    client.registerPolicy(
      createCounterpartyPolicy({ allow: opts.allowPayTo, deny: opts.denyPayTo }),
    );
  }

  // Spend limit policies
  const daily = opts?.spendLimitDaily;
  const perTx = opts?.spendLimitPerTx;
  if (daily || perTx) {
    client.registerPolicy((_version, reqs) => {
      if (daily) {
        const spend = calcSpend(readHistory(getHistoryPath()));
        if (spend.today >= daily) {
          throw new Error(
            `Daily spend limit reached (${formatUsdcValue(spend.today)}/${daily} USDC)`,
          );
        }
        const remaining = daily - spend.today;
        reqs = reqs.filter((r) => Number(r.amount) / 1_000_000 <= remaining);
        if (reqs.length === 0) {
          throw new Error(
            `Daily spend limit of ${daily} USDC would be exceeded (${formatUsdcValue(spend.today)} spent today)`,
          );
        }
      }
      if (perTx) {
        const before = reqs.length;
        reqs = reqs.filter((r) => Number(r.amount) / 1_000_000 <= perTx);
        if (reqs.length === 0 && before > 0) {
          throw new Error(`Payment exceeds per-transaction limit of ${perTx} USDC`);
        }
      }
      return reqs;
    });
  }

  return client;
}
