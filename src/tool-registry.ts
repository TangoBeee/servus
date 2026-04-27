import { bus } from "./events.js";
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
} from "./runtime.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TOOL_OUTPUT = 50_000;

export interface ToolCall {
  name: string;
  input: unknown;
}

export interface ToolBatchPlan {
  readOnly: ToolCall[];
  mutating: ToolCall[];
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(definition: ToolDefinition): void {
    if (this.tools.has(definition.name)) {
      throw new Error(`Tool already registered: ${definition.name}`);
    }
    this.tools.set(definition.name, definition);
  }

  registerMany(definitions: ToolDefinition[]): void {
    for (const definition of definitions) this.register(definition);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  planBatch(calls: ToolCall[]): ToolBatchPlan {
    const readOnly: ToolCall[] = [];
    const mutating: ToolCall[] = [];

    for (const call of calls) {
      const tool = this.tools.get(call.name);
      if (tool?.readOnly) readOnly.push(call);
      else mutating.push(call);
    }

    return { readOnly, mutating };
  }

  async execute(
    name: string,
    input: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolResult> {
    const definition = this.tools.get(name);
    if (!definition) {
      return {
        success: false,
        content: `Unknown tool: ${name}`,
        error: `Unknown tool: ${name}`,
      };
    }

    const started = Date.now();
    bus.push({
      type: "agent:tool_call",
      agent: "Runtime",
      message: name,
      metadata: {
        tool: name,
        source: definition.source,
        risk: definition.risk,
        readOnly: definition.readOnly,
      },
    });

    try {
      const parsed = definition.inputSchema ? definition.inputSchema.parse(input) : input;
      const timeoutMs = definition.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const result = await withTimeout(
        Promise.resolve(definition.execute(parsed, context)),
        timeoutMs,
        name,
      );
      const normalized = normalizeResult(result, Date.now() - started);

      bus.push({
        type: "agent:tool_result",
        agent: "Runtime",
        message: normalized.success ? "done" : normalized.error ?? "failed",
        metadata: {
          tool: name,
          durationMs: normalized.durationMs,
          success: normalized.success,
        },
      });

      return normalized;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const result: ToolResult = {
        success: false,
        content: message,
        error: message,
        durationMs: Date.now() - started,
      };

      bus.push({
        type: "agent:tool_result",
        agent: "Runtime",
        message,
        metadata: { tool: name, success: false, durationMs: result.durationMs },
      });

      return result;
    }
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  toolName: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Tool timed out after ${timeoutMs}ms: ${toolName}`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function normalizeResult(result: ToolResult, durationMs: number): ToolResult {
  const content = clamp(result.content);
  return {
    ...result,
    content,
    durationMs,
  };
}

function clamp(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT) return text;
  const keep = Math.floor((MAX_TOOL_OUTPUT - 80) / 2);
  return `${text.slice(0, keep)}\n\n[... truncated ${text.length - MAX_TOOL_OUTPUT} characters ...]\n\n${text.slice(-keep)}`;
}
