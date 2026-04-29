import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SERVUS_DIR } from "./config.js";
import { bus } from "./events.js";

export interface QueuedCodingUserMessage {
  id: string;
  sessionId: string;
  message: string;
  source: "tui" | "cli" | "api";
  createdAt: number;
}

const queues = new Map<string, QueuedCodingUserMessage[]>();

export function queueCodingUserMessage(input: {
  sessionId?: string;
  message: string;
  source?: QueuedCodingUserMessage["source"];
}): QueuedCodingUserMessage | null {
  const sessionId = input.sessionId?.trim();
  const message = input.message.trim();
  if (!sessionId || !message) return null;

  const item: QueuedCodingUserMessage = {
    id: `queued-user-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`,
    sessionId,
    message,
    source: input.source ?? "tui",
    createdAt: Date.now(),
  };
  const next = [...(queues.get(sessionId) ?? []), item].slice(-20);
  queues.set(sessionId, next);
  persistQueueEvent(sessionId, "queued", item);
  bus.push({
    type: "coding:user_message",
    agent: "CodingRuntime",
    message: "Queued same-session user message",
    metadata: { status: "queued", sessionId, id: item.id, source: item.source, message },
  });
  return item;
}

export function drainCodingUserMessages(sessionId?: string): QueuedCodingUserMessage[] {
  if (!sessionId) return [];
  const messages = queues.get(sessionId) ?? loadPersistedPendingMessages(sessionId);
  if (messages.length === 0) return [];
  queues.delete(sessionId);
  for (const item of messages) persistQueueEvent(sessionId, "drained", item);
  bus.push({
    type: "coding:user_message",
    agent: "CodingRuntime",
    message: `Drained ${messages.length} same-session user message(s)`,
    metadata: {
      status: "drained",
      sessionId,
      count: messages.length,
      ids: messages.map((item) => item.id),
    },
  });
  return messages;
}

export function clearCodingUserMessages(sessionId?: string): void {
  if (!sessionId) return;
  const messages = queues.get(sessionId) ?? loadPersistedPendingMessages(sessionId);
  queues.delete(sessionId);
  for (const item of messages) persistQueueEvent(sessionId, "cleared", item);
  if (messages.length > 0) {
    bus.push({
      type: "coding:user_message",
      agent: "CodingRuntime",
      message: `Cleared ${messages.length} queued same-session user message(s)`,
      metadata: {
        status: "cleared",
        sessionId,
        count: messages.length,
        ids: messages.map((item) => item.id),
      },
    });
  }
}

export function queuedCodingUserMessageCount(sessionId?: string): number {
  if (!sessionId) return 0;
  return queues.get(sessionId)?.length ?? loadPersistedPendingMessages(sessionId).length;
}

function persistQueueEvent(
  sessionId: string,
  status: "queued" | "drained" | "cleared",
  item: QueuedCodingUserMessage,
): void {
  try {
    const dir = join(SERVUS_DIR, "sessions", sessionId, "coding");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "user-messages.jsonl"), JSON.stringify({
      timestamp: Date.now(),
      status,
      ...item,
    }) + "\n");
  } catch {
    // Same-session message queue is in-memory first. Persistence is best-effort.
  }
}

function loadPersistedPendingMessages(sessionId: string): QueuedCodingUserMessage[] {
  const path = join(SERVUS_DIR, "sessions", sessionId, "coding", "user-messages.jsonl");
  if (!existsSync(path)) return [];
  try {
    const ledger = new Map<string, { status: "queued" | "drained" | "cleared"; item: QueuedCodingUserMessage }>();
    for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Partial<QueuedCodingUserMessage> & { status?: unknown };
        if (
          typeof parsed.id !== "string" ||
          typeof parsed.sessionId !== "string" ||
          typeof parsed.message !== "string" ||
          typeof parsed.createdAt !== "number" ||
          (parsed.source !== "tui" && parsed.source !== "cli" && parsed.source !== "api") ||
          (parsed.status !== "queued" && parsed.status !== "drained" && parsed.status !== "cleared")
        ) {
          continue;
        }
        ledger.set(parsed.id, {
          status: parsed.status,
          item: {
            id: parsed.id,
            sessionId: parsed.sessionId,
            message: parsed.message,
            source: parsed.source,
            createdAt: parsed.createdAt,
          },
        });
      } catch {
        // Ignore corrupt queue ledger rows.
      }
    }
    const pending = [...ledger.values()]
      .filter((entry) => entry.status === "queued" && entry.item.sessionId === sessionId)
      .map((entry) => entry.item)
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-20);
    if (pending.length > 0) queues.set(sessionId, pending);
    return pending;
  } catch {
    return [];
  }
}
