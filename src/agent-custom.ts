/**
 * Custom AI SDK agent backend.
 *
 * Uses the Vercel AI SDK v6 (`streamText` + tool definitions) to run an
 * autonomous agent loop with any supported LLM provider (OpenAI,
 * Anthropic, Google, or OpenAI-compatible endpoints).
 *
 * The agent manages its own conversation history across multiple
 * `send()` calls, enabling persistent multi-turn sessions.
 */

import {
  streamText,
  stepCountIs,
  type ModelMessage,
  type ToolSet,
  type StepResult,
} from "ai";
import type { LanguageModel } from "ai";
import type { IAgent, AgentConfig, AgentResponse, AgentFinalization, AgentToolEvent } from "./agent.js";
import type { TaskDomain } from "./engine.js";
import { pricingForModel, resolveModel } from "./provider.js";
import { createTools } from "./tools.js";
import { createFinishTools } from "./tools-finish.js";
import { wrapToolSetWithRegistry } from "./ai-tool-registry-adapter.js";
import { log, ANSI } from "./log.js";
import { bus } from "./events.js";
import { loadConfig } from "./config.js";
import { buildSkillsPrompt, loadSkills, selectSkillsForTask } from "./skills.js";
import type { SkillManifest } from "./runtime.js";
import {
  appendCompactionLog,
  loadAgentHistory,
  saveAgentHistory,
  shouldCompactContext,
  estimateMessageTokens,
} from "./context-manager.js";
import {
  loadCodingSettings,
  runCodingHooks,
  type CodingHookEvent,
  type CodingHookRunResult,
  type CodingSettings,
} from "./coding-settings.js";
import { loadPlugins, selectPluginsForTask } from "./plugins.js";
import type { PluginManifest } from "./runtime.js";

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_STEPS = 100;
const MAX_HISTORY = 80;
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_DELAY_MS = 8000;

type AiToolLike = {
  description?: string;
  inputSchema?: unknown;
  execute?: (input: unknown, options?: { abortSignal?: AbortSignal }) => Promise<unknown> | unknown;
};

// ─── Custom Agent ───────────────────────────────────────────────────────────

export class CustomAgent implements IAgent {
  readonly name: string;
  readonly role: string;
  readonly color: string;

  private model: LanguageModel;
  private provider: string;
  private modelId: string;
  private systemPrompt: string;
  private history: ModelMessage[] = [];
  private tools: ToolSet;
  private cwd: string;
  private domain: TaskDomain;
  private skills: SkillManifest[] = [];
  private plugins: PluginManifest[] = [];
  private activePlugins: PluginManifest[] = [];
  private maxSkillsPromptChars: number;
  private totalCost = 0;
  private totalTokens = { input: 0, output: 0 };
  private sessionId?: string;
  private finalization?: AgentFinalization;
  private toolEvents: AgentToolEvent[] = [];
  private settings: CodingSettings;

