import { once } from "node:events";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { buildCommand, type CommandContext } from "@stricli/core";
import { createX402ProxyHandler } from "../handler.js";
import { getHistoryPath, loadConfig } from "../lib/config.js";
import { dim, error, info, isTTY, success } from "../lib/output.js";
import { buildX402Client, resolveWallet, type WalletResolution } from "../lib/resolve-wallet.js";
import {
  DEFAULT_SURF_PROVIDER_ID,
  DEFAULT_SURF_UPSTREAM_URL,
  resolveMppSessionBudget,
  resolveProtocol,
  resolveProviders,
} from "../openclaw/defaults.js";
import { createInferenceProxyRouteHandler } from "../openclaw/route.js";
import { addressForNetwork } from "../openclaw/tools.js";
import { fetchAllBalances } from "./wallet.js";

type ServeFlags = {
  port: string;
  protocol: string | undefined;
  network: string | undefined;
  evmKey: string | undefined;
  solanaKey: string | undefined;
};

export type StartServeServerOptions = {
  upstreamUrl?: string;
  port?: number;
  protocol?: string;
  network?: string;
  evmKey?: string;
  solanaKey?: string;
  quiet?: boolean;
};

type StartedServeServer = {
  server: http.Server;
  port: number;
  close: () => Promise<void>;
};

async function resolveWalletForServe(flags: {
  evmKey?: string;
  solanaKey?: string;
}): Promise<WalletResolution> {
  let wallet = resolveWallet({
    evmKey: flags.evmKey,
    solanaKey: flags.solanaKey,
  });
  if (wallet.source !== "none") {
    return wallet;
  }

  const { runSetup } = await import("./setup.js");
  if (isTTY()) {
    dim("  No wallet found. Let's set one up first.\n");
    await runSetup();
  } else {
    dim("No wallet found. Auto-generating...");
    await runSetup({ nonInteractive: true });
  }

  wallet = resolveWallet({
    evmKey: flags.evmKey,
    solanaKey: flags.solanaKey,
  });
  if (wallet.source === "none") {
    error("Wallet setup failed. Run: $ npx x402-proxy setup");
    process.exit(1);
  }
  return wallet;
}

async function detectPreferredNetwork(wallet: WalletResolution): Promise<string | undefined> {
  if (!wallet.evmAddress || !wallet.solanaAddress) {
    return undefined;
  }

  const balances = await fetchAllBalances(wallet.evmAddress, wallet.solanaAddress);
  const evmUsdc = balances.evm ? Number(balances.evm.usdc) : 0;
  const solUsdc = balances.sol ? Number(balances.sol.usdc) : 0;
  if (evmUsdc > solUsdc) return "base";
  if (solUsdc > evmUsdc) return "solana";
  return undefined;
}

function walletAddressForNetwork(wallet: WalletResolution, network: string): string | null {
  return addressForNetwork(wallet.evmAddress ?? null, wallet.solanaAddress ?? null, network);
}

function createRequestHandler(
  routeHandler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>,
): http.RequestListener {
  return (req, res) => {
    void routeHandler(req, res)
      .then((handled) => {
        if (!handled && !res.headersSent) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Not found", code: "not_found" } }));
        }
      })
      .catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
        }
        res.end(
          JSON.stringify({
            error: {
              message: err instanceof Error ? err.message : String(err),
              code: "proxy_failed",
            },
          }),
        );
      });
  };
}

