# Changelog

All notable changes to this project will be documented in this file.

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

[0.11.2]: https://github.com/cascade-protocol/x402-proxy/compare/v0.11.1...v0.11.2
[0.11.1]: https://github.com/cascade-protocol/x402-proxy/compare/v0.11.0...v0.11.1
[0.11.0]: https://github.com/cascade-protocol/x402-proxy/compare/v0.10.12...v0.11.0
[0.10.12]: https://github.com/cascade-protocol/x402-proxy/releases/tag/v0.10.12
