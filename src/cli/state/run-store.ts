import type { ServusEvent } from "../../events.js";
import type { TaskDomain } from "../../engine.js";
import type { ClarificationRequest } from "../../clarification.js";
import type { SessionRecord } from "../../session-store.js";

export interface LogItem {
  id: number;
  type: string;
  message: string;
  agent?: string;
  color?: string;
  timestamp: number;
}

export interface ToolActivity {
  id: string;
  tool: string;
  agent?: string;
  preview: string;
  status: "running" | "done" | "failed";
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
}

export interface ApprovalActivity {
  id: string;
  action: string;
  risk: string;
  engine?: string;
  detail: string;
  approved?: boolean;
  timestamp: number;
}

export interface TodoActivity {
  id: string;
  content: string;
  status: string;
  evidence?: string[];
}

export interface RuntimeViewState {
  status: "idle" | "running" | "waiting_input" | "completed" | "failed";
  domain: TaskDomain | "auto";
  engine: string;
  model: string;
  backend: string;
  phase: string;
  cost: number;
  budget?: number;
  contextUsage?: {
    estimatedTokens: number;
    contextWindowTokens: number;
    compactAtTokens: number;
    percent: number;
    compactPercent: number;
    shouldCompact: boolean;
    suggestions?: Array<{
      severity: "info" | "warning";
      title: string;
      detail: string;
      savingsTokens?: number;
    }>;
  };
  sessionReplay?: {
    transcriptEvents: number;
    toolCalls: number;
    toolResults: number;
    toolResultArtifacts: number;
    readStateFiles: number;
    checkpoints: number;
    queuedUserMessages: number;
    compactions: number;
    lastAssistantMessage?: string;
  };
  launchCwd?: string;
  targetCwd?: string;
  completed: number;
  total: number;
  proofDir?: string;
  artifacts: string[];
  changedFiles: string[];
  checkpoints: string[];
  verification: string[];
  workflow?: {
    phase: string;
    activeStep?: string;
    plan: string[];
    evidence: Array<{ type: string; summary: string }>;
    artifacts: string[];
    questions: string[];
    finalSummary?: string;
  };
  evidence: Array<{ id: string; type: string; summary: string; timestamp?: number }>;
  todos: TodoActivity[];
  activeTools: string[];
  question?: string;
  questionContext?: string;
  questions: string[];
  clarification?: ClarificationRequest;
  logs: LogItem[];
  tools: ToolActivity[];
  approvals: ApprovalActivity[];
  errors: LogItem[];
}

export const initialRuntimeViewState: RuntimeViewState = {
  status: "idle",
  domain: "auto",
  engine: "none",
  model: "",
  backend: "",
  phase: "IDLE",
  cost: 0,
  completed: 0,
  total: 0,
  artifacts: [],
  changedFiles: [],
  checkpoints: [],
  verification: [],
  evidence: [],
  todos: [],
  activeTools: [],
  questions: [],
  logs: [],
  tools: [],
  approvals: [],
  errors: [],
};

