import { homedir } from "node:os";
import { join } from "node:path";
import { createKeyPairSignerFromBytes, type KeyPairSigner } from "@solana/kit";
import { x402Client } from "@x402/fetch";
import {
  definePluginEntry,
  type OpenClawPluginApi,
  type ProviderAuthMethod,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  createMppProxyHandler,
  createX402ProxyHandler,
  type MppProxyHandler,
  type X402ProxyHandler,
} from "../handler.js";
import { createWalletFile, getHistoryPath, getWalletPath, saveWalletFile } from "../lib/config.js";
import { generateMnemonic, isValidMnemonic } from "../lib/derive.js";
import { OptimizedSvmScheme } from "../lib/optimized-svm-scheme.js";
import { resolveWallet } from "../lib/wallet-resolution.js";
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

  const walletAuthMethod: ProviderAuthMethod = {
    id: "wallet-setup",
    label: "x402-proxy wallet setup",
    hint: "Generate or import a crypto wallet for paid inference",
    kind: "custom",
    run: async (ctx) => {
      const existing = resolveWallet();
      if (existing.source !== "none") {
        const addresses = [
          existing.evmAddress ? `EVM: ${existing.evmAddress}` : null,
          existing.solanaAddress ? `Solana: ${existing.solanaAddress}` : null,
        ]
          .filter(Boolean)
          .join("\n");
        await ctx.prompter.note(
          `Wallet already configured (source: ${existing.source}).\n\n${addresses}`,
          "x402-proxy wallet",
        );
        return { profiles: [] };
      }

      const action = await ctx.prompter.select({
        message: "How would you like to set up your x402-proxy wallet?",
        options: [
          { value: "generate" as const, label: "Generate a new wallet" },
          { value: "import" as const, label: "Import an existing BIP-39 mnemonic" },
        ],
      });

      let mnemonic: string;
      if (action === "import") {
        mnemonic = await ctx.prompter.text({
          message: "Enter your BIP-39 mnemonic (12 or 24 words):",
          validate: (v) => {
            const words = String(v ?? "")
              .trim()
              .split(/\s+/);
            if (words.length !== 12 && words.length !== 24)
              return "Mnemonic must be 12 or 24 words";
            if (!isValidMnemonic(words.join(" ")))
              return "Invalid BIP-39 mnemonic. Check the words and try again.";
          },
        });
        mnemonic = String(mnemonic).trim();
      } else {
        mnemonic = generateMnemonic();
      }

      const wallet = createWalletFile(mnemonic);
      saveWalletFile(wallet);

      const msg = [
        `EVM:    ${wallet.addresses.evm}`,
        `Solana: ${wallet.addresses.solana}`,
        "",
        `Wallet saved to ${getWalletPath()}`,
        "",
        "Fund these addresses with USDC to start using paid inference.",
        action === "generate"
          ? "\nRecover your mnemonic later with: npx x402-proxy wallet export-key mnemonic"
          : "",
      ]
        .filter(Boolean)
        .join("\n");
      await ctx.prompter.note(msg, "Wallet created");

      return {
        profiles: [
          {
            profileId: "surf:x402-proxy",
            credential: { type: "api_key", provider: "surf", key: "x402-proxy-managed" },
          },
        ],
      };
    },
  };

  for (const provider of providers) {
    const isFirst = provider === providers[0];
    api.registerProvider({
      id: provider.id,
      label: provider.id,
      auth: isFirst ? [walletAuthMethod] : [],
      resolveConfigApiKey: () => "x402-proxy-managed",
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
    `x402-proxy: HTTP routes ${routePrefixes.join(", ")} registered for ${providers.map((provider) => provider.upstreamUrl).join(", ")}`,
  );

  async function ensureWalletLoaded(opts?: { reload?: boolean }): Promise<void> {
    if (opts?.reload) {
      if (mppHandlerRef) {
        try {
          await mppHandlerRef.close();
        } catch {
          // best effort
        }
      }
      walletLoadPromise = null;
      solanaWalletAddress = null;
      evmWalletAddress = null;
      signerRef = null;
      proxyRef = null;
      mppHandlerRef = null;
      evmKeyRef = null;
    }

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
            "x402-proxy: no wallet found. Use /x_wallet setup or run `npx x402-proxy setup` on the host.",
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
