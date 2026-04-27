/**
 * Agent abstraction layer.
 *
 * Defines the IAgent interface that both the Claude Code SDK backend and
 * the custom AI SDK backend implement.  The orchestrator works exclusively
 * with this interface so it's backend-agnostic.
 */

export interface AgentConfig {
  name: string;
  role: string;
  color: string;
  model: string;
  prompt: string;
  disallowedTools?: string[];
  /** Additional tools to merge with the base tool set */
  extraTools?: Record<string, unknown>;
  /** Stable Servus run/session id for persistent agent context. */
  sessionId?: string;
}

export interface AgentToolEvent {
  type: "call" | "result";
  toolName: string;
  toolCallId?: string;
  input?: unknown;
  output?: unknown;
  timestamp: number;
}

export interface AgentFinalization {
  kind: "done" | "need_input";
  summary?: string;
  question?: string;
  questions?: string[];
  evidence?: Array<{
    type: string;
    source: string;
    summary: string;
    confidence?: "low" | "medium" | "high";
    data?: unknown;
  }>;
  satisfiedCriteria?: string[];
  artifacts?: string[];
  remainingRisks?: string[];
  confidence?: "low" | "medium" | "high";
}

export interface AgentResponse {
  text: string;
  cost: number;
  turns: number;
  subtype: string;
  finalization?: AgentFinalization;
  toolEvents?: AgentToolEvent[];
}

export interface IAgent {
  readonly name: string;
  readonly role: string;
  readonly color: string;
  readonly cost: number;

  send(message: string): Promise<AgentResponse>;
  close(): void;
}

export type AgentBackend = "claude-code" | "custom";

/**
 * Create an agent using the selected backend.
 *
 * - "claude-code"  → delegates to the @anthropic-ai/claude-agent-sdk V2 session
 * - "custom"       → uses the Vercel AI SDK with any supported provider
 */
export async function createAgent(
  backend: AgentBackend,
  config: AgentConfig,
  options?: { cwd?: string },
): Promise<IAgent> {
  switch (backend) {
    case "claude-code": {
      const { ClaudeCodeAgent } = await import("./agent-claude.js");
      return new ClaudeCodeAgent(config);
    }
    case "custom": {
      const { CustomAgent } = await import("./agent-custom.js");
      return new CustomAgent(config, options?.cwd ?? process.cwd());
    }
    default:
      throw new Error(`Unknown agent backend: ${backend}`);
  }
}