export function reduceRunEvent(state: RuntimeViewState, event: ServusEvent): RuntimeViewState {
  const next: RuntimeViewState = {
    ...state,
    logs: appendLog(state.logs, event),
  };

  if (event.type === "phase") next.phase = event.message;
  if (typeof event.metadata?.phase === "string") next.phase = event.metadata.phase;
  if (event.type.startsWith("coding:") && /^(coding:orienting|coding:discovering|coding:planning|coding:editing|coding:verifying|coding:repairing|coding:reviewing|coding:waiting_input)$/.test(event.type)) {
    next.phase = event.type.replace("coding:", "");
  }
  if (event.type === "engine:start") {
    next.status = "running";
    next.domain = stringMeta(event, "domain", next.domain) as RuntimeViewState["domain"];
    next.engine = stringMeta(event, "engine", next.engine);
  }
  if (event.type === "runtime:state") {
    const metadata = event.metadata ?? {};
    next.status = stringMeta(event, "status", next.status) as RuntimeViewState["status"];
    next.domain = stringMeta(event, "domain", next.domain) as RuntimeViewState["domain"];
    next.engine = stringMeta(event, "engine", next.engine);
    next.model = stringMeta(event, "model", next.model);
    next.backend = stringMeta(event, "backend", next.backend);
    if (typeof metadata.cost === "number") next.cost = metadata.cost;
    if (typeof metadata.budget === "number") next.budget = metadata.budget;
    if (typeof metadata.launchCwd === "string") next.launchCwd = metadata.launchCwd;
    if (typeof metadata.targetCwd === "string") next.targetCwd = metadata.targetCwd;
    if (typeof metadata.proofDir === "string") next.proofDir = metadata.proofDir;
    if (Array.isArray(metadata.artifacts)) {
      next.artifacts = metadata.artifacts.filter((item): item is string => typeof item === "string");
    }
    if (typeof metadata.question === "string") next.question = metadata.question;
    if (typeof metadata.questionContext === "string") next.questionContext = metadata.questionContext;
    if (Array.isArray(metadata.questions)) {
      next.questions = metadata.questions.filter((item): item is string => typeof item === "string");
    }
    const clarification = clarificationMeta(metadata.clarification);
    if (clarification) next.clarification = clarification;
  }
  if (event.type === "domain:workflow_state") {
    const metadata = event.metadata ?? {};
    next.domain = stringMeta(event, "domain", next.domain) as RuntimeViewState["domain"];
    next.phase = stringMeta(event, "phase", next.phase);
    next.workflow = {
      phase: next.phase,
      activeStep: typeof metadata.activeStep === "string" ? metadata.activeStep : event.message,
      plan: Array.isArray(metadata.plan)
        ? metadata.plan.filter((item): item is string => typeof item === "string")
        : state.workflow?.plan ?? [],
      evidence: Array.isArray(metadata.evidence)
        ? metadata.evidence
            .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
            .map((item) => ({
              type: typeof item.type === "string" ? item.type : "evidence",
              summary: typeof item.summary === "string" ? item.summary : "",
            }))
            .filter((item) => item.summary)
            .slice(-30)
        : state.workflow?.evidence ?? [],
      artifacts: Array.isArray(metadata.artifacts)
        ? metadata.artifacts.filter((item): item is string => typeof item === "string").slice(-50)
        : state.workflow?.artifacts ?? [],
      questions: Array.isArray(metadata.questions)
        ? metadata.questions.filter((item): item is string => typeof item === "string").slice(-10)
        : state.workflow?.questions ?? [],
      finalSummary: typeof metadata.finalSummary === "string" ? metadata.finalSummary : state.workflow?.finalSummary,
    };
  }
  if (event.type === "session:hydrated") {
    const metadata = event.metadata ?? {};
    next.status = "running";
    if (typeof metadata.targetCwd === "string") next.targetCwd = metadata.targetCwd;
    if (typeof metadata.launchCwd === "string") next.launchCwd = metadata.launchCwd;
    const replay = sessionReplayMeta(metadata.replay);
    if (replay) next.sessionReplay = replay;
  }
  if (event.type === "cost" && typeof event.metadata?.cost === "number") {
    next.cost = event.metadata.cost;
  }
  if (event.type === "context:usage") {
    const estimatedTokens = numberMeta(event, "estimatedTokens");
    const contextWindowTokens = numberMeta(event, "contextWindowTokens");
    const compactAtTokens = numberMeta(event, "compactAtTokens");
    if (estimatedTokens !== undefined && contextWindowTokens !== undefined && compactAtTokens !== undefined) {
      next.contextUsage = {
        estimatedTokens,
        contextWindowTokens,
        compactAtTokens,
        percent: contextWindowTokens > 0 ? Math.round((estimatedTokens / contextWindowTokens) * 1000) / 10 : 0,
        compactPercent: compactAtTokens > 0 ? Math.round((estimatedTokens / compactAtTokens) * 1000) / 10 : 0,
      shouldCompact: Boolean(event.metadata?.shouldCompact),
      suggestions: contextSuggestionsMeta(event.metadata?.suggestions),
    };
    }
  }
  if (event.type === "coding:todo_update") {
    const todos = event.metadata?.todos;
    if (Array.isArray(todos)) {
      next.todos = todos
        .filter((todo): todo is Record<string, unknown> => !!todo && typeof todo === "object")
        .map((todo, index) => ({
          id: typeof todo.id === "string" ? todo.id : `todo-${index + 1}`,
          content: typeof todo.content === "string" ? todo.content : String(todo.activeForm ?? "Untitled todo"),
          status: typeof todo.status === "string" ? todo.status : "pending",
          evidence: Array.isArray(todo.evidence)
            ? todo.evidence.filter((item): item is string => typeof item === "string")
            : undefined,
        }));
    }
  }
  if (event.type === "coding:checkpoint") {
    const checkpointId = stringMeta(event, "checkpointId", event.message);
    next.checkpoints = [...state.checkpoints, checkpointId].slice(-30);
    const changedFiles = event.metadata?.changedFiles;
    if (Array.isArray(changedFiles)) {
      next.changedFiles = [...new Set([
        ...state.changedFiles,
        ...changedFiles.filter((item): item is string => typeof item === "string"),
      ])].slice(-80);
    }
  }
  if (event.type === "coding:verify_start" || event.type === "coding:verify_finish" || event.type === "coding:verification_verdict") {
    next.verification = [...state.verification, event.message].slice(-30);
  }
  if (event.type === "evidence:add") {
    const evidence = event.metadata?.evidence;
    if (evidence && typeof evidence === "object") {
      const item = evidence as Record<string, unknown>;
      next.evidence = [
        ...state.evidence,
        {
          id: typeof item.id === "string" ? item.id : `${event.timestamp}:${state.evidence.length}`,
          type: typeof item.type === "string" ? item.type : "evidence",
          summary: typeof item.summary === "string" ? item.summary : event.message,
          timestamp: typeof item.timestamp === "number" ? item.timestamp : event.timestamp,
        },
      ].slice(-100);
    }
  }
  if (event.metadata?.total != null && typeof event.metadata.total === "number") next.total = event.metadata.total;
  if (event.metadata?.completed != null && typeof event.metadata.completed === "number") next.completed = event.metadata.completed;
  if (event.type === "tool:start") {
    const tool = stringMeta(event, "tool", event.message.split("(")[0] || "tool");
    const toolCallId = stringMeta(event, "toolCallId", `${event.timestamp}:${tool}:${state.tools.length}`);
    const activity: ToolActivity = {
      id: toolCallId,
      tool,
      agent: event.agent,
      preview: event.message,
      status: "running",
      startedAt: event.timestamp,
    };
    next.activeTools = [...new Set([...state.activeTools, tool])];
    next.tools = [...state.tools, activity].slice(-100);
  }
  if (event.type === "tool:finish") {
    const finishedTool = stringMeta(event, "tool", "");
    next.activeTools = finishedTool
      ? state.activeTools.filter((tool) => tool !== finishedTool)
      : state.activeTools.slice(1);
    next.tools = finishLastTool(state.tools, event);
  }
  if (event.type === "approval:request" || event.type === "consent:request") {
    next.approvals = [
      ...state.approvals,
      {
        id: `${event.timestamp}:${state.approvals.length}`,
        action: stringMeta(event, "action", "approval"),
        risk: stringMeta(event, "risk", "unknown"),
        engine: event.agent,
        detail: stringMeta(event, "detail", event.message),
        timestamp: event.timestamp,
      },
    ].slice(-100);
  }
  if (event.type === "approval:response" || event.type === "consent:response") {
    next.approvals = markLastApproval(state.approvals, Boolean(event.metadata?.approved));
  }
  if (event.type === "artifact:add") {
    const proofDir = stringMeta(event, "proofDir", "");
    if (proofDir) next.proofDir = proofDir;
    next.artifacts = [...state.artifacts, event.message].slice(-100);
  }
  if (event.type === "engine:error" || event.type === "agent:error" || event.type === "error") {
    next.status = "failed";
    next.errors = appendLog(state.errors, event).slice(-100);
  }
  if (event.type === "engine:needs_input" || event.type === "user_input:request") {
    next.status = "waiting_input";
    next.question = stringMeta(event, "question", event.message);
    next.questionContext = stringMeta(event, "questionContext", next.questionContext ?? "");
    const rawQuestions = event.metadata?.questions;
    if (Array.isArray(rawQuestions)) {
      next.questions = rawQuestions.filter((item): item is string => typeof item === "string");
    }
    const clarification = clarificationMeta(event.metadata?.clarification);
    if (clarification) next.clarification = clarification;
  }
  if (event.type === "engine:complete" || event.type === "complete") {
    next.status = "completed";
  }
  if (event.type === "coding:completed") {
    next.status = "completed";
    next.phase = "completed";
  }
  if (event.type === "coding:failed") {
    next.status = "failed";
    next.phase = "failed";
    next.errors = appendLog(state.errors, event).slice(-100);
  }

  return next;
}

