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

/** Known model metadata for cost/capability enrichment. */
const MODEL_METADATA: Record<string, Omit<ModelEntry, "provider" | "id">> = {
  "anthropic/claude-opus-4.6": {
    name: "Claude Opus 4.6",
    maxTokens: 200000,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.015, output: 0.075, cacheRead: 0.0015, cacheWrite: 0.01875 },
    contextWindow: 200000,
  },
  "anthropic/claude-opus-4.5": {
    name: "Claude Opus 4.5",
    maxTokens: 200000,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.015, output: 0.075, cacheRead: 0.0015, cacheWrite: 0.01875 },
    contextWindow: 200000,
  },
  "anthropic/claude-sonnet-4.6": {
    name: "Claude Sonnet 4.6",
    maxTokens: 200000,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.003, output: 0.015, cacheRead: 0.0003, cacheWrite: 0.00375 },
    contextWindow: 200000,
  },
  "anthropic/claude-sonnet-4.5": {
    name: "Claude Sonnet 4.5",
    maxTokens: 200000,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0.003, output: 0.015, cacheRead: 0.0003, cacheWrite: 0.00375 },
    contextWindow: 200000,
  },
  "x-ai/grok-4.20-beta": {
    name: "Grok 4.20 Beta",
    maxTokens: 131072,
    reasoning: true,
    input: ["text"],
    cost: { input: 0.003, output: 0.015, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
  },
  "x-ai/grok-4.1-fast": {
    name: "Grok 4.1 Fast",
    maxTokens: 131072,
    reasoning: false,
    input: ["text"],
    cost: { input: 0.001, output: 0.005, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
  },
  "minimax/minimax-m2.7": {
    name: "MiniMax M2.7",
    maxTokens: 1000000,
    reasoning: false,
    input: ["text"],
    cost: { input: 0.001, output: 0.005, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
  },
  "minimax/minimax-m2.5": {
    name: "MiniMax M2.5",
    maxTokens: 1000000,
    reasoning: false,
    input: ["text"],
    cost: { input: 0.001, output: 0.005, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
  },
  "moonshotai/kimi-k2.5": {
    name: "Kimi K2.5",
    maxTokens: 131072,
    reasoning: true,
    input: ["text"],
    cost: { input: 0.002, output: 0.008, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
  },
  "z-ai/glm-5": {
    name: "GLM-5",
    maxTokens: 128000,
    reasoning: false,
    input: ["text"],
    cost: { input: 0.001, output: 0.005, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
  },
  "z-ai/glm-5-turbo": {
    name: "GLM-5 Turbo",
    maxTokens: 128000,
    reasoning: false,
    input: ["text"],
    cost: { input: 0.001, output: 0.005, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
  },
  "qwen/qwen-2.5-7b-instruct": {
    name: "Qwen 2.5 7B Instruct",
    maxTokens: 32768,
    reasoning: false,
    input: ["text"],
    cost: { input: 0.0005, output: 0.002, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
  },
  "stepfun/step-3.5-flash": {
    name: "Step 3.5 Flash",
    maxTokens: 131072,
    reasoning: false,
    input: ["text"],
    cost: { input: 0.001, output: 0.005, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
  },
  "xiaomi/mimo-v2-pro": {
    name: "MiMo V2 Pro",
    maxTokens: 131072,
    reasoning: true,
    input: ["text"],
    cost: { input: 0.001, output: 0.005, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131072,
  },
};

const DEFAULT_CONTEXT_WINDOW = 131072;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function modelFromId(id: string): Omit<ModelEntry, "provider"> {
  const known = MODEL_METADATA[id];
  if (known) return { id, ...known };
  const raw = id.split("/").pop() ?? id;
  const name = raw.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return {
    id,
    name,
    maxTokens: DEFAULT_CONTEXT_WINDOW,
    reasoning: false,
    input: ["text"],
    cost: ZERO_COST,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
  };
}

/** Static fallback models used when upstream fetch fails. */
export const DEFAULT_SURF_MODELS: Array<Omit<ModelEntry, "provider">> =
  Object.keys(MODEL_METADATA).map(modelFromId);

const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;
let modelsCache: { models: Array<Omit<ModelEntry, "provider">>; fetchedAt: number } | null = null;

export async function fetchUpstreamModels(
  upstreamUrl: string,
): Promise<Array<Omit<ModelEntry, "provider">>> {
  if (modelsCache && Date.now() - modelsCache.fetchedAt < MODELS_CACHE_TTL_MS) {
    return modelsCache.models;
  }
  try {
    const res = await globalThis.fetch(`${upstreamUrl}/v1/models`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return modelsCache?.models ?? DEFAULT_SURF_MODELS;
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    if (!data.data?.length) return modelsCache?.models ?? DEFAULT_SURF_MODELS;
    const models = data.data.map((m) => modelFromId(m.id));
    modelsCache = { models, fetchedAt: Date.now() };
    return models;
  } catch {
    return modelsCache?.models ?? DEFAULT_SURF_MODELS;
  }
}

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