  constructor(config: AgentConfig, cwd: string) {
    this.name = config.name;
    this.role = config.role;
    this.color = config.color;
    this.systemPrompt = config.prompt;
    this.cwd = cwd;
    this.sessionId = config.sessionId;
    this.domain = config.domain ?? inferDomainFromAgent(config.name, config.role);
    this.settings = loadCodingSettings(cwd);

    const servusConfig = loadConfig();
    this.maxSkillsPromptChars = servusConfig.skills?.maxPromptChars ?? 24_000;
    if (servusConfig.skills?.enabled !== false) {
      this.skills = loadSkills({
        cwd,
        extraDirs: servusConfig.skills?.dirs,
        maxPromptChars: this.maxSkillsPromptChars,
      });
      if (this.skills.length > 0) {
        bus.push({
          type: "skill:load",
          agent: this.name,
          message: `${this.skills.length} skills available`,
          metadata: { count: this.skills.length },
        });
      }
    }
    if (servusConfig.plugins?.enabled !== false) {
      this.plugins = loadPlugins({
        cwd,
        extraDirs: servusConfig.plugins?.dirs,
        disabled: servusConfig.plugins?.disabled,
      });
      this.activePlugins = selectPluginsForTask("", this.domain, this.plugins);
      if (this.plugins.length > 0) {
        bus.push({
          type: "plugin:load",
          agent: this.name,
          message: `${this.plugins.length} plugin manifests available`,
          metadata: {
            count: this.plugins.length,
            activeCount: this.activePlugins.length,
            domain: this.domain,
            plugins: this.plugins.map((plugin) => ({
              id: plugin.id,
              version: plugin.version,
              active: this.activePlugins.some((active) => active.id === plugin.id),
            })),
          },
        });
      }
    }

    const resolved = resolveModel(config.model);
    this.model = resolved.model;
    this.provider = resolved.provider;
    this.modelId = resolved.modelId;
    this.history = loadAgentHistory(this.sessionId, this.name);

    const rawTools = {
      ...createTools(cwd, { sessionId: this.sessionId, agentName: this.name }),
      ...(config.extraTools ?? {}),
      ...createFinishTools((finalization) => {
        this.finalization = finalization;
      }, { agentName: this.name, color: this.color }),
    } as ToolSet;
    for (const name of expandDisallowedToolNames(config.disallowedTools ?? [])) {
      delete (rawTools as Record<string, unknown>)[name];
    }
    this.tools = wrapToolSetWithRegistry(
      wrapToolSetWithAgentHooks(rawTools, {
        cwd,
        agentName: this.name,
        sessionId: this.sessionId,
        settings: this.settings,
      }),
      cwd,
    );

    void this.runLifecycleHooks("SessionStart");

    log.agent(
      this.name,
      this.color,
      `${ANSI.dim}initialized (${resolved.provider}:${resolved.modelId})${ANSI.reset}`,
    );
  }

