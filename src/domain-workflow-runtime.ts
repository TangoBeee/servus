import type { IAgent } from "./agent.js";
import type { EngineContext, EngineResult, TaskDomain } from "./engine.js";
import { bus } from "./events.js";
import { runDomainAgentRuntime } from "./domain-agent-runtime.js";
import type { RunContract } from "./runtime.js";

export type DomainWorkflowPhase =
  | "orient"
  | "inspect"
  | "plan"
  | "act"
  | "verify"
  | "waiting_input"
  | "finalize"
  | "failed";

export interface DomainWorkflowEvidence {
  type: string;
  summary: string;
  source?: string;
  confidence?: "low" | "medium" | "high";
  data?: unknown;
}

export interface DomainWorkflowState {
  domain: TaskDomain;
  phase: DomainWorkflowPhase;
  task: string;
  plan: string[];
  activeStep?: string;
  evidence: DomainWorkflowEvidence[];
  artifacts: string[];
  questions: string[];
  verification: string[];
  finalSummary?: string;
}

export interface DomainWorkflowRuntimeOptions {
  domain: TaskDomain;
  agent: IAgent;
  ctx: EngineContext;
  initialMessage: string;
  contract?: RunContract;
  progressRequired?: boolean;
  maxRepairAttempts?: number;
  plan?: string[];
  evidenceTypes?: string[];
}

export function emitDomainWorkflowState(
  state: DomainWorkflowState,
  agent?: string,
): void {
  bus.push({
    type: "domain:workflow_state",
    agent,
    message: state.activeStep ?? state.phase,
    metadata: {
      ...state,
      phase: state.phase,
      domain: state.domain,
    },
  });
}

export function createInitialWorkflowState(input: {
  domain: TaskDomain;
  task: string;
  plan?: string[];
  activeStep?: string;
}): DomainWorkflowState {
  return {
    domain: input.domain,
    phase: "orient",
    task: input.task,
    plan: input.plan ?? defaultPlanForDomain(input.domain),
    activeStep: input.activeStep ?? "Understand the request and required evidence.",
    evidence: [],
    artifacts: [],
    questions: [],
    verification: [],
  };
}

export async function runDomainWorkflowRuntime(options: DomainWorkflowRuntimeOptions): Promise<EngineResult> {
  const state = createInitialWorkflowState({
    domain: options.domain,
    task: options.ctx.task,
    plan: options.plan,
  });
  emitDomainWorkflowState(state, options.agent.name);

  const evidenceList = options.evidenceTypes?.length
    ? options.evidenceTypes.map((item) => `- ${item}`).join("\n")
    : "- domain-specific source inspection\n- action or analysis evidence\n- verification/postcondition evidence";

  const result = await runDomainAgentRuntime({
    domain: options.domain,
    agent: options.agent,
    ctx: options.ctx,
    contract: options.contract,
    progressRequired: options.progressRequired,
    maxRepairAttempts: options.maxRepairAttempts,
    initialMessage: [
      options.initialMessage,
      "",
      "## Domain Workflow Runtime",
      "Follow these phases explicitly: orient -> inspect -> plan -> act -> verify -> finalize.",
      "Use servus_progress / ReportProgress to publish concise working notes at each meaningful phase.",
      "Do not finalize until evidence satisfies the runtime contract.",
      "",
      "Expected domain evidence types:",
      evidenceList,
    ].join("\n"),
  });

  const finalState: DomainWorkflowState = {
    ...state,
    phase: result.needsInput ? "waiting_input" : result.success ? "finalize" : "failed",
    activeStep: result.needsInput
      ? "Waiting for user input."
      : result.success
        ? "Runtime evidence accepted."
        : "Runtime evidence was insufficient or the task failed.",
    finalSummary: result.summary,
    artifacts: result.artifacts ?? [],
    questions: result.questions ?? (result.question ? [result.question] : []),
    evidence: (result.evidence ?? []).map((item) => ({
      type: item.type,
      source: item.source,
      summary: item.summary,
      confidence: item.confidence,
      data: item.data,
    })),
  };
  emitDomainWorkflowState(finalState, options.agent.name);

  return result;
}

function defaultPlanForDomain(domain: TaskDomain): string[] {
  if (domain === "desktop") {
    return [
      "Rank and inspect candidate paths.",
      "Disambiguate before acting when needed.",
      "Verify exact postconditions.",
    ];
  }
  if (domain === "data") {
    return [
      "Profile source documents or tables.",
      "Extract, transform, or report with schema evidence.",
      "Verify output artifacts and metadata.",
    ];
  }
  if (domain === "media") {
    return [
      "Check local media prerequisites.",
      "Plan inputs, outputs, codecs, and overwrite safety.",
      "Verify generated artifacts.",
    ];
  }
  if (domain === "extension") {
    return [
      "Infer extension type and target scope.",
      "Generate or import package files.",
      "Validate manifests, skills, and activation.",
    ];
  }
  if (domain === "general") {
    return [
      "Decide whether the task is answerable directly.",
      "Route actionable work to the right domain when needed.",
      "Answer only from supplied context or general knowledge.",
    ];
  }
  return [
    "Inspect available context.",
    "Act with domain tools.",
    "Verify evidence before finalizing.",
  ];
}
