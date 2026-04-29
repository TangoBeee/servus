/**
 * Multi-provider LLM factory.
 *
 * Uses the Vercel AI SDK provider packages to support OpenAI, Anthropic,
 * Google Gemini, and any OpenAI-compatible API (Ollama, Together, etc.).
 *
 * Model strings follow the format "provider:model-id" or can be
 * auto-detected from well-known provider model prefixes.
 */

import type { LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";

// ─── Provider Registry ──────────────────────────────────────────────────────

interface ProviderEntry {
  name: string;
  envKeys: string[];
  create: (opts?: Record<string, unknown>) => (modelId: string) => LanguageModel;
  prefixes: string[];
}

export interface ModelOption {
  provider: string;
  providerName: string;
  id: string;
  value: string;
  label: string;
  description: string;
  recommended?: boolean;
  inputPerM: number;
  outputPerM: number;
  cachedInputPerM?: number;
  contextWindow?: number;
  maxOutput?: number;
  pricingNote?: string;
  available: boolean;
}

const PROVIDERS: Record<string, ProviderEntry> = {
  openai: {
    name: "OpenAI",
    envKeys: ["OPENAI_API_KEY"],
    create: (opts) => {
      const sdk = createOpenAI(opts as Parameters<typeof createOpenAI>[0]);
      return (id: string) => sdk(id) as LanguageModel;
    },
    prefixes: ["gpt-", "o1-", "o3-", "o4-", "chatgpt-"],
  },
  anthropic: {
    name: "Anthropic",
    envKeys: ["ANTHROPIC_API_KEY"],
    create: (opts) => {
      const sdk = createAnthropic(opts as Parameters<typeof createAnthropic>[0]);
      return (id: string) => sdk(id) as LanguageModel;
    },
    prefixes: ["claude-"],
  },
  google: {
    name: "Google",
    envKeys: ["GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"],
    create: (opts) => {
      const sdk = createGoogleGenerativeAI(
        opts as Parameters<typeof createGoogleGenerativeAI>[0],
      );
      return (id: string) => sdk(id) as LanguageModel;
    },
    prefixes: ["gemini-", "models/gemini-"],
  },
  "openai-compatible": {
    name: "OpenAI-Compatible",
    envKeys: ["OPENAI_API_KEY"],
    create: (opts) => {
      const baseURL =
        (opts?.baseURL as string) ??
        process.env.OPENAI_BASE_URL ??
        process.env.OPENAI_API_BASE;
      if (!baseURL) {
        throw new Error(
          "openai-compatible provider requires OPENAI_BASE_URL or --provider-url",
        );
      }
      const sdk = createOpenAI({ baseURL, ...(opts as Record<string, unknown>) });
      return (id: string) => sdk(id) as LanguageModel;
    },
    prefixes: [],
  },
};

const MODEL_CATALOG: Array<Omit<ModelOption, "providerName" | "available">> = [
  {
    provider: "anthropic",
    id: "claude-sonnet-4-6",
    value: "claude-sonnet-4-6",
    label: "Sonnet 4.6",
    description: "Best Anthropic balance for coding agents, planning, and long-context edits.",
    recommended: true,
    inputPerM: 3,
    outputPerM: 15,
    cachedInputPerM: 0.3,
    contextWindow: 1_000_000,
    maxOutput: 64_000,
  },
  {
    provider: "anthropic",
    id: "claude-opus-4-7",
    value: "claude-opus-4-7",
    label: "Opus 4.7",
    description: "Most capable provider model for complex reasoning and agentic coding.",
    inputPerM: 5,
    outputPerM: 25,
    cachedInputPerM: 0.5,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
  },
  {
    provider: "anthropic",
    id: "claude-haiku-4-5-20251001",
    value: "claude-haiku-4-5-20251001",
    label: "Haiku 4.5",
    description: "Fast Anthropic model for lightweight turns and helper agents.",
    inputPerM: 1,
    outputPerM: 5,
    cachedInputPerM: 0.1,
    contextWindow: 200_000,
    maxOutput: 64_000,
  },
  {
    provider: "openai",
    id: "gpt-5.4",
    value: "gpt-5.4",
    label: "GPT-5.4",
    description: "Recommended OpenAI default for coding and professional agent work.",
    recommended: true,
    inputPerM: 2.5,
    outputPerM: 15,
    cachedInputPerM: 0.25,
    contextWindow: 1_050_000,
    maxOutput: 128_000,
    pricingNote: "Long context pricing applies above 272K input tokens.",
  },
  {
    provider: "openai",
    id: "gpt-5.5",
    value: "gpt-5.5",
    label: "GPT-5.5",
    description: "Highest-capability OpenAI model for difficult coding and research.",
    inputPerM: 5,
    outputPerM: 30,
    cachedInputPerM: 0.5,
    contextWindow: 1_000_000,
    maxOutput: 128_000,
  },
  {
    provider: "openai",
    id: "gpt-5.4-mini",
    value: "gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    description: "Cost-effective OpenAI model for helpers, routine coding, and automation.",
    inputPerM: 0.75,
    outputPerM: 4.5,
    cachedInputPerM: 0.075,
    contextWindow: 400_000,
    maxOutput: 128_000,
  },
  {
    provider: "openai",
    id: "gpt-5.2",
    value: "gpt-5.2",
    label: "GPT-5.2",
    description: "Strong OpenAI coding and agentic model with broad API support.",
    inputPerM: 1.75,
    outputPerM: 14,
    cachedInputPerM: 0.175,
    contextWindow: 400_000,
    maxOutput: 128_000,
  },
  {
    provider: "openai",
    id: "gpt-5.4-nano",
    value: "gpt-5.4-nano",
    label: "GPT-5.4 Nano",
    description: "Cheapest GPT-5.4-class OpenAI model for classification, extraction, ranking, and subagents.",
    inputPerM: 0.2,
    outputPerM: 1.25,
    cachedInputPerM: 0.02,
    contextWindow: 400_000,
    maxOutput: 128_000,
  },
  {
    provider: "google",
    id: "gemini-3-flash-preview",
    value: "gemini-3-flash-preview",
    label: "Gemini 3 Flash Preview",
    description: "Recommended Google default for fast frontier coding and agent work.",
    recommended: true,
    inputPerM: 0.5,
    outputPerM: 3,
    cachedInputPerM: 0.05,
    contextWindow: 1_048_576,
    maxOutput: 65_536,
  },
  {
    provider: "google",
    id: "gemini-3-pro-preview",
    value: "gemini-3-pro-preview",
    label: "Gemini 3 Pro Preview",
    description: "Google's strongest Gemini 3 model for multimodal and agentic reasoning.",
    inputPerM: 2,
    outputPerM: 12,
    cachedInputPerM: 0.2,
    contextWindow: 1_048_576,
    maxOutput: 65_536,
    pricingNote: "$2/$12 up to 200k input tokens; $4/$18 above 200k.",
  },
  {
    provider: "google",
    id: "gemini-2.5-pro",
    value: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    description: "Stable Google thinking model for complex code, data, and research tasks.",
    inputPerM: 1.25,
    outputPerM: 10,
    cachedInputPerM: 0.31,
    contextWindow: 1_048_576,
    maxOutput: 65_536,
  },
  {
    provider: "google",
    id: "gemini-2.5-flash-preview-09-2025",
    value: "gemini-2.5-flash-preview-09-2025",
    label: "Gemini 2.5 Flash Preview",
    description: "High-volume, low-latency Google model with thinking support.",
    inputPerM: 0.3,
    outputPerM: 2.5,
    cachedInputPerM: 0.03,
    contextWindow: 1_048_576,
    maxOutput: 65_536,
  },
  {
    provider: "google",
    id: "gemini-2.5-flash-lite-preview-09-2025",
    value: "gemini-2.5-flash-lite-preview-09-2025",
    label: "Gemini 2.5 Flash-Lite Preview",
    description: "Lowest-cost Google model for small helper and automation turns.",
    inputPerM: 0.1,
    outputPerM: 0.4,
    cachedInputPerM: 0.01,
    contextWindow: 1_048_576,
    maxOutput: 65_536,
  },
];

const STALE_BUNDLED_DEFAULTS = new Set([
  "claude-sonnet-4-20250514",
  "claude-3-5-sonnet-latest",
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-5-mini",
  "gpt-5-nano",
  "gemini-2.5-flash",
]);

// ─── Public API ─────────────────────────────────────────────────────────────

export interface ResolvedModel {
  model: LanguageModel;
  provider: string;
  modelId: string;
}

/**
 * Resolve a model string into a LanguageModel instance.
 *
 * Accepted formats:
 *   "provider:model-id"          → explicit provider
 *   "model-id"                   → auto-detect from prefix
 *
 * Examples:
 *   "openai:gpt-5.4"
 *   "anthropic:<model-id>"
 *   "google:gemini-3-flash-preview"
 *   "openai-compatible:my-local-model"
 *   "gpt-5.4"                    → auto-detects openai
 *   provider-native model ids     → auto-detected when their prefix is known
 *   "gemini-3-flash-preview"     → auto-detects google
 */
export function resolveModel(
  modelString: string,
  options?: { baseURL?: string },
): ResolvedModel {
  const colonIdx = modelString.indexOf(":");
  let providerKey: string | undefined;
  let modelId: string;

  // Check for explicit "provider:model" format
  // but skip if the colon looks like it's part of a URL or model version
  if (colonIdx > 0 && !modelString.startsWith("models/")) {
    const candidate = modelString.slice(0, colonIdx);
    if (PROVIDERS[candidate]) {
      providerKey = candidate;
      modelId = modelString.slice(colonIdx + 1);
    } else {
      modelId = modelString;
    }
  } else {
    modelId = modelString;
  }

  // Auto-detect provider from model prefix
  if (!providerKey) {
    for (const [key, entry] of Object.entries(PROVIDERS)) {
      if (entry.prefixes.some((p) => modelId.startsWith(p))) {
        providerKey = key;
        break;
      }
    }
  }

  if (!providerKey) {
    throw new Error(
      [
        `Cannot determine provider for model "${modelString}".`,
        `Use the format "provider:model-id" or set a known model prefix.`,
        `Supported providers: ${Object.keys(PROVIDERS).join(", ")}`,
      ].join("\n"),
    );
  }

  const entry = PROVIDERS[providerKey];

  // Check for API key
  const hasKey = entry.envKeys.some((k) => !!process.env[k]);
  if (!hasKey && providerKey !== "openai-compatible") {
    throw new Error(
      `Missing API key for ${entry.name}. Set one of: ${entry.envKeys.join(", ")}`,
    );
  }

  const factory = entry.create(options?.baseURL ? { baseURL: options.baseURL } : undefined);
  return {
    model: factory(modelId),
    provider: providerKey,
    modelId,
  };
}

/**
 * List all known providers and their required environment variables.
 */
export function listProviders(): Array<{ id: string; name: string; envKeys: string[] }> {
  return Object.entries(PROVIDERS).map(([id, e]) => ({
    id,
    name: e.name,
    envKeys: e.envKeys,
  }));
}

export function hasProviderAccess(provider: string): boolean {
  const entry = PROVIDERS[provider];
  if (!entry) return false;
  if (provider === "openai-compatible") {
    return !!(process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE);
  }
  return entry.envKeys.some((key) => !!process.env[key]);
}

export function inferProviderForModel(modelString: string): string | undefined {
  const colonIdx = modelString.indexOf(":");
  if (colonIdx > 0 && !modelString.startsWith("models/")) {
    const candidate = modelString.slice(0, colonIdx);
    if (PROVIDERS[candidate]) return candidate;
  }

  const modelId = colonIdx > 0 ? modelString.slice(colonIdx + 1) : modelString;
  for (const [key, entry] of Object.entries(PROVIDERS)) {
    if (entry.prefixes.some((prefix) => modelId.startsWith(prefix))) return key;
  }
  return undefined;
}

export function listModelOptions(opts: { includeUnavailable?: boolean } = {}): ModelOption[] {
  const models = MODEL_CATALOG.map((model) => {
    const provider = PROVIDERS[model.provider];
    return {
      ...model,
      providerName: provider?.name ?? model.provider,
      available: hasProviderAccess(model.provider),
    };
  });

  return opts.includeUnavailable ? models : models.filter((model) => model.available);
}

export function getDefaultModelForAvailableProvider(configuredDefault?: string): string {
  if (configuredDefault && !STALE_BUNDLED_DEFAULTS.has(configuredDefault)) {
    const provider = inferProviderForModel(configuredDefault);
    if (provider && hasProviderAccess(provider)) return configuredDefault;
  }

  const available = listModelOptions();
  const recommended = available.find((model) => model.recommended);
  return recommended?.value ?? available[0]?.value ?? configuredDefault ?? "gpt-5.4";
}

export function pricingForModel(provider: string, modelId: string): {
  inputPerM: number;
  outputPerM: number;
  cachedInputPerM?: number;
} {
  const normalized = modelId.toLowerCase();
  const exact = MODEL_CATALOG.find((model) =>
    model.provider === provider &&
    (model.id.toLowerCase() === normalized || model.value.toLowerCase() === normalized)
  );
  if (exact) {
    return {
      inputPerM: exact.inputPerM,
      outputPerM: exact.outputPerM,
      ...(exact.cachedInputPerM !== undefined ? { cachedInputPerM: exact.cachedInputPerM } : {}),
    };
  }

  const prefix = MODEL_CATALOG.find((model) =>
    model.provider === provider && normalized.startsWith(model.id.toLowerCase())
  );
  if (prefix) {
    return {
      inputPerM: prefix.inputPerM,
      outputPerM: prefix.outputPerM,
      ...(prefix.cachedInputPerM !== undefined ? { cachedInputPerM: prefix.cachedInputPerM } : {}),
    };
  }

  if (provider === "openai") return { inputPerM: 2.5, outputPerM: 15, cachedInputPerM: 0.25 };
  if (provider === "anthropic") return { inputPerM: 3, outputPerM: 15, cachedInputPerM: 0.3 };
  if (provider === "google") return { inputPerM: 0.5, outputPerM: 3, cachedInputPerM: 0.05 };
  return { inputPerM: 3, outputPerM: 15 };
}