  async send(message: string): Promise<AgentResponse> {
    this.finalization = undefined;
    this.toolEvents = [];
    const promptHooks = await this.runLifecycleHooks("UserPromptSubmit", {
      toolInput: { message },
    });
    const promptBlock = blockedHookResult(promptHooks);
    if (promptBlock) {
      const text = `Blocked by Servus hook: ${summarizeHookBlock(promptBlock)}`;
      this.history.push({ role: "user" as const, content: message });
      this.history.push({ role: "assistant" as const, content: text });
      this.persistHistory();
      return {
        text,
        cost: this.totalCost,
        turns: 0,
        subtype: "blocked_by_hook",
        finalization: this.finalization,
        toolEvents: this.toolEvents,
      };
    }
    this.history.push({ role: "user" as const, content: message });
    await this.compactIfNeeded("before_send", message);
    this.sanitizeHistoryForProvider("before_send");
    this.persistHistory();

    log.agent(this.name, this.color, "working...");

    let totalText = "";
    let steps = 0;
    let finishReason = "unknown";

    const doStream = () =>
      streamText({
        model: this.model,
        system: this.buildSystemPrompt(message),
        messages: this.history,
        tools: this.tools,
        stopWhen: stepCountIs(MAX_STEPS),
        onStepFinish: (step: StepResult<ToolSet>) => {
          steps++;
          if (step.usage) {
            this.totalTokens.input += step.usage.inputTokens ?? 0;
            this.totalTokens.output += step.usage.outputTokens ?? 0;
          }
        },
      });

    let lastErr: unknown;
    let result: Awaited<ReturnType<typeof streamText>> | null = null;
    let streamProtocolError = false;

    for (let attempt = 0; attempt < RATE_LIMIT_RETRIES; attempt++) {
      try {
        result = await doStream();
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        const isRateLimit =
          /rate_limit|Rate limit|tokens per min|Request too large/i.test(msg);
        const retryAfter = msg.match(/try again in ([\d.]+)s/i);
        const delayMs = retryAfter
          ? Math.ceil(parseFloat(retryAfter[1]) * 1000) + 500
          : RATE_LIMIT_DELAY_MS;
        if (isRateLimit && attempt < RATE_LIMIT_RETRIES - 1) {
          log.agent(
            this.name,
            this.color,
            `${ANSI.yellow}Rate limit hit, retrying in ${Math.ceil(delayMs / 1000)}s...${ANSI.reset}`,
          );
          await new Promise((r) => setTimeout(r, delayMs));
        } else {
          throw e;
        }
      }
    }

    if (!result) throw lastErr;

    let streamRateLimit = false;
    try {
      for await (const part of result.fullStream) {
        switch (part.type) {
          case "text-delta":
            totalText += part.text;
            emitAssistantDelta(this.name, this.color, part.text);
            log.agentText(this.name, this.color, part.text);
            break;

          case "tool-call": {
            const summary = summarizeInput(part.input);
            const toolCallId = typeof (part as { toolCallId?: unknown }).toolCallId === "string"
              ? (part as { toolCallId: string }).toolCallId
              : undefined;
            this.toolEvents.push({
              type: "call",
              toolName: part.toolName,
              ...(toolCallId ? { toolCallId } : {}),
              input: part.input,
              timestamp: Date.now(),
            });
            bus.push({
              type: "tool:start",
              agent: this.name,
              color: this.color,
              message: `${part.toolName}(${summary})`,
              metadata: { tool: part.toolName, input: part.input },
            });
            if (bus.interactive) {
              bus.push({
                type: "agent:tool_call",
                agent: this.name,
                color: this.color,
                message: `${part.toolName}(${summary})`,
              });
            } else {
              log.agent(
                this.name,
                this.color,
                `${ANSI.dim}→ ${part.toolName}(${summary})${ANSI.reset}`,
              );
            }
            break;
          }

          case "tool-result": {
            const raw = summarizeToolOutput(part.output);
            const resultPart = part as { toolName?: unknown; toolCallId?: unknown };
            const toolCallId = typeof resultPart.toolCallId === "string" ? resultPart.toolCallId : undefined;
            const toolName = typeof resultPart.toolName === "string"
              ? resultPart.toolName
              : toolCallId
                ? findLastToolEvent(this.toolEvents, (event) => event.type === "call" && event.toolCallId === toolCallId)?.toolName
                : findLastToolEvent(this.toolEvents, (event) => event.type === "call")?.toolName;
            this.toolEvents.push({
              type: "result",
              toolName: toolName ?? "unknown",
              ...(toolCallId ? { toolCallId } : {}),
              output: part.output,
              timestamp: Date.now(),
            });
            const firstLine = raw.split("\n")[0] ?? "";
            const preview = firstLine.slice(0, 80);
            bus.push({
              type: "tool:finish",
              agent: this.name,
              color: this.color,
              message: preview || "done",
              metadata: { tool: toolName ?? "unknown", output: raw.slice(0, 1000) },
            });
            if (bus.interactive) {
              bus.push({
                type: "agent:tool_result",
                agent: this.name,
                color: this.color,
                message: preview || "done",
              });
            } else {
              log.agent(
                this.name,
                this.color,
                `${ANSI.dim}← ${preview || "done"}${ANSI.reset}`,
              );
            }
            break;
          }

          case "error": {
            const errObj = (part as { error?: { type?: string; code?: string; message?: string } }).error;
            const errMsg =
              errObj && typeof errObj === "object"
                ? errObj.message ??
                  JSON.stringify(errObj)
                : String(errObj ?? "unknown error");
            const isTokenRateLimit =
              !!errObj &&
              (errObj.type === "tokens" ||
                errObj.code === "rate_limit_exceeded" ||
                /tokens per min|Request too large|rate_limit/i.test(errMsg));
            if (isTokenRateLimit) streamRateLimit = true;
            if (isProviderToolProtocolError(errMsg)) streamProtocolError = true;
            if (bus.interactive) {
              bus.push({
                type: "agent:error",
                agent: this.name,
                color: this.color,
                message: errMsg,
              });
            } else {
              log.agent(this.name, this.color, `${ANSI.red}error: ${errMsg}${ANSI.reset}`);
            }
            // Stop processing further parts on a stream-level rate limit error.
            if (isTokenRateLimit) {
              throw new Error(`stream_rate_limit: ${errMsg}`);
            }
            if (streamProtocolError) {
              throw new Error(`stream_tool_protocol: ${errMsg}`);
            }
            break;
          }

          default:
            break;
        }
      }

      if (totalText && !bus.interactive) process.stdout.write("\n");

      finishReason = await result.finishReason;

      this.totalCost = estimateCost(
        this.provider,
        this.modelId,
        this.totalTokens.input,
        this.totalTokens.output,
      );

      if (bus.interactive) {
        bus.push({
          type: "cost",
          agent: this.name,
          message: "cost update",
          metadata: {
            cost: this.totalCost,
            provider: this.provider,
            modelId: this.modelId,
            inputTokens: this.totalTokens.input,
            outputTokens: this.totalTokens.output,
          },
        });
      }

      // Append response messages to history for multi-turn context
      try {
        const response = await result.response;
        if (response.messages) {
          for (const msg of response.messages) {
            this.history.push(msg as ModelMessage);
          }
        }
      } catch {
        if (totalText) {
          this.history.push({
            role: "assistant" as const,
            content: totalText,
          });
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.agent(
        this.name,
        this.color,
        `${ANSI.red}error: ${msg}${ANSI.reset}`,
      );

      // For stream-level token / rate-limit errors, surface a special subtype so
      // the orchestrator can treat this as transient rather than a logical failure.
      if (streamRateLimit) {
        this.history.push({
          role: "assistant" as const,
          content: `[Agent notice: stream rate limit or token cap hit. Context may be too large; please retry with a smaller window or after a short delay.]`,
        });
        await this.compactIfNeeded("stream_rate_limit", message, true);
        this.sanitizeHistoryForProvider("stream_rate_limit");
        this.persistHistory();
        await this.runLifecycleHooks("StopFailure", {
          toolOutput: `Rate limit / token cap hit: ${msg}`,
          isError: true,
        });
        return {
          text: `Rate limit / token cap hit: ${msg}`,
          cost: this.totalCost,
          turns: steps,
          subtype: "error_rate_limit",
          finalization: this.finalization,
          toolEvents: this.toolEvents,
        };
      }

      if (streamProtocolError || isProviderToolProtocolError(msg)) {
        this.sanitizeHistoryForProvider("stream_protocol_error");
        this.history.push({
          role: "assistant" as const,
          content:
            "[Agent notice: model/tool stream protocol error. Servus sanitized tool history and the run can be resumed in the same session.]",
        });
        this.persistHistory();
        await this.runLifecycleHooks("StopFailure", {
          toolOutput: `Transient model/tool stream error: ${stripInternalErrorPrefix(msg)}`,
          isError: true,
        });
        return {
          text: `Transient model/tool stream error: ${stripInternalErrorPrefix(msg)}`,
          cost: this.totalCost,
          turns: steps,
          subtype: "error_stream_protocol",
          finalization: this.finalization,
          toolEvents: this.toolEvents,
        };
      }

      this.history.push({
        role: "assistant" as const,
        content: `[Agent error: ${msg}]`,
      });
      this.persistHistory();
      await this.runLifecycleHooks("StopFailure", {
        toolOutput: `Error: ${msg}`,
        isError: true,
      });

      return {
        text: `Error: ${msg}`,
        cost: this.totalCost,
        turns: steps,
        subtype: "error_during_execution",
        finalization: this.finalization,
        toolEvents: this.toolEvents,
      };
    }

    const subtype =
      finishReason === "stop"
        ? "success"
        : finishReason === "length"
          ? "error_max_turns"
          : finishReason;

    log.agent(
      this.name,
      this.color,
      `${ANSI.dim}done (steps: ${steps}, tokens: ${this.totalTokens.input + this.totalTokens.output}, cost: ~$${this.totalCost.toFixed(4)}, reason: ${finishReason})${ANSI.reset}`,
    );
    await this.compactIfNeeded("after_send", message);
    this.sanitizeHistoryForProvider("after_send");
    this.persistHistory();
    await this.runLifecycleHooks("Stop", {
      toolOutput: totalText,
    });

    return {
      text: totalText,
      cost: this.totalCost,
      turns: steps,
      subtype,
      finalization: this.finalization,
      toolEvents: this.toolEvents,
    };
  }

  get cost(): number {
    return this.totalCost;
  }

  close(): void {
    this.persistHistory();
    if (!this.sessionId) this.history = [];
  }

  private buildSystemPrompt(message: string): string {
    const sections = [this.systemPrompt];

    if (this.plugins.length > 0) {
      const selectedPlugins = selectPluginsForTask(message, this.domain, this.plugins);
      this.activePlugins = selectedPlugins;
      const pluginsPrompt = buildPluginsPrompt(selectedPlugins);
      if (pluginsPrompt) {
        sections.push(
          "",
          "# Active Servus Plugins",
          "These local plugin manifests are active for this task/domain. Plugin MCP servers are available through the Servus MCP tools when configured.",
          "",
          pluginsPrompt,
        );
      }
    }

    if (this.skills.length === 0) return sections.join("\n");

    const selected = selectSkillsForTask(message, this.skills);
    if (selected.length === 0) return sections.join("\n");

    const skillsPrompt = buildSkillsPrompt(selected, this.maxSkillsPromptChars);
    if (!skillsPrompt) return sections.join("\n");

    sections.push(
      "",
      "# Relevant Servus Skills",
      "Use these local skills when they match the current task. Respect each skill's allowed tools.",
      "",
      skillsPrompt,
    );
    return sections.join("\n");
  }

  private async runLifecycleHooks(
    event: CodingHookEvent,
    extra: Partial<{
      toolName: string;
      toolInput: unknown;
      toolOutput: string;
      isError: boolean;
    }> = {},
  ): Promise<CodingHookRunResult[]> {
    const results = await runCodingHooks(this.settings, event, {
      event,
      cwd: this.cwd,
      agentName: this.name,
      sessionId: this.sessionId,
      ...extra,
    });
    if (results.length > 0) {
      bus.push({
        type: "agent:hook",
        agent: this.name,
        color: this.color,
        message: `${event}: ${results.length} hook${results.length === 1 ? "" : "s"}`,
        metadata: {
          event,
          blocked: results.some((result) => result.blocked),
          results: results.map((result) => ({
            ok: result.ok,
            blocked: result.blocked,
            source: result.source,
            durationMs: result.durationMs,
            output: result.output.slice(0, 2000),
          })),
        },
      });
    }
    return results;
  }

  private async compactIfNeeded(reason: string, currentMessage: string, force = false): Promise<void> {
    const system = this.buildSystemPrompt(currentMessage);
    const assessment = shouldCompactContext(this.history, system, this.modelId);
    if (!force && !assessment.shouldCompact && this.history.length <= MAX_HISTORY) return;

    const keepRecent = Math.min(
      assessment.budget.keepRecentMessages,
      Math.max(8, Math.floor(MAX_HISTORY / 2)),
    );
    const splitIndex = Math.max(0, this.history.length - keepRecent);
    const older = this.history.slice(0, splitIndex);
    const recent = this.history.slice(splitIndex);
    if (older.length === 0) return;

    const beforeTokens = assessment.estimatedTokens;
    try {
      bus.push({
        type: "context:compact",
        agent: this.name,
        color: this.color,
        message: `Compacting ${older.length} older messages for ${this.modelId}`,
        metadata: {
          reason,
          modelId: this.modelId,
          estimatedTokens: beforeTokens,
          compactAtTokens: assessment.budget.compactAtTokens,
          sessionId: this.sessionId,
        },
      });

      const summaryResult = await streamText({
        model: this.model,
        system:
          "You compact context for Servus, an autonomous AI agent. Preserve facts needed to continue the same session: user intent, answered clarifications, decisions, tool results, browser/page state, files changed, failures, pending approvals, and next steps. Be concise, factual, and do not invent.",
        messages: [
          {
            role: "user" as const,
            content: [
              "Compact these older messages into a durable session summary.",
              "Keep user-provided answers and unresolved constraints explicit.",
              "",
              JSON.stringify(older),
            ].join("\n"),
          },
        ],
        stopWhen: stepCountIs(1),
      });

      let summaryText = "";
      for await (const part of summaryResult.fullStream) {
        if (part.type === "text-delta") summaryText += part.text;
      }

      const summary = summaryText.trim();
      if (summary) {
        this.history = [
          {
            role: "assistant" as const,
            content: `[Servus context summary after compaction]\n${summary}`,
          },
          ...recent,
        ];
      } else {
        this.history = this.history.slice(-keepRecent);
      }
    } catch (err: unknown) {
      this.history = this.history.slice(-keepRecent);
      bus.push({
        type: "context:compact",
        agent: this.name,
        color: this.color,
        message: `Context compaction fallback used for ${this.modelId}`,
        metadata: {
          reason,
          modelId: this.modelId,
          error: err instanceof Error ? err.message : String(err),
          sessionId: this.sessionId,
        },
      });
    }

    const afterTokens = estimateMessageTokens(this.history) + estimateMessageTokens(system);
    appendCompactionLog(this.sessionId, this.name, {
      reason,
      modelId: this.modelId,
      beforeTokens,
      afterTokens,
      keptRecentMessages: recent.length,
    });
  }

  private sanitizeHistoryForProvider(reason: string): void {
    const result = sanitizeToolHistory(this.history);
    if (result.removed === 0) return;

    this.history = result.messages;
    bus.push({
      type: "context:compact",
      agent: this.name,
      color: this.color,
      message: `Removed ${result.removed} orphaned tool history item${result.removed === 1 ? "" : "s"}`,
      metadata: {
        reason,
        modelId: this.modelId,
        sessionId: this.sessionId,
        removed: result.removed,
      },
    });
  }

  private persistHistory(): void {
    const estimatedTokens = estimateMessageTokens(this.history) + estimateMessageTokens(this.systemPrompt);
    saveAgentHistory(this.sessionId, this.name, this.modelId, this.history, estimatedTokens);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function wrapToolSetWithAgentHooks(
  tools: ToolSet,
  context: {
    cwd: string;
    agentName: string;
    sessionId?: string;
    settings: CodingSettings;
  },
): ToolSet {
  const wrapped: Record<string, unknown> = {};

  for (const [name, rawTool] of Object.entries(tools as Record<string, unknown>)) {
    if (!isAiToolLike(rawTool)) {
      wrapped[name] = rawTool;
      continue;
    }

    wrapped[name] = {
      ...rawTool,
      execute: async (input: unknown, options?: { abortSignal?: AbortSignal }) => {
        const pre = await runCodingHooks(context.settings, "PreToolUse", {
          event: "PreToolUse",
          cwd: context.cwd,
          agentName: context.agentName,
          sessionId: context.sessionId,
          toolName: name,
          toolInput: input,
        });
        const blocked = blockedHookResult(pre);
        if (blocked) {
          return `Error: blocked by Servus hook before ${name}: ${summarizeHookBlock(blocked)}`;
        }

        try {
          const output = await rawTool.execute!(input, options);
          await runCodingHooks(context.settings, "PostToolUse", {
            event: "PostToolUse",
            cwd: context.cwd,
            agentName: context.agentName,
            sessionId: context.sessionId,
            toolName: name,
            toolInput: input,
            toolOutput: summarizeToolOutput(output).slice(0, 20_000),
          });
          return output;
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          await runCodingHooks(context.settings, "PostToolUseFailure", {
            event: "PostToolUseFailure",
            cwd: context.cwd,
            agentName: context.agentName,
            sessionId: context.sessionId,
            toolName: name,
            toolInput: input,
            toolOutput: message,
            isError: true,
          });
          throw err;
        }
      },
    };
  }

  return wrapped as ToolSet;
}

function isAiToolLike(value: unknown): value is AiToolLike {
  return typeof value === "object" &&
    value !== null &&
    typeof (value as AiToolLike).execute === "function" &&
    "inputSchema" in value;
}

function blockedHookResult(results: CodingHookRunResult[]): CodingHookRunResult | undefined {
  return results.find((result) => result.blocked);
}

function summarizeHookBlock(result: CodingHookRunResult): string {
  const output = result.output.trim();
  if (output) return output.slice(0, 1000);
  return `${result.event} hook from ${result.source} returned a blocking result`;
}

function inferDomainFromAgent(name: string, role: string): TaskDomain {
  const text = `${name} ${role}`.toLowerCase();
  if (text.includes("browser")) return "browser";
  if (text.includes("desktop")) return "desktop";
  if (text.includes("media")) return "media";
  if (text.includes("data") || text.includes("document") || text.includes("spreadsheet")) return "data";
  if (text.includes("security") || text.includes("cyber")) return "security";
  if (text.includes("extension") || text.includes("plugin") || text.includes("skill")) return "extension";
  if (text.includes("developer") || text.includes("coding") || text.includes("code")) return "coding";
  return "general";
}

function buildPluginsPrompt(plugins: PluginManifest[]): string {
  const selected = plugins.slice(0, 12);
  if (selected.length === 0) return "";
  return selected.map((plugin) => {
    const lines = [
      `## Plugin: ${plugin.name ?? plugin.id}`,
      `ID: ${plugin.id}`,
      `Version: ${plugin.version}`,
      plugin.description ? `Description: ${plugin.description}` : "",
      plugin.tools?.length ? `Advertised tools: ${plugin.tools.join(", ")}` : "",
      plugin.skills?.length ? `Skills: ${plugin.skills.join(", ")}` : "",
      plugin.mcpServers ? `MCP servers: ${Object.keys(plugin.mcpServers).join(", ")}` : "",
      plugin.lspServers ? `LSP servers: ${Object.keys(plugin.lspServers).join(", ")}` : "",
    ].filter(Boolean);
    return lines.join("\n");
  }).join("\n\n");
}

function expandDisallowedToolNames(names: string[]): string[] {
  const aliases: Record<string, string[]> = {
    bash: ["bash", "Bash"],
    read: ["read", "Read"],
    write: ["write", "Write"],
    edit: ["edit", "Edit"],
    patch: ["patch"],
    grep: ["grep", "Grep"],
    glob: ["glob", "Glob"],
    ls: ["ls", "LS"],
    webfetch: ["webfetch", "WebFetch"],
    lsp: ["LSP", "lsp_status"],
    todowrite: ["todowrite", "TodoWrite"],
    task: ["Task"],
    mcp: ["mcp_list_servers", "McpListTools", "McpCallTool", "ListMcpResourcesTool", "ReadMcpResourceTool", "ListMcpPromptsTool", "GetMcpInstructionsTool", "TestMcpServerTool"],
    mcpcalltool: ["McpCallTool"],
    listmcpresourcestool: ["ListMcpResourcesTool"],
    readmcpresourcetool: ["ReadMcpResourceTool"],
  };
  const expanded = new Set<string>();
  for (const name of names) {
    expanded.add(name);
    const key = name.toLowerCase();
    for (const alias of aliases[key] ?? []) expanded.add(alias);
  }
  return [...expanded];
}

function summarizeInput(input: unknown): string {
  if (typeof input === "string") return input.slice(0, 60);
  if (typeof input === "object" && input !== null) {
    const entries = Object.entries(input as Record<string, unknown>);
    const parts = entries.slice(0, 2).map(([k, v]) => {
      const val = typeof v === "string" ? v.slice(0, 40) : JSON.stringify(v);
      return `${k}: ${val}`;
    });
    if (entries.length > 2) parts.push("...");
    return parts.join(", ");
  }
  return "";
}

function emitAssistantDelta(agent: string, color: string, text: string): void {
  if (!bus.interactive || !text) return;
  for (const char of text) {
    bus.push({
      type: "assistant:delta",
      agent,
      color,
      message: char,
    });
  }
}

function findLastToolEvent(
  events: AgentToolEvent[],
  predicate: (event: AgentToolEvent) => boolean,
): AgentToolEvent | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event && predicate(event)) return event;
  }
  return undefined;
}

function summarizeToolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  return JSON.stringify(output ?? "", (_key, value) => {
    if (typeof value === "string" && value.length > 400 && /^[A-Za-z0-9+/=]+$/.test(value)) {
      return `[base64 ${value.length} chars redacted]`;
    }
    if (isRecord(value) && typeof value.data === "string" && value.data.length > 400) {
      return { ...value, data: `[base64 ${value.data.length} chars redacted]` };
    }
    return value;
  });
}

