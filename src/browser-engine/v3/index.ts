// @ts-nocheck
import * as PublicApi from "./types/public/index.js";
import { V3 } from "./v3.js";
import { AnnotatedScreenshotText, LLMClient } from "./llm/LLMClient.js";
// No AgentProvider
import {
  validateZodSchema,
  isRunningInBun,
  toGeminiSchema,
  getZodType,
  transformSchema,
  injectUrls,
  providerEnvVarMap,
  loadApiKeyFromEnv,
  trimTrailingTextNode,
  jsonSchemaToZod,
} from "../utils.js";
import { isZod4Schema, isZod3Schema, toJsonSchema } from "./zodCompat.js";
// No mcp connection
import { V3Evaluator } from "../v3Evaluator.js";
import { tool } from "ai";
import { getAISDKLanguageModel } from "./llm/LLMProvider.js";
import { __internalCreateInMemoryAgentCacheHandle } from "./cache/serverAgentCache.js";
import { maybeRunShutdownSupervisorFromArgv } from "./shutdown/supervisor.js";

export { V3 } from "./v3.js";
export { V3 as BrowserCore } from "./v3.js";

export * from "./types/public/index.js";
export { AnnotatedScreenshotText, LLMClient } from "./llm/LLMClient.js";

// No agent tools

export {
  validateZodSchema,
  isRunningInBun,
  toGeminiSchema,
  getZodType,
  transformSchema,
  injectUrls,
  providerEnvVarMap,
  loadApiKeyFromEnv,
  trimTrailingTextNode,
  jsonSchemaToZod,
} from "../utils.js";
export { isZod4Schema, isZod3Schema, toJsonSchema } from "./zodCompat.js";

// No mcp server export
export { V3Evaluator } from "../v3Evaluator.js";
export { tool } from "ai";
export { getAISDKLanguageModel } from "./llm/LLMProvider.js";
export { __internalCreateInMemoryAgentCacheHandle } from "./cache/serverAgentCache.js";
export { maybeRunShutdownSupervisorFromArgv as __internalMaybeRunShutdownSupervisorFromArgv } from "./shutdown/supervisor.js";
export type { ServerAgentCacheHandle } from "./cache/serverAgentCache.js";

export type {
  ChatMessage,
  ChatMessageContent,
  ChatMessageImageContent,
  ChatMessageTextContent,
  ChatCompletionOptions,
  LLMResponse,
  CreateChatCompletionOptions,
  LLMUsage,
  LLMParsedResponse,
} from "./llm/LLMClient.js";

export type {
  BrowserCoreZodSchema,
  BrowserCoreZodObject,
  InferBrowserCoreSchema,
  JsonSchemaDocument,
} from "./zodCompat.js";

export type { JsonSchema, JsonSchemaProperty } from "../utils.js";

const BrowserCoreDefault = {
  ...PublicApi,
  V3,
  BrowserCore: V3,
  AnnotatedScreenshotText,
  LLMClient,
  validateZodSchema,
  isRunningInBun,
  toGeminiSchema,
  getZodType,
  transformSchema,
  injectUrls,
  providerEnvVarMap,
  loadApiKeyFromEnv,
  trimTrailingTextNode,
  jsonSchemaToZod,
  isZod4Schema,
  isZod3Schema,
  toJsonSchema,
  V3Evaluator,
  tool,
  getAISDKLanguageModel,
  __internalCreateInMemoryAgentCacheHandle,
  __internalMaybeRunShutdownSupervisorFromArgv:
    maybeRunShutdownSupervisorFromArgv,
};

export default BrowserCoreDefault;
