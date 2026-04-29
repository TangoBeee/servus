import { mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  streamText,
  stepCountIs,
  type LanguageModel,
  type ModelMessage,
  type TextStreamPart,
  type ToolSet,
} from "ai";
import type { AgentFinalization, AgentResponse } from "./agent.js";
import type { EngineContext } from "./engine.js";
import { pricingForModel, resolveModel } from "./provider.js";
import { SERVUS_DIR } from "./config.js";
import { bus } from "./events.js";
import { log, ANSI } from "./log.js";
import { appendProjectTranscript, updateSession } from "./session-store.js";
import {
  appendCompactionLog,
  estimateMessageTokens,
  loadAgentHistory,
  saveAgentHistory,
  shouldCompactContext,
} from "./context-manager.js";
import type { CodingHelperRequest, CodingRuntime } from "./coding-runtime.js";
import { CodingToolCatalog, type CodingToolCall, type CodingToolExecutionResult } from "./coding-tool-catalog.js";
import { drainCodingUserMessages } from "./coding-message-queue.js";
import { generateCodingContextSuggestions } from "./coding-context-suggestions.js";
import { loadCodingSessionReplay } from "./coding-session.js";

export type CodingTranscriptEvent = {
  timestamp: number;
  type: "user" | "assistant" | "tool_call" | "tool_result" | "compact_boundary" | "interruption" | "validation_failure";
  agent: string;
  content?: string;
  metadata?: Record<string, unknown>;
};

export interface CodingConversationLoopOptions {
  agentName: string;
  color?: string;
  model?: string;
  systemPrompt?: string;
  disallowedTools?: string[];
  includeTask?: boolean;
  maxTurns?: number;
  runTaskHelper?: (request: CodingHelperRequest) => Promise<string>;
}

const DEFAULT_MAX_TURNS = 48;
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_DELAY_MS = 8000;
const MICROCOMPACT_TOOL_RESULT_CHARS = 8_000;
const MICROCOMPACT_KEEP_RECENT_MESSAGES = 8;

export class CodingConversationLoop {
  readonly name: string;
  readonly color: string;
  private readonly model: LanguageModel;
  private readonly provider: string;
  private readonly modelId: string;
  private readonly systemPrompt: string;
  private readonly maxTurns: number;
  private readonly catalog: CodingToolCatalog;
  private history: ModelMessage[];
  private totalCost = 0;
  private totalTokens = { input: 0, output: 0 };
  private finalization?: AgentFinalization;

  constructor(
    private readonly ctx: EngineContext,
    private readonly runtime: CodingRuntime,
    options: CodingConversationLoopOptions,
  ) {
    const resolved = resolveModel(options.model ?? ctx.model);
    this.model = resolved.model;
    this.provider = resolved.provider;
    this.modelId = resolved.modelId;
    this.name = options.agentName;
    this.color = options.color ?? ANSI.green;
    this.systemPrompt = options.systemPrompt ?? runtime.buildSystemPrompt();
    this.maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
    this.history = normalizeCodingModelMessages(loadAgentHistory(ctx.sessionId, this.name));
    this.catalog = new CodingToolCatalog(ctx, runtime, {
      agentName: this.name,
      disallowedTools: options.disallowedTools,
      includeTask: options.includeTask,
      runTaskHelper: options.runTaskHelper,
      onFinalize: (finalization) => {
        this.finalization = finalization;
      },
    });
    log.agent(this.name, this.color, `${ANSI.dim}coding loop initialized (${resolved.provider}:${resolved.modelId})${ANSI.reset}`);
  }

  get cost(): number {
    return this.totalCost;
  }

