import {
  type Address,
  appendTransactionMessageInstructions,
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  isSolanaError,
  mainnet,
  partiallySignTransactionMessageWithSigners,
  pipe,
  prependTransactionMessageInstruction,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type TransactionSigner,
} from "@solana/kit";
import {
  getSetComputeUnitLimitInstruction,
  setTransactionMessageComputeUnitPrice,
} from "@solana-program/compute-budget";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  fetchMint,
  findAssociatedTokenPda,
  getTransferCheckedInstruction,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";
import type { PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";

const MEMO_PROGRAM_ADDRESS: Address = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" as Address;
const COMPUTE_UNIT_LIMIT = 20_000;
const COMPUTE_UNIT_PRICE_MICROLAMPORTS = 1;

const USDC_MINT: Address = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address;
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

type Transport = ReturnType<typeof createDefaultRpcTransport>;

/**
 * Create a failover transport that tries each RPC in order.
 * On 429 from one endpoint, immediately tries the next instead of waiting.
 * Each transport gets its own coalescing via createDefaultRpcTransport.
 */
function createFailoverTransport(urls: string[]) {
  const transports = urls.map((url) => createDefaultRpcTransport({ url }));
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

/**
 * Optimized ExactSvmScheme that replaces upstream @x402/svm to prevent
 * RPC rate-limit failures on parallel payments.
 *
 * Two optimizations over upstream:
 * 1. Shared RPC client - @solana/kit's built-in request coalescing
 *    merges identical getLatestBlockhash calls in the same tick into 1.
 * 2. Hardcoded USDC - skips fetchMint RPC call for USDC (immutable data).
 */
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
    const rpc = this.rpc;

    const asset = paymentRequirements.asset as Address;

    let tokenProgramAddress: Address;
    let decimals: number;
    if (asset === USDC_MINT) {
      tokenProgramAddress = TOKEN_PROGRAM_ADDRESS;
      decimals = USDC_DECIMALS;
    } else {
      const tokenMint = await fetchMint(rpc, asset);
      tokenProgramAddress = tokenMint.programAddress;
      if (
        tokenProgramAddress !== TOKEN_PROGRAM_ADDRESS &&
        tokenProgramAddress !== TOKEN_2022_PROGRAM_ADDRESS
      ) {
        throw new Error("Asset was not created by a known token program");
      }
      decimals = tokenMint.data.decimals;
    }

    const [sourceATA] = await findAssociatedTokenPda({
      mint: asset,
      owner: this.signer.address,
      tokenProgram: tokenProgramAddress,
    });

    const [destinationATA] = await findAssociatedTokenPda({
      mint: asset,
      owner: paymentRequirements.payTo as Address,
      tokenProgram: tokenProgramAddress,
    });

    const transferIx = getTransferCheckedInstruction(
      {
        source: sourceATA,
        mint: asset,
        destination: destinationATA,
        authority: this.signer,
        amount: BigInt(paymentRequirements.amount),
        decimals,
      },
      { programAddress: tokenProgramAddress },
    );

    const feePayer = paymentRequirements.extra?.feePayer as Address;
    if (!feePayer) {
      throw new Error("feePayer is required in paymentRequirements.extra for SVM transactions");
    }

    const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const memoIx = {
      programAddress: MEMO_PROGRAM_ADDRESS,
      accounts: [] as const,
      data: new TextEncoder().encode(
        Array.from(nonce)
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(""),
      ),
    };

    const tx = pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageComputeUnitPrice(COMPUTE_UNIT_PRICE_MICROLAMPORTS, tx),
      (tx) => setTransactionMessageFeePayer(feePayer, tx),
      (tx) =>
        prependTransactionMessageInstruction(
          getSetComputeUnitLimitInstruction({ units: COMPUTE_UNIT_LIMIT }),
          tx,
        ),
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
