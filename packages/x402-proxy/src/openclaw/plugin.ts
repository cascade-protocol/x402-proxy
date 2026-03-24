import { homedir } from "node:os";
import { join } from "node:path";
import { createKeyPairSignerFromBytes, type KeyPairSigner } from "@solana/kit";
import { x402Client } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { createX402ProxyHandler, type X402ProxyHandler } from "../handler.js";
import { getHistoryPath } from "../lib/config.js";
import { resolveWallet } from "../lib/resolve-wallet.js";
import { loadSvmWallet } from "../wallet.js";
import { createWalletCommand } from "./commands.js";
import { createX402RouteHandler } from "./route.js";
import { createBalanceTool, createPaymentTool, type ModelEntry, SOL_MAINNET } from "./tools.js";

declare const __VERSION__: string;

type ProviderConfig = {
  baseUrl: string;
  upstreamUrl?: string;
  models: Array<Omit<ModelEntry, "provider">>;
};

function parseProviders(config: Record<string, unknown>): {
  models: ModelEntry[];
  upstreamOrigins: string[];
} {
  const raw = (config.providers ?? {}) as Record<string, ProviderConfig>;
  const models: ModelEntry[] = [];
  const upstreamOrigins: string[] = [];
  for (const [name, prov] of Object.entries(raw)) {
    if (prov.upstreamUrl) upstreamOrigins.push(prov.upstreamUrl);
    for (const m of prov.models) {
      models.push({ ...m, provider: name });
    }
  }
  return { models, upstreamOrigins };
}

type ProviderCatalogResult = {
  provider: {
    baseUrl: string;
    api?: string;
    authHeader?: boolean;
    models: Array<Omit<ModelEntry, "provider">>;
  };
} | null;

type OpenClawPluginApi = {
  pluginConfig?: Record<string, unknown>;
  logger: { info: (msg: string) => void; error: (msg: string) => void };
  registerProvider: (provider: {
    id: string;
    label: string;
    auth: unknown[];
    catalog: {
      order?: "simple" | "profile" | "paired" | "late";
      run: (ctx: unknown) => Promise<ProviderCatalogResult>;
    };
  }) => void;
  registerTool: (tool: unknown) => void;
  registerCommand: (command: unknown) => void;
  registerService: (service: {
    id: string;
    start: () => Promise<void>;
    stop: () => Promise<void>;
  }) => void;
  registerHttpRoute: (params: {
    path: string;
    match: string;
    auth: string;
    handler: (req: unknown, res: unknown) => Promise<void>;
  }) => void;
};

export function register(api: OpenClawPluginApi): void {
  const config = (api.pluginConfig ?? {}) as Record<string, unknown>;
  const explicitKeypairPath = config.keypairPath as string | undefined;
  const rpcUrl = (config.rpcUrl as string) || "https://api.mainnet-beta.solana.com";
  const dashboardUrl = (config.dashboardUrl as string) || "";
  const { models: allModels, upstreamOrigins } = parseProviders(config);

  if (allModels.length === 0) {
    api.logger.error("x402-proxy: no providers configured");
    return;
  }

  const raw = (config.providers ?? {}) as Record<string, ProviderConfig>;
  for (const [name, prov] of Object.entries(raw)) {
    api.registerProvider({
      id: name,
      label: `${name} (x402)`,
      auth: [],
      catalog: {
        order: "simple",
        run: async () => ({
          provider: {
            baseUrl: prov.baseUrl,
            api: "openai-completions",
            authHeader: false,
            models: prov.models,
          },
        }),
      },
    });
  }

  api.logger.info(
    `x402-proxy: ${Object.keys(raw).join(", ")} - ${allModels.length} models, ${upstreamOrigins.length} x402 endpoints`,
  );

  let walletAddress: string | null = null;
  let signerRef: KeyPairSigner | null = null;
  let proxyRef: X402ProxyHandler | null = null;
  let walletLoading = false;

  // Resolve history path: use x402-proxy's XDG config dir
  const historyPath = getHistoryPath();

  async function ensureWalletLoaded(): Promise<void> {
    if (walletLoading || walletAddress) return;
    walletLoading = true;
    let signer: KeyPairSigner;
    try {
      if (explicitKeypairPath) {
        const resolvedPath = explicitKeypairPath.startsWith("~/")
          ? join(homedir(), explicitKeypairPath.slice(2))
          : explicitKeypairPath;
        signer = await loadSvmWallet(resolvedPath);
        walletAddress = signer.address;
      } else {
        const resolution = resolveWallet();
        if (resolution.source === "none" || !resolution.solanaKey || !resolution.solanaAddress) {
          walletLoading = false;
          api.logger.error(
            "x402-proxy: no wallet found. Run `x402-proxy setup` to create one, or set X402_PROXY_WALLET_MNEMONIC env var.",
          );
          return;
        }
        signer = await createKeyPairSignerFromBytes(resolution.solanaKey);
        walletAddress = resolution.solanaAddress;
      }
      signerRef = signer;
      api.logger.info(`x402: wallet ${walletAddress}`);
    } catch (err) {
      walletLoading = false;
      api.logger.error(`x402: failed to load wallet: ${err}`);
      return;
    }

    const client = new x402Client();
    client.register(SOL_MAINNET, new ExactSvmScheme(signer, { rpcUrl }));
    proxyRef = createX402ProxyHandler({ client });

    const upstreamOrigin = upstreamOrigins[0];
    if (upstreamOrigin) {
      const handler = createX402RouteHandler({
        upstreamOrigin,
        proxy: proxyRef,
        getWalletAddress: () => walletAddress,
        historyPath,
        allModels,
        logger: api.logger,
      });
      api.registerHttpRoute({
        path: "/x402",
        match: "prefix",
        auth: "plugin",
        handler: handler as (req: unknown, res: unknown) => Promise<void>,
      });
      api.logger.info(`x402: HTTP route registered for ${upstreamOrigin}`);
    }
  }

  // Eager load: survives hot-reload where service start() is not re-called
  ensureWalletLoaded();

  // Service: ensures wallet is loaded during normal boot lifecycle
  api.registerService({
    id: "x402-wallet",
    async start() {
      await ensureWalletLoaded();
    },
    async stop() {},
  });

  const toolCtx = {
    getWalletAddress: () => walletAddress,
    getSigner: () => signerRef,
    rpcUrl,
    historyPath,
    get proxy(): X402ProxyHandler {
      if (!proxyRef) throw new Error("x402 proxy not initialized yet");
      return proxyRef;
    },
    allModels,
  };

  api.registerTool(createBalanceTool(toolCtx));
  api.registerTool(createPaymentTool(toolCtx));

  const cmdCtx = {
    getWalletAddress: () => walletAddress,
    getSigner: () => signerRef,
    rpcUrl,
    dashboardUrl,
    historyPath,
    allModels,
  };

  api.registerCommand(createWalletCommand(cmdCtx));
}
