/**
 * Multi-provider LLM factory.
 *
 * Uses the Vercel AI SDK provider packages to support OpenAI, Anthropic,
 * Google Gemini, and any OpenAI-compatible API (Ollama, Together, etc.).
 *
 * Model strings follow the format "provider:model-id" or can be
 * auto-detected from well-known prefixes (gpt-*, claude-*, gemini-*).
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
    id: "claude-sonnet-4-20250514",
    value: "claude-sonnet-4-20250514",
    label: "Claude Sonnet 4",
    description: "Strong default for coding, planning, and agentic edits.",
    recommended: true,
  },
  {
    provider: "anthropic",
    id: "claude-3-5-sonnet-latest",
    value: "claude-3-5-sonnet-latest",
    label: "Claude 3.5 Sonnet",
    description: "Fast fallback Anthropic model when available on the account.",
  },
  {
    provider: "openai",
    id: "gpt-4o",
    value: "gpt-4o",
    label: "GPT-4o",
    description: "Balanced OpenAI default for coding and automation.",
    recommended: true,
  },
  {
    provider: "openai",
    id: "gpt-4.1",
    value: "gpt-4.1",
    label: "GPT-4.1",
    description: "Higher-capability OpenAI model for larger coding tasks.",
  },
  {
    provider: "openai",
    id: "gpt-4.1-mini",
    value: "gpt-4.1-mini",
    label: "GPT-4.1 Mini",
    description: "Lower-cost OpenAI model for simpler tasks.",
  },
  {
    provider: "openai",
    id: "gpt-4o-mini",
    value: "gpt-4o-mini",
    label: "GPT-4o Mini",
    description: "Fast low-cost OpenAI fallback.",
  },
  {
    provider: "google",
    id: "gemini-2.5-pro",
    value: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    description: "Strong Google model for coding and research.",
    recommended: true,
  },
  {
    provider: "google",
    id: "gemini-2.5-flash",
    value: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    description: "Fast Google model for routine automation.",
  },
];

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
 *   "openai:gpt-4o"
 *   "anthropic:claude-sonnet-4-20250514"
 *   "google:gemini-2.5-pro"
 *   "openai-compatible:my-local-model"
 *   "gpt-4o"                     → auto-detects openai
 *   "claude-sonnet-4-20250514"   → auto-detects anthropic
 *   "gemini-2.5-flash"           → auto-detects google
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
  if (configuredDefault) {
    const provider = inferProviderForModel(configuredDefault);
    if (provider && hasProviderAccess(provider)) return configuredDefault;
  }

  const available = listModelOptions();
  const recommended = available.find((model) => model.recommended);
  return recommended?.value ?? available[0]?.value ?? configuredDefault ?? "gpt-4o";
}
