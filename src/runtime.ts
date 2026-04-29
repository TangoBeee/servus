import { randomUUID } from "node:crypto";
import type { ZodTypeAny } from "zod";
import type { Engine, EngineContext, EngineResult, TaskDomain } from "./engine.js";

export type RunStatus = "queued" | "running" | "waiting_input" | "completed" | "failed" | "cancelled";
export type RunPhase = "orienting" | "discovering" | "planning" | "acting" | "verifying" | "waiting_input" | "completed" | "failed";
export type ToolRisk = "low" | "medium" | "high" | "critical";
export type ToolSource = "core" | "plugin" | "mcp" | "skill";

export interface SessionEvent {
  type: string;
  message: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface RunSession {
  id: string;
  cwd: string;
  task: string;
  domain: TaskDomain;
  model: string;
  mode: string;
  budget?: number;
  status: RunStatus;
  phase?: RunPhase;
  contract?: RunContract;
  startedAt: number;
  endedAt?: number;
  events: SessionEvent[];
  evidence: EvidenceItem[];
  artifacts: string[];
  cost: number;
}

export interface RunContract {
  id: string;
  domain: TaskDomain;
  intent: string;
  criteria: string[];
  requiredEvidence: string[];
  risk: ToolRisk;
  maxRepairAttempts: number;
}

export interface EvidenceItem {
  id: string;
  type: string;
  source: string;
  summary: string;
  data?: unknown;
  confidence?: "low" | "medium" | "high";
  timestamp: number;
}

export interface CompletionDecision {
  accepted: boolean;
  status: "completed" | "waiting_input" | "failed";
  missingCriteria: string[];
  confidence: "low" | "medium" | "high";
  repairPrompt?: string;
}

export interface ToolExecutionContext {
  cwd: string;
  session?: RunSession;
  signal?: AbortSignal;
}

export interface ToolResult {
  success: boolean;
  content: string;
  artifacts?: string[];
  evidence?: EvidenceItem[];
  candidates?: unknown[];
  verified?: boolean;
  confidence?: "low" | "medium" | "high";
  postconditions?: string[];
  structuredData?: unknown;
  sourcePath?: string;
  outputPath?: string;
  mimeType?: string;
  rows?: number;
  pages?: number;
  sheets?: number;
  error?: string;
  cost?: number;
  durationMs?: number;
}

export interface ToolDefinition<Input = unknown> {
  name: string;
  description: string;
  inputSchema?: ZodTypeAny;
  domain?: TaskDomain | "all";
  source: ToolSource;
  risk: ToolRisk;
  readOnly: boolean;
  mutatesFiles?: boolean;
  requiresCheckpoint?: boolean;
  permissionCategory?: string;
  evidenceType?: string;
  requiresConsent?: boolean;
  timeoutMs?: number;
  execute: (input: Input, context: ToolExecutionContext) => Promise<ToolResult> | ToolResult;
}

export interface SkillManifest {
  name: string;
  description: string;
  whenToUse?: string;
  allowedTools?: string[];
  pathPatterns?: string[];
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh";
  disableModelInvocation?: boolean;
  source: "bundled" | "project" | "user" | "plugin";
  path: string;
  body: string;
}

export interface PluginManifest {
  id: string;
  version: string;
  name?: string;
  description?: string;
  tools?: string[];
  skills?: string[];
  mcpServers?: Record<string, {
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
    headers?: Record<string, string>;
    timeoutMs?: number;
    toolFilter?: string[];
    resourceFilter?: string[];
    transport?: "auto" | "stdio" | "streamable-http" | "sse" | "http";
    auth?: {
      type?: "none" | "bearer" | "header" | "oauth" | "client_credentials";
      tokenEnv?: string;
      headerName?: string;
      clientIdEnv?: string;
      clientSecretEnv?: string;
      scopes?: string[];
      redirectUrl?: string;
    };
    disabled?: boolean;
  }>;
  lspServers?: Record<string, {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    extensions?: string[];
    languages?: Record<string, string>;
    languageId?: string;
    initializationOptions?: unknown;
  }>;
  hooks?: Record<string, Array<{
    matcher?: string;
    hooks: Array<{
      type?: "command" | "http" | "prompt";
      command?: string;
      url?: string;
      prompt?: string;
      model?: string;
      timeoutMs?: number;
      timeout?: number;
      statusMessage?: string;
      blocking?: boolean;
      async?: boolean;
      once?: boolean;
      headers?: Record<string, string>;
    }>;
  }>>;
  configSchema?: unknown;
  activation?: {
    always?: boolean;
    triggers?: string[];
    domains?: TaskDomain[];
    capabilities?: string[];
  };
  path: string;
}

export interface CreateRunSessionInput {
  cwd: string;
  task: string;
  domain: TaskDomain;
  model: string;
  mode: string;
  budget?: number;
}

export function createRunSession(input: CreateRunSessionInput): RunSession {
  return {
    id: randomUUID(),
    cwd: input.cwd,
    task: input.task,
    domain: input.domain,
    model: input.model,
    mode: input.mode,
    budget: input.budget,
    status: "running",
    phase: "orienting",
    startedAt: Date.now(),
    events: [],
    evidence: [],
    artifacts: [],
    cost: 0,
  };
}

export class AgentRuntime {
  readonly session: RunSession;

