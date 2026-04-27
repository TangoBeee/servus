/**
 * Engine abstraction layer.
 *
 * Each domain-specific engine (Coding, Desktop, Browser, Media, Data, Extension)
 * implements this interface. The orchestrator routes tasks to the
 * appropriate engine based on intent classification.
 */

import type { AgentBackend } from "./agent.js";
import type { ClarificationRequest } from "./clarification.js";
import type { EvidenceItem } from "./runtime.js";

// ─── Engine Context ─────────────────────────────────────────────────────────

export interface EngineContext {
  /** User's original task prompt */
  task: string;
  /** Working directory for file operations */
  cwd: string;
  /** LLM model to use for agents */
  model: string;
  /** Agent backend (claude-code or custom) */
  backend: AgentBackend;
  /** Max consecutive failures before giving up */
  maxConsecutiveFailures: number;
  /** Optional custom verification command */
  verifyCommand?: string;
  /** Budget cap in USD */
  maxBudgetUsd?: number;
  /** Session ID for TUI runs */
  sessionId?: string;
  /** Callback for requesting user consent on risky operations */
  onConsent?: (action: string, detail: string) => Promise<boolean>;
}

// ─── Engine Result ──────────────────────────────────────────────────────────

export interface EngineResult {
  /** Whether the engine completed its task successfully */
  success: boolean;
  /** Human-readable summary of what was done */
  summary: string;
  /** True when the engine stopped because it needs more user input. */
  needsInput?: boolean;
  /** Primary question or prompt to show to the user when needsInput is true. */
  question?: string;
  /** Specific questions/details requested from the user. */
  questions?: string[];
  /** Context shown before asking the user for missing details. */
  questionContext?: string;
  /** Structured clarification request for same-session continuations. */
  clarification?: ClarificationRequest;
  /** Paths to output artifacts (files, screenshots, etc.) */
  artifacts?: string[];
  /** Evidence collected by the runtime or domain tools. */
  evidence?: EvidenceItem[];
  /** Total cost incurred by this engine run */
  cost: number;
  /** Error message if the engine failed */
  error?: string;
}

// ─── Engine Interface ───────────────────────────────────────────────────────

export interface Engine {
  /** Unique engine identifier (e.g. "coding", "desktop", "browser", "media", "data", "extension", "security") */
  readonly name: string;
  /** Human-readable description used by the router for classification */
  readonly description: string;

  /**
   * Execute a natural-language task within this engine's domain.
   * Returns a structured result with success/failure and summary.
   */
  execute(ctx: EngineContext): Promise<EngineResult>;

  /** Cleanup resources (close agent sessions, etc.) */
  close(): void;
}

// ─── Task Domain Classification ─────────────────────────────────────────────

export type TaskDomain =
  | "coding"
  | "desktop"
  | "browser"
  | "media"
  | "data"
  | "extension"
  | "security"
  | "general";
