# x402-proxy

CLI and library for x402 paid HTTP requests and MCP proxy. Monorepo with single package at `packages/x402-proxy`.

## ALWAYS
- **Read before acting**: Read every file you intend to modify. Never speculate about code you haven't opened.
- **Use real types**: Import actual types from source packages. No `as` assertions or stub types.
- **Remove dead code**: Unused variables, imports, or functions get deleted. Never `_` prefix to silence linters.
- **Minimal changes**: No abstraction layers or helpers unless asked. Three similar lines > premature abstraction.
- **Run `pnpm check` after every set of changes** - this is REQUIRED before committing.
- **Mainnet only**: No testnet, devnet, Sepolia, or faucet references anywhere in the codebase.

## Project
- **Package:** `npx x402-proxy` and `npm install -g x402-proxy` (both MUST work)
- **Local testing:** Always use `node dist/bin/cli.js` from `packages/x402-proxy/` - never install globally
- **Stack:** Stricli (CLI framework), @clack/prompts (interactive UX), picocolors (colors)
- **Build:** `tsdown --publint` bundles ESM to `dist/`, shebang via banner config
- **Lint:** Biome (formatter + linter), `pnpm check` runs type-check + biome
- **Monorepo:** pnpm workspaces + Turbo, build from root with `pnpm build`
- **Repo:** `cascade-protocol/x402-proxy`

## Build & tsdown
- Uses `tsdown` with `fixedExtension: false` so that `"type": "module"` produces `.js` (not `.mjs`)
- Two build entries in `tsdown.config.ts`: CLI (with shebang banner, no dts) and library (with dts)
- Shebang (`#!/usr/bin/env node`) is added via `banner.js` in tsdown config, NOT in source files
- Build from root: `pnpm build` (runs via Turbo)
- Build package only: `cd packages/x402-proxy && pnpm build`

## Key Files
- `src/app.ts` - Stricli route map, **contains versionInfo that must match package.json**
- `src/bin/cli.ts` - CLI entry point
- `src/lib/resolve-wallet.ts` - wallet resolution cascade (flags > env > mnemonic > file)
- `src/lib/derive.ts` - BIP-39 mnemonic derivation (Solana + EVM)
- `src/lib/config.ts` - XDG config dir, YAML/JSONC/JSON loading
- `src/handler.ts` - x402 payment handler (wraps fetch)
- `src/history.ts` - JSONL transaction history

## Wallet Resolution
1. `--evm-key` / `--solana-key` flags
2. `X402_PROXY_WALLET_EVM_KEY` / `X402_PROXY_WALLET_SOLANA_KEY` env vars
3. `X402_PROXY_WALLET_MNEMONIC` env var
4. `~/.config/x402-proxy/wallet.json` file

## Git
- Use [Conventional Commits](https://www.conventionalcommits.org/) for all commit messages
  - Format: `type(scope): description`
  - Types: feat, fix, docs, chore, refactor, test, ci
  - Examples: `feat(cli): add mcp proxy command`, `fix(wallet): handle missing config dir`

## Validation
```bash
pnpm check    # type-check + biome lint (from root)
pnpm build    # clean + tsdown --publint (via Turbo)
```

## Release Workflow

**Order: check -> build -> version bump -> changelog -> commit + tag + push -> ask user to publish -> verify -> GitHub release**

1. Run `pnpm check` and `pnpm build` (publint validates package) - stop on any failure
2. Bump version in both `packages/x402-proxy/package.json` and `packages/x402-proxy/src/app.ts` (Stricli `versionInfo.currentVersion`)
3. Update `packages/x402-proxy/CHANGELOG.md` (add new `## [<version>] - YYYY-MM-DD` section, add comparison link at bottom)
4. Commit, tag, and push:
   ```bash
   git add packages/x402-proxy/package.json packages/x402-proxy/src/app.ts packages/x402-proxy/CHANGELOG.md
   git commit -m "chore(release): bump to <version>"
   git tag v<version>
   git push && git push origin v<version>
   ```
5. **ASK THE USER to run `npm publish`** from `packages/x402-proxy/` (requires OTP authentication the agent cannot provide)
6. After publish, verify with `npm view x402-proxy@<version> bin`
7. Create GitHub release:
   ```bash
   gh release create v<version> --title "v<version>" --notes "$(cat <<'EOF'
   <paste relevant CHANGELOG section>
   EOF
   )"
   ```
