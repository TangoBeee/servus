import { tool } from "ai";
import { z } from "zod";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type {
  CodingAmbiguity,
  CodingHelperRequest,
  CodingHelperType,
  CodingIntentContract,
  CodingRuntime,
  CodingTaskKind,
} from "./coding-runtime.js";
import { SERVUS_DIR } from "./config.js";
import {
  readProjectMemory,
  rememberProjectMemoryFact,
  type ProjectMemoryCategory,
} from "./project-memory.js";
import { loadCodingInstructions } from "./coding-instructions.js";

const taskKindSchema = z.enum(["change", "analysis", "verification"]);
const ambiguitySchema = z.enum(["none", "low", "material"]);
const riskSchema = z.enum(["low", "medium", "high"]);
const confidenceSchema = z.enum(["low", "medium", "high"]);

const intentSchema = z.object({
  id: z.string().optional(),
  kind: taskKindSchema,
  goal: z.string(),
  interpretation: z.string(),
  alternatives: z.array(z.string()).default([]),
  ambiguity: ambiguitySchema,
  confidence: confidenceSchema.default("medium"),
  evidence: z.array(z.string()).default([]),
  assumptions: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).min(1),
  constraints: z.array(z.string()).default([]),
  targetScope: z.array(z.string()).default([]),
  risk: riskSchema,
  editsAllowed: z.boolean(),
  requiresQuestion: z.boolean(),
  askReason: z.string().optional(),
  question: z.string().optional(),
});

const todoSchema = z.object({
  id: z.string(),
  content: z.string(),
  activeForm: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
  evidence: z.array(z.string()).default([]),
  criteria: z.array(z.string()).default([]),
});

const todoUpdateSchema = z.object({
  todos: z.array(todoSchema).min(1),
});

const planReadySchema = z.object({
  summary: z.string().describe("Short implementation plan summary."),
  evidence: z.array(z.string()).default([]).describe("Read-only evidence that supports this plan."),
});

const exitPlanModeSchema = z.object({
  plan: z.string().optional().describe("Implementation plan summary. If omitted, Servus uses the current recorded plan."),
  evidence: z.array(z.string()).default([]).describe("Read-only evidence supporting this plan."),
  allowedPrompts: z.array(z.object({
    tool: z.string().describe("Tool this permission applies to, e.g. Bash."),
    prompt: z.string().describe("Semantic action category, e.g. run tests or install dependencies."),
  })).optional().describe("Optional semantic permissions requested by the plan."),
}).passthrough();

const taskSchema = z.object({
  description: z.string().describe("Short phrase describing the helper task, shown in the tool timeline."),
  prompt: z.string().describe("Detailed instructions for the helper. Include concrete files, questions, and constraints when known."),
  subagent_type: z.string().optional().default("explore").describe("Helper type. Built-ins: explore, plan, review, verification, general-purpose. Custom ids from .servus/agents are also supported."),
});

const sendMessageSchema = z.object({
  to: z.string().describe("Helper run id or suffix returned by Task."),
  message: z.string().describe("Self-contained continuation instructions for that helper."),
});

const taskStopSchema = z.object({
  task_id: z.string().describe("Helper run id or suffix to stop."),
  reason: z.string().optional().describe("Reason for stopping the helper."),
});

const toolSearchSchema = z.object({
  query: z.string().describe("Capability or tool behavior to search for, e.g. edit files, inspect diff, ask user, subagent, lsp."),
});

const codingStateSchema = z.object({
  includeTodos: z.boolean().optional().default(true).describe("Include current coding todos."),
  includeEvidence: z.boolean().optional().default(false).describe("Include recent evidence summaries."),
});

const readToolResultSchema = z.object({
  path: z.string().describe("Artifact path returned by a truncated tool result."),
  offset: z.number().int().nonnegative().optional().default(0).describe("Character offset to start reading from."),
  limit: z.number().int().positive().optional().default(24_000).describe("Maximum characters to return."),
});

const memoryCategorySchema = z.enum([
  "project_profile",
  "architecture",
  "verification",
  "workflow",
  "important_files",
]);

