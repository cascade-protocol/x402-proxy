import { buildCommand, type CommandContext } from "@stricli/core";
import { appendHistory, type TxRecord } from "../history.js";
import { ensureConfigDir, getHistoryPath } from "../lib/config.js";
import { dim, error, warn } from "../lib/output.js";
import { buildX402Client, resolveWallet } from "../lib/resolve-wallet.js";

type McpFlags = {
  evmKey: string | undefined;
  solanaKey: string | undefined;
};

export const mcpCommand = buildCommand<McpFlags, [remoteUrl: string], CommandContext>({
  docs: {
    brief: "Start MCP stdio proxy with x402 payment (alpha)",
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
      error("No wallet configured. Set X402_PROXY_WALLET_MNEMONIC or run x402-proxy setup.");
      process.exit(1);
    }

    warn("Note: MCP proxy is alpha - please report issues.");
    dim(`x402-proxy MCP proxy -> ${remoteUrl}`);
    if (wallet.evmAddress) dim(`  EVM:    ${wallet.evmAddress}`);
    if (wallet.solanaAddress) dim(`  Solana: ${wallet.solanaAddress}`);

    const x402PaymentClient = await buildX402Client(wallet);

    // Dynamic imports to keep startup fast for non-MCP commands
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
    const { StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const { x402MCPClient } = await import("@x402/mcp");

    // Connect to remote MCP server
    const remoteClient = new Client({ name: "x402-proxy", version: "0.2.0" });
    const x402Mcp = new x402MCPClient(remoteClient, x402PaymentClient, {
      autoPayment: true,
      onPaymentRequested: (ctx) => {
        const accept = ctx.paymentRequired.accepts?.[0];
        if (accept) {
          warn(`  Payment: ${accept.amount} on ${accept.network} for tool "${ctx.toolName}"`);
        }
        return true;
      },
    });

    // Track payments
    x402Mcp.onAfterPayment(async (ctx) => {
      ensureConfigDir();
      const tx = ctx.settleResponse?.transaction;
      const accept = ctx.paymentPayload;
      const record: TxRecord = {
        t: Date.now(),
        ok: true,
        kind: "x402_payment",
        net: (accept as { network?: string }).network ?? "unknown",
        from: wallet.evmAddress ?? wallet.solanaAddress ?? "unknown",
        tx: typeof tx === "string" ? tx : undefined,
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

    // Get remote tools to register on the local server
    const { tools } = await x402Mcp.listTools();
    dim(`  ${tools.length} tools available`);

    // Create local MCP server (stdio)
    const localServer = new McpServer({
      name: "x402-proxy",
      version: "0.2.0",
    });

    // Register each remote tool as a local tool that proxies through x402
    for (const tool of tools) {
      localServer.tool(
        tool.name,
        tool.description ?? "",
        tool.inputSchema?.properties
          ? Object.fromEntries(
              Object.entries(tool.inputSchema.properties as Record<string, unknown>).map(
                ([k, v]) => [k, v as object],
              ),
            )
          : {},
        async (args) => {
          const result = await x402Mcp.callTool(tool.name, args);
          return {
            content: result.content as Array<{ type: "text"; text: string }>,
            isError: result.isError,
          };
        },
      );
    }

    // Also proxy resources if available
    try {
      const { resources } = await x402Mcp.listResources();
      if (resources.length > 0) {
        dim(`  ${resources.length} resources available`);
        for (const resource of resources) {
          localServer.resource(
            resource.name,
            resource.uri,
            resource.description ? { description: resource.description } : {},
            async (uri) => {
              const result = await x402Mcp.readResource({ uri: uri.href });
              return {
                contents: result.contents.map((c) => ({
                  uri: c.uri,
                  text: "text" in c ? (c.text as string) : "",
                })),
              };
            },
          );
        }
      }
    } catch {
      // Resources not supported by remote, that's fine
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
