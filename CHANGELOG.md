# Changelog

All notable changes to this project will be documented in this file.

## [0.11.6] - 2026-04-07

### Fixed

- Fix HTTP 404 on OpenClaw inference proxy: upstream URL was missing `/v1` suffix, causing requests to hit `/api/v1/inference/chat/completions` instead of `/api/v1/inference/v1/chat/completions`
- Fix `fetchUpstreamModels` URL construction after upstream URL correction

### Added

- 5 missing models in `MODEL_METADATA`: `z-ai/glm-5.1`, `x-ai/grok-4.20-multi-agent-beta`, `x-ai/grok-4.1-fast:online`, `x-ai/grok-4.20-beta:online`, `x-ai/grok-4.20-multi-agent-beta:online`
- Catalog auto-sync: `fetchUpstreamModels()` now called in catalog `run` to fetch live model list from upstream on gateway restart

### Changed

- Downgrade plugin startup logs from `info` to `debug` to reduce log spam during `oc status`/`oc doctor`

## [0.11.5] - 2026-04-07

### Fixed

- Fix race condition in MPP MCP proxy: concurrent tool calls no longer overwrite each other's payment amounts (replaced shared mutable variable with AsyncLocalStorage per-call context)

## [0.11.4] - 2026-04-03

### Added

- Model catalog: Claude Opus 4.5, Claude Sonnet 4.5, Grok 4.1 Fast, MiniMax M2.7

### Changed

- Refactor model defaults from array to record-based `MODEL_METADATA` lookup
- Provider auth now returns config patch when wallet already exists (fixes missing provider config on re-setup)
- Remove `autoEnableWhenConfiguredProviders` from plugin manifest (unnecessary for explicitly installed plugins)

## [0.11.3] - 2026-04-03

### Changed

- README rewritten to Standard Readme spec (badges, ToC, Install/Usage/Contributing sections)
- SKILL.md updated for consistency (MCP proxy mention, unified flag style)
- Unified package description across README, SKILL.md, and package.json

## [0.11.2] - 2026-04-02

### Fixed

- Strip surrounding quotes from mnemonic in `/x_wallet setup import` (Telegram copy-paste)
- Show actual word count in mnemonic validation errors

## [0.11.1] - 2026-04-02

### Fixed

- Fix x402-proxy-openclaw publish workflow permissions

## [0.11.0] - 2026-04-02

### Added

- OpenClaw `providerAuthChoices` wallet setup flow - interactive generate/import via gateway prompter
- `/x_wallet setup` subcommand for Telegram/slash-command wallet creation (generate or import mnemonic)
- BIP-39 mnemonic validation on import (both interactive and slash-command paths)
- `createWalletFile()` helper in config module

### Changed

- Converted dynamic imports in `handler.ts` to static imports (mppx, viem/accounts)
- Updated example URLs from POST `{"ref":"CoinbaseDev"}` to simpler GET `/twitter/user/openclaw`
- Usage examples now show `npx x402-proxy` prefix consistently
- OpenClaw compat bumped to `2026.4.1`
- Wallet-not-found error messages now suggest `/x_wallet setup` instead of CLI-only instructions

### Removed

- Default model display from `/x_wallet` info output

## [0.10.12] - 2026-04-02

### Fixed

- Restore explicit SetComputeUnitLimit instruction for Solana transactions
- Strip `outputSchema` from proxied MCP tool definitions
- Downgrade @modelcontextprotocol/sdk to 1.27.1 for compatibility

[0.11.6]: https://github.com/cascade-protocol/x402-proxy/compare/v0.11.5...v0.11.6
[0.11.5]: https://github.com/cascade-protocol/x402-proxy/compare/v0.11.4...v0.11.5
[0.11.4]: https://github.com/cascade-protocol/x402-proxy/compare/v0.11.3...v0.11.4
[0.11.3]: https://github.com/cascade-protocol/x402-proxy/compare/v0.11.2...v0.11.3
[0.11.2]: https://github.com/cascade-protocol/x402-proxy/compare/v0.11.1...v0.11.2
[0.11.1]: https://github.com/cascade-protocol/x402-proxy/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/cascade-protocol/x402-proxy/compare/v0.10.12...v0.11.0
[0.10.12]: https://github.com/cascade-protocol/x402-proxy/releases/tag/v0.10.12
