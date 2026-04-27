import type { ServusEvent } from "../../events.js";
import type { TaskDomain } from "../../engine.js";
import type { ClarificationRequest } from "../../clarification.js";

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

export interface RuntimeViewState {
  status: "idle" | "running" | "waiting_input" | "completed" | "failed";
  domain: TaskDomain | "auto";
  engine: string;
  model: string;
  backend: string;
  phase: string;
  cost: number;
  budget?: number;
  completed: number;
  total: number;
  proofDir?: string;
  artifacts: string[];
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
  if (event.type === "cost" && typeof event.metadata?.cost === "number") {
    next.cost = event.metadata.cost;
  }
  if (event.metadata?.total != null && typeof event.metadata.total === "number") next.total = event.metadata.total;
  if (event.metadata?.completed != null && typeof event.metadata.completed === "number") next.completed = event.metadata.completed;
  if (event.type === "tool:start") {
    const tool = stringMeta(event, "tool", event.message.split("(")[0] || "tool");
    const activity: ToolActivity = {
      id: `${event.timestamp}:${tool}:${state.tools.length}`,
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
    next.activeTools = state.activeTools.slice(1);
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

  return next;
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
  let idx = -1;
  for (let i = next.length - 1; i >= 0; i--) {
    const tool = next[i];
    if (tool.status === "running" && (!event.agent || tool.agent === event.agent)) {
      idx = i;
      break;
    }
  }
  if (idx === -1) return next;
  next[idx] = {
    ...next[idx],
    status: /error|fail/i.test(event.message) ? "failed" : "done",
    preview: event.message,
    finishedAt: event.timestamp,
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
