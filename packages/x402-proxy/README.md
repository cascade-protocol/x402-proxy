# x402-proxy

`curl` for [x402](https://www.x402.org/) and [MPP](https://mpp.dev/) paid APIs. Auto-pays HTTP 402 responses with USDC on Base, Solana, and [Tempo](https://tempo.xyz/) - zero crypto code on the buyer side. Supports one-time payments (x402, MPP charge) and pay-per-token streaming (MPP sessions).

## Quick Start

```bash
npx x402-proxy -X POST -d '{"ref":"CoinbaseDev"}' https://surf.cascade.fyi/api/v1/twitter/user
```

That's it. The endpoint returns 402, x402-proxy pays and streams the response.

No wallet? It'll walk you through setup automatically. One mnemonic derives both EVM (Base/Tempo) and Solana keypairs. Fund any chain and go.

## MCP Proxy

Let your AI agent consume any paid MCP server.

### Quick setup

```bash
npx x402-proxy mcp add surf https://surf.cascade.fyi/mcp
```

Auto-detects installed AI clients (Claude Code, Cursor, VS Code, and 16+ others), shows a config preview, and writes it for you. Runs wallet setup if needed.

### Manual config

Or add to your client config directly:

```json
{
  "mcpServers": {
    "surf": {
      "command": "npx",
      "args": ["-y", "x402-proxy", "mcp", "https://surf.cascade.fyi/mcp"]
    }
  }
}
```

The proxy auto-generates a wallet on first run and uses `~/.config/x402-proxy/wallet.json`. No env vars needed. Your agent never touches crypto.

For OpenClaw:

```bash
openclaw mcp set surf '{"command":"npx","args":["-y","x402-proxy","mcp","https://surf.cascade.fyi/mcp"]}'
```

## HTTP Requests

Works like curl. Response body streams to stdout, payment info goes to stderr.

```bash
# POST request
$ npx x402-proxy -X POST -d '{"ref":"CoinbaseDev"}' https://surf.cascade.fyi/api/v1/twitter/user

# POST with body and headers (curl-style short flags: -X, -H, -d)
$ npx x402-proxy -X POST \
  -H "Content-Type: application/json" \
  -d '{"url":"https://x402.org"}' \
  https://surf.cascade.fyi/api/v1/web/crawl

# Force a specific network
$ npx x402-proxy --network base https://api.example.com/data

# Debug protocol negotiation and payment flow
$ npx x402-proxy --verbose https://api.example.com/data

# Use MPP protocol for streaming payments
$ npx x402-proxy --protocol mpp \
  -X POST -H "Content-Type: application/json" \
  -d '{"model":"minimax/minimax-m2.5","stream":true,"messages":[{"role":"user","content":"Hello"}]}' \
  https://surf.cascade.fyi/api/v1/inference/completions

# Pipe-safe
$ npx x402-proxy https://api.example.com/data | jq '.results'
```

## Commands

```bash
$ npx x402-proxy <url>                    # paid HTTP request (default command)
$ npx x402-proxy mcp <url>                # MCP stdio proxy for agents
$ npx x402-proxy mcp add <name> <url>     # install MCP server into your AI client
$ npx x402-proxy setup                    # onboarding wizard
$ npx x402-proxy status                   # config + wallet + spend summary
$ npx x402-proxy config                   # show current configuration
$ npx x402-proxy config set <key> <value> # set a config value
$ npx x402-proxy config unset <key>       # remove a config value
$ npx x402-proxy wallet                   # show addresses and balances
$ npx x402-proxy wallet history           # payment history
$ npx x402-proxy wallet export-key <target> # bare key/mnemonic to stdout (evm|solana|mnemonic)
```

All commands support `--help` for details. Use `-c <dir>` to override the config directory.

## Wallet

A single BIP-39 mnemonic derives both chains:
- **Solana:** SLIP-10 Ed25519 at `m/44'/501'/0'/0'`
- **EVM:** BIP-32 secp256k1 at `m/44'/60'/0'/0/0`

Config stored at `$XDG_CONFIG_HOME/x402-proxy/` (default `~/.config/x402-proxy/`).

### Export keys for other tools

```bash
# Pipe-safe - outputs bare key/mnemonic to stdout
$ MY_KEY=$(npx x402-proxy wallet export-key evm)
$ MY_MNEMONIC=$(npx x402-proxy wallet export-key mnemonic)
```

## Env Vars

Override wallet per-instance (fallback for environments where the wallet file isn't accessible):

```
X402_PROXY_WALLET_MNEMONIC     # BIP-39 mnemonic (derives both chains)
X402_PROXY_WALLET_EVM_KEY      # EVM private key (hex)
X402_PROXY_WALLET_SOLANA_KEY   # Solana private key (base58)
```

Resolution order: flags > env vars > mnemonic env > `wallet.json` file.

## Library Usage

```ts
import {
  createX402ProxyHandler,
  createMppProxyHandler,
  extractTxSignature,
  detectProtocols,
  appendHistory,
  readHistory,
  calcSpend,
} from "x402-proxy";
```

See the [library API docs](https://github.com/cascade-protocol/x402-proxy/tree/main/packages/x402-proxy#library-api) for details.

## OpenClaw Plugin

x402-proxy ships as an [OpenClaw](https://openclaw.dev) plugin, giving your gateway automatic x402 payment capabilities. Registers `x_balance` and `x_payment` tools, `/x_wallet` command, and an HTTP route proxy for upstream x402 endpoints.

Configure providers and models in OpenClaw plugin settings. Uses the standard wallet resolution (env vars or `wallet.json`).

## License

Apache-2.0