  async send(message: string): Promise<AgentResponse> {
    this.finalization = undefined;
    this.catalog.clearFinalization();
    this.history.push({ role: "user", content: message } as ModelMessage);
    this.recordTranscript("user", message);
    this.persistHistory();
    const promptHooks = await this.runtime.runHooks("UserPromptSubmit", {
      event: "UserPromptSubmit",
      sessionId: this.ctx.sessionId,
      cwd: this.ctx.cwd,
      agentName: this.name,
      toolOutput: message,
    });
    const blockingPromptHook = promptHooks.find((hook) => hook.blocked);
    if (blockingPromptHook) {
      return this.response([
        "UserPromptSubmit hook blocked this coding turn.",
        blockingPromptHook.output ? `Hook output:\n${blockingPromptHook.output}` : "",
      ].filter(Boolean).join("\n"), 0, "error_during_execution");
    }

    let aggregateText = "";
    let subtype = "success";
    let turns = 0;

    for (let turn = 0; turn < this.maxTurns; turn++) {
      this.emitTurnEvent("coding:turn_start", `Coding turn ${turn + 1} started`, {
        turn: turn + 1,
        maxTurns: this.maxTurns,
        historyMessages: this.history.length,
      });
      this.injectQueuedUserMessages(turn);
      this.injectRuntimeReminder(turn);
      this.microcompactToolResults(turn === 0 ? "before_send" : "before_tool_continuation");
      await this.compactIfNeeded(turn === 0 ? "before_send" : "before_tool_continuation");
      const step = await this.runModelStep();
      turns++;
      this.emitTurnEvent("coding:turn_finish", `Coding turn ${turn + 1} finished`, {
        turn: turn + 1,
        maxTurns: this.maxTurns,
        textChars: step.text.length,
        toolCalls: step.toolCalls.map((call) => call.toolName),
        subtype: step.subtype,
      });
      aggregateText += step.text;
      subtype = step.subtype;

      if (step.text.trim()) {
        this.recordTranscript("assistant", step.text, { turn });
      }

      this.appendAssistantMessage(step.text, step.toolCalls);
      this.persistHistory();

      if (step.toolCalls.length === 0) {
        await this.compactIfNeeded("after_send");
        return this.response(aggregateText, turns, subtype);
      }

      for (const call of step.toolCalls) {
        this.recordTranscript("tool_call", undefined, {
          toolName: call.toolName,
          toolCallId: call.toolCallId,
          input: call.input,
        });
      }

      const results = step.toolResults ?? await this.catalog.executeToolCalls(step.toolCalls);
      this.appendToolResults(results);
      for (const result of results) {
        this.recordTranscript("tool_result", result.output, {
          toolName: result.toolName,
          toolCallId: result.toolCallId,
          isError: result.isError,
        });
      }
      this.persistHistory();

      const finalization = this.catalog.takeFinalization() ?? this.finalization;
      if (finalization) {
        this.finalization = finalization;
        await this.compactIfNeeded("after_finalization");
        return this.response(aggregateText, turns, "success");
      }

      if (subtype === "error_rate_limit" || subtype === "error_stream_protocol") {
        return this.response(aggregateText, turns, subtype);
      }
    }

    return this.response(
      aggregateText || "Coding model reached the maximum tool loop turns before completion.",
      turns,
      "error_max_turns",
    );
  }

  close(): void {
    this.persistHistory();
  }

