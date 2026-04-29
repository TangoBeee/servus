import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tool, type ToolSet } from "ai";
import type { AgentFinalization, AgentToolEvent } from "./agent.js";
import type { EngineContext } from "./engine.js";
import { SERVUS_DIR } from "./config.js";
import { bus } from "./events.js";
import { createTools } from "./tools.js";
import { createFinishTools } from "./tools-finish.js";
import { createCodingControlTools } from "./coding-control-tools.js";
import type { CodingHelperRequest, CodingRuntime } from "./coding-runtime.js";
import { appendEvent } from "./session-store.js";

export type CodingPermissionRule = {
  behavior: "allow" | "ask" | "deny";
  tool: string;
  pattern?: string;
  reason?: string;
};

export type CodingToolDefinition = {
  name: string;
  description: string;
  inputSchema: unknown;
  readOnly: boolean;
  concurrencySafe: boolean;
  requiresPermission: boolean;
  interruptBehavior: "cancel" | "block";
  maxResultSize: number;
  evidenceType: string;
  execute: (input: unknown, options?: { abortSignal?: AbortSignal }) => Promise<unknown>;
};

export type CodingToolUseContext = {
  cwd: string;
  sessionId?: string;
  agentName: string;
  abortSignal?: AbortSignal;
  permissions: CodingPermissionRule[];
};

export type CodingToolCall = {
  toolCallId: string;
  toolName: string;
  input: unknown;
};

export type CodingToolExecutionResult = {
  toolCallId: string;
  toolName: string;
  input: unknown;
  output: string;
  isError: boolean;
};

type ScheduledToolWork = {
  call: CodingToolCall;
  abortSignal?: AbortSignal;
  readOnly: boolean;
  resolve: (result: CodingToolExecutionResult) => void;
  reject: (error: unknown) => void;
};

type AiToolLike = {
  description?: string;
  inputSchema?: unknown;
  execute?: (input: unknown, options?: { abortSignal?: AbortSignal }) => Promise<unknown> | unknown;
};

const READ_ONLY_TOOLS = new Set([
  "Read",
  "read",
  "Glob",
  "glob",
  "Grep",
  "grep",
  "LS",
  "ls",
  "workspace_status",
  "git_diff",
  "LSP",
  "lsp_status",
  "workspace_map",
  "WorkspaceMap",
  "project_overview",
  "ProjectOverview",
  "WebFetch",
  "webfetch",
  "BashOutput",
  "ToolSearch",
  "MemoryRead",
  "coding_state",
  "ReadToolResult",
  "ScratchpadList",
  "ScratchpadRead",
  "AskUserQuestion",
  "servus_need_input",
  "servus_done",
  "mcp_list_servers",
  "McpListTools",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
]);

const MAX_READ_ONLY_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.SERVUS_CODING_TOOL_CONCURRENCY ?? "8", 10) || 8,
);

const MUTATING_FILE_TOOLS = new Set(["Write", "write", "Edit", "edit", "MultiEdit", "patch"]);
const PLAN_TOOLS = new Set(["TodoWrite", "todowrite", "coding_todo", "coding_intent", "coding_plan_ready", "ExitPlanMode", "ScratchpadWrite", "SendMessage", "TaskStop"]);

export class CodingToolCatalog {
  readonly definitions: Map<string, CodingToolDefinition>;
  readonly modelTools: ToolSet;
  readonly toolEvents: AgentToolEvent[] = [];
  private mutationQueue: Promise<unknown> = Promise.resolve();
  private scheduledQueue: ScheduledToolWork[] = [];
  private scheduledReadOnlyRunning = 0;
  private scheduledExclusiveRunning = false;
  private finalization?: AgentFinalization;

