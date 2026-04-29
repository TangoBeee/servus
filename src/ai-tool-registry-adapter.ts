import { tool, type ToolSet } from "ai";
import type { ZodTypeAny } from "zod";
import type { ToolRisk, ToolResult } from "./runtime.js";
import { ToolRegistry } from "./tool-registry.js";

type AiToolLike = {
  description?: string;
  inputSchema?: unknown;
  execute?: (input: unknown, options?: { abortSignal?: AbortSignal }) => Promise<unknown> | unknown;
};

const READ_ONLY_TOOLS = new Set([
  "read",
  "Read",
  "glob",
  "Glob",
  "grep",
  "Grep",
  "ls",
  "LS",
  "workspace_status",
  "git_diff",
  "LSP",
  "webfetch",
  "WebFetch",
  "browser_current_state",
  "browser_snapshot",
  "browser_observe",
  "browser_extract",
  "browser_screenshot",
  "data_readiness",
  "document_info",
  "extract_document_text",
  "extract_table",
  "media_readiness",
  "media_info",
  "security_scope",
  "security_recon",
  "servus_done",
  "servus_need_input",
  "servus_progress",
  "ReportProgress",
  "AskUserQuestion",
  "mcp_list_servers",
  "McpListTools",
  "ListMcpPromptsTool",
  "GetMcpInstructionsTool",
  "TestMcpServerTool",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
]);

const FILE_MUTATING_TOOLS = new Set(["write", "Write", "edit", "Edit", "MultiEdit", "patch", "apply_patch"]);

export function wrapToolSetWithRegistry(tools: ToolSet, cwd: string): ToolSet {
  const registry = new ToolRegistry();
  const wrapped: Record<string, unknown> = {};
  let mutationQueue: Promise<unknown> = Promise.resolve();

  for (const [name, rawTool] of Object.entries(tools as Record<string, unknown>)) {
    if (!isAiToolLike(rawTool)) {
      wrapped[name] = rawTool;
      continue;
    }

    const metadata = metadataForTool(name);
    registry.register({
      name,
      description: rawTool.description ?? name,
      inputSchema: isZodLike(rawTool.inputSchema) ? rawTool.inputSchema : undefined,
      domain: name.startsWith("browser_")
        ? "browser"
        : name.startsWith("desktop_")
          ? "desktop"
          : name.startsWith("media_")
            ? "media"
            : name.startsWith("data_")
              ? "data"
              : name.startsWith("security_")
                ? "security"
                : "coding",
      source: "core",
      risk: metadata.risk,
      readOnly: metadata.readOnly,
      mutatesFiles: metadata.mutatesFiles,
      requiresCheckpoint: metadata.requiresCheckpoint,
      permissionCategory: metadata.permissionCategory,
      evidenceType: metadata.evidenceType,
      requiresConsent: metadata.requiresConsent,
      timeoutMs: metadata.timeoutMs,
      execute: async (input, context) => {
        const output = await rawTool.execute!(input, { abortSignal: context.signal });
        return normalizeToolOutput(output);
      },
    });

    wrapped[name] = tool({
      description: rawTool.description ?? name,
      inputSchema: rawTool.inputSchema as never,
      execute: async (input: unknown, options?: { abortSignal?: AbortSignal }) => {
        const run = () => registry.execute(name, input, {
          cwd,
          signal: options?.abortSignal,
        });
        const result = metadata.readOnly
          ? await run()
          : await enqueueMutation(run);
        if (result.success) return result.content;
        return `Error: ${result.error ?? result.content}`;
      },
    });
  }

  return wrapped as ToolSet;

  function enqueueMutation(run: () => Promise<ReturnType<ToolRegistry["execute"]> extends Promise<infer T> ? T : never>) {
    const next = mutationQueue.then(run, run);
    mutationQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

function metadataForTool(name: string): {
  readOnly: boolean;
  risk: ToolRisk;
  mutatesFiles?: boolean;
  requiresCheckpoint?: boolean;
  permissionCategory?: string;
  evidenceType?: string;
  requiresConsent?: boolean;
  timeoutMs?: number;
} {
  if (READ_ONLY_TOOLS.has(name)) {
    return {
      readOnly: true,
      risk: "low",
      evidenceType: evidenceTypeFor(name),
      timeoutMs: name === "webfetch" ? 45_000 : 120_000,
    };
  }
  if (FILE_MUTATING_TOOLS.has(name)) {
    return {
      readOnly: false,
      risk: "medium",
      mutatesFiles: true,
      requiresCheckpoint: true,
      permissionCategory: "file_write",
      evidenceType: "coding_change",
      timeoutMs: 120_000,
    };
  }
  if (name === "bash") {
    return {
      readOnly: false,
      risk: "high",
      permissionCategory: "shell",
      evidenceType: "command_result",
      requiresConsent: true,
      timeoutMs: 600_000,
    };
  }
  if (
    name === "todowrite" ||
    name === "TodoWrite" ||
    name === "coding_intent" ||
    name === "coding_todo" ||
    name === "coding_plan_ready" ||
    name === "ExitPlanMode"
  ) {
    return {
      readOnly: false,
      risk: "low",
      permissionCategory: "plan_update",
      evidenceType: evidenceTypeFor(name),
      timeoutMs: 30_000,
    };
  }
  return {
    readOnly: false,
    risk: "medium",
    permissionCategory: "tool",
    evidenceType: evidenceTypeFor(name),
    timeoutMs: 120_000,
  };
}

function evidenceTypeFor(name: string): string {
  if (["read", "Read", "grep", "Grep", "glob", "Glob", "ls", "LS", "workspace_status", "git_diff", "LSP"].includes(name)) return "repo_evidence";
  if (name.startsWith("browser_")) return "browser_state";
  if (name.startsWith("data_")) return "artifact_verified";
  if (name.startsWith("media_")) return "artifact_verified";
  if (name.startsWith("security_")) return "scope_or_target_evidence";
  if (name.startsWith("desktop_")) return "path_verified";
  if (name === "coding_intent") return "coding_intent";
  if (name === "coding_todo" || name === "TodoWrite") return "coding_todo";
  if (name === "coding_plan_ready" || name === "ExitPlanMode") return "coding_plan";
  return "tool_result";
}

function normalizeToolOutput(output: unknown): ToolResult {
  if (typeof output === "string") {
    return {
      success: !output.startsWith("Error:"),
      content: output,
      ...(output.startsWith("Error:") ? { error: output } : {}),
    };
  }
  if (output && typeof output === "object" && "content" in output && "success" in output) {
    return output as ToolResult;
  }
  return {
    success: true,
    content: JSON.stringify(output ?? ""),
    structuredData: output,
  };
}

function isAiToolLike(value: unknown): value is AiToolLike {
  return typeof value === "object" &&
    value !== null &&
    typeof (value as AiToolLike).execute === "function" &&
    "inputSchema" in value;
}

function isZodLike(value: unknown): value is ZodTypeAny {
  return typeof value === "object" && value !== null && typeof (value as { parse?: unknown }).parse === "function";
}
