import {
  existsSync,
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SERVUS_DIR } from "./config.js";
import type { ServusEvent } from "./events.js";
import type { TaskDomain } from "./engine.js";
import type { EvidenceItem, RunContract, RunPhase } from "./runtime.js";

const SESSIONS_DIR = join(SERVUS_DIR, "sessions");

export interface SessionRecord {
  id: string;
  task: string;
  model: string;
  backend: string;
  cwd: string;
  status: "running" | "waiting_input" | "completed" | "failed";
  domain?: TaskDomain | "auto";
  runtimeStatus?: "queued" | "running" | "waiting_input" | "completed" | "failed" | "cancelled";
  phase?: RunPhase;
  contract?: RunContract;
  startTime: number;
  endTime?: number;
  cost: number;
  tasksCompleted: number;
  tasksFailed: number;
  logs: string[];
  events: ServusEvent[];
  evidence: EvidenceItem[];
  artifacts: string[];
  activeTools: string[];
  proofDir?: string;
}

function sessionPath(id: string): string {
  return join(SESSIONS_DIR, `${id}.json`);
}

function sessionDir(id: string): string {
  return join(SESSIONS_DIR, id);
}

function sessionStatePath(id: string): string {
  return join(sessionDir(id), "state.json");
}

function writeSession(record: SessionRecord): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const body = JSON.stringify(record, null, 2) + "\n";
  writeFileSync(sessionPath(record.id), body);
  try {
    mkdirSync(sessionDir(record.id), { recursive: true });
    writeFileSync(sessionStatePath(record.id), body);
  } catch {
    // Folder-based session storage is a compatibility mirror for the new
    // runtime model. Keep flat JSON working when home-dir sandboxing blocks it.
  }
}

export function createSession(
  task: string,
  model: string,
  backend: string,
  cwd: string,
  extras: Partial<Pick<SessionRecord, "domain" | "runtimeStatus" | "artifacts" | "activeTools" | "proofDir">> = {},
): SessionRecord {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const record: SessionRecord = {
    id: randomUUID().slice(0, 8),
    task,
    model,
    backend,
    cwd,
    status: "running",
    domain: extras.domain ?? "auto",
    runtimeStatus: extras.runtimeStatus ?? "running",
    phase: "orienting",
    startTime: Date.now(),
    cost: 0,
    tasksCompleted: 0,
    tasksFailed: 0,
    logs: [],
    events: [],
    evidence: [],
    artifacts: extras.artifacts ?? [],
    activeTools: extras.activeTools ?? [],
    proofDir: extras.proofDir,
  };
  writeSession(record);
  return record;
}

export function listSessions(): SessionRecord[] {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
  const records: SessionRecord[] = [];
  for (const f of files) {
    try {
      records.push(JSON.parse(readFileSync(join(SESSIONS_DIR, f), "utf-8")));
    } catch {
      /* skip corrupt files */
    }
  }
  return records.sort((a, b) => b.startTime - a.startTime);
}

export function getSession(id: string): SessionRecord | null {
  const p = existsSync(sessionStatePath(id)) ? sessionStatePath(id) : sessionPath(id);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

export function updateSession(id: string, data: Partial<SessionRecord>): void {
  const existing = getSession(id);
  if (!existing) return;
  const updated = { ...existing, ...data };
  writeSession(updated);
}

export function appendLog(id: string, line: string): void {
  const existing = getSession(id);
  if (!existing) return;
  existing.logs.push(line);
  if (existing.logs.length > 5000) existing.logs = existing.logs.slice(-4000);
  writeSession(existing);
}

export function appendEvent(id: string, event: ServusEvent): void {
  const existing = getSession(id);
  if (!existing) return;
  existing.events = [...(existing.events ?? []), event];
  if (existing.events.length > 5000) existing.events = existing.events.slice(-4000);
  try {
    mkdirSync(sessionDir(id), { recursive: true });
    appendFileSync(join(sessionDir(id), "events.jsonl"), JSON.stringify(event) + "\n");
  } catch {
    // Best-effort folder mirror; flat state remains authoritative.
  }
  writeSession(existing);
}

export function appendEvidence(id: string, evidence: EvidenceItem): void {
  const existing = getSession(id);
  if (!existing) return;
  existing.evidence = [...(existing.evidence ?? []), evidence];
  if (existing.evidence.length > 2000) existing.evidence = existing.evidence.slice(-1500);
  try {
    mkdirSync(sessionDir(id), { recursive: true });
    appendFileSync(join(sessionDir(id), "evidence.jsonl"), JSON.stringify(evidence) + "\n");
  } catch {
    // Best-effort folder mirror; flat state remains authoritative.
  }
  writeSession(existing);
}

export function deleteSession(id: string): void {
  const p = sessionPath(id);
  if (existsSync(p)) rmSync(p);
  const dir = sessionDir(id);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
