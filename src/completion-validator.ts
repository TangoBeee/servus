import type { AgentFinalization, AgentResponse } from "./agent.js";
import type { EngineContext, TaskDomain } from "./engine.js";
import type { CompletionDecision, RunContract, ToolRisk } from "./runtime.js";

export function createRunContract(ctx: EngineContext, domain: TaskDomain): RunContract {
  const intent = inferIntent(ctx.task, domain);
  return {
    id: `${domain}:${intent}`,
    domain,
    intent,
    criteria: criteriaFor(domain, intent),
    requiredEvidence: requiredEvidenceFor(domain, intent),
    risk: riskFor(domain, intent),
    maxRepairAttempts: domain === "general" ? 1 : 2,
  };
}

export function validateCompletion(
  ctx: EngineContext,
  domain: TaskDomain,
  response: AgentResponse,
  contract = createRunContract(ctx, domain),
): CompletionDecision {
  const finalization = getFinalization(response);

  if (finalization?.kind === "need_input") {
    return {
      accepted: true,
      status: "waiting_input",
      missingCriteria: [],
      confidence: finalization.confidence ?? "high",
    };
  }

  if (!finalization || finalization.kind !== "done") {
    return reject(
      ["structured servus_done call"],
      "Call servus_done with evidence, satisfied criteria, and confidence. Do not rely on a text-only DONE tag.",
    );
  }

  const missing: string[] = [];
  if (!finalization.summary?.trim()) missing.push("completion summary");
  if (!finalization.evidence?.length) missing.push("at least one evidence item");
  if (finalization.confidence === "low") missing.push("medium or high completion confidence");

  for (const required of contract.requiredEvidence) {
    if (!hasEvidence(finalization, response, required)) missing.push(required);
  }

  if (domain === "desktop") {
    missing.push(...validateDesktop(ctx.task, response, finalization, contract.intent));
  } else if (domain === "browser") {
    missing.push(...validateBrowser(response, finalization));
  } else if (domain === "media" || domain === "data") {
    missing.push(...validateArtifactDomain(response, finalization));
  } else if (domain === "security") {
    missing.push(...validateSecurity(response, finalization));
  } else if (domain === "general") {
    missing.push(...validateGeneral(ctx.task, response));
  }

  const uniqueMissing = [...new Set(missing.filter(Boolean))];
  if (uniqueMissing.length) {
    return reject(
      uniqueMissing,
      [
        "Your completion was rejected by the Servus runtime validator.",
        "Do not summarize as done yet.",
        "Gather or cite the missing evidence, then call servus_done again.",
        "",
        "Missing criteria:",
        ...uniqueMissing.map((item) => `- ${item}`),
      ].join("\n"),
    );
  }

  return {
    accepted: true,
    status: "completed",
    missingCriteria: [],
    confidence: finalization.confidence ?? "medium",
  };
}

export function finalizationToSummary(response: AgentResponse): string {
  const finalization = getFinalization(response);
  if (!finalization) return response.text;
  if (finalization.kind === "need_input") return finalization.question ?? finalization.summary ?? response.text;
  return [
    finalization.summary ?? response.text,
    "",
    "Evidence:",
    ...(finalization.evidence ?? []).map((item) => `- ${item.summary} (${item.source})`),
    finalization.remainingRisks?.length ? "\nRemaining risks:" : "",
    ...(finalization.remainingRisks ?? []).map((item) => `- ${item}`),
  ].filter(Boolean).join("\n");
}

export function getFinalization(response: AgentResponse): AgentFinalization | undefined {
  return response.finalization ?? parseTaggedFinalization(response.text);
}

function reject(missingCriteria: string[], repairPrompt: string): CompletionDecision {
  return {
    accepted: false,
    status: "failed",
    missingCriteria,
    confidence: "low",
    repairPrompt,
  };
}

