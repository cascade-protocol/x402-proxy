import { buildCommand, type CommandContext } from "@stricli/core";
import type { PaymentRequired } from "@x402/fetch";
import pc from "picocolors";
import { createX402ProxyHandler, extractTxSignature } from "../handler.js";
import { appendHistory, displayNetwork, type TxRecord } from "../history.js";
import { ensureConfigDir, getHistoryPath, isConfigured, loadConfig } from "../lib/config.js";
import { dim, error, info, isTTY } from "../lib/output.js";
import { buildX402Client, resolveWallet } from "../lib/resolve-wallet.js";

type FetchFlags = {
  method: string;
  body: string | undefined;
  header: string[] | undefined;
  evmKey: string | undefined;
  solanaKey: string | undefined;
  network: string | undefined;
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
      network: {
        kind: "parsed",
        brief: "Require specific network (base, solana)",
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

    // Resolve wallet - auto-setup on first use
    let wallet = resolveWallet({
      evmKey: flags.evmKey,
      solanaKey: flags.solanaKey,
    });
    if (wallet.source === "none") {
      if (!isTTY()) {
        error("No wallet configured.");
        console.error(
          pc.dim(
            `Run:\n  ${pc.cyan("$ npx x402-proxy setup")}\n\nOr set X402_PROXY_WALLET_MNEMONIC`,
          ),
        );
        process.exit(1);
      }
      dim("  No wallet found. Let's set one up first.\n");
      const { runSetup } = await import("./setup.js");
      await runSetup();
      console.log();
      wallet = resolveWallet();
      if (wallet.source === "none") {
        return;
      }
    }

    const config = loadConfig();

    // Auto-detect preferred network based on balance when not configured
    let preferredNetwork = config?.defaultNetwork;
    if (!preferredNetwork && wallet.evmAddress && wallet.solanaAddress) {
      const { fetchEvmBalances, fetchSolanaBalances } = await import("./wallet.js");
      const [evmBal, solBal] = await Promise.allSettled([
        fetchEvmBalances(wallet.evmAddress),
        fetchSolanaBalances(wallet.solanaAddress),
      ]);
      const evmUsdc = evmBal.status === "fulfilled" ? Number(evmBal.value?.usdc ?? 0) : 0;
      const solUsdc = solBal.status === "fulfilled" ? Number(solBal.value?.usdc ?? 0) : 0;
      if (evmUsdc > solUsdc) {
        preferredNetwork = "base";
      } else if (solUsdc > evmUsdc) {
        preferredNetwork = "solana";
      }
    }

    const client = await buildX402Client(wallet, {
      preferredNetwork,
      network: flags.network,
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

    // Payment failed - check balances and show appropriate message
    if (response.status === 402 && isTTY()) {
      const prHeader =
        response.headers.get("PAYMENT-REQUIRED") ?? response.headers.get("X-PAYMENT-REQUIRED");
      let accepts: PaymentRequired["accepts"] = [];
      if (prHeader) {
        try {
          const decoded = JSON.parse(Buffer.from(prHeader, "base64").toString()) as PaymentRequired;
          accepts = decoded.accepts ?? [];
        } catch {
          // Fall through with empty accepts
        }
      }

      let costNum = 0;
      let costStr = "?";
      if (accepts.length > 0) {
        const cheapest = accepts.reduce((min, a) =>
          Number(a.amount) < Number(min.amount) ? a : min,
        );
        costNum = Number(cheapest.amount) / 1_000_000;
        costStr = costNum.toFixed(4);
      }

      const hasEvm = accepts.some((a) => a.network.startsWith("eip155:"));
      const hasSolana = accepts.some((a) => a.network.startsWith("solana:"));
      const hasOther = accepts.some(
        (a) => !a.network.startsWith("eip155:") && !a.network.startsWith("solana:"),
      );

      // Check on-chain balances to give actionable feedback
      const { fetchEvmBalances, fetchSolanaBalances } = await import("./wallet.js");
      let evmUsdc = 0;
      let solUsdc = 0;
      if (hasEvm && wallet.evmAddress) {
        try {
          const bal = await fetchEvmBalances(wallet.evmAddress);
          evmUsdc = Number(bal.usdc);
        } catch {
          // Network error - fall through with 0
        }
      }
      if (hasSolana && wallet.solanaAddress) {
        try {
          const bal = await fetchSolanaBalances(wallet.solanaAddress);
          solUsdc = Number(bal.usdc);
        } catch {
          // Network error - fall through with 0
        }
      }

      const hasSufficientBalance =
        (hasEvm && evmUsdc >= costNum) || (hasSolana && solUsdc >= costNum);

      if (hasSufficientBalance) {
        // Balance is sufficient but payment failed - read server error
        let serverReason: string | undefined;
        try {
          const body = await response.text();
          if (body) {
            const parsed = JSON.parse(body) as { error?: string; message?: string };
            serverReason = parsed.error || parsed.message;
          }
        } catch {
          // Not JSON or no body
        }

        error(`Payment failed: ${costStr} USDC`);
        console.error();
        if (payment) {
          dim("  Payment was signed and sent but rejected by the server.");
        } else {
          dim("  Payment was not attempted despite sufficient balance.");
        }
        if (serverReason) {
          dim(`  Reason: ${serverReason}`);
        }
        if (hasEvm && wallet.evmAddress && evmUsdc > 0) {
          console.error(
            `    Base:   ${pc.cyan(wallet.evmAddress)} ${pc.dim(`(${evmUsdc.toFixed(4)} USDC)`)}`,
          );
        }
        if (hasSolana && wallet.solanaAddress && solUsdc > 0) {
          console.error(
            `    Solana: ${pc.cyan(wallet.solanaAddress)} ${pc.dim(`(${solUsdc.toFixed(4)} USDC)`)}`,
          );
        }
        console.error();
        dim("  This may be a temporary server-side issue. Try again in a moment.");
        console.error();
      } else {
        // Insufficient balance
        error(`Payment required: ${costStr} USDC`);

        if (hasEvm || hasSolana) {
          console.error();
          dim("  Fund your wallet with USDC:");
          if (hasEvm && wallet.evmAddress) {
            const balHint = evmUsdc > 0 ? pc.dim(` (${evmUsdc.toFixed(4)} USDC)`) : "";
            console.error(`    Base:   ${pc.cyan(wallet.evmAddress)}${balHint}`);
          }
          if (hasSolana && wallet.solanaAddress) {
            const balHint = solUsdc > 0 ? pc.dim(` (${solUsdc.toFixed(4)} USDC)`) : "";
            console.error(`    Solana: ${pc.cyan(wallet.solanaAddress)}${balHint}`);
          }
          if (hasEvm && !wallet.evmAddress) {
            dim("    Base:   endpoint accepts EVM but no EVM wallet configured");
          }
          if (hasSolana && !wallet.solanaAddress) {
            dim("    Solana: endpoint accepts Solana but no Solana wallet configured");
          }
        } else if (hasOther) {
          const networks = [...new Set(accepts.map((a) => a.network))].join(", ");
          console.error();
          error(`This endpoint only accepts payment on unsupported networks: ${networks}`);
        }

        console.error();
        dim("  Then re-run:");
        console.error(`    ${pc.cyan(`$ npx x402-proxy ${url}`)}`);
        console.error();
      }
      return;
    }

    if (payment && isTTY()) {
      info(
        `  Payment: ${payment.amount ? (Number(payment.amount) / 1_000_000).toFixed(4) : "?"} USDC (${displayNetwork(payment.network ?? "unknown")})`,
      );
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
