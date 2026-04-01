import type { ModelEntry } from "./tools.js";

export type PaymentProtocol = "x402" | "mpp" | "auto";

export type ProviderConfig = {
  baseUrl?: string;
  upstreamUrl?: string;
  protocol?: PaymentProtocol;
  mppSessionBudget?: string;
  models?: Array<Omit<ModelEntry, "provider">>;
};

export type ResolvedProviderConfig = {
  id: string;
  baseUrl: string;
  upstreamUrl: string;
  protocol: PaymentProtocol;
  mppSessionBudget: string;
  models: Array<Omit<ModelEntry, "provider">>;
};

export const DEFAULT_SURF_PROVIDER_ID = "surf";
export const DEFAULT_SURF_BASE_URL = "/x402-proxy/v1";
export const DEFAULT_SURF_UPSTREAM_URL = "https://surf.cascade.fyi/api/v1/inference";
export const DEFAULT_PROVIDER_PROTOCOL: PaymentProtocol = "mpp";
export const DEFAULT_MPP_SESSION_BUDGET = "0.5";

export const DEFAULT_SURF_MODELS: Array<Omit<ModelEntry, "provider">> = [
  {
    id: "anthropic/claude-opus-4.6",
    name: "Claude Opus 4.6",
    maxTokens: 200000,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.015, output: 0.075, cacheRead: 0.0015, cacheWrite: 0.01875 },
    contextWindow: 200000,
  },
  {
    id: "anthropic/claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
    maxTokens: 200000,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.003, output: 0.015, cacheRead: 0.0003, cacheWrite: 0.00375 },
    contextWindow: 200000,
  },
  {
    id: "x-ai/grok-4.20-beta",
    name: "Grok 4.20 Beta",
    maxTokens: 131072,
    reasoning: true,
    input: ["text"],
    cost: { input: 0.003, output: 0.015, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
  },
  {
    id: "minimax/minimax-m2.5",
    name: "MiniMax M2.5",
    maxTokens: 1000000,
    reasoning: false,
    input: ["text"],
    cost: { input: 0.001, output: 0.005, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
  },
  {
    id: "moonshotai/kimi-k2.5",
    name: "Kimi K2.5",
    maxTokens: 131072,
    reasoning: true,
    input: ["text"],
    cost: { input: 0.002, output: 0.008, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
  },
  {
    id: "z-ai/glm-5",
    name: "GLM-5",
    maxTokens: 128000,
    reasoning: false,
    input: ["text"],
    cost: { input: 0.001, output: 0.005, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
  },
];

export function resolveProviders(config: Record<string, unknown>): {
  providers: ResolvedProviderConfig[];
  models: ModelEntry[];
} {
  const defaultProtocol = resolveProtocol(config.protocol);
  const defaultMppSessionBudget = resolveMppSessionBudget(config.mppSessionBudget);
  const raw = (config.providers ?? {}) as Record<string, ProviderConfig>;
  const entries =
    Object.entries(raw).length > 0
      ? Object.entries(raw).map(([id, provider]) => ({
          id,
          baseUrl: provider.baseUrl || DEFAULT_SURF_BASE_URL,
          upstreamUrl: provider.upstreamUrl || DEFAULT_SURF_UPSTREAM_URL,
          protocol: resolveProtocol(provider.protocol, defaultProtocol),
          mppSessionBudget: resolveMppSessionBudget(
            provider.mppSessionBudget,
            defaultMppSessionBudget,
          ),
          models:
            provider.models && provider.models.length > 0 ? provider.models : DEFAULT_SURF_MODELS,
        }))
      : [
          {
            id: DEFAULT_SURF_PROVIDER_ID,
            baseUrl: DEFAULT_SURF_BASE_URL,
            upstreamUrl: DEFAULT_SURF_UPSTREAM_URL,
            protocol: defaultProtocol,
            mppSessionBudget: defaultMppSessionBudget,
            models: DEFAULT_SURF_MODELS,
          },
        ];

  return {
    providers: entries,
    models: entries.flatMap((provider) =>
      provider.models.map((model) => ({ ...model, provider: provider.id })),
    ),
  };
}

export function routePrefixForBaseUrl(baseUrl: string): string {
  const segments = baseUrl.split("/").filter(Boolean);
  return segments.length > 0 ? `/${segments[0]}` : "/";
}

export function resolveProtocol(
  value: unknown,
  fallback: PaymentProtocol = DEFAULT_PROVIDER_PROTOCOL,
): PaymentProtocol {
  return value === "x402" || value === "mpp" || value === "auto" ? value : fallback;
}

export function resolveMppSessionBudget(
  value: unknown,
  fallback = DEFAULT_MPP_SESSION_BUDGET,
): string {
  return typeof value === "string" && value.trim().length > 0 ? value : fallback;
}