  private async runModelStep(): Promise<{
    text: string;
    toolCalls: CodingToolCall[];
    toolResults?: CodingToolExecutionResult[];
    subtype: string;
  }> {
    let text = "";
    const toolCalls: CodingToolCall[] = [];
    const toolResultPromises: Array<Promise<CodingToolExecutionResult>> = [];
    let finishReason = "unknown";
    let streamProtocolError = false;
    let streamRateLimit = false;

    const execute = () => streamText({
      model: this.model,
      system: this.systemPrompt,
      messages: this.history,
      tools: this.catalog.modelTools,
      stopWhen: stepCountIs(1),
      onStepFinish: (step) => {
        if (step.usage) {
          this.totalTokens.input += step.usage.inputTokens ?? 0;
          this.totalTokens.output += step.usage.outputTokens ?? 0;
        }
      },
    });

    let result: Awaited<ReturnType<typeof streamText<ToolSet>>> | undefined;
    let lastError: unknown;
    let compactedAfterContextOverflow = false;
    for (let attempt = 0; attempt < RATE_LIMIT_RETRIES; attempt++) {
      try {
        result = await execute();
        lastError = undefined;
        break;
      } catch (err: unknown) {
        lastError = err;
        const msg = err instanceof Error ? err.message : String(err);
        const isRateLimit = /rate_limit|Rate limit|tokens per min|Request too large/i.test(msg);
        const isContextOverflow = isContextOverflowError(msg);
        if (isContextOverflow && !compactedAfterContextOverflow) {
          compactedAfterContextOverflow = true;
          this.history.push({
            role: "assistant",
            content: "[Agent notice: provider rejected the request for context size. Servus will compact and retry in the same coding session.]",
          } as ModelMessage);
          await this.compactIfNeeded("context_overflow_retry", true);
          continue;
        }
        const retryAfter = msg.match(/try again in ([\d.]+)s/i);
        const delayMs = retryAfter
          ? Math.ceil(parseFloat(retryAfter[1]) * 1000) + 500
          : RATE_LIMIT_DELAY_MS;
        if (isRateLimit && attempt < RATE_LIMIT_RETRIES - 1) {
          log.agent(this.name, this.color, `${ANSI.yellow}Rate limit hit, retrying in ${Math.ceil(delayMs / 1000)}s...${ANSI.reset}`);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        throw err;
      }
    }
    if (!result) throw lastError;

    try {
      for await (const part of result.fullStream as AsyncIterable<TextStreamPart<ToolSet>>) {
        if (part.type === "text-delta") {
          text += part.text;
          log.agentText(this.name, this.color, part.text);
        } else if (part.type === "reasoning-delta") {
          // Keep reasoning out of transcript; providers may stream it separately.
        } else if (part.type === "tool-call") {
          const call = {
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          };
          toolCalls.push(call);
          toolResultPromises.push(this.catalog.scheduleToolCall(call));
        } else if (part.type === "finish") {
          finishReason = part.finishReason;
        } else if (part.type === "error") {
          const msg = errorMessage(part.error);
          if (/tokens per min|Request too large|rate_limit/i.test(msg)) streamRateLimit = true;
          if (isProviderToolProtocolError(msg)) streamProtocolError = true;
          throw new Error(
            streamRateLimit
              ? `stream_rate_limit: ${msg}`
              : streamProtocolError
                ? `stream_tool_protocol: ${msg}`
                : isContextOverflowError(msg)
                  ? `stream_context_overflow: ${msg}`
                  : msg,
          );
        }
      }
      if (text && !bus.interactive) process.stdout.write("\n");
      finishReason = await result.finishReason;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (toolCalls.length > 0) {
        const toolResults = await settleScheduledToolResults(toolCalls, toolResultPromises);
        return {
          text: text.trim()
            ? text
            : `Transient model/tool stream error after tool calls: ${stripInternalErrorPrefix(msg)}`,
          toolCalls,
          toolResults,
          subtype: streamRateLimit || msg.startsWith("stream_rate_limit")
            ? "error_rate_limit"
            : streamProtocolError || isProviderToolProtocolError(msg)
              ? "error_stream_protocol"
              : "error_during_execution",
        };
      }
      if (streamRateLimit || msg.startsWith("stream_rate_limit")) {
        this.history.push({
          role: "assistant",
          content: "[Agent notice: stream rate limit or token cap hit. Servus will compact and continue in the same coding session.]",
        } as ModelMessage);
        await this.compactIfNeeded("stream_rate_limit", true);
        return { text: `Rate limit / token cap hit: ${msg}`, toolCalls: [], subtype: "error_rate_limit" };
      }
      if (msg.startsWith("stream_context_overflow") || isContextOverflowError(msg)) {
        this.history.push({
          role: "assistant",
          content: "[Agent notice: stream context overflow. Servus compacted the coding session and can continue.]",
        } as ModelMessage);
        await this.compactIfNeeded("stream_context_overflow", true);
        return { text: `Context limit hit and compaction was applied: ${stripInternalErrorPrefix(msg)}`, toolCalls: [], subtype: "error_rate_limit" };
      }
      if (streamProtocolError || isProviderToolProtocolError(msg)) {
        this.history.push({
          role: "assistant",
          content: "[Agent notice: model/tool stream protocol error. Tool history was preserved and the run can continue in the same session.]",
        } as ModelMessage);
        this.persistHistory();
        return { text: `Transient model/tool stream error: ${stripInternalErrorPrefix(msg)}`, toolCalls: [], subtype: "error_stream_protocol" };
      }
      return { text: `Error: ${msg}`, toolCalls: [], subtype: "error_during_execution" };
    }

    const toolResults = toolResultPromises.length
      ? await Promise.all(toolResultPromises)
      : undefined;

    this.totalCost = estimateCost(this.provider, this.modelId, this.totalTokens.input, this.totalTokens.output);
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
    const contextUsage = shouldCompactContext(this.history, this.systemPrompt, this.modelId);
    const replay = this.ctx.sessionId ? loadCodingSessionReplay(this.ctx.sessionId, this.ctx.cwd) : undefined;
    const suggestions = generateCodingContextSuggestions({
      estimatedTokens: contextUsage.estimatedTokens,
      contextWindowTokens: contextUsage.budget.contextWindowTokens,
      compactAtTokens: contextUsage.budget.compactAtTokens,
      historyTokens: estimateMessageTokens(this.history),
      systemTokens: estimateMessageTokens(this.systemPrompt),
      toolEvents: this.catalog.toolEvents,
      readStateFiles: replay?.readStateFiles,
      toolResultArtifacts: replay?.toolResultArtifacts,
      compactions: replay?.compactions,
    });
    const contextUsageMetadata = {
      modelId: this.modelId,
      estimatedTokens: contextUsage.estimatedTokens,
      contextWindowTokens: contextUsage.budget.contextWindowTokens,
      compactAtTokens: contextUsage.budget.compactAtTokens,
      keepRecentMessages: contextUsage.budget.keepRecentMessages,
      percent: contextUsage.budget.contextWindowTokens > 0
        ? Math.round((contextUsage.estimatedTokens / contextUsage.budget.contextWindowTokens) * 1000) / 10
        : 0,
      compactPercent: contextUsage.budget.compactAtTokens > 0
        ? Math.round((contextUsage.estimatedTokens / contextUsage.budget.compactAtTokens) * 1000) / 10
        : 0,
      shouldCompact: contextUsage.shouldCompact,
      suggestions,
    };
    bus.push({
      type: "context:usage",
      agent: this.name,
      message: `${contextUsage.estimatedTokens}/${contextUsage.budget.contextWindowTokens} estimated tokens`,
      metadata: contextUsageMetadata,
    });
    if (this.ctx.sessionId) updateSession(this.ctx.sessionId, { contextUsage: contextUsageMetadata });

    return {
      text,
      toolCalls,
      ...(toolResults ? { toolResults } : {}),
      subtype: finishReason === "length" ? "error_max_turns" : "success",
    };
  }

  private injectQueuedUserMessages(turn: number): void {
    const messages = drainCodingUserMessages(this.ctx.sessionId);
    if (messages.length === 0) return;
    const content = [
      "## Same-Session User Messages",
      "The user sent these messages while this coding run was active. Treat them as the latest user guidance for the same session.",
      "Do not restart, reroute, or discard current context. If a message changes scope materially, update intent/todos before editing.",
      "",
      ...messages.flatMap((item, index) => [
        `### Message ${index + 1}`,
        item.message,
        "",
      ]),
    ].join("\n");
    this.history.push({ role: "user", content } as ModelMessage);
    this.recordTranscript("user", content, {
      queued: true,
      turn,
      messageIds: messages.map((item) => item.id),
    });
    this.persistHistory();
  }

  private injectRuntimeReminder(turn: number): void {
    const reminder = this.runtime.buildTurnReminder(turn);
    if (!reminder) return;
    this.history.push({ role: "user", content: reminder } as ModelMessage);
    this.recordTranscript("user", reminder, {
      runtimeReminder: true,
      turn,
    });
    this.persistHistory();
  }

  private appendAssistantMessage(text: string, toolCalls: CodingToolCall[]): void {
    if (toolCalls.length === 0) {
      if (text.trim()) this.history.push({ role: "assistant", content: text } as ModelMessage);
      return;
    }
    this.history.push({
      role: "assistant",
      content: [
        ...(text.trim() ? [{ type: "text", text }] : []),
        ...toolCalls.map((call) => ({
          type: "tool-call",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input: call.input,
        })),
      ],
    } as unknown as ModelMessage);
  }

  private appendToolResults(results: Array<{ toolCallId: string; toolName: string; output: string; isError: boolean }>): void {
    this.history.push({
      role: "tool",
      content: results.map((result) => ({
        type: "tool-result",
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        output: { type: "text", value: result.output },
        ...(result.isError ? { isError: true } : {}),
      })),
    } as unknown as ModelMessage);
  }

  private response(text: string, turns: number, subtype: string): AgentResponse {
    log.agent(
      this.name,
      this.color,
      `${ANSI.dim}done (turns: ${turns}, tokens: ${this.totalTokens.input + this.totalTokens.output}, cost: ~$${this.totalCost.toFixed(4)}, status: ${subtype})${ANSI.reset}`,
    );
    return {
      text,
      cost: this.totalCost,
      turns,
      subtype,
      finalization: this.finalization,
      toolEvents: this.catalog.toolEvents,
    };
  }

  private microcompactToolResults(reason: string): void {
    const cutoff = Math.max(0, this.history.length - MICROCOMPACT_KEEP_RECENT_MESSAGES);
    if (cutoff === 0) return;
    let compacted = 0;
    let freedChars = 0;
    for (let messageIndex = 0; messageIndex < cutoff; messageIndex++) {
      const message = this.history[messageIndex] as unknown as { role?: string; content?: unknown };
      if (message.role !== "tool" || !Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (!part || typeof part !== "object") continue;
        const record = part as Record<string, unknown>;
        if (record.type !== "tool-result") continue;
        const current = toolResultOutputText(record.output);
        if (current.length < MICROCOMPACT_TOOL_RESULT_CHARS) continue;
        if (current.includes("[Servus micro-compacted tool result]")) continue;
        const toolName = typeof record.toolName === "string" ? record.toolName : "tool";
        const toolCallId = typeof record.toolCallId === "string" ? record.toolCallId : `tool-${messageIndex}`;
        const artifact = this.writeMicrocompactToolResult(toolName, toolCallId, current);
        const excerptBudget = Math.floor(MICROCOMPACT_TOOL_RESULT_CHARS * 0.35);
        const replacement = [
          "[Servus micro-compacted tool result]",
          `Tool: ${toolName}`,
          `Tool call id: ${toolCallId}`,
          `Original chars: ${current.length}`,
          artifact ? `Artifact: ${artifact}` : "Artifact: unavailable",
          "",
          "Head excerpt:",
          current.slice(0, excerptBudget),
          "",
          "Tail excerpt:",
          current.slice(-excerptBudget),
        ].join("\n");
        record.output = { type: "text", value: replacement };
        compacted++;
        freedChars += Math.max(0, current.length - replacement.length);
      }
    }
    if (compacted === 0) return;
    this.recordTranscript("compact_boundary", `Micro-compacted ${compacted} older tool result(s).`, {
      reason,
      compactedToolResults: compacted,
      freedChars,
    });
    appendCompactionLog(this.ctx.sessionId, this.name, {
      reason: `microcompact:${reason}`,
      modelId: this.modelId,
      compactedToolResults: compacted,
      freedChars,
      estimatedTokens: estimateMessageTokens(this.history) + estimateMessageTokens(this.systemPrompt),
    });
    bus.push({
      type: "context:compact",
      agent: this.name,
      message: `Micro-compacted ${compacted} older tool result(s)`,
      metadata: { reason, compactedToolResults: compacted, freedChars },
    });
    this.persistHistory();
  }

  private writeMicrocompactToolResult(toolName: string, toolCallId: string, text: string): string | undefined {
    if (!this.ctx.sessionId) return undefined;
    try {
      const dir = join(SERVUS_DIR, "sessions", this.ctx.sessionId, "coding", "tool-results");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${Date.now()}-micro-${sanitizeFileName(toolName)}-${sanitizeFileName(toolCallId)}.txt`);
      writeFileSync(path, text, "utf-8");
      this.runtime.state.artifacts = [...new Set([...this.runtime.state.artifacts, path])];
      return path;
    } catch {
      return undefined;
    }
  }

  private async compactIfNeeded(reason: string, force = false): Promise<void> {
    const assessment = shouldCompactContext(this.history, this.systemPrompt, this.modelId);
    if (!force && !assessment.shouldCompact) return;
    const keepRecent = assessment.budget.keepRecentMessages;
    const splitIndex = Math.max(0, this.history.length - keepRecent);
    const older = this.history.slice(0, splitIndex);
    const recent = this.history.slice(splitIndex);
    if (older.length === 0) return;

    const preHooks = await this.runtime.runHooks("PreCompact", {
      event: "PreCompact",
      sessionId: this.ctx.sessionId,
      cwd: this.ctx.cwd,
      agentName: this.name,
      toolOutput: JSON.stringify({
        reason,
        beforeTokens: assessment.estimatedTokens,
        keepRecent,
        olderMessages: older.length,
      }),
    });
    if (preHooks.some((hook) => hook.blocked)) return;

    const beforeTokens = assessment.estimatedTokens;
    let summary = "";
    try {
      const result = await streamText({
        model: this.model,
        system: [
          "You compact context for Servus Coding Agent.",
          "Preserve user intent, assumptions, selected files, read file state, todos, failed edits, verification failures, MCP/LSP findings, changed files, unresolved risks, and next steps.",
          "Be concise and factual. Do not invent.",
        ].join(" "),
        messages: [{
          role: "user",
          content: [
            "Compact these older coding messages into a durable continuation summary.",
            "",
            "Current Servus runtime state snapshot:",
            "```json",
            this.runtime.buildCompactionSnapshot(),
            "```",
            "",
            JSON.stringify(older),
          ].join("\n"),
        }] as ModelMessage[],
        stopWhen: stepCountIs(1),
      });
      for await (const part of result.fullStream) {
        if (part.type === "text-delta") summary += part.text;
      }
    } catch {
      summary = "";
    }

    this.history = [
      {
        role: "assistant",
        content: summary.trim()
          ? `[Servus coding context summary after compaction]\n${summary.trim()}`
          : "[Servus coding context summary after compaction]\nOlder coding messages were compacted. Continue using the current runtime state, todos, evidence, checkpoints, and verification records.",
      } as ModelMessage,
      ...recent,
    ];
    this.recordTranscript("compact_boundary", summary.trim(), {
      reason,
      beforeTokens,
      keptRecentMessages: recent.length,
    });
    appendCompactionLog(this.ctx.sessionId, this.name, {
      reason,
      modelId: this.modelId,
      beforeTokens,
      afterTokens: estimateMessageTokens(this.history) + estimateMessageTokens(this.systemPrompt),
      keptRecentMessages: recent.length,
    });
    void this.runtime.runHooks("PostCompact", {
      event: "PostCompact",
      sessionId: this.ctx.sessionId,
      cwd: this.ctx.cwd,
      agentName: this.name,
      toolOutput: summary.trim(),
    });
    this.persistHistory();
  }

  private persistHistory(): void {
    saveAgentHistory(
      this.ctx.sessionId,
      this.name,
      this.modelId,
      this.history,
      estimateMessageTokens(this.history) + estimateMessageTokens(this.systemPrompt),
    );
  }

  private recordTranscript(
    type: CodingTranscriptEvent["type"],
    content?: string,
    metadata?: Record<string, unknown>,
  ): void {
    if (!this.ctx.sessionId) return;
    const entry: CodingTranscriptEvent = {
      timestamp: Date.now(),
      type,
      agent: this.name,
      ...(content !== undefined ? { content } : {}),
      ...(metadata ? { metadata } : {}),
    };
    try {
      const dir = join(SERVUS_DIR, "sessions", this.ctx.sessionId, "coding");
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, "transcript.jsonl"), JSON.stringify(entry) + "\n");
    } catch {
      // Transcript persistence should never break the coding run.
    }
    appendProjectTranscript(this.ctx.cwd, this.ctx.sessionId, entry);
    if (type === "assistant" && content?.trim()) {
      bus.push({
        type: "assistant:message",
        agent: this.name,
        color: this.color,
        message: content,
        metadata: {
          sessionId: this.ctx.sessionId,
          transcriptType: type,
          ...(metadata ?? {}),
        },
      });
    }
  }

  private emitTurnEvent(
    type: "coding:turn_start" | "coding:turn_finish",
    message: string,
    metadata: Record<string, unknown>,
  ): void {
    bus.push({
      type,
      agent: this.name,
      color: this.color,
      message,
      metadata: {
        sessionId: this.ctx.sessionId,
        ...metadata,
      },
    });
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return String(error ?? "unknown error");
}