function inferIntent(task: string, domain: TaskDomain): string {
  const text = task.toLowerCase();
  if (domain === "desktop") {
    if (/\b(find|locate|where|search|show me|latest)\b/.test(text)) return "locate";
    if (/\b(move|rename|copy|organize)\b/.test(text)) return "mutate_path";
    if (/\b(open|launch)\b/.test(text)) return "open_path";
    if (/\b(delete|trash|remove)\b/.test(text)) return "trash_path";
  }
  if (domain === "browser") return "browser_workflow";
  if (domain === "media") return "media_artifact";
  if (domain === "data") return "data_artifact";
  if (domain === "security") return "security_analysis";
  if (domain === "coding") return "coding_change";
  return "answer";
}

function criteriaFor(domain: TaskDomain, intent: string): string[] {
  if (domain === "desktop" && intent === "locate") {
    return ["rank candidates", "verify selected path exists", "explain match reason", "ask if ambiguous"];
  }
  if (domain === "desktop") return ["identify exact path", "perform requested operation", "verify postcondition"];
  if (domain === "browser") return ["verify page state", "record proof", "surface blockers"];
  if (domain === "media" || domain === "data") return ["inspect source", "create or extract artifact", "verify artifact metadata"];
  if (domain === "security") return ["confirm explicit scope", "collect safe evidence", "report remediation"];
  return ["answer the user request"];
}

function requiredEvidenceFor(domain: TaskDomain, intent: string): string[] {
  if (domain === "desktop" && intent === "locate") return ["desktop_search", "path_verified"];
  if (domain === "desktop") return ["path_verified"];
  if (domain === "browser") return ["browser_state"];
  if (domain === "media" || domain === "data") return ["artifact_verified"];
  if (domain === "security") return ["scope_or_target_evidence"];
  return [];
}

function riskFor(domain: TaskDomain, intent: string): ToolRisk {
  if (domain === "desktop" && /mutate|trash/.test(intent)) return "high";
  if (domain === "browser" || domain === "security") return "medium";
  return "low";
}

function hasEvidence(finalization: AgentFinalization, response: AgentResponse, required: string): boolean {
  const evidenceText = JSON.stringify(finalization.evidence ?? []).toLowerCase();
  const toolNames = (response.toolEvents ?? []).map((event) => event.toolName);
  if (required === "desktop_search") return toolNames.includes("desktop_search") || evidenceText.includes("desktop_search");
  if (required === "path_verified") {
    return toolNames.some((name) => name === "desktop_inspect_path" || name === "desktop_select_candidate" || name === "desktop_verify_action") ||
      /\b(path_verified|verified|exists)\b/.test(evidenceText);
  }
  if (required === "browser_state") return toolNames.some((name) => name.startsWith("browser_")) || /\b(browser|page|screenshot|url)\b/.test(evidenceText);
  if (required === "artifact_verified") return /\b(artifact|output|created|verified|exists|rows|pages|sheets|duration|size)\b/.test(evidenceText);
  if (required === "scope_or_target_evidence") return /\b(scope|target|url|path|header|tls|scan|finding)\b/.test(evidenceText);
  return evidenceText.includes(required.toLowerCase());
}

function validateDesktop(
  task: string,
  response: AgentResponse,
  finalization: AgentFinalization,
  intent: string,
): string[] {
  const missing: string[] = [];
  const toolNames = (response.toolEvents ?? []).map((event) => event.toolName);
  const evidenceText = JSON.stringify(finalization.evidence ?? []).toLowerCase();
  if (intent === "locate") {
    if (!toolNames.includes("desktop_search") && !evidenceText.includes("desktop_search")) {
      missing.push("desktop_search tool used for ranked candidates");
    }
    if (
      !toolNames.some((name) => name === "desktop_select_candidate" || name === "desktop_inspect_path" || name === "desktop_verify_action") &&
      !/\b(path_verified|desktop_select_candidate|desktop_inspect_path|desktop_verify_action|verified path)\b/.test(evidenceText)
    ) {
      missing.push("selected candidate path verified");
    }
    if (!/\b(match|reason|score|rank|candidate)\b/.test(evidenceText)) missing.push("candidate match reason");
    if (ambiguousLocateTask(task, response, finalization)) missing.push("ambiguity resolved or user asked one clear question");
  } else if (!toolNames.includes("desktop_verify_action") && !/\bverified|postcondition|exists\b/.test(evidenceText)) {
    missing.push("desktop post-action verification");
  }
  return missing;
}

