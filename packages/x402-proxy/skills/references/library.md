# x402-proxy Library API

```bash
npm install x402-proxy
```

## Exports

```typescript
// Core
import { createX402ProxyHandler, extractTxSignature } from "x402-proxy";
import { x402Client } from "x402-proxy";

// Chain schemes
import { ExactEvmScheme, toClientEvmSigner } from "x402-proxy";
import { ExactSvmScheme } from "x402-proxy";

// Wallet loaders
import { loadEvmWallet, loadSvmWallet } from "x402-proxy";

// History
import { appendHistory, readHistory, calcSpend, explorerUrl, formatTxLine } from "x402-proxy";
```

## EVM (Base) setup

```typescript
import { createX402ProxyHandler, x402Client, ExactEvmScheme, toClientEvmSigner } from "x402-proxy";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const account = privateKeyToAccount(process.env.EVM_KEY as `0x${string}`);
const wallet = createWalletClient({ account, chain: base, transport: http() });

const client = x402Client(fetch)
  .register(new ExactEvmScheme(toClientEvmSigner(wallet)));

const { x402Fetch, shiftPayment } = createX402ProxyHandler({ x402Client: client });

const res = await x402Fetch("https://api.example.com/data");
const body = await res.json();
const payment = shiftPayment(); // { network, payTo, amount, asset }
```

## Solana setup

```typescript
import { createX402ProxyHandler, x402Client, ExactSvmScheme, loadSvmWallet } from "x402-proxy";

const signer = loadSvmWallet(process.env.MNEMONIC!);
const client = x402Client(fetch).register(new ExactSvmScheme(signer));
const { x402Fetch } = createX402ProxyHandler({ x402Client: client });
```

## Payment history

```typescript
import { appendHistory, readHistory, calcSpend } from "x402-proxy";

// Read and summarize
const records = await readHistory("./history.jsonl");
const { dailyUsd, totalUsd, txCount } = calcSpend(records);

// Append a record
await appendHistory("./history.jsonl", {
  ts: Date.now(),
  status: 200,
  network: "eip155:8453",
  payTo: "0x...",
  amount: "0.001",
  asset: "USDC",
  txId: "0xabc...",
  host: "api.example.com",
});
```

## Types

```typescript
type PaymentInfo = { network: string; payTo: string; amount: string; asset: string };
type X402ProxyOptions = { x402Client: ReturnType<typeof x402Client> };
type X402ProxyHandler = { x402Fetch: typeof fetch; shiftPayment: () => PaymentInfo | undefined };
type TxRecord = { ts: number; status: number; network: string; payTo: string; amount: string; asset: string; txId?: string; host: string };
```
