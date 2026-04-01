# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.10.1] - 2026-04-01

### Changed
- Dropped `@solana-program/compute-budget` and `@solana-program/token-2022` dependencies - compute budget instructions now use `@solana/kit` built-ins, non-USDC asset path removed (only USDC is supported)
- Kept `@solana-program/token` (clean peer deps) for `findAssociatedTokenPda` and `getTransferCheckedInstruction`
- Eliminates `@solana/sysvars` peer dependency warning on `npm install`

## [0.10.0] - 2026-04-01

### Added
- `serve` command - local HTTP proxy server for paid inference endpoints, auto-detects wallet and preferred network
- `claude` command - run Claude Code through a paid local proxy with `ANTHROPIC_BASE_URL` auto-configured
- `--model` flag on `claude` command (default: `minimax/minimax-m2.7`) - sets `ANTHROPIC_CUSTOM_MODEL_OPTION` for non-Anthropic models
- MPP payment support in OpenClaw plugin - inference proxy and `x_request` tool now handle both x402 (Solana) and MPP (Tempo/Base) protocols
- `/x_send` slash command with confirmation flow (5-min TTL) for USDC transfers from the OpenClaw gateway
- Default Surf provider config - plugin works out of the box without explicit provider configuration
- `defaults.ts` module with provider config types, resolution logic, and built-in model catalog
- Dual-wallet support in OpenClaw plugin - EVM and Solana addresses resolved independently
- `addressForNetwork` and `parseMppAmount` exported as shared helpers from `tools.ts`

### Changed
- OpenClaw plugin migrated to `definePluginEntry` SDK (from hand-rolled types)
- `x_balance` tool renamed to `x_wallet` (alias: `x_balance`)
- `x_payment` tool renamed to `x_request` (alias: `x_payment`) with x402/MPP protocol branching
- `/x_wallet` command: `send` subcommand now redirects to `/x_send`
- Inference proxy route handler renamed from `createX402RouteHandler` to `createInferenceProxyRouteHandler`
- SSE token tracking deduplicated into `createSseTracker()` helper shared by x402 and MPP paths
- Replaced hardcoded `"eip155:4217"` with imported `TEMPO_NETWORK` constant
- `serve` and `claude` commands handle their own SIGINT/SIGTERM (CLI entry point skips default handler for them)
- Wallet loading in plugin uses proper promise dedup (`walletLoadPromise`) instead of boolean flag
- Providers sorted once in route handler closure instead of per-request

### Fixed
- `preferredNetwork === "undefined"` string comparison in serve command replaced with proper `preferredNetwork || undefined` check

## [0.9.4] - 2026-03-27

### Fixed
- All example URLs migrated from legacy individual service subdomains (`twitter.surf.cascade.fyi`, `web.surf.cascade.fyi`, `inference.surf.cascade.fyi`) to unified `surf.cascade.fyi/api/v1/` endpoints across CLI help text, README, SKILL.md, and OpenClaw plugin docs

## [0.9.3] - 2026-03-26

### Fixed
- Solana RPC 429 rate-limit failures on concurrent payments - replaced upstream `ExactSvmScheme` (creates new RPC client per call) with `OptimizedSvmScheme` that shares a single RPC client with `@solana/kit` request coalescing (identical calls in the same microtask merge into one network request)
- Hardcoded USDC mint metadata (Token Program address, 6 decimals) to skip `fetchMint` RPC call entirely for USDC payments
- Added RPC failover transport: on 429 from one endpoint, immediately tries the next instead of failing. Two public mainnet RPCs: `api.mainnet.solana.com` (Solana Labs, 100 req/10s) and `public.rpc.solanavibestation.com` (community, 5 RPS)
- Custom RPC URL (via config or OpenClaw plugin) is tried first, with public RPCs as fallback

### Changed
- Added `@solana-program/compute-budget`, `@solana-program/token`, `@solana-program/token-2022`, `@x402/core` as direct dependencies (previously transitive via `@x402/svm`)

## [0.9.2] - 2026-03-26