function isProviderToolProtocolError(message: string): boolean {
  return /No tool call found for function call output|function_call_output|tool call.*not found|orphaned? tool|No output generated\. Check the stream for errors/i.test(message);
}

function isContextOverflowError(message: string): boolean {
  return /context_length_exceeded|context window|context limit|maximum context|too many tokens|input.*tokens|prompt.*too long|request.*too large/i.test(message);
}

function stripInternalErrorPrefix(message: string): string {
  return message
    .replace(/^stream_tool_protocol:\s*/i, "")
    .replace(/^stream_context_overflow:\s*/i, "")
    .trim();
}

function toolResultOutputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (!output || typeof output !== "object") return JSON.stringify(output ?? "");
  const record = output as Record<string, unknown>;
  if (record.type === "text" && typeof record.value === "string") return record.value;
  if (typeof record.value === "string") return record.value;
  return JSON.stringify(output);
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "tool";
}

async function settleScheduledToolResults(
  calls: CodingToolCall[],
  promises: Array<Promise<CodingToolExecutionResult>>,
): Promise<CodingToolExecutionResult[]> {
  const settled = await Promise.allSettled(promises);
  return settled.map((item, index) => {
    if (item.status === "fulfilled") return item.value;
    const call = calls[index];
    return {
      toolCallId: call?.toolCallId ?? `unknown-${index}`,
      toolName: call?.toolName ?? "unknown",
      input: call?.input,
      output: `Error: scheduled tool failed after a model stream interruption: ${
        item.reason instanceof Error ? item.reason.message : String(item.reason)
      }`,
      isError: true,
    };
  });
}

function estimateCost(provider: string, modelId: string, inputTokens: number, outputTokens: number): number {
  const pricing = pricingForModel(provider, modelId);
  return (inputTokens / 1_000_000) * pricing.inputPerM + (outputTokens / 1_000_000) * pricing.outputPerM;
}

function normalizeCodingModelMessages(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    const candidate = message as unknown as { role?: string; content?: unknown };
    if (candidate.role !== "tool" || !Array.isArray(candidate.content)) return message;
    return {
      ...candidate,
      content: candidate.content.map((part) => {
        if (!part || typeof part !== "object") return part;
        const record = part as Record<string, unknown>;
        if (record.type !== "tool-result") return part;
        const output = record.output;
        if (output && typeof output === "object") return part;
        return {
          ...record,
          output: {
            type: "text",
            value: typeof output === "string" ? output : JSON.stringify(output ?? ""),
          },
        };
      }),
    } as unknown as ModelMessage;
  });
}
