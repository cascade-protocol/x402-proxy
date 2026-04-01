import { homedir } from "node:os";
import { join } from "node:path";
import { createKeyPairSignerFromBytes, type KeyPairSigner } from "@solana/kit";
import { x402Client } from "@x402/fetch";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  createMppProxyHandler,
  createX402ProxyHandler,
  type MppProxyHandler,
  type X402ProxyHandler,
} from "../handler.js";
import { getHistoryPath } from "../lib/config.js";
import { OptimizedSvmScheme } from "../lib/optimized-svm-scheme.js";
import { resolveWallet } from "../lib/resolve-wallet.js";
import { loadSvmWallet } from "../wallet.js";
import { createSendCommand, createWalletCommand } from "./commands.js";
import { resolveProviders, routePrefixForBaseUrl } from "./defaults.js";
import { createInferenceProxyRouteHandler } from "./route.js";
import { addressForNetwork, createRequestTool, createWalletTool, SOL_MAINNET } from "./tools.js";

declare const __VERSION__: string;

export function register(api: OpenClawPluginApi): void {
  const config = (api.pluginConfig ?? {}) as Record<string, unknown>;
  const explicitKeypairPath = config.keypairPath as string | undefined;
  const rpcUrl = (config.rpcUrl as string) || "https://api.mainnet-beta.solana.com";
  const dashboardUrl = (config.dashboardUrl as string) || "";
  const { providers, models: allModels } = resolveProviders(config);
  const defaultProvider = providers[0];

  for (const provider of providers) {
    api.registerProvider({
      id: provider.id,
      label: provider.id,
      auth: [],
      catalog: {
        order: "simple",
        run: async () => ({
          provider: {
            baseUrl: provider.baseUrl,
            api: "openai-completions",
            authHeader: false,
            models: provider.models,
          },
        }),
      },
    });
  }

  api.logger.info(
    `x402-proxy: ${providers.map((provider) => `${provider.id}:${provider.protocol}`).join(", ")} - ${allModels.length} models`,
  );

  let solanaWalletAddress: string | null = null;
  let evmWalletAddress: string | null = null;
  let signerRef: KeyPairSigner | null = null;
  let proxyRef: X402ProxyHandler | null = null;
  let mppHandlerRef: MppProxyHandler | null = null;
  let evmKeyRef: string | null = null;
  let walletLoadPromise: Promise<void> | null = null;

  const historyPath = getHistoryPath();
  const routePrefixes = [
    ...new Set(providers.map((provider) => routePrefixForBaseUrl(provider.baseUrl))),
  ];

  const handler = createInferenceProxyRouteHandler({
    providers,
    getX402Proxy: () => proxyRef,
    getMppHandler: () => mppHandlerRef,
    getWalletAddress: () => solanaWalletAddress ?? evmWalletAddress,
    getWalletAddressForNetwork: (network) =>
      addressForNetwork(evmWalletAddress, solanaWalletAddress, network),
    historyPath,
    allModels,
    logger: api.logger,
  });
  for (const path of routePrefixes) {
    api.registerHttpRoute({
      path,
      match: "prefix",
      auth: "plugin",
      handler,
    });
  }
  api.logger.info(
    `proxy: HTTP routes ${routePrefixes.join(", ")} registered for ${providers.map((provider) => provider.upstreamUrl).join(", ")}`,
  );

  async function ensureWalletLoaded(): Promise<void> {
    if (walletLoadPromise) {
      await walletLoadPromise;
      return;
    }

    walletLoadPromise = (async () => {
      try {
        const resolution = resolveWallet();
        evmKeyRef = resolution.evmKey ?? null;
        evmWalletAddress = resolution.evmAddress ?? null;

        if (explicitKeypairPath) {
          const resolvedPath = explicitKeypairPath.startsWith("~/")
            ? join(homedir(), explicitKeypairPath.slice(2))
            : explicitKeypairPath;
          signerRef = await loadSvmWallet(resolvedPath);
          solanaWalletAddress = signerRef.address;
        } else if (resolution.solanaKey && resolution.solanaAddress) {
          signerRef = await createKeyPairSignerFromBytes(resolution.solanaKey);
          solanaWalletAddress = resolution.solanaAddress;
        } else {
          signerRef = null;
          solanaWalletAddress = null;
        }

        if (!solanaWalletAddress && !evmWalletAddress) {
          api.logger.error(
            "x402-proxy: no wallet found. Run `x402-proxy setup` to create one, or set X402_PROXY_WALLET_MNEMONIC / X402_PROXY_WALLET_EVM_KEY.",
          );
          return;
        }

        if (signerRef) {
          const client = new x402Client();
          client.register(SOL_MAINNET, new OptimizedSvmScheme(signerRef, { rpcUrl }));
          proxyRef = createX402ProxyHandler({ client });
        } else {
          proxyRef = null;
        }

        if (evmKeyRef) {
          const maxBudget = Math.max(
            ...providers.map((p) => Number(p.mppSessionBudget) || 0.5),
          ).toString();
          mppHandlerRef = await createMppProxyHandler({
            evmKey: evmKeyRef,
            maxDeposit: maxBudget,
          });
        } else {
          mppHandlerRef = null;
        }

        api.logger.info(
          `wallets: solana=${solanaWalletAddress ?? "missing"} evm=${evmWalletAddress ?? "missing"}`,
        );
      } catch (err) {
        api.logger.error(`wallet load failed: ${err}`);
      }
    })();

    await walletLoadPromise;
  }

  ensureWalletLoaded();
  api.registerService({
    id: "x402-wallet",
    async start() {
      await ensureWalletLoaded();
    },
    async stop() {
      if (mppHandlerRef) {
        try {
          await mppHandlerRef.close();
        } catch {
          // best effort
        }
      }
    },
  });

  const toolCtx = {
    ensureReady: ensureWalletLoaded,
    getSolanaWalletAddress: () => solanaWalletAddress,
    getEvmWalletAddress: () => evmWalletAddress,
    getSigner: () => signerRef,
    getX402Proxy: () => proxyRef,
    getEvmKey: () => evmKeyRef,
    getDefaultRequestProtocol: () => defaultProvider?.protocol ?? "mpp",
    getDefaultMppSessionBudget: () => defaultProvider?.mppSessionBudget ?? "0.5",
    rpcUrl,
    historyPath,
    allModels,
  };

  api.registerTool(createWalletTool(toolCtx), { names: ["x_balance"] });
  api.registerTool(createRequestTool(toolCtx), { names: ["x_payment"] });

  const cmdCtx = {
    ensureReady: ensureWalletLoaded,
    getSolanaWalletAddress: () => solanaWalletAddress,
    getEvmWalletAddress: () => evmWalletAddress,
    getSigner: () => signerRef,
    getDefaultRequestProtocol: () => defaultProvider?.protocol ?? "mpp",
    getDefaultMppSessionBudget: () => defaultProvider?.mppSessionBudget ?? "0.5",
    rpcUrl,
    dashboardUrl,
    historyPath,
    allModels,
  };

  api.registerCommand(createWalletCommand(cmdCtx));
  api.registerCommand(createSendCommand(cmdCtx));
}

export default definePluginEntry({
  id: "x402-proxy",
  name: "mpp/x402 Payments Proxy",
  description: "x402 and MPP payments, wallet tools, and paid inference proxying",
  register,
});