### Changed
- Upgraded all dependencies to latest: `@x402/*` 2.6.0 -> 2.8.0, `@solana/kit` 6.3.0 -> 6.5.0, `viem` 2.47.6, `@modelcontextprotocol/sdk` 1.28.0, `vitest` 4.1.1, `tsdown` 0.21.5, `@biomejs/biome` 2.4.9, `turbo` 2.8.20, `openclaw` 2026.3.24
- `pnpm check` now runs tests alongside build, type-check, and biome
- Biome config scoped to supported file types only (`*.ts`, `*.json`, `*.jsonc`)

## [0.9.1] - 2026-03-26

### Added
- `setup --non-interactive` flag - auto-generates wallet and outputs addresses as JSON to stdout (`{"base":"0x...","tempo":"0x...","solana":"..."}`)
- `setup --import-mnemonic` flag - import existing BIP-39 mnemonic non-interactively
- MCP proxy auto-generates wallet on first run when no wallet exists (no more "No wallet configured" error)
- OpenClaw integration example in README and SKILL.md: `openclaw mcp set surf '{"command":"npx","args":["-y","x402-proxy","mcp","https://surf.cascade.fyi/mcp"]}'`

### Fixed
- `npx -y` flag added to all generated MCP configs (`mcp add` command and docs) - prevents npx install prompt from corrupting MCP stdio protocol
- MCP config examples no longer show `X402_PROXY_WALLET_MNEMONIC` env var as default - wallet file is the primary path, env vars are documented as fallback only
- All example MCP URLs updated to `https://surf.cascade.fyi/mcp`
- Non-interactive JSON output uses network names (`base`, `tempo`, `solana`) instead of generic `evm`

## [0.9.0] - 2026-03-25

### Added
- `mcp add` command - onboarding wizard to install MCP servers into Claude Code, Cursor, VS Code, and 16+ other AI clients via `@getmcp/generators`
- Auto-detects installed AI clients and highlights them in the selection list
- Shows config diff preview with green markers before writing
- Prompts to overwrite if server name already exists (shows current config)
- Wallet setup runs automatically if not yet configured
- Balance check and funding hints shown after successful install
- `-c` / `--config-dir` global flag to override config directory for all commands
- Custom config directory injected as `XDG_CONFIG_HOME` env var into generated MCP server configs
- Tempo address shown alongside Base address in setup wizard

### Fixed
- Solana USDC balance shows `0` instead of `?` for fresh wallets (non-existent ATA means zero balance, not unknown)
- MPP payment protocol description corrected from "streaming micropayments" to "machine payments over HTTP 402"

## [0.8.6] - 2026-03-25

### Fixed
- Example URLs in help output and setup wizard: `/user/` corrected to `/users/` (was returning 404)

## [0.8.5] - 2026-03-24

### Fixed
- OpenClaw plugin: models now appear in `openclaw models` list - replaced invalid `models` field on `registerProvider()` with a `catalog` hook returning `ProviderCatalogResult`, which is required by OpenClaw's provider discovery filter

## [0.8.4] - 2026-03-24

### Fixed
- Servers returning Solana payment options with EVM-format `payTo` addresses (e.g. `0x...`) no longer crash with a base58 decode error - malformed options are filtered out and valid options are used instead
- When all payment options from a server have mismatched address formats, a clear error is shown instead of a cryptic codec failure

## [0.8.3] - 2026-03-24

### Added
- JSON response pretty-printing: non-streaming `application/json` responses auto-formatted with 2-space indent on TTY
- `--json` flag now works: forces JSON pretty-printing even when piped (non-TTY)
- Color-coded HTTP status lines: green for 2xx, yellow for 3xx, red for 4xx/5xx

### Fixed
- MPP streaming payment label unified from `MPP session:` to `Payment: ... MPP` to match non-streaming format
- MPP streaming status line now starts on a new line instead of appending to last JSON chunk

## [0.8.2] - 2026-03-24

### Fixed
- JSON request bodies sent without explicit `Content-Type` header now auto-detect as `application/json` instead of defaulting to `text/plain` - fixes servers rejecting JSON bodies on payment retry

