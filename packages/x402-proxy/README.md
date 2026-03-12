# x402-proxy

Generic [x402](https://www.x402.org/) payment proxy library for Solana and EVM USDC. Wraps `fetch` with automatic x402 payment handling, tracks transaction history, and provides wallet loading utilities.

## Install

```bash
npm install x402-proxy
```

Peer dependencies: `@solana/kit`, `ethers`, `viem`

## Usage

```ts
import {
  x402Client,
  ExactSvmScheme,
  ExactEvmScheme,
  createX402ProxyHandler,
  extractTxSignature,
  loadSvmWallet,
  loadEvmWallet,
} from "x402-proxy";

// 1. Configure the x402 client with payment schemes
const svmWallet = await loadSvmWallet("/path/to/keypair.json");
const client = x402Client([ExactSvmScheme(svmWallet)]);

// 2. Create the proxy handler
const { x402Fetch, shiftPayment } = createX402ProxyHandler({ client });

// 3. Make requests - payments are handled automatically
const response = await x402Fetch("https://api.example.com/paid-endpoint");
const payment = shiftPayment(); // { network, payTo, amount, asset }
const txSig = extractTxSignature(response);
```

### Transaction history

```ts
import { appendHistory, readHistory, calcSpend, formatTxLine } from "x402-proxy";

// Append a transaction record
appendHistory("/path/to/history.jsonl", {
  t: Date.now(),
  ok: true,
  kind: "x402_inference",
  net: "solana:mainnet",
  from: "J5UH...",
  tx: "5abc...",
  amount: 0.05,
  token: "USDC",
  model: "claude-sonnet-4-20250514",
});

// Read and aggregate
const records = readHistory("/path/to/history.jsonl");
const { today, total, count } = calcSpend(records);
```

## API

### Payment proxy

- `createX402ProxyHandler(opts)` - wraps fetch with automatic x402 payment. Returns `{ x402Fetch, shiftPayment }`
- `extractTxSignature(response)` - extracts on-chain TX signature from payment response headers

### Wallet loading

- `loadSvmWallet(path)` - load Solana keypair from solana-keygen JSON file
- `loadEvmWallet(path)` - load EVM wallet from hex private key file

### Transaction history

- `appendHistory(path, record)` - append a `TxRecord` to a JSONL file (auto-truncates at 1000 lines)
- `readHistory(path)` - read all records from a JSONL history file
- `calcSpend(records)` - aggregate USDC spend (today/total/count)
- `explorerUrl(net, tx)` - generate block explorer URL (Solscan, Basescan, Etherscan)
- `formatTxLine(record)` - format a record as a markdown line with explorer link

### Re-exports

- `x402Client`, `ExactSvmScheme`, `ExactEvmScheme`, `toClientEvmSigner` - from `@x402/fetch`, `@x402/svm`, `@x402/evm`

## License

Apache-2.0
