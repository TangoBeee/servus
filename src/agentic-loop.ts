import type { IAgent } from "./agent.js";
import type { AgentResponse } from "./agent.js";
import type { EngineContext, EngineResult, TaskDomain } from "./engine.js";
import { detectClarificationRequest, stripProtocolTags } from "./clarification.js";
import {
  createRunContract,
  finalizationToSummary,
  getFinalization,
  validateCompletion,
} from "./completion-validator.js";

export interface ValidatedAgentTaskOptions {
  agent: IAgent;
  ctx: EngineContext;
  domain: TaskDomain;
  initialMessage: string;
  maxRepairAttempts?: number;
}

export async function runValidatedAgentTask(options: ValidatedAgentTaskOptions): Promise<EngineResult> {
  const contract = createRunContract(options.ctx, options.domain);
  const maxRepairAttempts = options.maxRepairAttempts ?? contract.maxRepairAttempts;
  let message = [
    options.initialMessage,
    "",
    "## Runtime Contract",
    `Intent: ${contract.intent}`,
    "Acceptance criteria:",
    ...contract.criteria.map((item) => `- ${item}`),
    "Required evidence:",
    ...contract.requiredEvidence.map((item) => `- ${item}`),
    "",
    "Use servus_done only after these criteria are satisfied. Use servus_need_input if they cannot be satisfied without user input.",
    "If servus_done/servus_need_input tools are unavailable in this backend, output equivalent JSON inside <servus_done_json>...</servus_done_json> or <servus_need_input_json>...</servus_need_input_json> tags.",
  ].join("\n");

  for (let attempt = 0; attempt <= maxRepairAttempts; attempt++) {
    const response = await options.agent.send(message);
    const cost = options.agent.cost;

    const finalization = getFinalization(response);
    if (finalization?.kind === "need_input") {
      const question = finalization.question ?? finalization.summary ?? "I need one more detail to continue.";
      return {
        success: false,
        needsInput: true,
        summary: question,
        question,
        questions: finalization.questions ?? [question],
        questionContext: finalization.summary,
        cost,
        error: "Needs user input",
      };
    }

    const clarification = detectClarificationRequest(response.text, options.ctx.task);
    if (clarification) {
      return {
        success: false,
        needsInput: true,
        summary: clarification.message,
        question: clarification.message,
        questions: clarification.questions,
        questionContext: clarification.context,
        clarification,
        cost,
        error: "Needs user input",
      };
    }

    const decision = validateCompletion(options.ctx, options.domain, response, contract);
    if (decision.accepted && decision.status === "completed") {
      return {
        success: true,
        summary: stripProtocolTags(finalizationToSummary(response)),
        artifacts: finalization?.artifacts,
        evidence: finalization?.evidence?.map((item, index) => ({
          id: `agent-evidence-${index + 1}`,
          type: item.type,
          source: item.source,
          summary: item.summary,
          ...(item.data !== undefined ? { data: item.data } : {}),
          ...(item.confidence ? { confidence: item.confidence } : {}),
          timestamp: Date.now(),
        })),
        cost,
      };
    }

    if (attempt >= maxRepairAttempts) {
      return {
        success: false,
        summary: [
          "Agent did not provide enough verified evidence to complete the task.",
          "",
          "Missing criteria:",
          ...decision.missingCriteria.map((item) => `- ${item}`),
          "",
          stripProtocolTags(response.text).trim(),
        ].filter(Boolean).join("\n"),
        cost,
        error: "Completion validator rejected task result",
      };
    }

    message = [
      "## Runtime validation failed",
      decision.repairPrompt ?? "Your result did not satisfy the runtime contract.",
      "",
      "Continue in this same session. Do not restart the task. Gather the missing evidence, then call servus_done.",
    ].join("\n");
  }

  return {
    success: false,
    summary: "Agent did not complete the task within the runtime repair limit.",
    cost: options.agent.cost,
    error: "Runtime repair limit exceeded",
  };
}

export function resultFromValidatedResponse(
  ctx: EngineContext,
  domain: TaskDomain,
  response: AgentResponse,
): EngineResult | null {
  const finalization = getFinalization(response);
  if (!finalization) return null;
  const cost = response.cost;
  if (finalization.kind === "need_input") {
    const question = finalization.question ?? finalization.summary ?? "I need one more detail to continue.";
    return {
      success: false,
      needsInput: true,
      summary: question,
      question,
      questions: finalization.questions ?? [question],
      questionContext: finalization.summary,
      cost,
      error: "Needs user input",
    };
  }

  const decision = validateCompletion(ctx, domain, response);
  if (!decision.accepted) {
    return {
      success: false,
      summary: [
        "Agent attempted to finish, but runtime validation rejected the result.",
        "",
        "Missing criteria:",
        ...decision.missingCriteria.map((item) => `- ${item}`),
      ].join("\n"),
      cost,
      error: "Completion validator rejected task result",
    };
  }

  return {
    success: true,
    summary: stripProtocolTags(finalizationToSummary(response)),
    artifacts: finalization.artifacts,
    evidence: finalization.evidence?.map((item, index) => ({
      id: `agent-evidence-${index + 1}`,
      type: item.type,
      source: item.source,
      summary: item.summary,
      ...(item.data !== undefined ? { data: item.data } : {}),
      ...(item.confidence ? { confidence: item.confidence } : {}),
      timestamp: Date.now(),
    })),
    cost,
  };
}
