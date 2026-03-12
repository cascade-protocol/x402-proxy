import { buildCommand } from "@stricli/core";
import pc from "picocolors";
import { isConfigured, getHistoryPath, ensureConfigDir } from "../lib/config.js";
import { resolveWallet, buildX402Client } from "../lib/resolve-wallet.js";
import { error, info, isTTY, dim, warn } from "../lib/output.js";
import { createX402ProxyHandler, extractTxSignature } from "../handler.js";
import { appendHistory, type TxRecord } from "../history.js";

export const fetchCommand = buildCommand({
  docs: {
    brief: "Make a paid HTTP request (default command)",
  },
  parameters: {
    flags: {
      method: {
        kind: "parsed",
        brief: "HTTP method",
        parse: String,
        default: "GET",
        optional: true,
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
        // Delegate to status display
        const { statusCommand } = await import("./status.js");
        statusCommand.func.call(this, {});
      } else {
        console.log();
        console.log(pc.cyan("x402-proxy") + pc.dim(" - pay for any x402 resource"));
        console.log();
        console.log(pc.dim("  Get started:"));
        console.log(`    ${pc.cyan("x402-proxy setup")}          Create a wallet`);
        console.log(`    ${pc.cyan("x402-proxy <url>")}          Make a paid request`);
        console.log(`    ${pc.cyan("x402-proxy mcp <url>")}      MCP proxy for agents`);
        console.log(`    ${pc.cyan("x402-proxy wallet")}         Wallet info`);
        console.log(`    ${pc.cyan("x402-proxy --help")}         All commands`);
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

    const client = await buildX402Client(wallet);
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
