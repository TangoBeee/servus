/**
 * Agent abstraction layer.
 *
 * Defines the IAgent interface used by the Servus agent runtime. The
 * orchestrator works exclusively with this interface so domain engines stay
 * backend-agnostic.
 */

import type { TaskDomain } from "./engine.js";

export interface AgentConfig {
  name: string;
  role: string;
  color: string;
  model: string;
  prompt: string;
  /** Domain this agent is serving. Used for skills, plugins, hooks, and policy context. */
  domain?: TaskDomain;
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
  choices?: Array<{
    id: string;
    label: string;
    options: string[];
    required?: boolean;
  }>;
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

export type AgentBackend = "custom";

const LEGACY_PROVIDER_BACKEND = `${"claude"}-code`;
const REMOVED_PROVIDER_SDK_BACKEND = `${"provider"}-sdk`;

export function normalizeAgentBackend(value: unknown): AgentBackend {
  if (value === REMOVED_PROVIDER_SDK_BACKEND || value === LEGACY_PROVIDER_BACKEND) return "custom";
  return "custom";
}

/**
 * Create an agent using the selected backend.
 *
 * - custom         → uses the AI SDK with any supported provider
 */
export async function createAgent(
  backend: AgentBackend,
  config: AgentConfig,
  options?: { cwd?: string },
): Promise<IAgent> {
  switch (backend) {
    case "custom": {
      const { CustomAgent } = await import("./agent-custom.js");
      return new CustomAgent(config, options?.cwd ?? process.cwd());
    }
    default:
      throw new Error(`Unknown agent backend: ${backend}`);
  }
}
