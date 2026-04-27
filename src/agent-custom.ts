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
import { resolveModel } from "./provider.js";
import { createTools } from "./tools.js";
import { createFinishTools } from "./tools-finish.js";
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

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_STEPS = 100;
const MAX_HISTORY = 80;
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_DELAY_MS = 8000;

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
  private skills: SkillManifest[] = [];
  private maxSkillsPromptChars: number;
  private totalCost = 0;
  private totalTokens = { input: 0, output: 0 };
  private sessionId?: string;
  private finalization?: AgentFinalization;
  private toolEvents: AgentToolEvent[] = [];

  constructor(config: AgentConfig, cwd: string) {
    this.name = config.name;
    this.role = config.role;
    this.color = config.color;
    this.systemPrompt = config.prompt;
    this.cwd = cwd;
    this.sessionId = config.sessionId;

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

    const resolved = resolveModel(config.model);
    this.model = resolved.model;
    this.provider = resolved.provider;
    this.modelId = resolved.modelId;
    this.history = loadAgentHistory(this.sessionId, this.name);

    this.tools = {
      ...createTools(cwd),
      ...(config.extraTools ?? {}),
      ...createFinishTools((finalization) => {
        this.finalization = finalization;
      }),
    } as ToolSet;
    for (const name of config.disallowedTools ?? []) {
      delete (this.tools as Record<string, unknown>)[name];
    }

    log.agent(
      this.name,
      this.color,
      `${ANSI.dim}initialized (${resolved.provider}:${resolved.modelId})${ANSI.reset}`,
    );
  }

  async send(message: string): Promise<AgentResponse> {
    this.finalization = undefined;
    this.toolEvents = [];
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
              metadata: { output: raw.slice(0, 1000) },
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
    if (this.skills.length === 0) return this.systemPrompt;

    const selected = selectSkillsForTask(message, this.skills);
    if (selected.length === 0) return this.systemPrompt;

    const skillsPrompt = buildSkillsPrompt(selected, this.maxSkillsPromptChars);
    if (!skillsPrompt) return this.systemPrompt;

    return [
      this.systemPrompt,
      "",
      "# Relevant Servus Skills",
      "Use these local skills when they match the current task. Respect each skill's allowed tools.",
      "",
      skillsPrompt,
    ].join("\n");
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
  // Prices are per 1M tokens.
  // Values are approximate and can be updated as providers change pricing.
  const table: Record<
    string,
    { inputPerM: number; outputPerM: number; match: (model: string) => boolean }
  > = {
    openai_gpt41_mini: {
      inputPerM: 0.4,
      outputPerM: 1.6,
      match: (m) => m.startsWith("gpt-4.1-mini"),
    },
    openai_gpt4o_mini: {
      inputPerM: 0.15,
      outputPerM: 0.6,
      match: (m) => m.startsWith("gpt-4o-mini"),
    },
    openai_default: {
      inputPerM: 3,
      outputPerM: 15,
      match: () => provider === "openai",
    },
    anthropic_sonnet: {
      inputPerM: 3,
      outputPerM: 15,
      match: (m) => m.startsWith("claude-"),
    },
    google_gemini_flash: {
      inputPerM: 0.15,
      outputPerM: 0.6,
      match: (m) =>
        m.startsWith("gemini-2.5-flash") || m.startsWith("models/gemini-2.5-flash"),
    },
    google_gemini_pro: {
      inputPerM: 1.25,
      outputPerM: 10,
      match: (m) =>
        m.startsWith("gemini-2.5-pro") || m.startsWith("models/gemini-2.5-pro"),
    },
  };

  let pricing: { inputPerM: number; outputPerM: number } = {
    inputPerM: 3,
    outputPerM: 15,
  };

  for (const entry of Object.values(table)) {
    if (entry.match(modelId)) {
      pricing = { inputPerM: entry.inputPerM, outputPerM: entry.outputPerM };
      break;
    }
  }

  const inputCost = (inputTokens / 1_000_000) * pricing.inputPerM;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerM;
  return inputCost + outputCost;
}
