import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { SERVUS_DIR } from "./config.js";

export interface ContextBudget {
  modelId: string;
  contextWindowTokens: number;
  compactAtTokens: number;
  keepRecentMessages: number;
}

export interface AgentHistoryRecord {
  sessionId: string;
  agent: string;
  modelId: string;
  history: ModelMessage[];
  compactedAt?: number;
  estimatedTokens?: number;
}

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_COMPACT_RATIO = 0.62;

export function contextBudgetForModel(modelId: string): ContextBudget {
  const normalized = modelId.toLowerCase();
  const contextWindowTokens =
    normalized.startsWith("gpt-5")
      ? 400_000
      : normalized.startsWith("gpt-4.1")
        ? 1_000_000
        : normalized.startsWith("gpt-4o")
          ? 128_000
          : normalized.startsWith("claude-opus-4-7") || normalized.startsWith("claude-sonnet-4-6")
            ? 1_000_000
            : normalized.startsWith("claude-")
              ? 200_000
              : normalized.includes("gemini-3") || normalized.includes("gemini-2.5")
                ? 1_000_000
                : DEFAULT_CONTEXT_WINDOW;

  const compactAtTokens = Math.max(
    16_000,
    Math.floor(contextWindowTokens * DEFAULT_COMPACT_RATIO),
  );
  const keepRecentMessages = contextWindowTokens >= 400_000 ? 28 : 18;

  return {
    modelId,
    contextWindowTokens,
    compactAtTokens,
    keepRecentMessages,
  };
}

export function estimateMessageTokens(messages: ModelMessage[] | string): number {
  const text = typeof messages === "string" ? messages : JSON.stringify(messages);
  return Math.ceil(text.length / 4);
}

export function shouldCompactContext(
  history: ModelMessage[],
  systemPrompt: string,
  modelId: string,
): { shouldCompact: boolean; estimatedTokens: number; budget: ContextBudget } {
  const budget = contextBudgetForModel(modelId);
  const estimatedTokens = estimateMessageTokens(history) + estimateMessageTokens(systemPrompt);
  return {
    shouldCompact: estimatedTokens >= budget.compactAtTokens,
    estimatedTokens,
    budget,
  };
}

export function agentHistoryPath(sessionId: string, agent: string): string {
  return join(agentSessionDir(sessionId, agent), "history.json");
}

export function agentSessionDir(sessionId: string, agent: string): string {
  return join(SERVUS_DIR, "agent-sessions", sanitize(sessionId), sanitize(agent));
}

function sessionScopedAgentDir(sessionId: string, agent: string): string {
  return join(SERVUS_DIR, "sessions", sanitize(sessionId), "coding", "agents", sanitize(agent));
}

function sessionScopedAgentHistoryPath(sessionId: string, agent: string): string {
  return join(sessionScopedAgentDir(sessionId, agent), "history.json");
}

export function loadAgentHistory(sessionId: string | undefined, agent: string): ModelMessage[] {
  if (!sessionId) return [];
  const path = existsSync(sessionScopedAgentHistoryPath(sessionId, agent))
    ? sessionScopedAgentHistoryPath(sessionId, agent)
    : agentHistoryPath(sessionId, agent);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<AgentHistoryRecord>;
    return Array.isArray(parsed.history) ? parsed.history : [];
  } catch {
    return [];
  }
}

export function saveAgentHistory(
  sessionId: string | undefined,
  agent: string,
  modelId: string,
  history: ModelMessage[],
  estimatedTokens?: number,
): void {
  if (!sessionId) return;
  const dir = agentSessionDir(sessionId, agent);
  mkdirSync(dir, { recursive: true });
  const record: AgentHistoryRecord = {
    sessionId: sanitize(sessionId),
    agent,
    modelId,
    history,
    estimatedTokens,
  };
  writeFileSync(agentHistoryPath(sessionId, agent), JSON.stringify(record, null, 2) + "\n");
  const scopedDir = sessionScopedAgentDir(sessionId, agent);
  mkdirSync(scopedDir, { recursive: true });
  writeFileSync(sessionScopedAgentHistoryPath(sessionId, agent), JSON.stringify(record, null, 2) + "\n");
}

export function appendCompactionLog(
  sessionId: string | undefined,
  agent: string,
  entry: Record<string, unknown>,
): void {
  if (!sessionId) return;
  const dir = agentSessionDir(sessionId, agent);
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "compactions.jsonl"), JSON.stringify({ timestamp: Date.now(), ...entry }) + "\n");
  const scopedDir = sessionScopedAgentDir(sessionId, agent);
  mkdirSync(scopedDir, { recursive: true });
  const record = JSON.stringify({ timestamp: Date.now(), agent, ...entry }) + "\n";
  appendFileSync(join(scopedDir, "compactions.jsonl"), record);
  const codingDir = join(SERVUS_DIR, "sessions", sanitize(sessionId), "coding");
  mkdirSync(codingDir, { recursive: true });
  appendFileSync(join(codingDir, "compactions.jsonl"), record);
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}