export function hydrateRuntimeViewState(
  record: SessionRecord | null,
  fallback: Pick<RuntimeViewState, "model" | "backend" | "budget" | "domain">,
): RuntimeViewState {
  let state: RuntimeViewState = {
    ...initialRuntimeViewState,
    model: fallback.model,
    backend: fallback.backend,
    budget: fallback.budget,
    domain: fallback.domain,
  };
  if (!record) return state;
  for (const event of record.events ?? []) {
    state = reduceRunEvent(state, event);
  }
  if ((record.logs ?? []).length > 0 && state.logs.length === 0) {
    state = {
      ...state,
      logs: record.logs.slice(-500).map((message, index) => ({
        id: record.startTime + index,
        type: "log",
        message,
        timestamp: record.startTime + index,
      })),
    };
  }
  if (record.finalSummary) {
    state = reduceRunEvent(state, {
      type: record.status === "completed" ? "engine:complete" : "info",
      agent: "Servus",
      message: record.finalSummary,
      timestamp: record.endTime ?? Date.now(),
    } as ServusEvent);
  }
  return {
    ...state,
    status: (record.runtimeStatus ?? record.status) as RuntimeViewState["status"],
    domain: (record.domain ?? fallback.domain) as RuntimeViewState["domain"],
    model: record.model,
    backend: record.backend,
    cost: record.cost,
    proofDir: record.proofDir ?? state.proofDir,
    artifacts: record.artifacts ?? state.artifacts,
    evidence: (record.evidence ?? []).map((item) => ({
      id: item.id,
      type: item.type,
      summary: item.summary,
      timestamp: item.timestamp,
    })).slice(-100),
    contextUsage: contextUsageRecord(record.contextUsage) ?? state.contextUsage,
    launchCwd: record.launchCwd ?? state.launchCwd,
    targetCwd: record.targetCwd ?? state.targetCwd ?? record.cwd,
  };
}

