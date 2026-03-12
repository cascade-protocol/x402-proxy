# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.1] - 2026-03-12

### Changed
- Package description and keywords aligned with "curl for x402 paid APIs" positioning
- README rewritten: real endpoint in Quick Start, MCP Proxy elevated above HTTP Requests
- Stricli commands use explicit generic types (fixes TS 5.9 type inference)
- `displayStatus()` extracted as callable function from status command
- `PaymentRequirements.amount` used instead of removed `maxAmountRequired`

### Fixed
- All `tsc --noEmit` type errors resolved (previously passing only at build time)
- Biome schema version bumped to match CLI 2.4.6

## [0.2.0] - 2026-03-12

### Added
- CLI binary accessible via `npx x402-proxy`
- `fetch` command (default) - curl-like HTTP client with automatic x402 payment
- `mcp` command (alpha) - MCP stdio proxy with auto-payment for AI agents
- `setup` command - interactive onboarding wizard with @clack/prompts
- `status` command - config, wallet, and spend summary
- `wallet` subcommand with `info`, `history`, `fund`, `export-key`
- BIP-39 mnemonic wallet derivation (Solana SLIP-10 + EVM BIP-32 from single seed)
- XDG-compliant config storage (`~/.config/x402-proxy/`)
- Wallet resolution cascade: flags > env vars > mnemonic env > wallet.json
- JSONL payment history with auto-truncation
- Env var overrides with `X402_PROXY_WALLET_*` prefix

### Changed
- Package now ships both CLI binary and library
- Dual tsdown build entries (bin/cli with shebang + index with dts)

## [0.1.0] - 2026-03-10

### Added
- Initial release (library only)
- `createX402ProxyHandler` - wraps fetch with automatic x402 payment
- `extractTxSignature` - extracts TX signature from payment response headers
- `loadSvmWallet` / `loadEvmWallet` - wallet loading utilities
- `appendHistory` / `readHistory` / `calcSpend` - JSONL transaction history
- Re-exports from `@x402/fetch`, `@x402/svm`, `@x402/evm`

[Unreleased]: https://github.com/cascade-protocol/x402-proxy/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/cascade-protocol/x402-proxy/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/cascade-protocol/x402-proxy/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/cascade-protocol/x402-proxy/releases/tag/v0.1.0
