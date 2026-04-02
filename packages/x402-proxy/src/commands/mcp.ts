declare const __VERSION__: string;

import { buildCommand, type CommandContext } from "@stricli/core";
import { TEMPO_NETWORK } from "../handler.js";
import { appendHistory, displayNetwork, formatAmount, type TxRecord } from "../history.js";
import { getHistoryPath, loadConfig } from "../lib/config.js";
import { dim, error, warn } from "../lib/output.js";
import { buildX402Client, resolveWallet } from "../lib/resolve-wallet.js";

type McpFlags = {
  evmKey: string | undefined;
  solanaKey: string | undefined;
  network: string | undefined;
  protocol: string | undefined;
};

type ToolDefinition = {
  name: string;
  [key: string]: unknown;
};

type ResourceDefinition = {
  uri: string;
  [key: string]: unknown;
};

type TextContent = {
  type: "text";
  text: string;
  [key: string]: unknown;
};

type CallToolResultLike = {
  content: Array<{ type: string; [key: string]: unknown }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

type X402PaymentRequired = {
  x402Version: number;
  accepts: Array<{ amount?: string; network: string; [key: string]: unknown }>;
  [key: string]: unknown;
};

type X402PaymentRequiredErrorData = {
  x402?: X402PaymentRequired;
};

type X402SettleResponse = {
  transaction?: string;
  [key: string]: unknown;
};

const X402_PAYMENT_META_KEY = "x402/payment";
const X402_PAYMENT_RESPONSE_META_KEY = "x402/payment-response";

export function cloneTool(tool: ToolDefinition): ToolDefinition {
  return { ...tool };
}

export function cloneResource(resource: ResourceDefinition): ResourceDefinition {
  return { ...resource };
}

export function normalizeCallToolResult(result: CallToolResultLike): CallToolResultLike {
  return {
    content: result.content,
    ...(result.structuredContent !== undefined
      ? { structuredContent: result.structuredContent }
      : {}),
    ...(result.isError !== undefined ? { isError: result.isError } : {}),
    ...(result._meta !== undefined ? { _meta: result._meta } : {}),
  };
}

function isTextContent(content: { type: string; [key: string]: unknown }): content is TextContent {
  return content.type === "text" && typeof content.text === "string";
}

function isX402PaymentRequired(value: unknown): value is X402PaymentRequired {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.x402Version === "number" && Array.isArray(candidate.accepts);
}

function extractPaymentRequiredFromObject(value: unknown): X402PaymentRequired | undefined {
  if (isX402PaymentRequired(value)) return value;
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  const wrappedError = candidate["x402/error"];
  if (typeof wrappedError === "object" && wrappedError !== null) {
    const errorData = (wrappedError as Record<string, unknown>).data;
    if (isX402PaymentRequired(errorData)) return errorData;
  }
  return undefined;
}

export function extractPaymentRequiredFromResult(
  result: CallToolResultLike,
): X402PaymentRequired | undefined {
  if (!result.isError) return undefined;
  const structured = extractPaymentRequiredFromObject(result.structuredContent);
  if (structured) return structured;
  const first = result.content[0];
  if (!first || !isTextContent(first)) return undefined;
  try {
    return extractPaymentRequiredFromObject(JSON.parse(first.text));
  } catch {
    return undefined;
  }
}

function extractPaymentRequiredFromError(error: unknown): X402PaymentRequired | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const data = (error as { data?: X402PaymentRequiredErrorData }).data;
  return data?.x402;
}

export async function callX402ToolWithAutoPayment(opts: {
  remoteClient: { callTool(params: Record<string, unknown>): Promise<CallToolResultLike> };
  name: string;
  args: Record<string, unknown>;
  x402PaymentClient: { createPaymentPayload(requirements: X402PaymentRequired): Promise<unknown> };
  onPaymentRequested: (paymentRequired: X402PaymentRequired, toolName: string) => void;
  onPaymentSettled: (ctx: {
    toolName: string;
    paymentPayload: { accepted?: { network?: string; payTo?: string; amount?: string } };
    settleResponse?: X402SettleResponse;
  }) => void;
}): Promise<CallToolResultLike> {
  let paymentRequired: X402PaymentRequired | undefined;
  try {
    const result = await opts.remoteClient.callTool({ name: opts.name, arguments: opts.args });
    paymentRequired = extractPaymentRequiredFromResult(result);
    if (!paymentRequired) return result;
  } catch (error) {
    paymentRequired = extractPaymentRequiredFromError(error);
    if (!paymentRequired) throw error;
  }

  opts.onPaymentRequested(paymentRequired, opts.name);
  const paymentPayload = (await opts.x402PaymentClient.createPaymentPayload(paymentRequired)) as {
    accepted?: { network?: string; payTo?: string; amount?: string };
  };
  const paidResult = await opts.remoteClient.callTool({
    name: opts.name,
    arguments: opts.args,
    _meta: { [X402_PAYMENT_META_KEY]: paymentPayload },
  });
  opts.onPaymentSettled({
    toolName: opts.name,
    paymentPayload,
    settleResponse: paidResult._meta?.[X402_PAYMENT_RESPONSE_META_KEY] as
      | X402SettleResponse
      | undefined,
  });
  return paidResult;
}

