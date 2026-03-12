import { buildCommand, type CommandContext } from "@stricli/core";
import pc from "picocolors";
import { createX402ProxyHandler, extractTxSignature } from "../handler.js";
import { appendHistory, type TxRecord } from "../history.js";
import { ensureConfigDir, getHistoryPath, isConfigured, loadConfig } from "../lib/config.js";
import { dim, error, info, isTTY } from "../lib/output.js";
import { buildX402Client, resolveWallet } from "../lib/resolve-wallet.js";

type FetchFlags = {
  method: string;
  body: string | undefined;
  header: string[] | undefined;
  evmKey: string | undefined;
  solanaKey: string | undefined;
  json: boolean;
};

export const fetchCommand = buildCommand<FetchFlags, [url?: string], CommandContext>({
  docs: {
    brief: "Make a paid HTTP request (default command)",
    fullDescription: `Make a paid HTTP request. Payment is automatic when the server returns 402.

Examples:
  $ x402-proxy https://twitter.surf.cascade.fyi/user/cascade_fyi
  $ x402-proxy -X POST -d '{"url":"https://x402.org"}' https://web.surf.cascade.fyi/v1/crawl
  $ x402-proxy https://api.example.com/data | jq '.results'`,
  },
  parameters: {
    flags: {
      method: {
        kind: "parsed",
        brief: "HTTP method",
        parse: String,
        default: "GET",
      },
      body: {
        kind: "parsed",
        brief: "Request body",
        parse: String,
        optional: true,
      },
      header: {
        kind: "parsed",
        brief: "HTTP header (Key: Value), repeatable",
        parse: String,
        variadic: true,
        optional: true,
      },
      evmKey: {
        kind: "parsed",
        brief: "EVM private key (hex)",
        parse: String,
        optional: true,
      },
      solanaKey: {
        kind: "parsed",
        brief: "Solana private key (base58)",
        parse: String,
        optional: true,
      },
      json: {
        kind: "boolean",
        brief: "Force JSON output",
        default: false,
      },
    },
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "URL to request",
          parse: String,
          optional: true,
        },
      ],
    },
  },
  async func(flags, url?: string) {
    // No URL: show status or onboarding
    if (!url) {
      if (isConfigured()) {
        const { displayStatus } = await import("./status.js");
        await displayStatus();

        console.log();
        console.log(pc.dim("  Commands:"));
        console.log(`    ${pc.cyan("$ npx x402-proxy <url>")}              Fetch a paid API`);
        console.log(
          `    ${pc.cyan("$ npx x402-proxy mcp <url>")}          MCP proxy for AI agents`,
        );
        console.log(`    ${pc.cyan("$ npx x402-proxy setup")}              Reconfigure wallet`);
        console.log(`    ${pc.cyan("$ npx x402-proxy wallet")}             Addresses and balances`);
        console.log(`    ${pc.cyan("$ npx x402-proxy wallet history")}     Full payment history`);
        console.log(`    ${pc.cyan("$ npx x402-proxy wallet fund")}        Funding instructions`);
        console.log();
        console.log(
          pc.dim("  try: ") +
            pc.cyan("$ npx x402-proxy https://twitter.surf.cascade.fyi/user/cascade_fyi"),
        );
        console.log();
        console.log(pc.dim("  https://github.com/cascade-protocol/x402-proxy"));
        console.log();
      } else {
        console.log();
        console.log(pc.cyan(pc.bold("x402-proxy")));
        console.log(pc.dim("curl for x402 paid APIs"));
        console.log();
        console.log(pc.dim("  Commands:"));
        console.log(`    ${pc.cyan("$ npx x402-proxy setup")}              Create a wallet`);
        console.log(`    ${pc.cyan("$ npx x402-proxy <url>")}              Fetch a paid API`);
        console.log(
          `    ${pc.cyan("$ npx x402-proxy mcp <url>")}          MCP proxy for AI agents`,
        );
        console.log(`    ${pc.cyan("$ npx x402-proxy wallet")}             Addresses and balances`);
        console.log(`    ${pc.cyan("$ npx x402-proxy wallet history")}     Payment history`);
        console.log(`    ${pc.cyan("$ npx x402-proxy wallet fund")}        Funding instructions`);
        console.log(`    ${pc.cyan("$ npx x402-proxy --help")}             All options`);
        console.log();
        console.log(pc.dim("  try: ") + pc.cyan("$ npx x402-proxy setup"));
        console.log();
        console.log(pc.dim("  https://github.com/cascade-protocol/x402-proxy"));
        console.log();
      }
      return;
    }

    // Validate URL
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      error(`Invalid URL: ${url}`);
      process.exit(1);
    }

    // Resolve wallet
    const wallet = resolveWallet({
      evmKey: flags.evmKey,
      solanaKey: flags.solanaKey,
    });
    if (wallet.source === "none") {
      error("No wallet configured.");
      console.error(pc.dim(`Run ${pc.cyan("x402-proxy setup")} or set X402_PROXY_WALLET_MNEMONIC`));
      process.exit(1);
    }

    const config = loadConfig();
    const client = await buildX402Client(wallet, {
      preferredNetwork: config?.defaultNetwork,
      spendLimitDaily: config?.spendLimitDaily,
      spendLimitPerTx: config?.spendLimitPerTx,
    });
    const { x402Fetch, shiftPayment } = createX402ProxyHandler({ client });

    // Build request
    const headers = new Headers();
    if (flags.header) {
      for (const h of flags.header) {
        const idx = h.indexOf(":");
        if (idx > 0) headers.set(h.slice(0, idx).trim(), h.slice(idx + 1).trim());
      }
    }

    const method = flags.method || "GET";
    const init: RequestInit = { method, headers };
    if (flags.body) init.body = flags.body;

    if (isTTY()) {
      dim(`  ${method} ${parsedUrl.toString()}`);
    }

    const startMs = Date.now();
    let response: Response;
    try {
      response = await x402Fetch(parsedUrl.toString(), init);
    } catch (err) {
      error(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    const elapsedMs = Date.now() - startMs;

    // Check if payment was made
    const payment = shiftPayment();
    const txSig = extractTxSignature(response);

    if (payment && isTTY()) {
      info(`  Payment: ${payment.amount ?? "?"} (${payment.network ?? "unknown"})`);
      if (txSig) dim(`  Tx: ${txSig}`);
    }

    if (isTTY()) {
      dim(`  ${response.status} ${response.statusText} (${elapsedMs}ms)`);
    }

    // Record payment in history
    if (payment) {
      ensureConfigDir();
      const record: TxRecord = {
        t: Date.now(),
        ok: response.ok,
        kind: "x402_payment",
        net: payment.network ?? "unknown",
        from: wallet.evmAddress ?? wallet.solanaAddress ?? "unknown",
        to: payment.payTo,
        tx: txSig,
        amount: payment.amount ? Number(payment.amount) / 1_000_000 : undefined,
        token: "USDC",
        ms: elapsedMs,
        label: parsedUrl.hostname,
      };
      appendHistory(getHistoryPath(), record);
    }

    // Stream response body to stdout
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          process.stdout.write(value);
        }
      } finally {
        reader.releaseLock();
      }
    }

    // Trailing newline for TTY
    if (isTTY() && response.body) {
      process.stdout.write("\n");
    }
  },
});
