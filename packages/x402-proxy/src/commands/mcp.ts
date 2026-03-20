declare const __VERSION__: string;

import { buildCommand, type CommandContext } from "@stricli/core";
import { TEMPO_NETWORK } from "../handler.js";
import { appendHistory, displayNetwork, type TxRecord } from "../history.js";
import { getHistoryPath, loadConfig } from "../lib/config.js";
import { dim, error, warn } from "../lib/output.js";
import { buildX402Client, resolveWallet } from "../lib/resolve-wallet.js";

type McpFlags = {
  evmKey: string | undefined;
  solanaKey: string | undefined;
  network: string | undefined;
  protocol: string | undefined;
};

export const mcpCommand = buildCommand<McpFlags, [remoteUrl: string], CommandContext>({
  docs: {
    brief: "Start MCP stdio proxy with automatic payment",
    fullDescription: `Start an MCP stdio proxy with automatic payment (x402 or MPP) for AI agents.

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
    const resolvedProtocol = flags.protocol ?? config?.preferredProtocol ?? "x402";

    // Dynamic imports to keep startup fast for non-MCP commands
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
    const { StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );
    const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");

    const {
      ListToolsRequestSchema,
      CallToolRequestSchema,
      ListResourcesRequestSchema,
      ReadResourceRequestSchema,
      ToolListChangedNotificationSchema,
      ResourceListChangedNotificationSchema,
    } = await import("@modelcontextprotocol/sdk/types.js");

    async function connectTransport(target: { connect(t: unknown): Promise<void> }) {
      try {
        const transport = new StreamableHTTPClientTransport(new URL(remoteUrl));
        await target.connect(transport);
        dim("  Connected via StreamableHTTP");
        return;
      } catch {
        // StreamableHTTP not supported, try SSE
      }
      try {
        const transport = new SSEClientTransport(new URL(remoteUrl));
        await target.connect(transport);
        dim("  Connected via SSE");
      } catch (err) {
        error(
          `Failed to connect to ${remoteUrl}: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }
    }

    if (resolvedProtocol === "mpp") {
      await startMppProxy();
    } else {
      await startX402Proxy();
    }

    async function startX402Proxy() {
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

      const x402PaymentClient = await buildX402Client(wallet, {
        preferredNetwork,
        network: flags.network,
        spendLimitDaily: config?.spendLimitDaily,
        spendLimitPerTx: config?.spendLimitPerTx,
      });

      const { x402MCPClient } = await import("@x402/mcp");

      // Connect to remote MCP server
      const remoteClient = new Client({ name: "x402-proxy", version: __VERSION__ });
      // x402MCPClient expects Client resolved with zod@3 (via @x402/mcp),
      // but ours resolves with zod@4 (via mppx). Structurally identical.
      const x402Mcp = new x402MCPClient(
        remoteClient as unknown as ConstructorParameters<typeof x402MCPClient>[0],
        x402PaymentClient,
        {
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
        },
      );

      // Track payments
      x402Mcp.onAfterPayment(async (ctx) => {
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

      await connectTransport(x402Mcp);

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

      const localServer = new Server(
        { name: "x402-proxy", version: __VERSION__ },
        {
          capabilities: {
            tools: tools.length > 0 ? {} : undefined,
            resources: remoteResources.length > 0 ? {} : undefined,
          },
        },
      );

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

      // Forward remote list-change notifications
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

      dim("  MCP proxy running (stdio, x402)");

      let closing = false;
      const cleanup = async () => {
        if (closing) return;
        closing = true;
        await x402Mcp.close();
        process.exit(0);
      };
      process.stdin.on("end", cleanup);
      process.on("SIGINT", cleanup);
      process.on("SIGTERM", cleanup);
    }

    async function startMppProxy() {
      if (!wallet.evmKey) {
        error("MPP requires an EVM wallet. Configure one with: npx x402-proxy setup");
        process.exit(1);
      }

      const { tempo } = await import("mppx/client");
      const { McpClient } = await import("mppx/mcp-sdk/client");
      const { privateKeyToAccount } = await import("viem/accounts");

      const account = privateKeyToAccount(wallet.evmKey as `0x${string}`);
      const maxDeposit = config?.mppSessionBudget ?? "1";

      // Connect base client to remote MCP server
      const remoteClient = new Client({ name: "x402-proxy", version: __VERSION__ });

      await connectTransport(remoteClient);

      // McpClient expects Client resolved with zod@3 (via mppx's own SDK copy),
      // but ours resolves with zod@4. Structurally identical.
      const mppClient = McpClient.wrap(
        remoteClient as unknown as Parameters<typeof McpClient.wrap>[0],
        { methods: [tempo({ account, maxDeposit })] },
      );

      // Discover remote capabilities via base client
      let { tools } = await remoteClient.listTools();
      dim(`  ${tools.length} tools available`);

      let remoteResources: Array<{
        name: string;
        uri: string;
        description?: string;
        mimeType?: string;
      }> = [];
      try {
        const res = await remoteClient.listResources();
        remoteResources = res.resources;
        if (remoteResources.length > 0) dim(`  ${remoteResources.length} resources available`);
      } catch {
        dim("  Resources not available from remote");
      }

      const localServer = new Server(
        { name: "x402-proxy", version: __VERSION__ },
        {
          capabilities: {
            tools: tools.length > 0 ? {} : undefined,
            resources: remoteResources.length > 0 ? {} : undefined,
          },
        },
      );

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
        const result = await mppClient.callTool({ name, arguments: args ?? {} });

        // Record MPP payment if receipt present
        if (result.receipt) {
          const record: TxRecord = {
            t: Date.now(),
            ok: true,
            kind: "mpp_payment",
            net: TEMPO_NETWORK,
            from: wallet.evmAddress ?? "unknown",
            tx: result.receipt.reference,
            token: "USDC",
            label: `mcp:${name}`,
          };
          appendHistory(getHistoryPath(), record);
          warn(`  MPP payment for tool "${name}" (Tempo)`);
        }

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
          const result = await remoteClient.readResource({ uri: request.params.uri });
          return {
            contents: result.contents.map((c) => ({ ...c })),
          };
        });
      }

      // Forward remote list-change notifications
      remoteClient.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        const updated = await remoteClient.listTools();
        tools = updated.tools;
        dim(`  Tools updated: ${tools.length} available`);
        await localServer.notification({ method: "notifications/tools/list_changed" });
      });

      if (remoteResources.length > 0) {
        remoteClient.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
          const updated = await remoteClient.listResources();
          remoteResources = updated.resources;
          dim(`  Resources updated: ${remoteResources.length} available`);
          await localServer.notification({ method: "notifications/resources/list_changed" });
        });
      }

      // Connect local server to stdio
      const stdioTransport = new StdioServerTransport();
      await localServer.connect(stdioTransport);

      dim("  MCP proxy running (stdio, mpp)");

      let closing = false;
      const cleanup = async () => {
        if (closing) return;
        closing = true;
        await remoteClient.close();
        process.exit(0);
      };
      process.stdin.on("end", cleanup);
      process.on("SIGINT", cleanup);
      process.on("SIGTERM", cleanup);
    }
  },
});