  constructor(
    private readonly ctx: EngineContext,
    private readonly runtime: CodingRuntime,
    options: {
      agentName: string;
      disallowedTools?: string[];
      includeTask?: boolean;
      runTaskHelper?: (request: CodingHelperRequest) => Promise<string>;
      onFinalize?: (finalization: AgentFinalization) => void;
    },
  ) {
    const rawTools = {
      ...createTools(ctx.cwd, { sessionId: ctx.sessionId, agentName: options.agentName }),
      ...createCodingControlTools(runtime, {
        includeTask: options.includeTask ?? true,
        runTaskHelper: options.runTaskHelper,
      }),
      ...createFinishTools((finalization) => {
        this.finalization = finalization;
        options.onFinalize?.(finalization);
      }),
    };

    this.definitions = new Map();
    this.modelTools = {};
    const disallowed = expandDisallowedCodingToolNames(options.disallowedTools ?? []);
    for (const [name, rawTool] of Object.entries(rawTools)) {
      if (disallowed.has(name) || !isAiToolLike(rawTool)) continue;
      const executable = rawTool as AiToolLike;
      const metadata = metadataForTool(name);
      const definition: CodingToolDefinition = {
        name,
        description: rawTool.description ?? name,
        inputSchema: rawTool.inputSchema,
        readOnly: metadata.readOnly,
        concurrencySafe: metadata.concurrencySafe,
        requiresPermission: metadata.requiresPermission,
        interruptBehavior: metadata.interruptBehavior,
        maxResultSize: metadata.maxResultSize,
        evidenceType: metadata.evidenceType,
        execute: async (input, options) => executable.execute!(input, options),
      };
      this.definitions.set(name, definition);
      (this.modelTools as Record<string, unknown>)[name] = tool({
        description: definition.description,
        inputSchema: definition.inputSchema as never,
      } as never);
    }
  }

  takeFinalization(): AgentFinalization | undefined {
    return this.finalization;
  }

  clearFinalization(): void {
    this.finalization = undefined;
  }

  async executeToolCalls(calls: CodingToolCall[], abortSignal?: AbortSignal): Promise<CodingToolExecutionResult[]> {
    const results: CodingToolExecutionResult[] = [];
    for (const batch of partitionToolCalls(calls, this.definitions)) {
      if (batch.concurrent) {
        const batchResults = await mapWithConcurrency(
          batch.calls,
          MAX_READ_ONLY_CONCURRENCY,
          (call) => this.executeOne(call, abortSignal),
        );
        results.push(...batchResults);
      } else {
        for (const call of batch.calls) {
          results.push(await this.enqueueMutation(() => this.executeOne(call, abortSignal)));
        }
      }
    }
    return results;
  }

  scheduleToolCall(call: CodingToolCall, abortSignal?: AbortSignal): Promise<CodingToolExecutionResult> {
    const definition = this.definitions.get(call.toolName);
    const readOnly = definition?.concurrencySafe ?? false;
    return new Promise((resolve, reject) => {
      this.scheduledQueue.push({ call, abortSignal, readOnly, resolve, reject });
      this.pumpScheduledQueue();
    });
  }

  private pumpScheduledQueue(): void {
    if (this.scheduledExclusiveRunning) return;

    while (this.scheduledQueue.length > 0) {
      const next = this.scheduledQueue[0];

      if (next.readOnly) {
        if (this.scheduledReadOnlyRunning >= MAX_READ_ONLY_CONCURRENCY) return;
        this.scheduledQueue.shift();
        this.scheduledReadOnlyRunning++;
        void this.executeOne(next.call, next.abortSignal)
          .then(next.resolve, next.reject)
          .finally(() => {
            this.scheduledReadOnlyRunning--;
            this.pumpScheduledQueue();
          });
        continue;
      }

      if (this.scheduledReadOnlyRunning > 0) return;
      this.scheduledQueue.shift();
      this.scheduledExclusiveRunning = true;
      void this.enqueueMutation(() => this.executeOne(next.call, next.abortSignal))
        .then(next.resolve, next.reject)
        .finally(() => {
          this.scheduledExclusiveRunning = false;
          this.pumpScheduledQueue();
        });
      return;
    }
  }

