import { buildCommand, type CommandContext } from "@stricli/core";
import type { PaymentRequired } from "@x402/fetch";
import pc from "picocolors";
import {
  createMppProxyHandler,
  createX402ProxyHandler,
  detectProtocols,
  extractTxSignature,
  type MppPaymentInfo,
  type PaymentInfo,
  TEMPO_NETWORK,
} from "../handler.js";
import {
  appendHistory,
  displayNetwork,
  formatAmount,
  formatUsdcValue,
  type TxRecord,
} from "../history.js";
import { getHistoryPath, isConfigured, loadConfig } from "../lib/config.js";
import { dim, error, info, isTTY } from "../lib/output.js";
import { buildX402Client, resolveWallet } from "../lib/resolve-wallet.js";

function isStreamingResponse(res: Response): boolean {
  return (res.headers.get("content-type") ?? "").includes("text/event-stream");
}

type FetchFlags = {
  method: string;
  body: string | undefined;
  header: string[] | undefined;
  evmKey: string | undefined;
  solanaKey: string | undefined;
  network: string | undefined;
  protocol: string | undefined;
  json: boolean;
  verbose: boolean;
};

export const fetchCommand = buildCommand<FetchFlags, [url?: string], CommandContext>({
  docs: {
    brief: "Make a paid HTTP request (default command)",
    fullDescription: `Make a paid HTTP request. Payment is automatic when the server returns 402.

Examples:
  $ x402-proxy -X POST -d '{"ref":"CoinbaseDev"}' https://surf.cascade.fyi/api/v1/twitter/user
  $ x402-proxy -X POST -d '{"url":"https://x402.org"}' https://surf.cascade.fyi/api/v1/web/crawl
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
        brief: "Require specific network (base, solana, tempo)",
        parse: String,
        optional: true,
      },
      protocol: {
        kind: "parsed",
        brief: "Payment protocol (x402, mpp)",
        parse: String,
        optional: true,
      },
      json: {
        kind: "boolean",
        brief: "Force JSON output",
        default: false,
      },
      verbose: {
        kind: "boolean",
        brief: "Show debug details (protocol negotiation, headers, payment flow)",
        default: false,
      },
    },
    aliases: {
      X: "method",
      d: "body",
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
    const verbose = (msg: string) => {
      if (flags.verbose) dim(`  [verbose] ${msg}`);
    };

    const closeMppSession = async (handler: Awaited<ReturnType<typeof createMppProxyHandler>>) => {
      verbose("closing MPP session...");
      try {
        await handler.close();
        verbose("session closed successfully");
      } catch (closeErr) {
        verbose(
          `session close failed: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}`,
        );
      }
    };

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
            pc.cyan(
              `$ npx x402-proxy -X POST -d '{"ref":"CoinbaseDev"}' https://surf.cascade.fyi/api/v1/twitter/user`,
            ),
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
    const resolvedProtocol = flags.protocol ?? config?.preferredProtocol;
    const maxDeposit = config?.mppSessionBudget ?? "1";
    verbose(`wallet source: ${wallet.source}`);
    verbose(`protocol: ${resolvedProtocol ?? "auto-detect"}, maxDeposit: ${maxDeposit}`);

    // Auto-detect preferred network based on balance when not configured
    let preferredNetwork = config?.defaultNetwork;
    if (!preferredNetwork && wallet.evmAddress && wallet.solanaAddress) {
      const { fetchAllBalances } = await import("./wallet.js");
      const balances = await fetchAllBalances(wallet.evmAddress, wallet.solanaAddress);
      const evmUsdc = balances.evm ? Number(balances.evm.usdc) : 0;
      const solUsdc = balances.sol ? Number(balances.sol.usdc) : 0;
      if (evmUsdc > solUsdc) {
        preferredNetwork = "base";
      } else if (solUsdc > evmUsdc) {
        preferredNetwork = "solana";
      }
    }

    // Build request
    const headers = new Headers();
    if (flags.header) {
      for (const h of flags.header) {
        const idx = h.indexOf(":");
        if (idx > 0) headers.set(h.slice(0, idx).trim(), h.slice(idx + 1).trim());
      }
    }

    const method = flags.method || "GET";
    // Auto-detect JSON body and set Content-Type if not explicitly provided
    if (flags.body && !headers.has("Content-Type")) {
      const trimmed = flags.body.trimStart();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        headers.set("Content-Type", "application/json");
      }
    }
    // Convert Headers to plain object so mppx SSE spread doesn't lose them
    const init: RequestInit = { method, headers: Object.fromEntries(headers.entries()) };
    if (flags.body) init.body = flags.body;

    if (isTTY()) {
      dim(`  ${method} ${parsedUrl.toString()}`);
    }

    const startMs = Date.now();
    let response: Response;
    let x402Payment: PaymentInfo | undefined;
    let mppPayment: MppPaymentInfo | undefined;
    let usedProtocol: "x402" | "mpp" | undefined;

    try {
      if (resolvedProtocol === "mpp") {
        // Explicit MPP - skip x402 entirely
        if (!wallet.evmKey) {
          error("MPP requires an EVM wallet. Configure one with: npx x402-proxy setup");
          process.exit(1);
        }

        const mppHandler = await createMppProxyHandler({
          evmKey: wallet.evmKey,
          maxDeposit,
        });

        // Detect SSE streaming requests - these need session.sse() for mid-stream voucher cycling
        const isStreamingRequest = flags.body != null && /"stream"\s*:\s*true/.test(flags.body);
        verbose(`mpp handler created, streaming: ${isStreamingRequest}`);

        if (isStreamingRequest) {
          try {
            verbose("opening SSE session...");
            const tokens = await mppHandler.sse(parsedUrl.toString(), init);
            verbose("SSE stream opened, reading tokens...");
            try {
              for await (const token of tokens) {
                process.stdout.write(token);
              }
            } catch (streamErr) {
              // Server may close connection after final SSE event (e.g. mppx 204 receipt bug).
              // Swallow "terminated" so payment/history logging still runs.
              const msg = streamErr instanceof Error ? streamErr.message : String(streamErr);
              verbose(`SSE stream error: ${msg}`);
              if (!msg.includes("terminated")) throw streamErr;
            }
            verbose("SSE stream complete");
          } finally {
            await closeMppSession(mppHandler);
          }

          // SSE open pushes an intent-only entry; close pushes the actual receipt
          mppHandler.shiftPayment();
          const closeReceipt = mppHandler.shiftPayment();
          verbose(
            closeReceipt
              ? `close receipt: amount=${closeReceipt.amount ?? "none"}, channelId=${closeReceipt.channelId ?? "none"}, txHash=${closeReceipt.receipt?.txHash ?? "none"}`
              : "no close receipt (session close may have failed)",
          );
          mppPayment = closeReceipt ?? {
            protocol: "mpp",
            network: TEMPO_NETWORK,
            intent: "session",
          };
          usedProtocol = "mpp";

          const elapsedMs = Date.now() - startMs;
          const spentAmount = mppPayment.amount ? Number(mppPayment.amount) : undefined;
          if (isTTY()) process.stderr.write("\n");
          if (mppPayment && isTTY()) {
            const mppAmount = spentAmount != null ? ` ${formatAmount(spentAmount, "USDC")}` : "";
            info(`  Payment:${mppAmount} MPP (${displayNetwork(mppPayment.network)})`);
          }
          if (isTTY()) {
            dim(`  Streamed (${elapsedMs}ms)`);
          }

          if (mppPayment) {
            const record: TxRecord = {
              t: Date.now(),
              ok: true,
              kind: "mpp_payment",
              net: mppPayment.network,
              from: wallet.evmAddress ?? "unknown",
              tx: mppPayment.receipt?.reference ?? mppPayment.channelId,
              amount: spentAmount,
              token: "USDC",
              ms: elapsedMs,
              label: parsedUrl.hostname,
            };
            appendHistory(getHistoryPath(), record);
          }

          if (isTTY()) process.stdout.write("\n");
          return;
        }

        // Non-streaming MPP request
        verbose("sending non-streaming MPP request...");
        try {
          response = await mppHandler.fetch(parsedUrl.toString(), init);
          verbose(`response: ${response.status} ${response.statusText}`);
        } finally {
          await closeMppSession(mppHandler);
        }
        mppPayment = mppHandler.shiftPayment();
        usedProtocol = "mpp";
      } else if (resolvedProtocol === "x402") {
        // Explicit x402
        const client = await buildX402Client(wallet, {
          preferredNetwork,
          network: flags.network,
          spendLimitDaily: config?.spendLimitDaily,
          spendLimitPerTx: config?.spendLimitPerTx,
        });
        const handler = createX402ProxyHandler({ client });
        response = await handler.x402Fetch(parsedUrl.toString(), init);
        x402Payment = handler.shiftPayment();
        usedProtocol = "x402";
      } else {
        // Auto-detect: try x402 first, fall through to MPP if needed
        const client = await buildX402Client(wallet, {
          preferredNetwork,
          network: flags.network,
          spendLimitDaily: config?.spendLimitDaily,
          spendLimitPerTx: config?.spendLimitPerTx,
        });
        const handler = createX402ProxyHandler({ client });
        response = await handler.x402Fetch(parsedUrl.toString(), init);
        x402Payment = handler.shiftPayment();
        usedProtocol = "x402";

        // If x402 couldn't handle it and server advertises MPP, fall through
        if (response.status === 402 && wallet.evmKey) {
          const detected = detectProtocols(response);
          verbose(`auto-detect: x402=${detected.x402}, mpp=${detected.mpp}`);
          if (detected.mpp) {
            verbose("falling through to MPP...");
            const mppHandler = await createMppProxyHandler({
              evmKey: wallet.evmKey,
              maxDeposit,
            });
            try {
              response = await mppHandler.fetch(parsedUrl.toString(), init);
              verbose(`MPP response: ${response.status} ${response.statusText}`);
            } finally {
              await closeMppSession(mppHandler);
            }
            mppPayment = mppHandler.shiftPayment();
            x402Payment = undefined;
            usedProtocol = "mpp";
          }
        }
      }
    } catch (err) {
      error(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    const elapsedMs = Date.now() - startMs;

    const payment = x402Payment ?? mppPayment;
    const txSig = extractTxSignature(response);

    verbose(`protocol used: ${usedProtocol ?? "none"}`);
    for (const [k, v] of response.headers) {
      if (/payment|auth|www|x-pay/i.test(k)) verbose(`header ${k}: ${v.slice(0, 200)}`);
    }

    // Non-402 error: tell user whether payment was attempted
    if (!response.ok && response.status !== 402 && isTTY()) {
      if (!payment) {
        dim("  Server returned error before payment was attempted.");
      } else {
        dim("  Payment was processed but server returned an error.");
      }
    }

    // Payment failed - check balances and show appropriate message
    if (response.status === 402 && isTTY()) {
      const detected = detectProtocols(response);

      // Parse x402 challenge details
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
        costStr = formatUsdcValue(costNum);
      }

      const hasEvm = accepts.some((a) => a.network.startsWith("eip155:"));
      const hasSolana = accepts.some((a) => a.network.startsWith("solana:"));
      const hasMpp = detected.mpp;
      const hasOther = accepts.some(
        (a) => !a.network.startsWith("eip155:") && !a.network.startsWith("solana:"),
      );

      // Check on-chain balances to give actionable feedback
      const { fetchAllBalances } = await import("./wallet.js");
      const balances = await fetchAllBalances(wallet.evmAddress, wallet.solanaAddress);
      const evmUsdc = hasEvm && balances.evm ? Number(balances.evm.usdc) : 0;
      const solUsdc = hasSolana && balances.sol ? Number(balances.sol.usdc) : 0;
      const tempoUsdc = hasMpp && balances.tempo ? Number(balances.tempo.usdc) : 0;

      const hasSufficientBalance =
        (hasEvm && evmUsdc >= costNum) ||
        (hasSolana && solUsdc >= costNum) ||
        (hasMpp && tempoUsdc >= costNum);

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
            `    Base:   ${pc.cyan(wallet.evmAddress)} ${pc.dim(`(${formatAmount(evmUsdc, "USDC")})`)}`,
          );
        }
        if (hasMpp && wallet.evmAddress && tempoUsdc > 0) {
          console.error(
            `    Tempo:  ${pc.cyan(wallet.evmAddress)} ${pc.dim(`(${formatAmount(tempoUsdc, "USDC")})`)}`,
          );
        }
        if (hasSolana && wallet.solanaAddress && solUsdc > 0) {
          console.error(
            `    Solana: ${pc.cyan(wallet.solanaAddress)} ${pc.dim(`(${formatAmount(solUsdc, "USDC")})`)}`,
          );
        }
        console.error();
        dim("  This may be a temporary server-side issue. Try again in a moment.");
        console.error();
      } else {
        // Insufficient balance
        error(`Payment required: ${costStr} USDC`);

        if (hasEvm || hasSolana || hasMpp) {
          console.error();
          dim("  Fund your wallet with USDC:");
          if (hasEvm && wallet.evmAddress) {
            const balHint = evmUsdc > 0 ? pc.dim(` (${formatAmount(evmUsdc, "USDC")})`) : "";
            console.error(`    Base:   ${pc.cyan(wallet.evmAddress)}${balHint}`);
          }
          if (hasMpp && wallet.evmAddress) {
            const balHint = tempoUsdc > 0 ? pc.dim(` (${formatAmount(tempoUsdc, "USDC")})`) : "";
            console.error(`    Tempo:  ${pc.cyan(wallet.evmAddress)}${balHint}`);
          }
          if (hasSolana && wallet.solanaAddress) {
            const balHint = solUsdc > 0 ? pc.dim(` (${formatAmount(solUsdc, "USDC")})`) : "";
            console.error(`    Solana: ${pc.cyan(wallet.solanaAddress)}${balHint}`);
          }
          if (hasEvm && !wallet.evmAddress) {
            dim("    Base:   endpoint accepts EVM but no EVM wallet configured");
          }
          if (hasMpp && !wallet.evmAddress) {
            dim("    Tempo:  endpoint accepts MPP but no EVM wallet configured");
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
      if (usedProtocol === "mpp" && mppPayment) {
        const mppAmount = mppPayment.amount
          ? ` ${formatAmount(Number(mppPayment.amount), "USDC")}`
          : "";
        info(`  Payment:${mppAmount} MPP (${displayNetwork(mppPayment.network)})`);
      } else if (x402Payment) {
        const x402Amount = x402Payment.amount
          ? formatAmount(Number(x402Payment.amount) / 1_000_000, "USDC")
          : "? USDC";
        info(`  Payment: ${x402Amount} (${displayNetwork(x402Payment.network ?? "unknown")})`);
      }
      if (txSig) dim(`  Tx: ${txSig}`);
    }

    if (isTTY()) {
      const statusText = `  ${response.status} ${response.statusText} (${elapsedMs}ms)`;
      const colorFn = response.status < 300 ? pc.green : response.status < 400 ? pc.yellow : pc.red;
      process.stderr.write(`${colorFn(statusText)}\n`);
    }

    // Record payment in history
    if (x402Payment) {
      const record: TxRecord = {
        t: Date.now(),
        ok: response.ok,
        kind: "x402_payment",
        net: x402Payment.network ?? "unknown",
        from: wallet.evmAddress ?? wallet.solanaAddress ?? "unknown",
        to: x402Payment.payTo,
        tx: txSig,
        amount: x402Payment.amount ? Number(x402Payment.amount) / 1_000_000 : undefined,
        token: "USDC",
        ms: elapsedMs,
        label: parsedUrl.hostname,
      };
      appendHistory(getHistoryPath(), record);
    } else if (mppPayment) {
      const record: TxRecord = {
        t: Date.now(),
        ok: response.ok,
        kind: "mpp_payment",
        net: mppPayment.network,
        from: wallet.evmAddress ?? "unknown",
        tx: mppPayment.receipt?.reference ?? txSig,
        amount: mppPayment.amount ? Number(mppPayment.amount) : undefined,
        token: "USDC",
        ms: elapsedMs,
        label: parsedUrl.hostname,
      };
      appendHistory(getHistoryPath(), record);
    }

    // Stream response body to stdout
    const isJsonResponse = (response.headers.get("content-type") ?? "").includes(
      "application/json",
    );
    const shouldPrettyPrint =
      isJsonResponse && (flags.json || isTTY()) && !isStreamingResponse(response);
    if (response.body) {
      if (shouldPrettyPrint) {
        const text = await response.text();
        try {
          process.stdout.write(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
        } catch {
          process.stdout.write(text);
          if (isTTY()) process.stdout.write("\n");
        }
      } else {
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
        if (isTTY()) process.stdout.write("\n");
      }
    }
  },
});