function appendLog(logs: LogItem[], event: ServusEvent): LogItem[] {
  if (event.type === "agent:text") return logs;
  return [
    ...logs,
    {
      id: event.timestamp + logs.length,
      type: event.type,
      message: event.message,
      agent: event.agent,
      color: event.color,
      timestamp: event.timestamp,
    },
  ].slice(-500);
}

function finishLastTool(tools: ToolActivity[], event: ServusEvent): ToolActivity[] {
  const next = [...tools];
  const toolCallId = stringMeta(event, "toolCallId", "");
  let idx = -1;
  if (toolCallId) {
    idx = next.findIndex((tool) => tool.id === toolCallId);
  }
  for (let i = next.length - 1; i >= 0; i--) {
    if (idx !== -1) break;
    const tool = next[i];
    if (tool.status === "running" && (!event.agent || tool.agent === event.agent)) {
      idx = i;
      break;
    }
  }
  if (idx === -1) return next;
  next[idx] = {
    ...next[idx],
    status: event.metadata?.isError === true || /error|fail/i.test(event.message) ? "failed" : "done",
    preview: event.message,
    finishedAt: event.timestamp,
    ...(typeof event.metadata?.durationMs === "number" ? { durationMs: event.metadata.durationMs } : {}),
  };
  return next;
}

function markLastApproval(approvals: ApprovalActivity[], approved: boolean): ApprovalActivity[] {
  const next = [...approvals];
  let idx = -1;
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i].approved === undefined) {
      idx = i;
      break;
    }
  }
  if (idx === -1) return next;
  next[idx] = { ...next[idx], approved };
  return next;
}