## [0.8.1] - 2026-03-24

### Added
- Curl-style short flags: `-X` (method), `-H` (header), `-d` (body) for the `fetch` command
- `-H` preprocessing in CLI entry point to work around Stricli reserving `-H` for `--help-all`

### Fixed
- SSE streaming resilience: swallow Node.js "terminated" errors when server closes connection after final event, so payment logging still completes
- Bumped `mppx` to ^0.4.9 (fixes 204-safe SSE receipt wrapping and idempotent voucher replay)

## [0.8.0] - 2026-03-21

### Added
- `config` command with `show`, `set`, and `unset` subcommands for managing configuration from the CLI (no more manual YAML editing)
- Setup wizard now asks about preferred payment protocol (x402/MPP) and network
- MCP proxy handles `McpError(-32042)` from dual-protocol servers that throw instead of using `isError`, automatically retrying with x402 payment
- MPP payment amounts captured from challenges and displayed in payment logs, MCP proxy output, and transaction history
- `formatAmount()` and `formatUsdcValue()` exported from library for adaptive USDC precision formatting

### Changed
- USDC amounts displayed with adaptive precision (2-6 decimals based on magnitude) instead of fixed 4 decimals everywhere
- Zero-balance detection uses numeric comparison instead of string matching

## [0.7.1] - 2026-03-20

### Fixed
- Non-402 server errors (500, 503, etc.) now indicate whether payment was attempted, helping users distinguish "server down" from "payment failed"

## [0.7.0] - 2026-03-20

### Added
- `--verbose` flag on `fetch` command - debug logging for protocol negotiation, headers, session lifecycle, and payment flow
- OpenClaw plugin integration (`x402-proxy/openclaw`) - registers `x_balance` tool, `x_payment` tool, `/x_wallet` command, and HTTP route proxy for upstream x402 endpoints
- `openclaw.plugin.json` manifest with config schema for providers, keypair path, RPC URL, and dashboard URL
- `./openclaw` subpath export in package.json

### Fixed
- MPP SSE requests silently losing `Content-Type` and other headers when `Headers` instances are spread (workaround for mppx SDK bug, upstream fix: wevm/mppx#209)
- MPP session `close()` errors no longer crash the CLI - wrapped in try/catch with verbose error reporting
- MPP payment history now includes `amount` (converted from base units) and `channelId` in transaction records
- MPP streaming history records now use `channelId` as fallback for `tx` field when no receipt reference is available

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

[Unreleased]: https://github.com/cascade-protocol/x402-proxy/compare/v0.10.1...HEAD
[0.10.1]: https://github.com/cascade-protocol/x402-proxy/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/cascade-protocol/x402-proxy/compare/v0.9.4...v0.10.0
[0.9.4]: https://github.com/cascade-protocol/x402-proxy/compare/v0.9.3...v0.9.4
[0.9.3]: https://github.com/cascade-protocol/x402-proxy/compare/v0.9.2...v0.9.3
[0.9.2]: https://github.com/cascade-protocol/x402-proxy/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/cascade-protocol/x402-proxy/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/cascade-protocol/x402-proxy/compare/v0.8.6...v0.9.0
[0.8.6]: https://github.com/cascade-protocol/x402-proxy/compare/v0.8.5...v0.8.6
[0.8.5]: https://github.com/cascade-protocol/x402-proxy/compare/v0.8.4...v0.8.5
[0.8.4]: https://github.com/cascade-protocol/x402-proxy/compare/v0.8.3...v0.8.4
[0.8.3]: https://github.com/cascade-protocol/x402-proxy/compare/v0.8.2...v0.8.3
[0.8.2]: https://github.com/cascade-protocol/x402-proxy/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/cascade-protocol/x402-proxy/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/cascade-protocol/x402-proxy/compare/v0.7.1...v0.8.0
[0.7.1]: https://github.com/cascade-protocol/x402-proxy/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/cascade-protocol/x402-proxy/compare/v0.6.0...v0.7.0
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
