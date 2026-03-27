# OpenClaw Plugin Setup

x402-proxy ships as an [OpenClaw](https://openclaw.dev) plugin. Gives your gateway automatic x402 payment, wallet management, and pay-per-use inference proxying via Solana USDC.

## What it registers

- **`x_balance` tool** - check wallet SOL/USDC balances, daily spend, available funds
- **`x_payment` tool** - call any x402-enabled endpoint with automatic payment (params: `url`, `method`, `params`, `headers`)
- **`/x_wallet` command** - wallet status dashboard, `send <amount|all> <address>`, `history [page]`
- **HTTP route `/x402/*`** - proxies requests to upstream inference endpoints with payment, tracks token usage and cost

## Step 1: Install the plugin

```bash
openclaw plugins install x402-proxy
```

This downloads from npm, validates `openclaw.plugin.json`, and installs to `~/.openclaw/extensions/x402-proxy/`.

## Step 2: Configure wallet

The plugin resolves a Solana wallet using the same cascade as the CLI:

1. `keypairPath` in plugin config (solana-keygen JSON file)
2. `X402_PROXY_WALLET_SOLANA_KEY` env var (base58 or JSON array)
3. `X402_PROXY_WALLET_MNEMONIC` env var (BIP-39, derives both Solana and EVM)
4. `~/.config/x402-proxy/wallet.json` (auto-created by `npx x402-proxy setup`)

Easiest path - run setup first, then the plugin picks up the wallet automatically:

```bash
npx x402-proxy setup
```

Or set an explicit keypair in plugin config (step 3).

## Step 3: Configure providers and models

Add the plugin config to your `openclaw.json` (or via `openclaw config edit`):

```json
{
  "plugins": {
    "entries": {
      "x402-proxy": {
        "config": {
          "providers": {
            "surf-inference": {
              "baseUrl": "/x402/v1",
              "upstreamUrl": "https://inference.surf.cascade.fyi",
              "models": [
                { "id": "anthropic/claude-opus-4.6", "name": "Claude Opus 4.6", "maxTokens": 200000, "reasoning": true, "input": ["text", "image"], "cost": { "input": 0.015, "output": 0.075, "cacheRead": 0.0015, "cacheWrite": 0.01875 }, "contextWindow": 200000 },
                { "id": "anthropic/claude-sonnet-4.6", "name": "Claude Sonnet 4.6", "maxTokens": 200000, "reasoning": true, "input": ["text", "image"], "cost": { "input": 0.003, "output": 0.015, "cacheRead": 0.0003, "cacheWrite": 0.00375 }, "contextWindow": 200000 },
                { "id": "anthropic/claude-opus-4.5", "name": "Claude Opus 4.5", "maxTokens": 200000, "reasoning": true, "input": ["text", "image"], "cost": { "input": 0.015, "output": 0.075, "cacheRead": 0.0015, "cacheWrite": 0.01875 }, "contextWindow": 200000 },
                { "id": "anthropic/claude-sonnet-4.5", "name": "Claude Sonnet 4.5", "maxTokens": 200000, "reasoning": true, "input": ["text", "image"], "cost": { "input": 0.003, "output": 0.015, "cacheRead": 0.0003, "cacheWrite": 0.00375 }, "contextWindow": 200000 },
                { "id": "x-ai/grok-4.20-beta", "name": "Grok 4.20 Beta", "maxTokens": 131072, "reasoning": true, "input": ["text"], "cost": { "input": 0.003, "output": 0.015, "cacheRead": 0, "cacheWrite": 0 }, "contextWindow": 131072 },
                { "id": "x-ai/grok-4.20-multi-agent-beta", "name": "Grok 4.20 Multi-Agent", "maxTokens": 131072, "reasoning": true, "input": ["text"], "cost": { "input": 0.003, "output": 0.015, "cacheRead": 0, "cacheWrite": 0 }, "contextWindow": 131072 },
                { "id": "x-ai/grok-4.1-fast", "name": "Grok 4.1 Fast", "maxTokens": 131072, "reasoning": false, "input": ["text"], "cost": { "input": 0.001, "output": 0.005, "cacheRead": 0, "cacheWrite": 0 }, "contextWindow": 131072 },
                { "id": "x-ai/grok-4.20-beta:online", "name": "Grok 4.20 Beta (Online)", "maxTokens": 131072, "reasoning": true, "input": ["text"], "cost": { "input": 0.005, "output": 0.025, "cacheRead": 0, "cacheWrite": 0 }, "contextWindow": 131072 },
                { "id": "x-ai/grok-4.20-multi-agent-beta:online", "name": "Grok 4.20 Multi-Agent (Online)", "maxTokens": 131072, "reasoning": true, "input": ["text"], "cost": { "input": 0.005, "output": 0.025, "cacheRead": 0, "cacheWrite": 0 }, "contextWindow": 131072 },
                { "id": "x-ai/grok-4.1-fast:online", "name": "Grok 4.1 Fast (Online)", "maxTokens": 131072, "reasoning": false, "input": ["text"], "cost": { "input": 0.003, "output": 0.015, "cacheRead": 0, "cacheWrite": 0 }, "contextWindow": 131072 },
                { "id": "minimax/minimax-m2.7", "name": "MiniMax M2.7", "maxTokens": 1000000, "reasoning": false, "input": ["text"], "cost": { "input": 0.001, "output": 0.005, "cacheRead": 0, "cacheWrite": 0 }, "contextWindow": 1000000 },
                { "id": "minimax/minimax-m2.5", "name": "MiniMax M2.5", "maxTokens": 1000000, "reasoning": false, "input": ["text"], "cost": { "input": 0.001, "output": 0.005, "cacheRead": 0, "cacheWrite": 0 }, "contextWindow": 1000000 },
                { "id": "moonshotai/kimi-k2.5", "name": "Kimi K2.5", "maxTokens": 131072, "reasoning": true, "input": ["text"], "cost": { "input": 0.002, "output": 0.008, "cacheRead": 0, "cacheWrite": 0 }, "contextWindow": 131072 },
                { "id": "z-ai/glm-5", "name": "GLM-5", "maxTokens": 128000, "reasoning": false, "input": ["text"], "cost": { "input": 0.001, "output": 0.005, "cacheRead": 0, "cacheWrite": 0 }, "contextWindow": 128000 },
                { "id": "qwen/qwen-2.5-7b-instruct", "name": "Qwen 2.5 7B Instruct", "maxTokens": 32768, "reasoning": false, "input": ["text"], "cost": { "input": 0.0003, "output": 0.001, "cacheRead": 0, "cacheWrite": 0 }, "contextWindow": 32768 }
              ]
            }
          }
        }
      }
    }
  }
}
```

### Config fields

| Field | Description |
|-------|-------------|
| `providers.<name>.baseUrl` | Route path registered in OpenClaw (e.g., `/x402/v1`) |
| `providers.<name>.upstreamUrl` | Actual upstream endpoint (e.g., `https://inference.surf.cascade.fyi`) |
| `providers.<name>.models[]` | Model catalog array |
| `keypairPath` | Optional path to solana-keygen JSON file (overrides wallet resolution) |
| `rpcUrl` | Solana RPC URL (defaults to mainnet public endpoints with failover) |
| `dashboardUrl` | URL linked from `/x_wallet` dashboard |

### Model entry fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Model identifier (e.g., `anthropic/claude-opus-4.6`) |
| `name` | string | Display name |
| `maxTokens` | number | Max context length |
| `reasoning` | boolean | Supports extended thinking |
| `input` | string[] | Input modalities: `["text"]` or `["text", "image"]` |
| `cost.input` | number | USDC per 1K input tokens |
| `cost.output` | number | USDC per 1K output tokens |
| `cost.cacheRead` | number | USDC per 1K cached read tokens |
| `cost.cacheWrite` | number | USDC per 1K cache write tokens |
| `contextWindow` | number | Full context window size |

## Step 4: Restart gateway and verify

```bash
openclaw gateway restart
openclaw models    # verify models appear
```

## How it works

1. Plugin boots, loads wallet via the resolution cascade
2. Registers each provider from config into OpenClaw's model catalog (API type: `openai-completions`, no auth required)
3. HTTP route `/x402/*` intercepts inference requests, strips prefix, proxies to `upstreamUrl`
4. On 402 response, auto-signs a Solana USDC payment and retries
5. SSE streaming responses are parsed for token usage and logged to `~/.config/x402-proxy/history.jsonl`
6. Tools and command are available to all agents on the gateway

## Fetching latest models

The model list on `inference.surf.cascade.fyi` changes over time. Fetch the current catalog:

```bash
npx x402-proxy --protocol mpp --network solana \
  https://inference.surf.cascade.fyi/v1/models
```

Then update the `models` array in your plugin config accordingly.

## Troubleshooting

- **Models don't appear in `openclaw models`** - the plugin uses a `catalog` hook (not `models` field). Make sure you're on x402-proxy >= 0.8.5.
- **"no wallet found" in logs** - run `npx x402-proxy setup` or set `X402_PROXY_WALLET_MNEMONIC` env var before starting the gateway.
- **402 errors on inference** - check wallet has USDC balance: use `x_balance` tool or `npx x402-proxy wallet`.
- **Gateway cold start slow** - normal on small VMs (~72s). The `x402-wallet` service eagerly loads the wallet during boot.
