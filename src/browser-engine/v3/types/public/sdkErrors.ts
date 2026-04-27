// @ts-nocheck
import { ZodError } from "zod";
// Avoid .js extension so bundlers resolve TS source
// Pruned dangling import: ../../../version.js

export class BrowserCoreError extends Error {
  public readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export class BrowserCoreDefaultError extends BrowserCoreError {
  constructor(error?: unknown) {
    if (error instanceof Error || error instanceof BrowserCoreError) {
      super(
        `\nHey! We're sorry you ran into an error. \nBrowserCore version: ${BROWSER_CORE_VERSION} \nIf you need help, please open a Github issue or reach out to us on Discord: https://browser_core.dev/discord\n\nFull error:\n${error.message}`,
      );
    }
  }
}

export class BrowserCoreEnvironmentError extends BrowserCoreError {
  constructor(
    currentEnvironment: string,
    requiredEnvironment: string,
    feature: string,
  ) {
    super(
      `You seem to be setting the current environment to ${currentEnvironment}.` +
        `Ensure the environment is set to ${requiredEnvironment} if you want to use ${feature}.`,
    );
  }
}

export class MissingEnvironmentVariableError extends BrowserCoreError {
  constructor(missingEnvironmentVariable: string, feature: string) {
    super(
      `${missingEnvironmentVariable} is required to use ${feature}.` +
        `Please set ${missingEnvironmentVariable} in your environment.`,
    );
  }
}

export class UnsupportedModelError extends BrowserCoreError {
  constructor(supportedModels: string[], feature?: string) {
    const message = feature
      ? `${feature} requires a valid model.`
      : `Unsupported model.`;

    const guidance =
      `\n\nPlease use the provider/model format (e.g., "openai/gpt-4o", "anthropic/claude-sonnet-4-5", "google/gemini-3-flash-preview").` +
      `\n\nFor a complete list of supported models and providers, see: https://docs.browser_core.dev/v3/configuration/models#configuration-setup`;

    super(`${message}${guidance}`);
  }
}

export class UnsupportedModelProviderError extends BrowserCoreError {
  constructor(supportedProviders: string[], feature?: string) {
    super(
      feature
        ? `${feature} requires one of the following model providers: ${supportedProviders}`
        : `please use one of the supported model providers: ${supportedProviders}`,
    );
  }
}

export class UnsupportedAISDKModelProviderError extends BrowserCoreError {
  constructor(provider: string, supportedProviders: string[]) {
    super(
      `${provider} is not currently supported for aiSDK. please use one of the supported model providers: ${supportedProviders}`,
    );
  }
}

export class InvalidAISDKModelFormatError extends BrowserCoreError {
  constructor(modelName: string) {
    super(
      `${modelName} does not follow correct format for specifying aiSDK models. Please define your model as 'provider/model-name'. For example: \`model: 'openai/gpt-4o-mini'\``,
    );
  }
}

export class BrowserCoreNotInitializedError extends BrowserCoreError {
  constructor(prop: string) {
    super(
      `You seem to be calling \`${prop}\` on a page in an uninitialized \`BrowserCore\` object. ` +
        `Ensure you are running \`await browser_core.init()\` on the BrowserCore object before ` +
        `referencing the \`page\` object.`,
    );
  }
}

export class LocalProviderSessionNotFoundError extends BrowserCoreError {
  constructor() {
    super("No LocalProvider session ID found");
  }
}

export class CaptchaTimeoutError extends BrowserCoreError {
  constructor() {
    super("Captcha timeout");
  }
}

export class MissingLLMConfigurationError extends BrowserCoreError {
  constructor() {
    super(
      "No LLM API key or LLM Client configured. An LLM API key or a custom LLM Client " +
        "is required to use act, extract, or observe.",
    );
  }
}

export class HandlerNotInitializedError extends BrowserCoreError {
  constructor(handlerType: string) {
    super(`${handlerType} handler not initialized`);
  }
}

export class BrowserCoreInvalidArgumentError extends BrowserCoreError {
  constructor(message: string) {
    super(`InvalidArgumentError: ${message}`);
  }
}

export class CookieValidationError extends BrowserCoreError {
  constructor(message: string) {
    super(message);
  }
}

export class CookieSetError extends BrowserCoreError {
  constructor(message: string) {
    super(message);
  }
}

export class BrowserCoreElementNotFoundError extends BrowserCoreError {
  constructor(xpaths: string[]) {
    super(`Could not find an element for the given xPath(s): ${xpaths}`);
  }
}

export class AgentScreenshotProviderError extends BrowserCoreError {
  constructor(message: string) {
    super(`ScreenshotProviderError: ${message}`);
  }
}

export class BrowserCoreMissingArgumentError extends BrowserCoreError {
  constructor(message: string) {
    super(`MissingArgumentError: ${message}`);
  }
}

export class CreateChatCompletionResponseError extends BrowserCoreError {
  constructor(message: string) {
    super(`CreateChatCompletionResponseError: ${message}`);
  }
}

export class BrowserCoreEvalError extends BrowserCoreError {
  constructor(message: string) {
    super(`BrowserCoreEvalError: ${message}`);
  }
}

export class BrowserCoreDomProcessError extends BrowserCoreError {
  constructor(message: string) {
    super(`Error Processing Dom: ${message}`);
  }
}

export class BrowserCoreLocatorError extends BrowserCoreError {
  constructor(action: string, selector: string, message: string) {
    super(
      `Error ${action} Element with selector: ${selector} Reason: ${message}`,
    );
  }
}

export class BrowserCoreClickError extends BrowserCoreError {
  constructor(message: string, selector: string) {
    super(
      `Error Clicking Element with selector: ${selector} Reason: ${message}`,
    );
  }
}

export class LLMResponseError extends BrowserCoreError {
  constructor(primitive: string, message: string) {
    super(`${primitive} LLM response error: ${message}`);
  }
}

export class BrowserCoreIframeError extends BrowserCoreError {
  constructor(frameUrl: string, message: string) {
    super(
      `Unable to resolve frameId for iframe with URL: ${frameUrl} Full error: ${message}`,
    );
  }
}

export class ContentFrameNotFoundError extends BrowserCoreError {
  constructor(selector: string) {
    super(`Unable to obtain a content frame for selector: ${selector}`);
  }
}

export class XPathResolutionError extends BrowserCoreError {
  constructor(xpath: string) {
    super(`XPath "${xpath}" does not resolve in the current page or frames`);
  }
}

export class ExperimentalApiConflictError extends BrowserCoreError {
  constructor() {
    super(
      "`experimental` mode cannot be used together with the BrowserCore API. " +
        "To use experimental features, set experimental: true and disableAPI: true in the browser_core constructor. " +
        "To use the BrowserCore API, set experimental: false and disableAPI: false (or omit it) in the browser_core constructor.",
    );
  }
}

export class ExperimentalNotConfiguredError extends BrowserCoreError {
  constructor(featureName: string) {
    super(`Feature "${featureName}" is an experimental feature, and cannot be configured when disableAPI: false.
    Please set experimental: true and disableAPI: true in the browser_core constructor to use this feature.
    If you wish to use the BrowserCore API, please ensure ${featureName} is not defined in your function call,
    and set experimental: false, disableAPI: false (or omit it) in the BrowserCore constructor.`);
  }
}

export class CuaModelRequiredError extends BrowserCoreError {
  constructor(availableModels: readonly string[]) {
    super(
      `To use the computer use agent (CUA), please provide a CUA model in the agent constructor or browser_core config. ` +
        `Try one of our supported CUA models: ${availableModels.join(", ")}`,
    );
  }
}

export class ZodSchemaValidationError extends Error {
  constructor(
    public readonly received: unknown,
    public readonly issues: ReturnType<ZodError["format"]>,
  ) {
    super(`Zod schema validation failed

— Received —
${JSON.stringify(received, null, 2)}

— Issues —
${JSON.stringify(issues, null, 2)}`);
    this.name = "ZodSchemaValidationError";
  }
}

export class BrowserCoreInitError extends BrowserCoreError {
  constructor(message: string) {
    super(message);
  }
}

export class MCPConnectionError extends BrowserCoreError {
  public readonly serverUrl: string;
  public readonly originalError: unknown;

