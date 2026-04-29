import type { AgentFinalization, AgentResponse } from "./agent.js";
import type { EngineContext, TaskDomain } from "./engine.js";
import type { CompletionDecision, RunContract, ToolRisk } from "./runtime.js";
import { loadBrowserSessionState } from "./browser-session.js";

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
    missing.push(...validateBrowser(ctx, response, finalization));
  } else if (domain === "media" || domain === "data") {
    missing.push(...validateArtifactDomain(response, finalization));
  } else if (domain === "extension") {
    missing.push(...validateExtension(response, finalization));
  } else if (domain === "security") {
    missing.push(...validateSecurity(response, finalization));
  } else if (domain === "coding") {
    missing.push(...validateCoding(ctx.task, response, finalization, contract.intent));
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
  if (domain === "extension") return "extension_package";
  if (domain === "security") return "security_analysis";
  if (domain === "coding") {
    if (codingVerificationOnlyTask(text)) return "coding_verification";
    return codingTaskRequiresFileChange(text)
      ? "coding_change"
      : "coding_analysis";
  }
  return "answer";
}

function criteriaFor(domain: TaskDomain, intent: string): string[] {
  if (domain === "desktop" && intent === "locate") {
    return ["rank candidates", "verify selected path exists", "explain match reason", "ask if ambiguous"];
  }
  if (domain === "desktop") return ["identify exact path", "perform requested operation", "verify postcondition"];
  if (domain === "browser") return ["verify page state", "record proof", "surface blockers"];
  if (domain === "media" || domain === "data") return ["inspect source", "create or extract artifact", "verify artifact metadata"];
  if (domain === "extension") return ["understand extension intent", "generate or inspect package", "validate activation"];
  if (domain === "security") return ["confirm explicit scope", "collect safe evidence", "report remediation"];
  if (domain === "coding" && intent === "coding_change") return ["inspect relevant code", "modify focused files", "capture checkpoint", "run verification"];
  if (domain === "coding" && intent === "coding_verification") return ["run requested verification", "report exact result"];
  if (domain === "coding") return ["inspect repository evidence", "answer without mutating files"];
  return ["answer the user request"];
}