  constructor(session: RunSession) {
    this.session = session;
  }

  record(type: string, message: string, metadata?: Record<string, unknown>): SessionEvent {
    const event: SessionEvent = {
      type,
      message,
      timestamp: Date.now(),
      ...(metadata ? { metadata } : {}),
    };
    this.session.events.push(event);
    return event;
  }

  setPhase(phase: RunPhase, message: string = phase): void {
    this.session.phase = phase;
    this.record("runtime:phase", message, { phase });
  }

  addEvidence(item: Omit<EvidenceItem, "id" | "timestamp"> & { id?: string; timestamp?: number }): EvidenceItem {
    const evidence: EvidenceItem = {
      id: item.id ?? randomUUID(),
      type: item.type,
      source: item.source,
      summary: item.summary,
      ...(item.data !== undefined ? { data: item.data } : {}),
      ...(item.confidence ? { confidence: item.confidence } : {}),
      timestamp: item.timestamp ?? Date.now(),
    };
    this.session.evidence.push(evidence);
    this.record("evidence:add", evidence.summary, { evidence });
    return evidence;
  }

  async executeEngine(engine: Engine, ctx: EngineContext): Promise<EngineResult> {
    this.setPhase("acting", `Starting ${engine.name}`);
    this.record("engine:start", `Starting ${engine.name}`, { engine: engine.name });

    try {
      const result = await engine.execute(ctx);
      this.session.cost += result.cost;
      if (result.artifacts) this.session.artifacts.push(...result.artifacts);

      if (result.needsInput) {
        this.session.status = "waiting_input";
        this.setPhase("waiting_input", result.question ?? result.summary);
        this.record("engine:needs_input", result.question ?? result.summary, {
          engine: engine.name,
          questions: result.questions,
          questionContext: result.questionContext,
          clarification: result.clarification,
          cost: result.cost,
        });
      } else if (result.success) {
        this.session.status = "completed";
        this.setPhase("completed", result.summary);
        this.record("engine:complete", result.summary, { engine: engine.name, cost: result.cost });
      } else {
        this.session.status = "failed";
        this.setPhase("failed", result.error ?? result.summary);
        this.record("engine:error", result.error ?? result.summary, { engine: engine.name });
      }

      this.session.endedAt = Date.now();
      return result;
    } catch (err: unknown) {
      this.session.status = "failed";
      this.session.endedAt = Date.now();
      const message = err instanceof Error ? err.message : String(err);
      this.setPhase("failed", message);
      this.record("engine:error", message, { engine: engine.name });
      throw err;
    }
  }
}
