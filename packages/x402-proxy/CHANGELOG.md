# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] - 2026-03-19

### Added
- MPP (Machine Payments Protocol) support via `mppx` SDK - pay-per-token streaming and charge-per-request on the Tempo network
- `--protocol` flag for `fetch` and `mcp` commands - choose between `x402` and `mpp` payment protocols
- MPP streaming: `--protocol mpp` with `"stream": true` in body uses session-based SSE with mid-stream voucher cycling
- MPP MCP proxy: `--protocol mpp` on `mcp` command wraps tool calls with MPP payments via `mppx/mcp-sdk`
- Auto-detect fallback: if x402 returns 402 and server advertises MPP via `WWW-Authenticate: Payment`, falls through to MPP automatically
- Tempo USDC balance shown in `wallet` and `status` commands
- `preferredProtocol` and `mppSessionBudget` config options
- `detectProtocols()`, `createMppProxyHandler()`, `TEMPO_NETWORK` exported from library
- `MppPaymentInfo`, `MppProxyHandler`, `DetectedProtocols` types exported

### Changed
- `PaymentInfo` type now includes `protocol: "x402"` discriminator
- `extractTxSignature()` now also extracts references from MPP `Payment-Receipt` headers
- 402 error display shows Tempo balances and MPP-accepting endpoints
- `appendHistory` creates parent directory automatically (removed `ensureConfigDir` calls)
- Balance fetching consolidated into `fetchAllBalances()` helper

## [0.5.2] - 2026-03-19

### Fixed
- Package exports missing top-level `types` condition - TypeScript with `moduleResolution: "bundler"` could not resolve type declarations

## [0.5.1] - 2026-03-19

### Fixed
- Solana USDC balance showing 0.0000 instead of actual balance due to `getTokenAccountsByOwner` being rate-limited (429) on public Solana RPC
- Replaced with offline ATA derivation via `@solana/kit` + lightweight `getTokenAccountBalance` call that works reliably on any public RPC
- RPC errors now show `?` instead of silently displaying `0.0000`

## [0.5.0] - 2026-03-16

### Changed
- MCP proxy graduated from alpha to stable - removed alpha warning and label
- MCP proxy uses low-level `Server` class instead of `McpServer` to proxy raw JSON schemas verbatim without Zod conversion
- MCP proxy now forwards blob resource contents (previously only text was proxied)
- MCP content type widened to pass through all MCP content types (image, audio, resource_link) not just text

### Added
- MCP proxy forwards `notifications/tools/list_changed` and `notifications/resources/list_changed` from remote servers so local clients stay in sync with dynamic tool/resource updates

## [0.4.2] - 2026-03-16

### Fixed
- Twitter endpoint URLs updated from `/user/` to `/users/` to match spec change

### Added
- CHANGELOG.md included in npm package metadata
- `skills/` directory with SKILL.md and library reference included in npm package

## [0.4.1] - 2026-03-13

### Changed
- Extracted `createNetworkFilter`, `createNetworkPreference`, `networkToCaipPrefix` as exported functions for testability
- Publish workflow auto-creates GitHub releases from CHANGELOG.md (no more manual `gh release create`)
- Release docs updated in CLAUDE.md with `act` dry-run instructions for CI workflows

### Added
- Tests for network filter, network preference selector, Solana address derivation, and wallet resolution (14 new tests)

## [0.4.0] - 2026-03-13

### Added
- `--network` flag for `fetch` and `mcp` commands - hard filter that requires a specific network (base, solana, or CAIP-2 ID), fails with clear error if unavailable
- Human-readable network names in payment output ("Base", "Solana" instead of "eip155:8453")
- `displayNetwork()` exported from library for mapping CAIP-2 IDs to display names

### Fixed
- Wildcard scheme registration (`eip155:*`, `solana:*`) via SDK helpers - payment signing now works for any EVM chain a server requests, not just Base
- Solana address derivation for `--solana-key` flag and `X402_PROXY_WALLET_SOLANA_KEY` env var - balance detection, wallet display, and history recording were broken without it
- MCP command now auto-detects preferred network based on USDC balance (same fix previously applied to `fetch`)
- MCP payment history records now include `amount`, `to`, and correct `network` (removed fragile type cast)
- Removed debug prefix stripping from payment amounts in handler
- USDC balance display now shows 4 decimal places (was 2)

## [0.3.2] - 2026-03-13

### Added
- Auto-setup: running `npx x402-proxy <url>` without a wallet launches the setup wizard, then continues with the request
- 402 error handling parses the endpoint's `PAYMENT-REQUIRED` header to show actual accepted networks and costs
- CI pipeline (GitHub Actions: check, build, test on push/PR)
- Automated npm publishing with OIDC provenance on tag push
- Tests for wallet derivation and transaction history (25 tests)
- Funding hint in `wallet` when USDC balance is zero

### Changed
- Version injected at build time from package.json (no more stale hardcoded strings)
- `wallet fund` command removed (addresses and hint shown in `wallet` directly)
- All command references use `$ npx x402-proxy` format

## [0.3.1] - 2026-03-12

### Added
- `wallet export-key mnemonic` - export BIP-39 mnemonic to stdout (pipe-safe, with confirmation prompt)

## [0.3.0] - 2026-03-12

### Added
- Live wallet balances in `status` and `wallet` commands (USDC + ETH/SOL via RPC)
- Recent transactions shown in `status` (last 5) and `wallet` (last 10)
- Network preference (`defaultNetwork` config) - prefers configured chain when endpoint accepts multiple
- Spend limits (`spendLimitDaily`, `spendLimitPerTx` config) enforced via x402Client policy
- `--verbose` flag on `wallet` command to show transaction IDs
- Confirmation prompt on `wallet export-key` when stdout is a terminal
- Help text with usage examples for `fetch --help` and `mcp --help`
- Full command reference, "try:" suggestion, and repo link in no-args output
- Network indicator on transaction lines (base/sol)
- Setup outro with "try your first request" using real endpoint

### Changed
- "EVM" label replaced with "Base" throughout (wallet, status, setup)
- Config directory displayed as `~/.config/...` instead of absolute path
- Error messages prefixed with `✗`, success with `✓` for accessibility
- No-args output redesigned: identity header, wallet summary, commands, try suggestion
- Example URLs use path-based format (`/user/cascade_fyi`) to avoid zsh glob issues
- `@solana/kit`, `ethers`, `viem` moved from peerDependencies to dependencies (fixes npx ERESOLVE warnings)
- Wallet subcommand hints shown at bottom of `wallet` output

### Fixed
- RPC balance failures show "(network error)" instead of silent omission

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
- `mcp` command - MCP stdio proxy with auto-payment for AI agents
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

[Unreleased]: https://github.com/cascade-protocol/x402-proxy/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/cascade-protocol/x402-proxy/compare/v0.5.2...v0.6.0
[0.5.2]: https://github.com/cascade-protocol/x402-proxy/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/cascade-protocol/x402-proxy/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/cascade-protocol/x402-proxy/compare/v0.4.2...v0.5.0
[0.4.2]: https://github.com/cascade-protocol/x402-proxy/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/cascade-protocol/x402-proxy/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/cascade-protocol/x402-proxy/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/cascade-protocol/x402-proxy/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/cascade-protocol/x402-proxy/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/cascade-protocol/x402-proxy/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/cascade-protocol/x402-proxy/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/cascade-protocol/x402-proxy/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/cascade-protocol/x402-proxy/releases/tag/v0.1.0