function sanitizeToolHistory(history: ModelMessage[]): { messages: ModelMessage[]; removed: number } {
  const resultIds = new Set<string>();
  for (const message of history) {
    for (const part of messageParts(message)) {
      if (part.type === "tool-result" && typeof part.toolCallId === "string") {
        resultIds.add(part.toolCallId);
      }
    }
  }

  const seenCalls = new Set<string>();
  const messages: ModelMessage[] = [];
  let removed = 0;

  for (const message of history) {
    const role = messageRole(message);
    const content = messageContent(message);
    if (!Array.isArray(content)) {
      messages.push(message);
      continue;
    }

    const nextParts: unknown[] = [];
    for (const part of content) {
      if (!isRecord(part)) {
        nextParts.push(part);
        continue;
      }

      if (role === "assistant" && part.type === "tool-call") {
        const toolCallId = typeof part.toolCallId === "string" ? part.toolCallId : "";
        if (toolCallId && resultIds.has(toolCallId)) {
          seenCalls.add(toolCallId);
          nextParts.push(part);
        } else {
          removed++;
        }
        continue;
      }

      if (role === "tool" && part.type === "tool-result") {
        const toolCallId = typeof part.toolCallId === "string" ? part.toolCallId : "";
        if (toolCallId && seenCalls.has(toolCallId)) {
          nextParts.push(part);
        } else {
          removed++;
        }
        continue;
      }

      nextParts.push(part);
    }

    if (nextParts.length === content.length) {
      messages.push(message);
    } else if (nextParts.length > 0) {
      messages.push({ ...(message as object), content: nextParts } as ModelMessage);
    } else {
      removed++;
    }
  }

  return { messages, removed };
}

function messageParts(message: ModelMessage): Array<Record<string, unknown>> {
  const content = messageContent(message);
  if (!Array.isArray(content)) return [];
  return content.filter(isRecord);
}

function messageRole(message: ModelMessage): string {
  return typeof (message as { role?: unknown }).role === "string"
    ? (message as { role: string }).role
    : "";
}

function messageContent(message: ModelMessage): unknown {
  return (message as { content?: unknown }).content;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isProviderToolProtocolError(message: string): boolean {
  return /No tool call found for function call output|function_call_output|tool call.*not found|orphaned? tool|No output generated\. Check the stream for errors/i.test(message);
}

function stripInternalErrorPrefix(message: string): string {
  return message.replace(/^stream_tool_protocol:\s*/i, "").trim();
}

function estimateCost(
  provider: string,
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = pricingForModel(provider, modelId);
  const inputCost = (inputTokens / 1_000_000) * pricing.inputPerM;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerM;
  return inputCost + outputCost;
}