const memoryReadSchema = z.object({
  maxChars: z.number().int().positive().optional().default(24_000).describe("Maximum characters of memory text to return."),
});

const memoryWriteSchema = z.object({
  text: z.string().min(12).max(800).describe("One durable project fact useful across future tasks. Do not include secrets, transient errors, or vague status."),
  category: memoryCategorySchema.describe("The memory category this fact belongs to."),
  reason: z.string().min(8).max(500).describe("Why this memory is useful in future contexts."),
  evidence: z.array(z.string()).default([]).describe("Files, commands, or observations supporting this memory."),
  confidence: z.enum(["low", "medium", "high"]).optional().default("high"),
});

const scratchpadPathSchema = z.object({
  path: z.string().optional().default("notes.md").describe("Scratchpad-relative path."),
});

const scratchpadWriteSchema = z.object({
  path: z.string().optional().default("notes.md").describe("Scratchpad-relative path."),
  content: z.string().describe("Content to write into the session scratchpad file."),
  append: z.boolean().optional().default(true).describe("Append by default; set false to replace the file."),
});

export function createCodingControlTools(
  runtime: CodingRuntime,
  options: {
    includeTask?: boolean;
    runTaskHelper?: (request: CodingHelperRequest) => Promise<string>;
  } = {},
) {
  const includeTask = options.includeTask ?? true;
  const controls = {
    coding_state: tool({
      description: [
        "Show the current Servus coding session state.",
        "Use this after compaction, helper returns, validation failures, or long tool runs to avoid stale assumptions.",
      ].join("\n"),
      inputSchema: codingStateSchema,
      execute: async (input: z.infer<typeof codingStateSchema>) => {
        const summary = await runtime.buildStatusSummary();
        return [
          summary,
          input.includeTodos ? [
            "",
            "Todos:",
            runtime.state.todos.length
              ? runtime.state.todos.map((todo) =>
                  `- [${todo.status}] ${todo.id}: ${todo.content}${todo.evidence.length ? ` (evidence: ${todo.evidence.join("; ")})` : ""}`
                ).join("\n")
              : "none",
          ].join("\n") : undefined,
          input.includeEvidence ? [
            "",
            "Recent evidence:",
            runtime.state.evidence.slice(-10).map((item) =>
              `- ${item.type} from ${item.source}: ${item.summary}`
            ).join("\n") || "none",
          ].join("\n") : undefined,
        ].filter(Boolean).join("\n");
      },
    }),

    ReadToolResult: tool({
      description: [
        "Read a large Servus tool-result artifact created when tool output was truncated.",
        "Only session-owned coding tool-result artifacts can be read. Use the artifact path shown in the previous tool output.",
      ].join("\n"),
      inputSchema: readToolResultSchema,
      execute: async (input: z.infer<typeof readToolResultSchema>) => {
        return readSessionToolResult(runtime.state.sessionId, input.path, input.offset, input.limit);
      },
    }),

    MemoryRead: tool({
      description: [
        "Read durable Servus project memory for this repository.",
        "Use when a task depends on established project conventions, commands, architecture notes, or prior verified facts.",
      ].join("\n"),
      inputSchema: memoryReadSchema,
      execute: async (input: z.infer<typeof memoryReadSchema>) => {
        const memory = readProjectMemory(runtime.state.targetCwd, input.maxChars);
        return [
          `Project memory: ${memory.enabled ? "enabled" : "disabled"}`,
          `Path: ${memory.memoryPath}`,
          `Truncated: ${memory.truncated ? "yes" : "no"}`,
          "",
          memory.text || "No project memory has been recorded yet.",
        ].join("\n");
      },
    }),

    MemoryWrite: tool({
      description: [
        "Write one durable Servus project memory fact.",
        "Use only for high-signal facts that are likely useful in future tasks: project commands, architecture conventions, important files, verified workflows, or stable constraints.",
        "Never store secrets, credentials, transient errors, one-off todos, or vague summaries.",
      ].join("\n"),
      inputSchema: memoryWriteSchema,
      execute: async (input: z.infer<typeof memoryWriteSchema>) => {
        const result = rememberProjectMemoryFact({
          cwd: runtime.state.targetCwd,
          sessionId: runtime.state.sessionId,
          text: input.text,
          category: input.category as ProjectMemoryCategory,
          source: input.evidence.length
            ? `MemoryWrite evidence: ${input.evidence.slice(0, 3).join("; ")}`
            : "MemoryWrite",
          reason: input.reason,
          confidence: input.confidence,
        });
        if (!result.updated) {
          return [
            "Project memory was not updated.",
            "The memory system may be disabled or the fact looked too transient, vague, secret-like, or low signal.",
            `Path: ${result.memoryPath}`,
          ].join("\n");
        }
        runtime.state.instructions = loadCodingInstructions(runtime.state.targetCwd);
        return [
          "Project memory updated.",
          `Path: ${result.memoryPath}`,
          result.added.length ? `Added: ${result.added.join(" | ")}` : `Refreshed: ${result.observed.join(" | ")}`,
        ].join("\n");
      },
    }),

    ScratchpadList: tool({
      description: "List files in the Servus session scratchpad used for coordinator/worker notes.",
      inputSchema: z.object({}),
      execute: async () => listScratchpad(runtime.state.scratchpadDir),
    }),

    ScratchpadRead: tool({
      description: "Read a Servus session scratchpad file. This is for coordinator/worker notes, not project files.",
      inputSchema: scratchpadPathSchema,
      execute: async (input: z.infer<typeof scratchpadPathSchema>) =>
        readScratchpad(runtime.state.scratchpadDir, input.path),
    }),

    ScratchpadWrite: tool({
      description: "Write or append coordinator/worker notes into the Servus session scratchpad. Does not modify the user's project.",
      inputSchema: scratchpadWriteSchema,
      execute: async (input: z.infer<typeof scratchpadWriteSchema>) =>
        writeScratchpad(runtime.state.scratchpadDir, input.path, input.content, input.append),
    }),

    coding_intent: tool({
      description: [
        "Confirm or update the coding intent contract before editing.",
        "Use this after read-only discovery when the initial interpretation, scope, acceptance criteria, or ambiguity changes.",
        "If ambiguity is material, set requiresQuestion=true and ask the user through servus_need_input instead of editing.",
      ].join("\n"),
      inputSchema: intentSchema,
      execute: async (input: z.infer<typeof intentSchema>) => {
        const updated = runtime.updateIntentContract({
          ...input,
          id: input.id ?? runtime.state.intentContract?.id ?? "intent-model",
          kind: input.kind as CodingTaskKind,
          ambiguity: input.ambiguity as CodingAmbiguity,
        } as CodingIntentContract);
        return [
          "Coding intent contract recorded.",
          `Ambiguity: ${updated.ambiguity}`,
          `Edits allowed: ${updated.editsAllowed}`,
          `Interpretation: ${updated.interpretation}`,
          `Criteria: ${updated.acceptanceCriteria.join(" | ")}`,
        ].join("\n");
      },
    }),

    coding_todo: tool({
      description: [
        "Update the session-owned coding todo list.",
        "Use this for multi-step work and keep exactly one item in_progress.",
        "Do not mark a todo completed unless evidence explains what satisfied it.",
      ].join("\n"),
      inputSchema: todoUpdateSchema,
      execute: async (input: z.infer<typeof todoUpdateSchema>) => {
        const todos = runtime.updateTodos(input.todos);
        const completed = todos.filter((todo) => todo.status === "completed").length;
        return `Coding todos updated: ${completed}/${todos.length} completed.`;
      },
    }),

    TodoWrite: tool({
      description: [
        "Servus todo tool.",
        "Use proactively for non-trivial multi-step coding work.",
        "Keep exactly one item in_progress and include evidence before marking items completed.",
        "Skip this for trivial one-step tasks.",
      ].join("\n"),
      inputSchema: todoUpdateSchema,
      execute: async (input: z.infer<typeof todoUpdateSchema>) => {
        const todos = runtime.updateTodos(input.todos);
        const completed = todos.filter((todo) => todo.status === "completed").length;
        const verificationNudgeNeeded = todos.length >= 3 &&
          todos.every((todo) => todo.status === "completed") &&
          !todos.some((todo) => /verif|test|typecheck|lint|build/i.test(todo.content));
        return [
          `Todos updated: ${completed}/${todos.length} completed.`,
          verificationNudgeNeeded
            ? "Reminder: this multi-step task has no verification todo. Add or run a verification step before final completion."
            : undefined,
        ].filter(Boolean).join("\n");
      },
    }),

    coding_plan_ready: tool({
      description: [
        "Signal that read-only planning is complete and implementation can proceed.",
        "Use before editing when the runtime planApproval status is pending.",
      ].join("\n"),
      inputSchema: planReadySchema,
      execute: async (input: z.infer<typeof planReadySchema>) => {
        const approval = runtime.markPlanReady(input.summary, input.evidence);
        return [
          "Coding plan checkpoint recorded.",
          `Status: ${approval.status}`,
          `Required: ${approval.required}`,
          `Summary: ${approval.planSummary ?? input.summary}`,
        ].join("\n");
      },
    }),

    ExitPlanMode: tool({
      description: [
        "Servus plan checkpoint tool.",
        "Use when read-only planning is complete and you are ready to proceed to implementation.",
        "Do not use this for pure research/analysis tasks. AskUserQuestion should be used first if requirements are still unresolved.",
      ].join("\n"),
      inputSchema: exitPlanModeSchema,
      execute: async (input: z.infer<typeof exitPlanModeSchema>) => {
        const summary = input.plan?.trim() ||
          runtime.state.planApproval.planSummary ||
          runtime.state.plan.tasks.map((task) => `- ${task.title}`).join("\n") ||
          "Read-only plan is ready.";
        const evidence = [
          ...input.evidence,
          ...(input.allowedPrompts?.map((item) => `${item.tool}: ${item.prompt}`) ?? []),
        ];
        const approval = runtime.markPlanReady(summary, evidence);
        return [
          "ExitPlanMode accepted by Servus.",
          `Status: ${approval.status}`,
          `Plan approval required: ${approval.required}`,
          "Continue with implementation only if edits are allowed by the intent contract.",
        ].join("\n");
      },
    }),

  };

  if (!includeTask) return controls;

  return {
    ...controls,
    Task: tool({
      description: [
        "Servus read-only helper agent tool.",
        "Use this when a focused helper can materially reduce uncertainty: codebase exploration, implementation planning, review, or independent verification.",
        "The helper cannot edit files. Servus will run it outside this model turn and inject its findings into the same session.",
        "After calling Task, wait for the helper result before calling servus_done.",
      ].join("\n"),
      inputSchema: taskSchema,
      execute: async (input: z.infer<typeof taskSchema>) => {
        const type = normalizeTaskHelperType(runtime, input.subagent_type);
        const request = runtime.requestHelper(type, input.description, input.prompt);
        if (options.runTaskHelper) {
          try {
            const result = await options.runTaskHelper(request);
            runtime.clearPendingHelperRequest(request.id);
            return result;
          } catch (err) {
            runtime.clearPendingHelperRequest(request.id);
            return [
              `Task helper failed: ${request.id}`,
              err instanceof Error ? err.message : String(err),
              "Continue without restarting. Use available repo evidence or ask one clear question if blocked.",
            ].join("\n");
          }
        }
        return [
          `Task helper scheduled: ${request.id}`,
          `Type: ${request.type}`,
          "Servus will return the helper findings in the same coding session. Do not finalize until those findings are available.",
        ].join("\n");
      },
    }),

    SendMessage: tool({
      description: [
        "Continue an existing Servus helper worker in the same coding session.",
        "Use this when the helper's prior context is useful. The message must be self-contained and include exact files, constraints, and done criteria.",
      ].join("\n"),
      inputSchema: sendMessageSchema,
      execute: async (input: z.infer<typeof sendMessageSchema>) => {
        const request = runtime.requestHelperContinuation(input.to, input.message);
        if (options.runTaskHelper) {
          try {
            const result = await options.runTaskHelper(request);
            runtime.clearPendingHelperRequest(request.id);
            return result;
          } catch (err) {
            runtime.clearPendingHelperRequest(request.id);
            return [
              `SendMessage helper continuation failed: ${request.id}`,
              err instanceof Error ? err.message : String(err),
              "Continue without restarting. Use available repo evidence or ask one clear question if blocked.",
            ].join("\n");
          }
        }
        return `Continuation scheduled for ${input.to}: ${request.id}`;
      },
    }),

    TaskStop: tool({
      description: "Stop or mark a Servus helper worker as no longer relevant.",
      inputSchema: taskStopSchema,
      execute: async (input: z.infer<typeof taskStopSchema>) => {
        const result = runtime.stopHelperRun(input.task_id, input.reason);
        return result.summary;
      },
    }),

    ToolSearch: tool({
      description: [
        "Servus tool discovery helper.",
        "Use when you are unsure which Servus tool should handle a coding action.",
      ].join("\n"),
      inputSchema: toolSearchSchema,
      execute: async (input: z.infer<typeof toolSearchSchema>) => {
        return searchCodingTools(input.query, runtime);
      },
    }),
  };
}