  private async executeOne(call: CodingToolCall, abortSignal?: AbortSignal): Promise<CodingToolExecutionResult> {
    const definition = this.definitions.get(call.toolName);
    const startedAt = Date.now();
    this.toolEvents.push({
      type: "call",
      toolName: call.toolName,
      toolCallId: call.toolCallId,
      input: call.input,
      timestamp: Date.now(),
    });
    const startEvent = bus.push({
      type: "tool:start",
      agent: "CodingAgent",
      message: `${call.toolName}(${summarizeInput(call.input)})`,
      metadata: {
        tool: call.toolName,
        toolCallId: call.toolCallId,
        input: call.input,
        readOnly: definition?.readOnly,
      },
    });
    if (this.ctx.sessionId && !bus.interactive) appendEvent(this.ctx.sessionId, startEvent);

    if (!definition) {
      return this.finish(call, unavailableToolMessage(call.toolName, this.definitions), true, startedAt);
    }

    const parsed = parseToolInput(definition.inputSchema, call.input);
    if (!parsed.ok) {
      return this.finish(call, `Error: invalid ${call.toolName} input: ${parsed.error}`, true, startedAt);
    }

    const denied = await this.checkPermission(definition, parsed.input);
    if (denied) {
      return this.finish(call, denied, true, startedAt);
    }

    try {
      const preHooks = await this.runtime.runHooks("PreToolUse", {
        event: "PreToolUse",
        sessionId: this.ctx.sessionId,
        cwd: this.ctx.cwd,
        agentName: "CodingAgent",
        toolName: definition.name,
        toolInput: parsed.input,
      });
      const blockingPreHook = preHooks.find((hook) => hook.blocked);
      if (blockingPreHook) {
        return this.finish(
          call,
          [
            `Error: ${definition.name} blocked by Servus PreToolUse hook.`,
            blockingPreHook.output ? `Hook output:\n${blockingPreHook.output}` : "",
          ].filter(Boolean).join("\n"),
          true,
          startedAt,
        );
      }
      const raw = await definition.execute(parsed.input, { abortSignal });
      const normalized = await this.normalizeOutput(call, raw, definition.maxResultSize);
      const isError = normalized.startsWith("Error:");
      const result = this.finish(call, normalized, isError, startedAt);
      const postEvent = isError ? "PostToolUseFailure" : "PostToolUse";
      void this.runtime.runHooks(postEvent, {
        event: postEvent,
        sessionId: this.ctx.sessionId,
        cwd: this.ctx.cwd,
        agentName: "CodingAgent",
        toolName: definition.name,
        toolInput: parsed.input,
        toolOutput: normalized,
        isError,
      });
      return result;
    } catch (err: unknown) {
      return this.finish(call, `Error: ${err instanceof Error ? err.message : String(err)}`, true, startedAt);
    }
  }

  private async checkPermission(definition: CodingToolDefinition, input: unknown): Promise<string | null> {
    const deny = this.matchPermission(definition, input, "deny");
    if (deny) return `Error: ${definition.name} denied by coding permission rule${deny.reason ? `: ${deny.reason}` : ""}.`;
    const ask = this.matchPermission(definition, input, "ask");
    const allow = this.matchPermission(definition, input, "allow");
    if (!ask && !definition.requiresPermission) return null;
    if (allow && !ask) return null;
    if (!definition.requiresPermission && !ask) return null;
    if (definition.name === "servus_done" || definition.name === "servus_need_input" || definition.name === "AskUserQuestion") return null;
    if (definition.name === "McpCallTool") {
      const approved = await bus.requestApproval({
        action: "Call MCP tool",
        detail: summarizeInput(input),
        risk: "medium",
        engine: "Coding",
      });
      return approved ? null : "Error: MCP tool call was not approved.";
    }
    const approved = await bus.requestApproval({
      action: `Use ${definition.name}`,
      detail: summarizeInput(input),
      risk: MUTATING_FILE_TOOLS.has(definition.name) || definition.name === "Bash" || definition.name === "bash" ? "medium" : "low",
      engine: "Coding",
    });
    return approved ? null : `Error: ${definition.name} was not approved.`;
  }

  private matchPermission(
    definition: CodingToolDefinition,
    input: unknown,
    behavior: CodingPermissionRule["behavior"],
  ): CodingPermissionRule | undefined {
    const decision = this.runtime.permissionDecision(definition.name, input);
    if (decision.behavior !== behavior || !decision.rule) return undefined;
    return {
      behavior: decision.rule.behavior,
      tool: decision.rule.rule,
      reason: decision.rule.reason ?? `${decision.rule.source} Servus settings`,
    };
  }

  private async normalizeOutput(
    call: CodingToolCall,
    output: unknown,
    maxResultSize: number,
  ): Promise<string> {
    const text = typeof output === "string"
      ? output
      : output === undefined
        ? ""
        : JSON.stringify(output, null, 2);
    if (text.length <= maxResultSize) return text || "(no output)";

    const artifact = this.writeLargeToolOutput(call, text);
    const head = text.slice(0, Math.floor(maxResultSize * 0.55));
    const tail = text.slice(-Math.floor(maxResultSize * 0.25));
    return [
      `Tool output was ${text.length} characters and was stored as an artifact.`,
      artifact ? `Artifact: ${artifact}` : "Artifact write failed.",
      "",
      "Output excerpt:",
      head,
      "\n[… output truncated for context budget …]\n",
      tail,
    ].join("\n");
  }