export const mcpCommand = buildCommand<McpFlags, [remoteUrl: string], CommandContext>({
  docs: {
    brief: "Start MCP stdio proxy with automatic payment",
    fullDescription: `Start an MCP stdio proxy with automatic payment (x402 or MPP) for AI agents.

Add to your MCP client config (Claude, Cursor, etc.):
  "command": "npx",
  "args": ["-y", "x402-proxy", "mcp", "https://surf.cascade.fyi/mcp"]

Wallet is auto-generated on first run. No env vars needed.`,
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
      // Auto-setup wallet in non-interactive environments (e.g. MCP stdio)
      dim("No wallet found. Auto-generating...");
      const { runSetup } = await import("./setup.js");
      await runSetup({ nonInteractive: true });
      // Re-resolve after setup
      const fresh = resolveWallet({ evmKey: flags.evmKey, solanaKey: flags.solanaKey });
      if (fresh.source === "none") {
        error("Wallet auto-setup failed. Run: $ npx x402-proxy setup");
        process.exit(1);
      }
      Object.assign(wallet, fresh);
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

      function warnPayment(
        accepts: Array<{ amount?: string; network: string }> | undefined,
        toolName: string,
      ) {
        const accept = accepts?.[0];
        if (accept) {
          const amount = accept.amount
            ? formatAmount(Number(accept.amount) / 1_000_000, "USDC")
            : "? USDC";
          warn(`  Payment: ${amount} on ${displayNetwork(accept.network)} for tool "${toolName}"`);
        }
      }

      // Connect to remote MCP server
      const remoteClient = new Client({ name: "x402-proxy", version: __VERSION__ });
      await connectTransport(remoteClient);

      function recordX402Payment(ctx: {
        toolName: string;
        paymentPayload: { accepted?: { network?: string; payTo?: string; amount?: string } };
        settleResponse?: X402SettleResponse;
      }) {
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
      }

      // Discover remote capabilities
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
        tools: tools.map((t) => cloneTool(t as ToolDefinition)),
      }));

      localServer.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        const result = await callX402ToolWithAutoPayment({
          remoteClient: remoteClient as unknown as {
            callTool(params: Record<string, unknown>): Promise<CallToolResultLike>;
          },
          name,
          args: (args ?? {}) as Record<string, unknown>,
          x402PaymentClient: x402PaymentClient as unknown as {
            createPaymentPayload(requirements: X402PaymentRequired): Promise<unknown>;
          },
          onPaymentRequested: (paymentRequired, toolName) => {
            warnPayment(paymentRequired.accepts, toolName);
          },
          onPaymentSettled: recordX402Payment,
        });
        return normalizeCallToolResult(result);
      });

      if (remoteResources.length > 0) {
        localServer.setRequestHandler(ListResourcesRequestSchema, async () => ({
          resources: remoteResources.map((r) => cloneResource(r as ResourceDefinition)),
        }));

        localServer.setRequestHandler(ReadResourceRequestSchema, async (request) => {
          const result = await remoteClient.readResource({ uri: request.params.uri });
          return {
            contents: result.contents.map((c: Record<string, unknown>) => ({ ...c })),
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

      dim("  MCP proxy running (stdio, x402)");

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

      // Wrap tempo methods to capture payment amounts from challenges
      let lastChallengeAmount: number | undefined;
      const tempoMethods = tempo({ account, maxDeposit });
      const wrappedMethods = tempoMethods.map((m) => ({
        ...m,
        createCredential: async (params: { challenge: { request: Record<string, unknown> } }) => {
          const req = params.challenge.request as { amount?: string; decimals?: number };
          if (req.amount) {
            lastChallengeAmount = Number(req.amount) / 10 ** (req.decimals ?? 6);
          }
          return (m.createCredential as (p: unknown) => Promise<string>)(params);
        },
      }));

      // Connect base client to remote MCP server
      const remoteClient = new Client({ name: "x402-proxy", version: __VERSION__ });

      await connectTransport(remoteClient);

      // McpClient expects Client resolved with zod@3 (via mppx's own SDK copy),
      // but ours resolves with zod@4. Structurally identical.
      const mppClient = McpClient.wrap(
        remoteClient as unknown as Parameters<typeof McpClient.wrap>[0],
        { methods: wrappedMethods as unknown as Parameters<typeof McpClient.wrap>[1]["methods"] },
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
        tools: tools.map((t) => cloneTool(t as ToolDefinition)),
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
            amount: lastChallengeAmount,
            token: "USDC",
            label: `mcp:${name}`,
          };
          appendHistory(getHistoryPath(), record);
          const amountStr =
            lastChallengeAmount !== undefined ? formatAmount(lastChallengeAmount, "USDC") : "";
          warn(
            `  MPP payment for tool "${name}" (Tempo)${amountStr ? ` \u00b7 ${amountStr}` : ""}`,
          );
          lastChallengeAmount = undefined;
        }

        return normalizeCallToolResult(result as CallToolResultLike);
      });

      if (remoteResources.length > 0) {
        localServer.setRequestHandler(ListResourcesRequestSchema, async () => ({
          resources: remoteResources.map((r) => cloneResource(r as ResourceDefinition)),
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
