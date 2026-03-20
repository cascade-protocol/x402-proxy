import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createTransactionMessage,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  type Instruction,
  type KeyPairSigner,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN_PROGRAM: Address = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM: Address = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

export type UsdcBalance = { raw: bigint; ui: string };
export type TokenHolding = { mint: string; amount: string; decimals: number };

async function findAta(mint: Address, owner: Address): Promise<Address> {
  const encoder = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM,
    seeds: [encoder.encode(owner), encoder.encode(TOKEN_PROGRAM), encoder.encode(mint)],
  });
  return pda;
}

function transferCheckedIx(
  source: Address,
  mint: Address,
  destination: Address,
  authority: KeyPairSigner,
  amount: bigint,
  decimals: number,
): Instruction {
  const data = new Uint8Array(1 + 8 + 1);
  data[0] = 12; // TransferChecked discriminator
  new DataView(data.buffer).setBigUint64(1, amount, true);
  data[9] = decimals;
  return {
    programAddress: TOKEN_PROGRAM,
    accounts: [
      { address: source, role: 2 /* writable */ },
      { address: mint, role: 0 /* readonly */ },
      { address: destination, role: 2 /* writable */ },
      { address: authority.address, role: 1 /* readonly signer */ },
    ],
    data,
  };
}

export async function getTokenAccounts(rpcUrl: string, owner: string): Promise<TokenHolding[]> {
  const rpc = createSolanaRpc(rpcUrl);
  const { value } = await rpc
    .getTokenAccountsByOwner(
      address(owner),
      { programId: TOKEN_PROGRAM },
      { encoding: "jsonParsed" },
    )
    .send();
  return value
    .map((v) => {
      const info = v.account.data.parsed.info;
      return {
        mint: info.mint as string,
        amount: info.tokenAmount.uiAmountString as string,
        decimals: info.tokenAmount.decimals as number,
      };
    })
    .filter((t) => t.mint !== USDC_MINT && t.amount !== "0");
}

export async function getUsdcBalance(rpcUrl: string, owner: string): Promise<UsdcBalance> {
  const rpc = createSolanaRpc(rpcUrl);
  const { value } = await rpc
    .getTokenAccountsByOwner(
      address(owner),
      { mint: address(USDC_MINT) },
      { encoding: "jsonParsed" },
    )
    .send();
  if (value.length > 0) {
    const ta = value[0].account.data.parsed.info.tokenAmount;
    return {
      raw: BigInt(ta.amount),
      ui: ta.uiAmount !== null ? ta.uiAmount.toFixed(2) : "0.00",
    };
  }
  return { raw: 0n, ui: "0.00" };
}

export async function getSolBalanceLamports(rpcUrl: string, owner: string): Promise<bigint> {
  const rpc = createSolanaRpc(rpcUrl);
  const { value } = await rpc.getBalance(address(owner)).send();
  return value;
}

export async function getSolBalance(rpcUrl: string, owner: string): Promise<string> {
  const lamports = await getSolBalanceLamports(rpcUrl, owner);
  return (Number(lamports) / 1e9).toFixed(4);
}

export async function checkAtaExists(rpcUrl: string, owner: string): Promise<boolean> {
  const ata = await findAta(address(USDC_MINT), address(owner));
  const rpc = createSolanaRpc(rpcUrl);
  const { value } = await rpc.getAccountInfo(ata, { encoding: "base64" }).send();
  return value !== null;
}

export async function transferUsdc(
  signer: KeyPairSigner,
  rpcUrl: string,
  dest: string,
  amountRaw: bigint,
): Promise<string> {
  const rpc = createSolanaRpc(rpcUrl);
  const usdcMint = address(USDC_MINT);

  const sourceAta = await findAta(usdcMint, signer.address);
  const destAta = await findAta(usdcMint, address(dest));

  const transferIx = transferCheckedIx(sourceAta, usdcMint, destAta, signer, amountRaw, 6);

  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
  const tx = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(signer.address, m),
    (m) => appendTransactionMessageInstructions([transferIx], m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
  );

  const signed = await partiallySignTransactionMessageWithSigners(tx);
  const encoded = getBase64EncodedWireTransaction(signed);
  return (await rpc.sendTransaction(encoded, { encoding: "base64" }).send()) as string;
}
