declare const __VERSION__: string;

import { buildCommand, type CommandContext } from "@stricli/core";
import { appendHistory, displayNetwork, type TxRecord } from "../history.js";
import { ensureConfigDir, getHistoryPath, loadConfig } from "../lib/config.js";
import { dim, error, warn } from "../lib/output.js";
import { buildX402Client, resolveWallet } from "../lib/resolve-wallet.js";

type McpFlags = {
  evmKey: string | undefined;
  solanaKey: string | undefined;
  network: string | undefined;
};

export const mcpCommand = buildCommand<McpFlags, [remoteUrl: string], CommandContext>({
  docs: {
    brief: "Start MCP stdio proxy with x402 payment",
    fullDescription: `Start an MCP stdio proxy with automatic x402 payment for AI agents.

Add to your MCP client config (Claude, Cursor, etc.):
  "command": "npx",
  "args": ["x402-proxy", "mcp", "https://mcp.example.com/sse"],
  "env": { "X402_PROXY_WALLET_MNEMONIC": "your 24 words" }`,
  },
  parameters: {
    flags: {
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
    },
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "Remote MCP server URL",
          parse: String,
        },
      ],
    },
  },
  async func(flags, remoteUrl: string) {
    // All output goes to stderr - stdout is the JSON-RPC protocol
    const wallet = resolveWallet({
      evmKey: flags.evmKey,
      solanaKey: flags.solanaKey,
    });

    if (wallet.source === "none") {
      error(
        "No wallet configured.\nRun:\n  $ npx x402-proxy setup\n\nOr set X402_PROXY_WALLET_MNEMONIC",
      );
      process.exit(1);
    }

    dim(`x402-proxy MCP proxy -> ${remoteUrl}`);
    if (wallet.evmAddress) dim(`  EVM:    ${wallet.evmAddress}`);
    if (wallet.solanaAddress) dim(`  Solana: ${wallet.solanaAddress}`);

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

    const x402PaymentClient = await buildX402Client(wallet, {
      preferredNetwork,
      network: flags.network,
      spendLimitDaily: config?.spendLimitDaily,
      spendLimitPerTx: config?.spendLimitPerTx,
    });

    // Dynamic imports to keep startup fast for non-MCP commands
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
    const { StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );
    const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const { x402MCPClient } = await import("@x402/mcp");

    // Connect to remote MCP server
    const remoteClient = new Client({ name: "x402-proxy", version: __VERSION__ });
    const x402Mcp = new x402MCPClient(remoteClient, x402PaymentClient, {
      autoPayment: true,
      onPaymentRequested: (ctx) => {
        const accept = ctx.paymentRequired.accepts?.[0];
        if (accept) {
          const amount = accept.amount ? (Number(accept.amount) / 1_000_000).toFixed(4) : "?";
          warn(
            `  Payment: ${amount} USDC on ${displayNetwork(accept.network)} for tool "${ctx.toolName}"`,
          );
        }
        return true;
      },
    });

    // Track payments
    x402Mcp.onAfterPayment(async (ctx) => {
      ensureConfigDir();
      const accepted = ctx.paymentPayload.accepted;
      const tx = ctx.settleResponse?.transaction;
      const record: TxRecord = {
        t: Date.now(),
        ok: true,
        kind: "x402_payment",
        net: accepted?.network ?? "unknown",
        from: wallet.evmAddress ?? wallet.solanaAddress ?? "unknown",
        to: accepted?.payTo,
        tx: typeof tx === "string" ? tx : undefined,
        amount: accepted?.amount ? Number(accepted.amount) / 1_000_000 : undefined,
        token: "USDC",
        label: `mcp:${ctx.toolName}`,
      };
      appendHistory(getHistoryPath(), record);
    });

    // Try StreamableHTTP first, fall back to SSE
    let connected = false;
    try {
      const transport = new StreamableHTTPClientTransport(new URL(remoteUrl));
      await x402Mcp.connect(transport);
      connected = true;
      dim("  Connected via StreamableHTTP");
    } catch {
      // StreamableHTTP not supported, try SSE
    }

    if (!connected) {
      try {
        const transport = new SSEClientTransport(new URL(remoteUrl));
        await x402Mcp.connect(transport);
        connected = true;
        dim("  Connected via SSE");
      } catch (err) {
        error(
          `Failed to connect to ${remoteUrl}: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }
    }

    // Discover remote capabilities
    let { tools } = await x402Mcp.listTools();
    dim(`  ${tools.length} tools available`);

    let remoteResources: Array<{
      name: string;
      uri: string;
      description?: string;
      mimeType?: string;
    }> = [];
    try {
      const res = await x402Mcp.listResources();
      remoteResources = res.resources;
      if (remoteResources.length > 0) dim(`  ${remoteResources.length} resources available`);
    } catch {
      dim("  Resources not available from remote");
    }

    // Create local server using low-level Server (not McpServer) to proxy
    // raw JSON Schemas verbatim without Zod conversion
    const localServer = new Server(
      { name: "x402-proxy", version: __VERSION__ },
      {
        capabilities: {
          tools: tools.length > 0 ? {} : undefined,
          resources: remoteResources.length > 0 ? {} : undefined,
        },
      },
    );

    const {
      ListToolsRequestSchema,
      CallToolRequestSchema,
      ListResourcesRequestSchema,
      ReadResourceRequestSchema,
      ToolListChangedNotificationSchema,
      ResourceListChangedNotificationSchema,
    } = await import("@modelcontextprotocol/sdk/types.js");

    localServer.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: t.annotations,
      })),
    }));

    localServer.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const result = await x402Mcp.callTool(name, args ?? {});
      return {
        content: result.content as Array<{ type: string; [key: string]: unknown }>,
        isError: result.isError,
      };
    });

    if (remoteResources.length > 0) {
      localServer.setRequestHandler(ListResourcesRequestSchema, async () => ({
        resources: remoteResources.map((r) => ({
          name: r.name,
          uri: r.uri,
          description: r.description,
          mimeType: r.mimeType,
        })),
      }));

      localServer.setRequestHandler(ReadResourceRequestSchema, async (request) => {
        const result = await x402Mcp.readResource({ uri: request.params.uri });
        return {
          contents: result.contents.map((c) => ({ ...c })),
        };
      });
    }

    // Forward remote list-change notifications so local clients stay in sync
    remoteClient.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      const updated = await x402Mcp.listTools();
      tools = updated.tools;
      dim(`  Tools updated: ${tools.length} available`);
      await localServer.notification({ method: "notifications/tools/list_changed" });
    });

    if (remoteResources.length > 0) {
      remoteClient.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
        const updated = await x402Mcp.listResources();
        remoteResources = updated.resources;
        dim(`  Resources updated: ${remoteResources.length} available`);
        await localServer.notification({ method: "notifications/resources/list_changed" });
      });
    }

    // Connect local server to stdio
    const stdioTransport = new StdioServerTransport();
    await localServer.connect(stdioTransport);

    dim("  MCP proxy running (stdio)");

    // Keep process alive until stdin closes
    process.stdin.on("end", async () => {
      await x402Mcp.close();
      process.exit(0);
    });
  },
});
