# x402-proxy-openclaw

OpenClaw plugin for x402 and MPP payments, wallet tools, and paid inference proxying.

## Install

```bash
openclaw plugins install x402-proxy-openclaw
```

## What It Adds

- `x_wallet` and `x_request` tools, with `x_balance` and `x_payment` aliases
- `/x_wallet` and `/x_send` commands
- an HTTP route proxy for upstream inference endpoints
- a built-in `surf` provider at `/x402-proxy/v1`

By default, the plugin proxies `https://surf.cascade.fyi/api/v1/inference` and prefers MPP.

## Relationship To The CLI Package

The standalone CLI and library remain published as `x402-proxy`.

Use `x402-proxy` when you want:
- paid HTTP requests from the command line
- the MCP proxy
- local wallet setup and export flows

Use `x402-proxy-openclaw` when you want:
- OpenClaw gateway integration
- plugin-managed tools, commands, and routes

## License

Apache-2.0
