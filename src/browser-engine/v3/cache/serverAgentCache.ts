// @ts-nocheck
import { AgentCache } from "./AgentCache.js";
import { CacheStorage } from "./CacheStorage.js";
import type { V3 } from "../v3.js";
import type { AgentCacheTransferPayload } from "../types/private/index.js";
import type { ActHandler } from "../handlers/actHandler.js";
import type { V3Context } from "../understudy/context.js";
import type { AvailableModel, V3Options } from "../types/public/index.js";
import type { ModelConfiguration } from "../types/public/model.js";
import type { LLMClient } from "../llm/LLMClient.js";

export interface ServerAgentCacheHandle {
  complete(): AgentCacheTransferPayload | null;
  discard(): void;
}

// TODO (refactor-caching): this reflective access is a known temporary escape hatch.
// Once the caching internals are reworked, replace it with proper V3 helpers so
// we stop poking private fields from the outside.
function getInternalField<T>(instance: V3, key: string): T {
  return (instance as unknown as Record<string, unknown>)[key] as T;
}

function setInternalField(instance: V3, key: string, value: unknown): void {
  (instance as unknown as Record<string, unknown>)[key] = value;
}

function createMemoryAgentCache(browser_core: V3): AgentCache {
  const resolveLlmClient = getInternalField<
    (model?: ModelConfiguration) => LLMClient
  >(browser_core, "resolveLlmClient");

  return new AgentCache({
    storage: CacheStorage.createMemory(browser_core.logger),
    logger: browser_core.logger,
    getActHandler: () =>
      getInternalField<ActHandler | null>(browser_core, "actHandler"),
    getContext: () => getInternalField<V3Context | null>(browser_core, "ctx"),
    getDefaultLlmClient: () => resolveLlmClient.call(browser_core),
    getBaseModelName: () =>
      getInternalField<AvailableModel>(browser_core, "modelName"),
    getSystemPrompt: () =>
      getInternalField<V3Options>(browser_core, "opts").systemPrompt,
    domSettleTimeoutMs: getInternalField<number | undefined>(
      browser_core,
      "domSettleTimeoutMs",
    ),
    act: browser_core.act.bind(browser_core),
    bufferLatestEntry: true,
  });
}

export function __internalCreateInMemoryAgentCacheHandle(
  browser_core: V3,
): ServerAgentCacheHandle {
  const originalCache = getInternalField<AgentCache>(browser_core, "agentCache");
  const memoryCache = createMemoryAgentCache(browser_core);

  setInternalField(browser_core, "agentCache", memoryCache);
  let restored = false;
  const restore = () => {
    if (!restored) {
      setInternalField(browser_core, "agentCache", originalCache);
      restored = true;
    }
  };

  return {
    complete: () => {
      const entry = memoryCache.consumeBufferedEntry();
      restore();
      return entry;
    },
    discard: () => {
      restore();
    },
  };
}
