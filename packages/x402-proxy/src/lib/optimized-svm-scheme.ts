import {
  type Address,
  appendTransactionMessageInstructions,
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  isSolanaError,
  type MainnetUrl,
  mainnet,
  partiallySignTransactionMessageWithSigners,
  pipe,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  setTransactionMessageComputeUnitLimit,
  setTransactionMessageComputeUnitPrice,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type TransactionSigner,
} from "@solana/kit";
import {
  findAssociatedTokenPda,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import type { SpendControls } from "@x402/core/client";
import type { PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";

export const proxySpendControls = {
  maxAmountPerPayment: false,
  allowedAssets: [{ network: "solana:*", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }],
} satisfies SpendControls;

const USDC_DECIMALS = 6;

// Public no-auth Solana mainnet RPCs used as failover chain.
// On 429 from one endpoint the transport immediately tries the next.
//
// api.mainnet.solana.com (Solana Labs load-balanced cluster):
//   100 req/10s per IP, 40 req/10s per method, 100 MB/30s bandwidth cap.
//   (api.mainnet-beta.solana.com is an alias for the same cluster -
//    requests to either count against the same rate limit.)
//
// public.rpc.solanavibestation.com (community, self-hosted in Atlanta):
//   5 RPS general limit. 100% uptime last 90 days per status page.
const MAINNET_RPC_URLS = [
  "https://api.mainnet.solana.com",
  "https://public.rpc.solanavibestation.com",
];

/**
 * Create a failover transport that tries each RPC in order.
 * On 429 from one endpoint, immediately tries the next instead of waiting.
 * Each transport gets its own coalescing via createDefaultRpcTransport.
 */
function createFailoverTransport(urls: MainnetUrl[]) {
  const transports = urls.map((url) => createDefaultRpcTransport({ url }));
  type Transport = (typeof transports)[number];
  const failover: Transport = (async (config) => {
    let lastError: unknown;
    for (const transport of transports) {
      try {
        return await transport(config);
      } catch (e) {
        lastError = e;
        if (
          isSolanaError(e, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR) &&
          e.context.statusCode === 429
        ) {
          continue;
        }
        throw e;
      }
    }
    throw lastError;
  }) as Transport;
  return failover;
}

function createRpcClient(customRpcUrl?: string) {
  const urls = customRpcUrl ? [customRpcUrl, ...MAINNET_RPC_URLS] : MAINNET_RPC_URLS;
  return createSolanaRpcFromTransport(createFailoverTransport(urls.map((u) => mainnet(u))));
}

/** Shares a coalescing failover RPC and builds transfers from known mainnet USDC metadata. */
export class OptimizedSvmScheme implements SchemeNetworkClient {
  readonly scheme = "exact";
  private readonly rpc: ReturnType<typeof createRpcClient>;

  constructor(
    private readonly signer: TransactionSigner,
    config?: { rpcUrl?: string },
  ) {
    this.rpc = createRpcClient(config?.rpcUrl);
  }

  async createPaymentPayload(x402Version: number, paymentRequirements: PaymentRequirements) {
    const {
      resolveBlockhash,
      resolveTransactionVersion,
      DEFAULT_COMPUTE_UNIT_LIMIT,
      DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
      MAX_MEMO_BYTES,
      MEMO_PROGRAM_ADDRESS,
      USDC_MAINNET_ADDRESS,
    } = await import("@x402/svm");
    // The optimized builder uses v0 ComputeBudget instructions.
    resolveTransactionVersion(paymentRequirements.extra, [0]);
    const rpc = this.rpc;
    const asset = paymentRequirements.asset as Address;

    if (asset !== USDC_MAINNET_ADDRESS) {
      throw new Error(`Unsupported asset: ${asset}. Only USDC is supported.`);
    }

    const [[sourceATA], [destinationATA]] = await Promise.all([
      findAssociatedTokenPda({
        mint: asset,
        owner: this.signer.address,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      }),
      findAssociatedTokenPda({
        mint: asset,
        owner: paymentRequirements.payTo as Address,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      }),
    ]);

    const transferIx = getTransferCheckedInstruction({
      source: sourceATA,
      mint: asset,
      destination: destinationATA,
      authority: this.signer,
      amount: BigInt(paymentRequirements.amount),
      decimals: USDC_DECIMALS,
    });

    const feePayer = paymentRequirements.extra?.feePayer as Address;
    if (!feePayer) {
      throw new Error("feePayer is required in paymentRequirements.extra for SVM transactions");
    }

    const sellerMemo = paymentRequirements.extra?.memo;
    const memo =
      typeof sellerMemo === "string" && sellerMemo !== ""
        ? sellerMemo
        : Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
    const data = new TextEncoder().encode(memo);
    if (data.byteLength > MAX_MEMO_BYTES)
      throw new Error(`extra.memo exceeds the maximum of ${MAX_MEMO_BYTES} bytes`);
    const memoIx = { programAddress: MEMO_PROGRAM_ADDRESS as Address, accounts: [] as const, data };
    const latestBlockhash = await resolveBlockhash(rpc, paymentRequirements);

    const tx = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageComputeUnitLimit(DEFAULT_COMPUTE_UNIT_LIMIT, tx),
      (tx) =>
        setTransactionMessageComputeUnitPrice(BigInt(DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS), tx),
      (tx) => setTransactionMessageFeePayer(feePayer, tx),
      (tx) => appendTransactionMessageInstructions([transferIx, memoIx], tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    );

    const signedTransaction = await partiallySignTransactionMessageWithSigners(tx);

    return {
      x402Version,
      payload: { transaction: getBase64EncodedWireTransaction(signedTransaction) },
    };
  }
}