export async function startServeServer(
  options: StartServeServerOptions = {},
): Promise<StartedServeServer> {
  const config = loadConfig();
  const wallet = await resolveWalletForServe(options);
  const resolvedProtocol = resolveProtocol(options.protocol ?? config?.preferredProtocol);
  const configuredMppBudget = resolveMppSessionBudget(config?.mppSessionBudget);
  const preferredNetwork = config?.defaultNetwork ?? (await detectPreferredNetwork(wallet));
  const upstreamUrl = options.upstreamUrl ?? DEFAULT_SURF_UPSTREAM_URL;
  const x402Client = await buildX402Client(wallet, {
    preferredNetwork: preferredNetwork || undefined,
    network: options.network,
    spendLimitDaily: config?.spendLimitDaily,
    spendLimitPerTx: config?.spendLimitPerTx,
  });
  const x402Proxy = createX402ProxyHandler({ client: x402Client });
  const { providers, models } = resolveProviders({
    protocol: resolvedProtocol,
    mppSessionBudget: configuredMppBudget,
    providers: {
      [DEFAULT_SURF_PROVIDER_ID]: {
        baseUrl: "/",
        upstreamUrl,
        protocol: resolvedProtocol,
        mppSessionBudget: configuredMppBudget,
      },
    },
  });

  const routeHandler = createInferenceProxyRouteHandler({
    providers,
    getX402Proxy: () => x402Proxy,
    getWalletAddress: () => wallet.solanaAddress ?? wallet.evmAddress ?? null,
    getWalletAddressForNetwork: (network) => walletAddressForNetwork(wallet, network),
    getEvmKey: () => wallet.evmKey ?? null,
    historyPath: getHistoryPath(),
    allModels: models,
    logger: {
      info: (msg) => {
        if (!options.quiet) dim(msg);
      },
      error: (msg) => {
        if (!options.quiet) error(msg);
      },
    },
  });

  const server = http.createServer(createRequestHandler(routeHandler));
  server.on("clientError", (err, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    if (!options.quiet) error(`client error: ${err.message}`);
  });

  server.listen(options.port ?? 0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  const port =
    address && typeof address === "object" && typeof address.port === "number" ? address.port : 0;
  if (!options.quiet) {
    success(`Proxy listening on http://127.0.0.1:${port}`);
    info(`Upstream: ${upstreamUrl}`);
    info(`Protocol: ${resolvedProtocol}`);
  }

  return {
    server,
    port,
    close: async () => {
      if (!server.listening) return;
      server.close();
      await once(server, "close");
    },
  };
}

function waitForSignal(): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    const onSignal = (signal: NodeJS.Signals) => {
      process.off("SIGINT", onSigInt);
      process.off("SIGTERM", onSigTerm);
      resolve(signal);
    };
    const onSigInt = () => onSignal("SIGINT");
    const onSigTerm = () => onSignal("SIGTERM");
    process.on("SIGINT", onSigInt);
    process.on("SIGTERM", onSigTerm);
  });
}

export const serveCommand = buildCommand<ServeFlags, [upstreamUrl?: string], CommandContext>({
  docs: {
    brief: "Start a local paid inference proxy",
    fullDescription: `Start a local HTTP proxy that forwards inference requests upstream and auto-pays x402 or MPP 402 challenges.

Examples:
  $ x402-proxy serve
  $ x402-proxy serve --port 8402
  $ x402-proxy serve https://surf.cascade.fyi/api/v1/inference --protocol mpp`,
  },
  parameters: {
    flags: {
      port: {
        kind: "parsed",
        brief: "Listen port (0 = ephemeral)",
        parse: String,
        default: "0",
      },
      protocol: {
        kind: "parsed",
        brief: "Payment protocol (x402, mpp, auto)",
        parse: String,
        optional: true,
      },
      network: {
        kind: "parsed",
        brief: "Preferred or required network (base, solana, tempo)",
        parse: String,
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
    },
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "Upstream inference URL",
          parse: String,
          optional: true,
        },
      ],
    },
  },
  async func(flags, upstreamUrl?: string) {
    const started = await startServeServer({
      upstreamUrl,
      port: Number(flags.port),
      protocol: flags.protocol,
      network: flags.network,
      evmKey: flags.evmKey,
      solanaKey: flags.solanaKey,
    });

    const signal = await waitForSignal();
    dim(`Received ${signal}, shutting down...`);
    await started.close();
    process.exit(signal === "SIGINT" ? 130 : 143);
  },
});
