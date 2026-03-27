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

## Testing & Debugging

All commands run from the repo root. Always `pnpm build` first.

### CLI smoke test
```bash
# Direct HTTP request (single process, no concurrency concerns)
node packages/x402-proxy/dist/bin/cli.js -X POST -d '{"ref":"CoinbaseDev"}' https://surf.cascade.fyi/api/v1/twitter/user --network solana

# Wallet info
node packages/x402-proxy/dist/bin/cli.js wallet info
```

### MCP Inspector - interactive UI
```bash
# Start inspector (opens browser at localhost:6274)
npx @modelcontextprotocol/inspector \
  node packages/x402-proxy/dist/bin/cli.js mcp --network solana https://surf.cascade.fyi/mcp
```
Use the Tools tab to call tools manually (e.g. `surf_twitter_user` with `ref=cascade_fyi`).

### MCP Inspector - CLI mode
```bash
# List tools (no payment)
npx @modelcontextprotocol/inspector --cli \
  node packages/x402-proxy/dist/bin/cli.js mcp https://surf.cascade.fyi/mcp \
  --method tools/list

# Call a tool
npx @modelcontextprotocol/inspector --cli \
  node packages/x402-proxy/dist/bin/cli.js mcp --network solana https://surf.cascade.fyi/mcp \
  --method tools/call --tool-name surf_twitter_user --tool-arg ref=cascade_fyi
```

### MCP concurrency stress test via Inspector proxy

The Inspector proxy at `localhost:6277` exposes a Streamable HTTP endpoint. This lets you
fire concurrent requests through a **single MCP server process** - critical for testing
RPC coalescing and failover (which only work within one process, not across separate CLIs).

Auth header: `x-mcp-proxy-auth: Bearer <TOKEN>` (token printed at inspector startup).

```bash
TOKEN="<token from inspector startup>"

# 1. Create a session (spawns a new stdio MCP server behind the proxy)
curl -s -X POST "http://localhost:6277/mcp?transportType=stdio&command=node&args=dist/bin/cli.js%20mcp%20--network%20solana%20https://surf.cascade.fyi/mcp" \
  -H "Content-Type: application/json" \
  -H "x-mcp-proxy-auth: Bearer $TOKEN" \
  -H "Accept: application/json, text/event-stream" \
  -D /tmp/mcp-headers.txt \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"stress-test","version":"1.0.0"}}}'

# Extract session ID from response headers
SESSION=$(grep -i 'mcp-session-id' /tmp/mcp-headers.txt | tr -d '\r' | awk '{print $2}')

# 2. Fire N concurrent tool calls through the single server process
call() {
  local id=$1
  curl -s --max-time 120 -X POST "http://localhost:6277/mcp" \
    -H "Content-Type: application/json" \
    -H "x-mcp-proxy-auth: Bearer $TOKEN" \
    -H "mcp-session-id: $SESSION" \
    -H "Accept: application/json, text/event-stream" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":$id,\"method\":\"tools/call\",\"params\":{\"name\":\"surf_twitter_user\",\"arguments\":{\"ref\":\"cascade_fyi\"}}}"
}

# Fire 30 concurrent calls
for i in $(seq 1 30); do call $i & done
wait
```

**Key details:**
- Each CLI invocation is a separate process with its own RPC client - no coalescing across processes
- Coalescing + failover only help in single-process modes: MCP server, OpenClaw plugin
- The Inspector proxy routes all concurrent HTTP requests through one stdio MCP server process
- 429 errors from Solana RPC show as bare `"HTTP error (429)"` in MCP mode (no "Failed to create payment" wrapper)
- Use `surf.cascade.fyi/mcp` as the test endpoint (Solana payments)