  constructor(serverUrl: string, originalError: unknown) {
    const errorMessage =
      originalError instanceof Error
        ? originalError.message
        : String(originalError);

    super(
      `Failed to connect to MCP server at "${serverUrl}". ${errorMessage}. ` +
        `Please verify the server URL is correct and the server is running.`,
    );

    this.serverUrl = serverUrl;
    this.originalError = originalError;
  }
}

export class BrowserCoreShadowRootMissingError extends BrowserCoreError {
  constructor(detail?: string) {
    super(
      `No shadow root present on the resolved host` +
        (detail ? `: ${detail}` : ""),
    );
  }
}

export class BrowserCoreShadowSegmentEmptyError extends BrowserCoreError {
  constructor() {
    super(`Empty selector segment after shadow-DOM hop ("//")`);
  }
}

export class BrowserCoreShadowSegmentNotFoundError extends BrowserCoreError {
  constructor(segment: string, hint?: string) {
    super(
      `Shadow segment '${segment}' matched no element inside shadow root` +
        (hint ? ` ${hint}` : ""),
    );
  }
}

export class ElementNotVisibleError extends BrowserCoreError {
  constructor(selector: string) {
    super(`Element not visible (no box model): ${selector}`);
  }
}

export class ResponseBodyError extends BrowserCoreError {
  constructor(message: string) {
    super(`Failed to retrieve response body: ${message}`);
  }
}

export class ResponseParseError extends BrowserCoreError {
  constructor(message: string) {
    super(`Failed to parse response: ${message}`);
  }
}

export class TimeoutError extends BrowserCoreError {
  constructor(operation: string, timeoutMs: number) {
    super(`${operation} timed out after ${timeoutMs}ms`);
  }
}

export class ActTimeoutError extends TimeoutError {
  constructor(timeoutMs: number) {
    super("act()", timeoutMs);
    this.name = "ActTimeoutError";
  }
}

export class ExtractTimeoutError extends TimeoutError {
  constructor(timeoutMs: number) {
    super("extract()", timeoutMs);
    this.name = "ExtractTimeoutError";
  }
}

export class ObserveTimeoutError extends TimeoutError {
  constructor(timeoutMs: number) {
    super("observe()", timeoutMs);
    this.name = "ObserveTimeoutError";
  }
}

export class PageNotFoundError extends BrowserCoreError {
  constructor(identifier: string) {
    super(`No Page found for ${identifier}`);
  }
}

export class ConnectionTimeoutError extends BrowserCoreError {
  constructor(message: string) {
    super(`Connection timeout: ${message}`);
  }
}

export class StreamingCallbacksInNonStreamingModeError extends BrowserCoreError {
  public readonly invalidCallbacks: string[];