function stringMeta(event: ServusEvent, key: string, fallback: string): string {
  const value = event.metadata?.[key];
  return typeof value === "string" && value ? value : fallback;
}

function numberMeta(event: ServusEvent, key: string): number | undefined {
  const value = event.metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function contextUsageRecord(value: unknown): RuntimeViewState["contextUsage"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<NonNullable<RuntimeViewState["contextUsage"]>>;
  if (
    typeof record.estimatedTokens !== "number" ||
    typeof record.contextWindowTokens !== "number" ||
    typeof record.compactAtTokens !== "number"
  ) return undefined;
  return {
    estimatedTokens: record.estimatedTokens,
    contextWindowTokens: record.contextWindowTokens,
    compactAtTokens: record.compactAtTokens,
    percent: typeof record.percent === "number"
      ? record.percent
      : record.contextWindowTokens > 0
        ? Math.round((record.estimatedTokens / record.contextWindowTokens) * 1000) / 10
        : 0,
    compactPercent: typeof record.compactPercent === "number"
      ? record.compactPercent
      : record.compactAtTokens > 0
        ? Math.round((record.estimatedTokens / record.compactAtTokens) * 1000) / 10
        : 0,
    shouldCompact: Boolean(record.shouldCompact),
    suggestions: contextSuggestionsMeta((record as Record<string, unknown>).suggestions),
  };
}

function contextSuggestionsMeta(value: unknown): NonNullable<RuntimeViewState["contextUsage"]>["suggestions"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const suggestions = value
    .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    .map((item) => {
      const severity = item.severity === "warning" ? "warning" : "info";
      const title = typeof item.title === "string" ? item.title : "";
      const detail = typeof item.detail === "string" ? item.detail : "";
      if (!title || !detail) return undefined;
      return {
        severity,
        title,
        detail,
        ...(typeof item.savingsTokens === "number" ? { savingsTokens: item.savingsTokens } : {}),
      };
    })
    .filter((item): item is NonNullable<NonNullable<RuntimeViewState["contextUsage"]>["suggestions"]>[number] => !!item)
    .slice(0, 5);
  return suggestions.length ? suggestions : undefined;
}

function sessionReplayMeta(value: unknown): RuntimeViewState["sessionReplay"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const transcriptEvents = numberField(record, "transcriptEvents");
  const toolCalls = numberField(record, "toolCalls");
  const toolResults = numberField(record, "toolResults");
  const toolResultArtifacts = numberField(record, "toolResultArtifacts");
  const readStateFiles = numberField(record, "readStateFiles");
  const checkpoints = numberField(record, "checkpoints");
  const queuedUserMessages = numberField(record, "queuedUserMessages");
  const compactions = numberField(record, "compactions");
  if (
    transcriptEvents === undefined ||
    toolCalls === undefined ||
    toolResults === undefined ||
    toolResultArtifacts === undefined ||
    readStateFiles === undefined ||
    checkpoints === undefined ||
    queuedUserMessages === undefined ||
    compactions === undefined
  ) return undefined;
  return {
    transcriptEvents,
    toolCalls,
    toolResults,
    toolResultArtifacts,
    readStateFiles,
    checkpoints,
    queuedUserMessages,
    compactions,
    ...(typeof record.lastAssistantMessage === "string" ? { lastAssistantMessage: record.lastAssistantMessage } : {}),
  };
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clarificationMeta(value: unknown): ClarificationRequest | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<ClarificationRequest>;
  if (
    (candidate.mode === "blocking_facts" || candidate.mode === "discovered_choices" || candidate.mode === "consent") &&
    typeof candidate.message === "string" &&
    typeof candidate.context === "string" &&
    Array.isArray(candidate.questions)
  ) {
    return {
      mode: candidate.mode,
      message: candidate.message,
      context: candidate.context,
      questions: candidate.questions.filter((item): item is string => typeof item === "string"),
      choices: Array.isArray(candidate.choices) ? candidate.choices : undefined,
      answers: candidate.answers,
      sameSession: true,
    };
  }
  return undefined;
}
