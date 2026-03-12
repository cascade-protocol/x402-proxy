# x402-proxy

CLI and library for paying [x402](https://www.x402.org/) resources. Auto-pays HTTP 402 responses with USDC on Base or Solana.

## Quick Start

```bash
npx x402-proxy setup                # generate wallet from BIP-39 mnemonic
npx x402-proxy wallet fund          # see where to send USDC
npx x402-proxy https://example.com  # make a paid request
```

**Done.** Your wallet derives both EVM (Base) and Solana keypairs from a single mnemonic. Fund either chain and start paying for x402 resources.

## Commands

```bash
x402-proxy <url>                    # paid HTTP request (default command)
x402-proxy mcp <url>                # MCP stdio proxy for agents (alpha)
x402-proxy setup                    # onboarding wizard
x402-proxy status                   # config + wallet + spend summary
x402-proxy wallet                   # show addresses
x402-proxy wallet history           # payment history
x402-proxy wallet fund              # funding instructions
x402-proxy wallet export-key <chain> # bare key to stdout (evm|solana)
```

All commands support `--help` for details.

## Fetch (HTTP Client)

```bash
# GET request
x402-proxy https://twitter.surf.cascade.fyi/search?q=x402

# POST with body and headers
x402-proxy --method POST \
  --header "Content-Type: application/json" \
  --body '{"url":"https://x402.org"}' \
  https://web.surf.cascade.fyi/v1/crawl
```

Response body streams to stdout, payment info goes to stderr. Pipe-safe:

```bash
x402-proxy https://api.example.com/data | jq '.results'
```

## MCP Proxy (Alpha)

Wraps a remote MCP server with automatic x402 payment. Configure in your MCP client:

```json
{
  "mcpServers": {
    "paid-service": {
      "command": "npx",
      "args": ["x402-proxy", "mcp", "https://mcp.example.com/sse"],
      "env": {
        "X402_PROXY_WALLET_MNEMONIC": "your 24 words here"
      }
    }
  }
}
```

## Wallet

A single BIP-39 mnemonic derives both chains:
- **Solana:** SLIP-10 Ed25519 at `m/44'/501'/0'/0'`
- **EVM:** BIP-32 secp256k1 at `m/44'/60'/0'/0/0`

Config stored at `$XDG_CONFIG_HOME/x402-proxy/` (default `~/.config/x402-proxy/`).

### Export keys for other tools

```bash
# Pipe-safe - outputs bare key to stdout
MY_KEY=$(npx x402-proxy wallet export-key evm)
```

## Env Vars

Override wallet per-instance (useful for MCP configs):

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
  extractTxSignature,
  appendHistory,
  readHistory,
  calcSpend,
} from "x402-proxy";
```

See the [library API docs](https://github.com/cascade-protocol/x402-proxy/tree/main/packages/x402-proxy#library-api) for details.

## License

Apache-2.0