  constructor(invalidCallbacks: string[]) {
    super(
      `Streaming-only callback(s) "${invalidCallbacks.join('", "')}" cannot be used in non-streaming mode. ` +
        `Set 'stream: true' in AgentConfig to use these callbacks.`,
    );
    this.invalidCallbacks = invalidCallbacks;
  }
}

export class AgentAbortError extends BrowserCoreError {
  public readonly reason: string;

  constructor(reason?: string) {
    const message = reason
      ? `Agent execution was aborted: ${reason}`
      : "Agent execution was aborted";
    super(message);
    this.reason = reason || "aborted";
  }
}

export class BrowserCoreClosedError extends BrowserCoreError {
  constructor() {
    super("BrowserCore session was closed");
  }
}

export class CdpConnectionClosedError extends BrowserCoreError {
  constructor(reason: string) {
    super(`CDP connection closed: ${reason}`);
  }
}

export class BrowserCoreSetExtraHTTPHeadersError extends BrowserCoreError {
  public readonly failures: string[];

  constructor(failures: string[]) {
    super(
      `setExtraHTTPHeaders failed for ${failures.length} session(s): ${failures.join(", ")}`,
    );
    this.failures = failures;
  }
}

export class BrowserCoreSnapshotError extends BrowserCoreError {
  constructor(cause?: unknown) {
    const suffix =
      cause instanceof Error
        ? `: ${cause.message}`
        : cause
          ? `: ${String(cause)}`
          : "";
    super(`error taking snapshot${suffix}`, cause);
  }
}

export class UnderstudyCommandException extends BrowserCoreError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "UnderstudyCommandException";
  }
}