function searchCodingTools(query: string, runtime: CodingRuntime): string {
  const terms = query.toLowerCase().split(/[^a-z0-9_/-]+/).filter(Boolean);
  const catalog = [
    {
      names: ["coding_state"],
      text: "Inspect current Servus coding session state: intent, todos, checkpoints, selected skills, verification, and changed files.",
      keywords: ["state", "status", "session", "todo", "checkpoint", "verification", "context"],
    },
    {
      names: ["Read", "read"],
      text: "Read a file or directory. Required before Edit/Write/Patch on existing files. Hidden Servus/internal paths stay excluded by default.",
      keywords: ["read", "file", "open", "inspect", "directory", "context"],
    },
    {
      names: ["workspace_map", "WorkspaceMap"],
      text: "Bounded tree-style workspace map for project summaries, architecture orientation, and choosing focused search paths.",
      keywords: ["tree", "map", "structure", "workspace", "project", "summary", "architecture", "files"],
    },
    {
      names: ["project_overview", "ProjectOverview"],
      text: "Policy-safe project overview from docs, manifests, source layout, configs, and likely entrypoints. Use first for project summaries and onboarding analysis.",
      keywords: ["project", "overview", "summary", "architecture", "onboarding", "readme", "manifest", "entrypoint", "structure"],
    },
    {
      names: ["Grep", "grep"],
      text: "Search file contents with ripgrep. Supports files_with_matches, content, count, context, offset, type, and ignore_case.",
      keywords: ["grep", "search", "find", "regex", "content", "symbol", "matches"],
    },
    {
      names: ["Glob", "glob"],
      text: "Find files by glob with limit/offset and workspace ignore policy.",
      keywords: ["glob", "files", "pattern", "find", "list"],
    },
    {
      names: ["Edit", "edit"],
      text: "Precise existing-file string replacement. Requires prior Read and unique oldString context.",
      keywords: ["edit", "replace", "modify", "patch", "change"],
    },
    {
      names: ["Write", "write"],
      text: "Create or overwrite a file. Existing files require prior Read. New docs/README require explicit user request.",
      keywords: ["write", "create", "overwrite", "file"],
    },
    {
      names: ["Bash", "bash", "BashOutput", "KillBash"],
      text: "Run project commands and verification. Bash supports run_in_background for long commands; use BashOutput to poll and KillBash to stop. Destructive, dependency install, git mutation, and shell-side file mutation require approval or are blocked.",
      keywords: ["bash", "shell", "command", "test", "build", "verify", "npm", "git", "background", "output", "kill"],
    },
    {
      names: ["LSP", "lsp_status"],
      text: "Code intelligence. Uses real configured/detected language servers when available, then falls back to source/ripgrep. Supports documentSymbol, goToDefinition, findReferences, hover, workspaceSymbol, and call hierarchy.",
      keywords: ["lsp", "language", "server", "definition", "references", "symbols", "hover", "call"],
    },
    {
      names: ["workspace_status"],
      text: "Read-only git status summary with Servus/generated paths hidden. Use before and after edits.",
      keywords: ["status", "git", "dirty", "workspace", "changes"],
    },
    {
      names: ["git_diff"],
      text: "Read-only current diff or diff stat. Use before finalizing changes.",
      keywords: ["diff", "review", "changes", "checkpoint"],
    },
    {
      names: ["ReadToolResult"],
      text: "Read a previously truncated large tool-result artifact from this coding session.",
      keywords: ["tool", "result", "artifact", "large", "truncated", "output"],
    },
    {
      names: ["TodoWrite", "coding_todo"],
      text: "Maintain multi-step task todos. Exactly one in_progress; completed todos need evidence.",
      keywords: ["todo", "plan", "tasks", "track"],
    },
    {
      names: ["ExitPlanMode", "coding_plan_ready"],
      text: "Record the read-only plan checkpoint before broad/risky implementation.",
      keywords: ["plan", "approval", "checkpoint", "exit"],
    },
    {
      names: ["Task", "SendMessage", "TaskStop"],
      text: "Run, continue, or stop focused Servus helper workers. Task can use explore, plan, review, verification, worker, or custom subagents.",
      keywords: ["task", "agent", "subagent", "helper", "worker", "sendmessage", "stop", "explore", "review", "verification"],
    },
    {
      names: ["MemoryRead", "MemoryWrite"],
      text: "Read or intentionally update durable Servus project memory. MemoryWrite stores only high-signal stable facts and rejects transient notes or secrets.",
      keywords: ["memory", "remember", "project", "durable", "conventions", "instructions", "learn"],
    },
    {
      names: ["ScratchpadList", "ScratchpadRead", "ScratchpadWrite"],
      text: "Session scratchpad tools for durable coordinator/worker notes. These do not modify project files.",
      keywords: ["scratchpad", "notes", "worker", "coordinator", "memory", "session"],
    },
    {
      names: ["mcp_list_servers", "McpListTools", "McpCallTool", "ListMcpPromptsTool", "GetMcpInstructionsTool", "TestMcpServerTool"],
      text: "Discover and call tools from configured MCP servers. McpCallTool asks approval because external tools may mutate remote state.",
      keywords: ["mcp", "server", "tool", "resource", "external", "connector"],
    },
    {
      names: ["ListMcpResourcesTool", "ReadMcpResourceTool"],
      text: "Servus MCP resource tools for listing configured resources and reading one resource by server and URI.",
      keywords: ["mcp", "resource", "read", "list", "context"],
    },
    {
      names: ["AskUserQuestion", "servus_need_input"],
      text: "Ask one clear user question with concrete options only when genuinely blocked.",
      keywords: ["ask", "question", "input", "clarify", "ambiguity"],
    },
    {
      names: ["servus_done"],
      text: "Finish only after intent, changed files or repo evidence, diff/checkpoint, verification, and satisfied criteria are present.",
      keywords: ["done", "finish", "complete", "final"],
    },
  ];
  const scored = catalog
    .map((entry) => ({
      entry,
      score: terms.reduce((score, term) => {
        const haystack = `${entry.names.join(" ")} ${entry.text} ${entry.keywords.join(" ")}`.toLowerCase();
        return score + (haystack.includes(term) ? 1 : 0);
      }, 0),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  const results = scored.length ? scored.map((item) => item.entry) : catalog.slice(0, 8);
  const customAgents = runtime.state.agents
    .filter((agent) => {
      const haystack = `${agent.id} ${agent.description}`.toLowerCase();
      return terms.length === 0 || terms.some((term) => haystack.includes(term));
    })
    .slice(0, 8);
  return [
    `ToolSearch results for: ${query}`,
    "",
    ...results.map((entry) => `- ${entry.names.join(" / ")}: ${entry.text}`),
    ...(customAgents.length
      ? [
          "",
          "Custom Task subagents:",
          ...customAgents.map((agent) => `- Task(subagent_type="${agent.id}"): ${agent.description}`),
        ]
      : []),
  ].join("\n");
}

function readSessionToolResult(
  sessionId: string,
  artifactPath: string,
  offset = 0,
  limit = 24_000,
): string {
  const base = resolve(SERVUS_DIR, "sessions", sessionId, "coding", "tool-results");
  const target = resolve(artifactPath);
  const rel = relative(base, target);
  if (!rel || rel.startsWith("..") || rel.split(/[\\/]/).includes("..")) {
    return "Error: ReadToolResult can only read tool-result artifacts from the current Servus coding session.";
  }
  if (!existsSync(target)) return `Error: tool-result artifact not found — ${artifactPath}`;
  const st = statSync(target);
  if (!st.isFile()) return `Error: tool-result artifact is not a file — ${artifactPath}`;
  const text = readFileSync(target, "utf-8");
  const start = Math.max(0, offset);
  const count = Math.max(1, Math.min(limit, 60_000));
  const end = Math.min(text.length, start + count);
  return [
    `Tool result artifact: ${target}`,
    `Chars: ${start}-${end} of ${text.length}`,
    `Truncated: ${end < text.length ? "yes" : "no"}`,
    "",
    text.slice(start, end),
  ].join("\n");
}

function scratchpadFile(baseDir: string | undefined, requested = "notes.md"): { ok: true; path: string } | { ok: false; error: string } {
  if (!baseDir) return { ok: false, error: "Error: no session scratchpad is available for this direct run." };
  const safe = requested.trim() || "notes.md";
  const target = resolve(baseDir, safe);
  const rel = relative(resolve(baseDir), target);
  if (!rel || rel.startsWith("..") || rel.split(/[\\/]/).includes("..")) {
    return { ok: false, error: `Error: scratchpad path must stay inside ${baseDir}.` };
  }
  return { ok: true, path: target };
}

function listScratchpad(baseDir: string | undefined): string {
  if (!baseDir) return "No session scratchpad is available for this direct run.";
  if (!existsSync(baseDir)) return `Scratchpad is empty: ${baseDir}`;
  const files: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(baseDir!, full);
      if (entry.isDirectory()) walk(full);
      else files.push(rel);
      if (files.length >= 200) return;
    }
  }
  walk(baseDir);
  return files.length
    ? [`Scratchpad: ${baseDir}`, "", ...files].join("\n")
    : `Scratchpad is empty: ${baseDir}`;
}

function readScratchpad(baseDir: string | undefined, requested = "notes.md"): string {
  const target = scratchpadFile(baseDir, requested);
  if (!target.ok) return target.error;
  if (!existsSync(target.path)) return `Scratchpad file not found: ${relative(baseDir!, target.path)}`;
  const st = statSync(target.path);
  if (!st.isFile()) return `Scratchpad path is not a file: ${relative(baseDir!, target.path)}`;
  const text = readFileSync(target.path, "utf-8");
  return [
    `Scratchpad file: ${relative(baseDir!, target.path)}`,
    `Chars: ${text.length}`,
    "",
    text.slice(0, 60_000),
    text.length > 60_000 ? "\n[... scratchpad output truncated ...]" : "",
  ].join("\n");
}

function writeScratchpad(
  baseDir: string | undefined,
  requested = "notes.md",
  content: string,
  append = true,
): string {
  const target = scratchpadFile(baseDir, requested);
  if (!target.ok) return target.error;
  mkdirSync(dirname(target.path), { recursive: true });
  const prefix = append && existsSync(target.path) ? "\n\n" : "";
  const next = append && existsSync(target.path)
    ? `${readFileSync(target.path, "utf-8")}${prefix}${content}`
    : content;
  writeFileSync(target.path, next, "utf-8");
  return `Scratchpad ${append ? "updated" : "written"}: ${relative(baseDir!, target.path)} (${next.length} chars)`;
}

function normalizeTaskHelperType(runtime: CodingRuntime, type: z.infer<typeof taskSchema>["subagent_type"]): CodingHelperType {
  const normalized = (type || "explore").trim().toLowerCase();
  if (runtime.getCodingAgent(normalized)) return normalized;
  if (type === "plan" || type === "review" || type === "verification" || type === "worker") return type;
  if (normalized === "plan" || normalized === "review" || normalized === "verification" || normalized === "worker") return normalized;
  return "explore";
}
