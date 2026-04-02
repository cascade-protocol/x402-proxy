---
name: x402-proxy
description: Use x402-proxy CLI for consuming and debugging x402 and MPP paid APIs. Use this skill when testing x402/MPP endpoints, configuring MCP payment proxies for AI agents, managing wallets, or scripting paid HTTP requests. Triggers on x402-proxy, npx x402-proxy, x402 endpoint testing, MPP streaming payments, paid API debugging, MCP payment proxy, wallet management, or any mention of auto-paying HTTP 402 responses.
---

# x402-proxy

`curl` for x402 and MPP paid APIs. Auto-pays HTTP 402 responses with USDC on Base, Solana, and [Tempo](https://tempo.xyz/). Supports one-time payments (x402, MPP charge) and pay-per-token streaming (MPP sessions).

## Quick start

```bash
npx x402-proxy -X POST -d '{"ref":"CoinbaseDev"}' https://surf.cascade.fyi/api/v1/twitter/user
```

First run auto-creates a wallet. No setup needed.

## HTTP requests

```bash
# GET - body to stdout, payment info to stderr
npx x402-proxy https://api.example.com/resource

# POST with body and headers
npx x402-proxy --method POST \
  --header "Content-Type: application/json" \
  --body '{"query":"example"}' \
  https://api.example.com/search

# Force a specific chain
npx x402-proxy --network solana https://api.example.com/data

# Pipe-safe - only response body on stdout
npx x402-proxy https://api.example.com/data | jq '.results'

# Save response to file
npx x402-proxy https://api.example.com/data > response.json
```

## Commands

```
x402-proxy <url>                        # paid HTTP request (default)
x402-proxy serve                        # local paid inference proxy server
x402-proxy claude                       # run Claude Code through paid local proxy
x402-proxy mcp <url>                    # MCP stdio proxy for AI agents
x402-proxy mcp add <name> <url>         # install MCP server into AI client
x402-proxy setup                        # wallet onboarding wizard
x402-proxy setup --force                # re-run setup (overwrite existing wallet)
x402-proxy status                       # config + wallet + daily spend summary
x402-proxy config                       # show current configuration
x402-proxy config set <key> <value>     # set a config value
x402-proxy config unset <key>           # remove a config value
x402-proxy wallet                       # show addresses and USDC balances
x402-proxy wallet history               # payment log
x402-proxy wallet history --limit 5     # last 5 payments
x402-proxy wallet history --json        # machine-readable output
x402-proxy wallet export-key evm        # bare EVM private key to stdout
x402-proxy wallet export-key solana     # bare Solana private key to stdout
x402-proxy wallet export-key mnemonic   # bare mnemonic to stdout
```

## Fetch flags

```
--method, -X <METHOD>     HTTP method (default: GET)
--header, -H <KEY:VALUE>  Add request header (repeatable)
--body, -d <DATA>         Request body (string or @file)
--network <NETWORK>       Force payment chain (base, solana, tempo)
--protocol <PROTOCOL>    Payment protocol (x402, mpp)
--verbose                Show debug details (protocol negotiation, headers, payment flow)
```

## MCP proxy for AI agents

Quick setup (auto-detects installed AI clients):

```bash
x402-proxy mcp add surf https://surf.cascade.fyi/mcp
```

Or drop into your client config manually:

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

For OpenClaw:

```bash
openclaw mcp set surf '{"command":"npx","args":["-y","x402-proxy","mcp","https://surf.cascade.fyi/mcp"]}'
```

The wallet is auto-generated on first run and stored at `~/.config/x402-proxy/wallet.json`. No env vars needed. The proxy intercepts 402 responses, pays automatically, forwards the result. Supports StreamableHTTP and SSE.

For non-interactive setup (e.g. automated provisioning):

```bash
npx x402-proxy setup --non-interactive
# outputs: {"evm":"0x...","solana":"..."}
```

## Wallet & env vars

One BIP-39 mnemonic derives both Solana and EVM keypairs. Auto-detects which chain based on USDC balance.

```
X402_PROXY_WALLET_MNEMONIC       # BIP-39 mnemonic (derives both chains)
X402_PROXY_WALLET_EVM_KEY        # EVM private key (hex, 0x optional)
X402_PROXY_WALLET_SOLANA_KEY     # Solana private key (base58 or JSON array)
```

Resolution: flags > env vars > mnemonic env > `~/.config/x402-proxy/wallet.json`

Pipe-safe export for scripting:

```bash
MY_KEY=$(npx x402-proxy wallet export-key evm)
MY_MNEMONIC=$(npx x402-proxy wallet export-key mnemonic)
```

## Config

Lives at `~/.config/x402-proxy/` (or `$XDG_CONFIG_HOME/x402-proxy/`):

```yaml
# config.yaml
defaultNetwork: base          # or "solana"
preferredProtocol: x402       # or "mpp" for Tempo/MPP endpoints
mppSessionBudget: "1"         # max USDC deposit for MPP streaming sessions
spendLimitDaily: 10           # USDC daily cap
spendLimitPerTx: 1            # USDC per-request cap
```

Also supports JSONC and JSON config files. Wallet stored in `wallet.json` (mode 0600), payments logged to `history.jsonl`.

## Testing & debugging x402 services

```bash
# Smoke test an endpoint
npx x402-proxy --verbose https://your-service.com/paid-route

# Test both chains
npx x402-proxy --network base https://your-service.com/route
npx x402-proxy --network solana https://your-service.com/route

# Batch test
for route in /users/test /tweets/search /v1/crawl; do
  echo "--- $route ---"
  npx x402-proxy "https://your-service.com$route" 2>/dev/null | head -c 200
  echo
done

# Check what you spent
npx x402-proxy wallet history --limit 5
npx x402-proxy status
```

stdout = response body, stderr = payment info. Pipes, redirects, and `jq` all work cleanly.

## OpenClaw Plugin

x402-proxy also ships as a separate [OpenClaw](https://openclaw.dev) plugin package, `x402-proxy-openclaw`, for automatic x402 payments, wallet management, and pay-per-use inference proxying. For full installation, provider/model configuration, and troubleshooting, read `references/openclaw-plugin.md`.

Quick install:

```bash
openclaw plugins install x402-proxy-openclaw
npx x402-proxy setup   # creates wallet if needed
```

Registers: `x_wallet` tool, `x_request` tool (aliased as `x_balance`/`x_payment`), `/x_wallet` and `/x_send` commands, `/x402-proxy/*` HTTP route for inference proxying.

## Library API

For programmatic use in Node.js apps, read `references/library.md`.