  private writeLargeToolOutput(call: CodingToolCall, text: string): string | undefined {
    if (!this.ctx.sessionId) return undefined;
    try {
      const dir = join(SERVUS_DIR, "sessions", this.ctx.sessionId, "coding", "tool-results");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${Date.now()}-${sanitizeFileName(call.toolName)}-${sanitizeFileName(call.toolCallId)}.txt`);
      writeFileSync(path, text, "utf-8");
      this.runtime.state.artifacts = [...new Set([...this.runtime.state.artifacts, path])];
      return path;
    } catch {
      return undefined;
    }
  }

  private finish(call: CodingToolCall, output: string, isError: boolean, startedAt?: number): CodingToolExecutionResult {
    const durationMs = startedAt ? Date.now() - startedAt : undefined;
    this.toolEvents.push({
      type: "result",
      toolName: call.toolName,
      toolCallId: call.toolCallId,
      output,
      timestamp: Date.now(),
    });
    const finishEvent = bus.push({
      type: "tool:finish",
      agent: "CodingAgent",
      message: output.split("\n")[0]?.slice(0, 160) || "done",
      metadata: {
        tool: call.toolName,
        toolCallId: call.toolCallId,
        isError,
        ...(durationMs !== undefined ? { durationMs } : {}),
        output: output.slice(0, 1200),
      },
    });
    if (this.ctx.sessionId && !bus.interactive) appendEvent(this.ctx.sessionId, finishEvent);
    return {
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      input: call.input,
      output,
      isError,
    };
  }

  private async enqueueMutation<T>(run: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.then(run, run);
    this.mutationQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await run(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function metadataForTool(name: string): Omit<CodingToolDefinition, "name" | "description" | "inputSchema" | "execute"> {
  const readOnly = READ_ONLY_TOOLS.has(name);
  const planTool = PLAN_TOOLS.has(name);
  if (name === "MemoryWrite") {
    return {
      readOnly: false,
      concurrencySafe: false,
      requiresPermission: true,
      interruptBehavior: "block",
      maxResultSize: 12_000,
      evidenceType: "project_memory",
    };
  }
  return {
    readOnly,
    concurrencySafe: readOnly,
    requiresPermission: name === "McpCallTool",
    interruptBehavior: readOnly || planTool ? "cancel" : "block",
    maxResultSize: name === "Bash" || name === "bash" ? 40_000 : 24_000,
    evidenceType: evidenceTypeFor(name),
  };
}

function evidenceTypeFor(name: string): string {
  if (["Read", "read", "Grep", "grep", "Glob", "glob", "LS", "ls", "workspace_map", "WorkspaceMap", "project_overview", "ProjectOverview", "workspace_status", "git_diff", "LSP", "lsp_status"].includes(name)) return "repo_evidence";
  if (MUTATING_FILE_TOOLS.has(name)) return "coding_change";
  if (name === "Bash" || name === "bash" || name === "BashOutput" || name === "KillBash") return "verification_or_command";
  if (PLAN_TOOLS.has(name)) return "coding_plan";
  if (name === "Task") return "coding_helper";
  if (name === "MemoryRead" || name === "MemoryWrite") return "project_memory";
  if (name.toLowerCase().includes("mcp")) return "mcp";
  if (name === "servus_done") return "completion";
  if (name === "servus_need_input" || name === "AskUserQuestion") return "question";
  return "tool_result";
}

function partitionToolCalls(
  calls: CodingToolCall[],
  definitions: Map<string, CodingToolDefinition>,
): Array<{ concurrent: boolean; calls: CodingToolCall[] }> {
  const batches: Array<{ concurrent: boolean; calls: CodingToolCall[] }> = [];
  for (const call of calls) {
    const concurrent = definitions.get(call.toolName)?.concurrencySafe ?? false;
    const last = batches.at(-1);
    if (concurrent && last?.concurrent) last.calls.push(call);
    else batches.push({ concurrent, calls: [call] });
  }
  return batches;
}

function parseToolInput(schema: unknown, input: unknown): { ok: true; input: unknown } | { ok: false; error: string } {
  if (!schema || typeof schema !== "object" || typeof (schema as { safeParse?: unknown }).safeParse !== "function") {
    return { ok: true, input };
  }
  const result = (schema as { safeParse: (value: unknown) => { success: boolean; data?: unknown; error?: unknown } }).safeParse(input);
  if (result.success) return { ok: true, input: result.data };
  return { ok: false, error: stringifySchemaError(result.error) };
}

function stringifySchemaError(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error ?? "schema validation failed");
}

function isAiToolLike(value: unknown): value is AiToolLike {
  return typeof value === "object" &&
    value !== null &&
    "inputSchema" in value &&
    typeof (value as AiToolLike).execute === "function";
}

function expandDisallowedCodingToolNames(names: string[]): Set<string> {
  const aliases: Record<string, string[]> = {
    bash: ["bash", "Bash", "BashOutput", "KillBash"],
    bashoutput: ["BashOutput"],
    killbash: ["KillBash"],
    read: ["read", "Read", "ReadToolResult"],
    overview: ["project_overview", "ProjectOverview"],
    projectoverview: ["project_overview", "ProjectOverview"],
    repomap: ["project_overview", "ProjectOverview", "workspace_map", "WorkspaceMap"],
    write: ["write", "Write"],
    edit: ["edit", "Edit", "MultiEdit"],
    multiedit: ["MultiEdit"],
    patch: ["patch"],
    grep: ["grep", "Grep"],
    glob: ["glob", "Glob"],
    ls: ["ls", "LS"],
    webfetch: ["webfetch", "WebFetch"],
    task: ["Task"],
    sendmessage: ["SendMessage"],
    taskstop: ["TaskStop"],
    scratchpad: ["ScratchpadList", "ScratchpadRead", "ScratchpadWrite"],
    memory: ["MemoryRead", "MemoryWrite"],
    memoryread: ["MemoryRead"],
    memorywrite: ["MemoryWrite"],
    mcp: ["mcp_list_servers", "McpListTools", "McpCallTool", "ListMcpResourcesTool", "ReadMcpResourceTool", "ListMcpPromptsTool", "GetMcpInstructionsTool", "TestMcpServerTool"],
  };
  const expanded = new Set<string>();
  for (const name of names) {
    expanded.add(name);
    for (const alias of aliases[name.toLowerCase()] ?? []) expanded.add(alias);
  }
  return expanded;
}

function summarizeInput(input: unknown): string {
  if (typeof input === "string") return input.slice(0, 80);
  if (!input || typeof input !== "object") return String(input ?? "");
  const entries = Object.entries(input as Record<string, unknown>);
  return entries.slice(0, 3).map(([key, value]) => {
    const rendered = typeof value === "string" ? value : JSON.stringify(value);
    return `${key}: ${rendered?.slice(0, 60)}`;
  }).join(", ");
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
}

function unavailableToolMessage(toolName: string, definitions: Map<string, CodingToolDefinition>): string {
  const normalized = toolName.toLowerCase().replace(/[^a-z0-9]/g, "");
  const aliases: Record<string, string[]> = {
    applypatch: ["patch"],
    updateplan: ["TodoWrite", "ExitPlanMode"],
    todoupdate: ["TodoWrite"],
    askuser: ["AskUserQuestion", "servus_need_input"],
    finish: ["servus_done"],
    done: ["servus_done"],
    complete: ["servus_done"],
    shell: ["Bash"],
    terminal: ["Bash"],
    exec: ["Bash"],
    readfile: ["Read"],
    writefile: ["Write"],
    editfile: ["Edit", "MultiEdit"],
    search: ["Grep", "Glob", "ToolSearch"],
    listfiles: ["LS", "Glob"],
    diff: ["git_diff"],
    status: ["workspace_status", "coding_state"],
    tree: ["workspace_map", "WorkspaceMap", "LS", "Glob"],
    workspacemap: ["workspace_map", "WorkspaceMap"],
    projectmap: ["project_overview", "ProjectOverview", "workspace_map", "WorkspaceMap"],
  };
  const direct = aliases[normalized]?.filter((name) => definitions.has(name)) ?? [];
  const fuzzy = [...definitions.keys()]
    .map((name) => ({ name, score: fuzzyToolScore(normalized, name.toLowerCase().replace(/[^a-z0-9]/g, "")) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((item) => item.name);
  const suggestions = [...new Set([...direct, ...fuzzy])].slice(0, 6);
  return [
    `Error: No such coding tool is available: ${toolName}`,
    suggestions.length
      ? `Use one of these Servus tools instead: ${suggestions.join(", ")}.`
      : "Use ToolSearch to discover the available Servus coding tools.",
    "Do not invent tool names; retry the same step with an available tool.",
  ].join("\n");
}

function fuzzyToolScore(query: string, candidate: string): number {
  if (!query || !candidate) return 0;
  if (query === candidate) return 100;
  if (candidate.includes(query) || query.includes(candidate)) return 40;
  let score = 0;
  let j = 0;
  for (let i = 0; i < query.length && j < candidate.length; i++) {
    const at = candidate.indexOf(query[i], j);
    if (at === -1) continue;
    score += 1;
    j = at + 1;
  }
  return score >= Math.min(4, query.length) ? score : 0;
}