function ambiguousLocateTask(task: string, response: AgentResponse, finalization: AgentFinalization): boolean {
  const lowered = task.toLowerCase();
  if (/\b(latest|newest|recent|exact|only|named)\b/.test(lowered)) return false;
  const searchResults = response.toolEvents
    ?.filter((event) => event.type === "result" && event.toolName === "desktop_search")
    .map((event) => JSON.stringify(event.output ?? ""));
  const combined = searchResults?.join("\n") ?? "";
  const found = combined.match(/Found\s+(\d+)/i)?.[1];
  const count = found ? Number(found) : 0;
  return count > 1 && !JSON.stringify(finalization).toLowerCase().includes("ambig");
}

function validateBrowser(response: AgentResponse, finalization: AgentFinalization): string[] {
  const toolNames = (response.toolEvents ?? []).map((event) => event.toolName);
  const text = JSON.stringify(finalization).toLowerCase();
  if (!toolNames.some((name) => name === "browser_current_state" || name === "browser_snapshot" || name === "browser_screenshot" || name === "browser_extract")) {
    return ["browser page state or proof evidence"];
  }
  if (/\bblocked|captcha|cloudflare|login required|could not\b/.test(text) && !finalization.remainingRisks?.length) {
    return ["browser blocker reported as remaining risk instead of completed"];
  }
  return [];
}

function validateArtifactDomain(response: AgentResponse, finalization: AgentFinalization): string[] {
  if (finalization.artifacts?.length) return [];
  const text = JSON.stringify(finalization.evidence ?? []).toLowerCase();
  if (/\b(output|artifact|created|converted|extracted|rows|pages|duration|size)\b/.test(text)) return [];
  if ((response.toolEvents ?? []).some((event) => /info|extract|write|convert|download|trim|thumbnail|report/i.test(event.toolName))) return [];
  return ["artifact or extracted output verification"];
}

function validateSecurity(response: AgentResponse, finalization: AgentFinalization): string[] {
  const toolNames = (response.toolEvents ?? []).map((event) => event.toolName);
  const text = JSON.stringify(finalization).toLowerCase();
  if (!toolNames.some((name) => name.startsWith("security_")) && !/\btarget|scope|finding|header|tls|scan\b/.test(text)) {
    return ["explicit security scope and evidence"];
  }
  return [];
}

function validateGeneral(task: string, response: AgentResponse): string[] {
  const text = `${task}\n${response.text}`.toLowerCase();
  if (/\b(file|folder|browser|website|code|security|vulnerability|download|convert|spreadsheet|pdf)\b/.test(text)) {
    return ["general task should not claim external/file/web/code/security work without routing"];
  }
  return [];
}

function parseTaggedFinalization(text: string): AgentFinalization | undefined {
  const done = text.match(/<servus_done_json>\s*([\s\S]*?)\s*<\/servus_done_json>/i);
  if (done?.[1]) {
    try {
      const parsed = JSON.parse(done[1]) as AgentFinalization;
      return { ...parsed, kind: "done" };
    } catch {
      return undefined;
    }
  }
  const needInput = text.match(/<servus_need_input_json>\s*([\s\S]*?)\s*<\/servus_need_input_json>/i);
  if (needInput?.[1]) {
    try {
      const parsed = JSON.parse(needInput[1]) as AgentFinalization;
      return { ...parsed, kind: "need_input" };
    } catch {
      return undefined;
    }
  }
  return undefined;
}