function requiredEvidenceFor(domain: TaskDomain, intent: string): string[] {
  if (domain === "desktop" && intent === "locate") return ["desktop_search", "path_verified"];
  if (domain === "desktop") return ["path_verified"];
  if (domain === "browser") return ["browser_state"];
  if (domain === "media" || domain === "data") return ["artifact_verified"];
  if (domain === "extension") return ["extension_validated"];
  if (domain === "security") return ["scope_or_target_evidence"];
  if (domain === "coding" && intent === "coding_change") return ["coding_change", "verification_attempt"];
  if (domain === "coding" && intent === "coding_verification") return ["verification_attempt"];
  if (domain === "coding") return ["repo_evidence"];
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
  if (required === "artifact_verified") return /\b(artifact|output|created|verified|exists|rows|pages|sheets|duration|size|schema|profile|query|merged|downloaded)\b/.test(evidenceText);
  if (required === "extension_validated") return /\b(extension|skill|plugin|manifest|activation|validated|skill\.md|servus\.plugin\.json)\b/.test(evidenceText);
  if (required === "scope_or_target_evidence") return /\b(scope|target|url|path|header|tls|scan|finding)\b/.test(evidenceText);
  if (required === "coding_change") return /\b(coding_change|changed files?|edited|modified|checkpoint|diff)\b/.test(evidenceText) ||
    toolNames.some((name) => ["write", "Write", "edit", "Edit", "MultiEdit", "patch"].includes(name));
  if (required === "verification_attempt") return /\b(verification_attempt|verification|test|typecheck|lint|build|passed)\b/.test(evidenceText) ||
    toolNames.some((name) => name === "bash");
  if (required === "repo_evidence") return /\b(repo_evidence|read|grep|glob|inspected|repository)\b/.test(evidenceText) ||
    toolNames.some((name) => ["read", "grep", "glob", "ls", "workspace_status", "git_diff", "LSP"].includes(name));
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

function validateBrowser(ctx: EngineContext, response: AgentResponse, finalization: AgentFinalization): string[] {
  const toolNames = (response.toolEvents ?? []).map((event) => event.toolName);
  const text = JSON.stringify(finalization).toLowerCase();
  const session = loadBrowserSessionState(ctx.sessionId);
  if (!toolNames.some((name) =>
    name === "browser_current_state" ||
    name === "browser_snapshot" ||
    name === "browser_observe" ||
    name === "browser_screenshot" ||
    name === "browser_extract" ||
    name === "browser_agent"
  )) {
    return ["browser page state or proof evidence"];
  }
  const evidenceText = JSON.stringify(finalization.evidence ?? []).toLowerCase();
  const hasProof =
    Boolean(session.lastScreenshot || session.lastSnapshot) ||
    /\b(screenshot|snapshot|url|title|browser_current_state|browser_extract|browser_observe|browser_agent)\b/.test(evidenceText);
  if (!hasProof) {
    return ["browser screenshot, snapshot, URL/title, or extracted proof"];
  }
  const failedRecent = session.failedActionHistory.slice(-3).some((action) =>
    Date.now() - action.timestamp < 20 * 60_000 &&
    !/\b(alternate|take over|blocked|not completed|could not|failed)\b/i.test(text)
  );
  if (failedRecent) {
    return ["recent failed browser action resolved or reported as blocker"];
  }
  if (session.status === "blocked" && !finalization.remainingRisks?.length) {
    return ["browser blocker reported as remaining risk instead of completed"];
  }
  if (/\b(blocked|captcha|cloudflare|login required|could not|unable to|failed|no progress|did not advance)\b/.test(text) && !finalization.remainingRisks?.length) {
    return ["browser blocker reported as remaining risk instead of completed"];
  }
  return [];
}

function validateArtifactDomain(response: AgentResponse, finalization: AgentFinalization): string[] {
  if (finalization.artifacts?.length) return [];
  const text = JSON.stringify(finalization.evidence ?? []).toLowerCase();
  if (/\b(output|artifact|created|converted|extracted|rows|pages|sheets|duration|size|schema|profile|query|summary|summarized|merged|downloaded)\b/.test(text)) return [];
  if ((response.toolEvents ?? []).some((event) => /info|extract|write|convert|download|trim|thumbnail|report|profile|schema|query|summarize|merge|plan_job|batch_plan/i.test(event.toolName))) return [];
  return ["artifact or extracted output verification"];
}

function validateExtension(response: AgentResponse, finalization: AgentFinalization): string[] {
  const toolNames = (response.toolEvents ?? []).map((event) => event.toolName);
  const text = JSON.stringify(finalization).toLowerCase();
  const hasOperation = toolNames.some((name) =>
    ["create_skill", "create_plugin", "extension_import_package", "extension_export_package", "extension_repair_manifest"].includes(name)
  ) || /\b(created|imported|exported|repaired|skill|plugin|extension_spec)\b/.test(text);
  const hasValidation = toolNames.some((name) =>
    ["validate_extension", "extension_test_activation"].includes(name)
  ) || /\b(validation passed|activation test|validated|manifest_validation|skill_validation)\b/.test(text);
  const missing: string[] = [];
  if (!hasOperation) missing.push("extension spec or package operation evidence");
  if (!hasValidation) missing.push("extension validation or activation test evidence");
  return missing;
}

function validateSecurity(response: AgentResponse, finalization: AgentFinalization): string[] {
  const toolNames = (response.toolEvents ?? []).map((event) => event.toolName);
  const text = JSON.stringify(finalization).toLowerCase();
  if (!toolNames.some((name) => name.startsWith("security_")) && !/\btarget|scope|finding|header|tls|scan\b/.test(text)) {
    return ["explicit security scope and evidence"];
  }
  const missing: string[] = [];
  if (!toolNames.includes("security_preflight") && !/\b(preflight|scope|explicit target|authorized)\b/.test(text)) {
    missing.push("security preflight or explicit scope evidence");
  }
  if (/\b(vulnerability|finding|xss|injection|ssrf|auth|authz|idor|exploit|bypass)\b/.test(text)) {
    if (
      !toolNames.some((name) =>
        name === "security_vulnerability_class_plan" ||
        name === "security_playbook" ||
        name === "security_static_code_scan" ||
        name === "security_attack_surface_map"
      ) &&
      !/\b(class methodology|playbook|static scan|attack surface|source-to-sink|guard evidence)\b/.test(text)
    ) {
      missing.push("class-specific methodology or scan evidence");
    }
    if (
      !toolNames.some((name) => name === "security_classify_validation_result" || name === "security_report_filter") &&
      !/\b(EXPLOITED|BLOCKED_BY_SECURITY|FALSE_POSITIVE|POTENTIAL|NOT_TESTED|validated|not tested|false positive|blocked by security)\b/i.test(JSON.stringify(finalization))
    ) {
      missing.push("validation verdict or explicit limitation for each security finding");
    }
  }
  return missing;
}

function validateCoding(
  task: string,
  response: AgentResponse,
  finalization: AgentFinalization,
  intent: string,
): string[] {
  const missing: string[] = [];
  const toolNames = (response.toolEvents ?? []).map((event) => event.toolName);
  const text = JSON.stringify(finalization).toLowerCase();
  const requiresFileChange = codingTaskRequiresFileChange(task);
  if (intent === "coding_change" || intent === "coding_verification") {
    if (requiresFileChange &&
        !/\b(changed files?|edited|modified|patch|diff|checkpoint|coding_change)\b/.test(text) &&
        !toolNames.some((name) => ["write", "edit", "patch"].includes(name))) {
      missing.push("changed files or diff evidence");
    }
    if (!/\b(verification|test|typecheck|lint|build|passed|verification_attempt)\b/.test(text) &&
        !toolNames.includes("bash")) {
      missing.push("verification attempt evidence");
    }
  } else {
    if (!/\b(read|grep|glob|repository|file|evidence|repo_evidence)\b/.test(text) &&
        !toolNames.some((name) => ["read", "grep", "glob", "ls", "workspace_status", "git_diff", "LSP"].includes(name))) {
      missing.push("repository evidence for coding analysis");
    }
    if (/\b(write|edited|modified|patched)\b/.test(text)) {
      missing.push("read-only analysis should not claim file mutation");
    }
  }
  if (/\b(servus-plan\.json|init\.sh)\b/.test(task) && !/\buser requested\b/.test(text)) {
    return missing;
  }
  return missing;
}

function codingTaskRequiresFileChange(task: string): boolean {
  const text = task.toLowerCase();
  if (codingVerificationOnlyTask(text)) return false;
  return /\b(add|build|change|create|debug|edit|enhance|fix|implement|improve|install|migrate|modify|patch|polish|refactor|remove|rename|repair|replace|update|upgrade|write)\b/.test(text) ||
    /\bmake\b.+\bbetter\b/.test(text);
}

function codingVerificationOnlyTask(text: string): boolean {
  return /\b(run|check|verify)\b.*\b(build|ci|lint|test|tests|typecheck)\b/.test(text);
}

function validateGeneral(task: string, response: AgentResponse): string[] {
  const text = `${task}\n${response.text}`.toLowerCase();
  const toolNames = (response.toolEvents ?? []).map((event) => event.toolName);
  if (!toolNames.includes("general_answer_with_basis") && !/\b(answer_basis|user_supplied_context|general_knowledge|routing_decision)\b/.test(text)) {
    return ["general answer basis"];
  }
  if (/\b(file|folder|browser|website|code|security|vulnerability|download|convert|spreadsheet|pdf)\b/.test(text)) {
    if (!toolNames.includes("general_route_task") && !/\b(route|engine|should handle|routing_decision)\b/.test(text)) {
      return ["general task should route tool-backed work instead of claiming it"];
    }
  }
  return [];
}

function parseTaggedFinalization(text: string): AgentFinalization | undefined {
  const taggedDone = extractTaggedJson(text, "servus_done_json") ?? extractTaggedJson(text, "servus_done");
  if (taggedDone) return coerceDoneFinalization(taggedDone);

  const taggedNeedInput = extractTaggedJson(text, "servus_need_input_json") ?? extractTaggedJson(text, "servus_need_input");
  if (taggedNeedInput) return coerceNeedInputFinalization(taggedNeedInput);

  const raw = extractLikelyJson(text);
  if (!raw) return undefined;
  if (raw.kind === "done" || "evidence" in raw || "satisfiedCriteria" in raw || "satisfied_criteria" in raw) {
    return coerceDoneFinalization(raw);
  }
  if (raw.kind === "need_input" || "question" in raw || "questions" in raw) {
    return coerceNeedInputFinalization(raw);
  }
  return undefined;
}

function extractTaggedJson(text: string, tag: string): unknown | undefined {
  const match = text.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*<\\/${tag}>`, "i"));
  if (!match?.[1]) return undefined;
  return parseJsonBlock(match[1]);
}

function extractLikelyJson(text: string): Record<string, unknown> | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidates = [
    fenced?.[1],
    text.trim().startsWith("{") && text.trim().endsWith("}") ? text.trim() : undefined,
  ].filter((item): item is string => !!item);
  for (const candidate of candidates) {
    const parsed = parseJsonBlock(candidate);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  }
  return undefined;
}

function parseJsonBlock(value: string): unknown | undefined {
  const cleaned = value.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return undefined;
  }
}

function coerceDoneFinalization(value: unknown): AgentFinalization | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return {
    kind: "done",
    summary: stringOrUndefined(record.summary) ?? stringOrUndefined(record.text) ?? stringOrUndefined(record.message),
    evidence: coerceEvidence(record.evidence),
    satisfiedCriteria: stringArray(record.satisfiedCriteria ?? record.satisfied_criteria),
    artifacts: stringArray(record.artifacts),
    remainingRisks: stringArray(record.remainingRisks ?? record.remaining_risks),
    confidence: coerceConfidence(record.confidence) ?? "medium",
  };
}

function coerceNeedInputFinalization(value: unknown): AgentFinalization | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const questions = stringArray(record.questions);
  const question = stringOrUndefined(record.question) ?? questions[0];
  if (!question) return undefined;
  return {
    kind: "need_input",
    question,
    questions: questions.length ? questions : [question],
    choices: coerceChoices(record.choices ?? record.options),
    summary: stringOrUndefined(record.summary) ?? stringOrUndefined(record.context) ?? question,
    confidence: coerceConfidence(record.confidence) ?? "high",
  };
}

function coerceEvidence(value: unknown): NonNullable<AgentFinalization["evidence"]> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item))
    .map((item) => ({
      type: stringOrUndefined(item.type) ?? "evidence",
      source: stringOrUndefined(item.source) ?? "final_json",
      summary: stringOrUndefined(item.summary) ?? stringOrUndefined(item.text) ?? "Evidence provided in final JSON.",
      ...(coerceConfidence(item.confidence) ? { confidence: coerceConfidence(item.confidence) } : {}),
      ...(item.data !== undefined ? { data: item.data } : {}),
    }))
    .filter((item) => item.summary.trim());
}

function coerceChoices(value: unknown): AgentFinalization["choices"] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.every((item) => typeof item === "string")) {
    return [{
      id: "choice",
      label: "Choice",
      options: value.map(String).slice(0, 8),
      required: true,
    }];
  }
  const choices = value
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item))
    .map((item, index) => ({
      id: stringOrUndefined(item.id) ?? `choice_${index + 1}`,
      label: stringOrUndefined(item.label) ?? "Choice",
      options: stringArray(item.options).slice(0, 12),
      required: typeof item.required === "boolean" ? item.required : true,
    }))
    .filter((item) => item.options.length > 0);
  return choices.length ? choices : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => typeof item === "string" ? item.trim() : "").filter(Boolean);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function coerceConfidence(value: unknown): "low" | "medium" | "high" | undefined {
  if (value === "low" || value === "medium" || value === "high") return value;
  return undefined;
}
