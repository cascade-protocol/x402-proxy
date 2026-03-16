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
- `src/app.ts` - Stricli route map (version injected via `__VERSION__` at build time)
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

## Version Management
- Version is defined ONLY in `packages/x402-proxy/package.json`
- `tsdown.config.ts` reads it and injects as `__VERSION__` at build time via `define`
- `src/app.ts` and `src/commands/mcp.ts` use `__VERSION__` - never hardcode version strings in source

## Release Workflow

**CRITICAL: Before saying "ready to release", run through EVERY item in this checklist. Do NOT skip any step.**

### Pre-release checklist (run through ALL before committing)
- [ ] `pnpm check` passes (type-check + biome)
- [ ] `pnpm build` passes (publint validates package)
- [ ] `pnpm --filter x402-proxy test` passes
- [ ] Version bumped in `packages/x402-proxy/package.json` (the ONLY place - __VERSION__ handles the rest)
- [ ] `CHANGELOG.md` updated: new `## [<version>] - YYYY-MM-DD` section with all changes since last release
- [ ] `CHANGELOG.md` comparison links updated at bottom of file
- [ ] README.md reflects any command/feature changes
- [ ] `skills/x402-proxy/SKILL.md` reflects any command/feature/URL changes (symlinked into npm package)
- [ ] No stale version strings anywhere in source (grep for old version number)

### Release steps
1. Commit and tag:
   ```bash
   git add -A
   git commit -m "feat(scope): descriptive summary of changes"
   git tag v<version>
   git push && git push origin v<version>
   ```
2. CI publishes automatically via `.github/workflows/publish.yml` (OIDC provenance, triggered on `v*` tags)
3. The publish workflow also auto-creates a GitHub release by extracting the matching version section from `CHANGELOG.md`
4. Verify: `npm view x402-proxy@<version> bin`

**Note:** Commit messages must describe the actual changes, not just "bump to X". Use conventional commit format with a meaningful summary.

## Testing CI Workflows

Use [act](https://github.com/nektos/act) to test GitHub Actions locally before pushing.

```bash
# Dry-run CI workflow
act -n --workflows .github/workflows/ci.yml -s GITHUB_TOKEN="$(gh auth token)"

# Dry-run publish workflow (simulating a tag push)
act -n --workflows .github/workflows/publish.yml \
  -e <(echo '{"ref":"refs/tags/v<version>"}') \
  -s GITHUB_TOKEN="$(gh auth token)"
```

Always dry-run with act after modifying workflow files to catch issues before pushing.
