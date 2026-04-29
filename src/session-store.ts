import {
  existsSync,
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { SERVUS_DIR } from "./config.js";
import type { ServusEvent } from "./events.js";
import type { TaskDomain } from "./engine.js";
import type { EvidenceItem, RunContract, RunPhase } from "./runtime.js";

const SESSIONS_DIR = join(SERVUS_DIR, "sessions");
const PROJECTS_DIR = join(SERVUS_DIR, "projects");
const SESSION_INDEX_PATH = join(SERVUS_DIR, "session-index.jsonl");

export interface SessionIndexEntry {
  id: string;
  title: string;
  task: string;
  cwd: string;
  targetCwd?: string;
  domain?: TaskDomain | "auto";
  status: SessionRecord["status"];
  runtimeStatus?: SessionRecord["runtimeStatus"];
  model: string;
  backend: string;
  updatedAt: number;
  startTime: number;
  endTime?: number;
  cost: number;
  reason: "created" | "status" | "summary" | "target";
}

export interface ProjectSessionSummary {
  id: string;
  task: string;
  status: SessionRecord["status"];
  runtimeStatus?: SessionRecord["runtimeStatus"];
  domain?: SessionRecord["domain"];
  model: string;
  backend: string;
  cwd: string;
  launchCwd?: string;
  targetCwd?: string;
  startTime: number;
  endTime?: number;
  cost: number;
  proofDir?: string;
  finalSummary?: string;
  sessionFile: string;
}

export interface ProjectSessionIndex {
  version: number;
  project: { key: string; cwd: string };
  updatedAt?: number;
  sessions: ProjectSessionSummary[];
}

export interface SessionRecord {
  id: string;
  task: string;
  model: string;
  backend: string;
  cwd: string;
  launchCwd?: string;
  targetCwd?: string;
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
  finalSummary?: string;
  contextUsage?: unknown;
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

function projectKey(cwd: string): string {
  return resolve(cwd).replace(/[^a-zA-Z0-9._-]/g, "-");
}

function projectDir(cwd: string): string {
  return join(PROJECTS_DIR, projectKey(cwd));
}

function projectSessionPath(record: Pick<SessionRecord, "id" | "cwd" | "targetCwd">): string {
  return join(projectDir(recordWorkspaceCwd(record)), `${record.id}.jsonl`);
}

function projectIndexPath(cwd: string): string {
  return join(projectDir(cwd), "sessions-index.json");
}

export function getProjectSessionKey(cwd: string): string {
  return projectKey(cwd);
}

export function getProjectSessionDir(cwd: string): string {
  const dir = projectDir(cwd);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "memory"), { recursive: true });
  return dir;
}

export function getProjectMemoryDir(cwd: string): string {
  const dir = join(getProjectSessionDir(cwd), "memory");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function listProjectSessions(cwd: string): ProjectSessionSummary[] {
  return readProjectIndex(projectIndexPath(cwd), cwd).sessions;
}

export function appendProjectTranscript(cwd: string, sessionId: string, entry: Record<string, unknown>): void {
  try {
    const record = getSession(sessionId);
    const path = record ? projectSessionPath(record) : join(getProjectSessionDir(cwd), `${sessionId}.jsonl`);
    appendFileSync(path, JSON.stringify({
      sessionId,
      source: "coding",
      ...entry,
    }) + "\n");
    if (record) updateProjectIndex(record);
  } catch {
    // Best-effort project transcript mirror.
  }
}

function writeSession(record: SessionRecord): void {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const body = JSON.stringify(record, null, 2) + "\n";
  writeFileSync(sessionPath(record.id), body);
  try {
    mkdirSync(sessionDir(record.id), { recursive: true });
    writeFileSync(sessionStatePath(record.id), body);
    updateProjectIndex(record);
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
  extras: Partial<Pick<SessionRecord, "domain" | "runtimeStatus" | "artifacts" | "activeTools" | "proofDir" | "launchCwd" | "targetCwd">> = {},
): SessionRecord {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const record: SessionRecord = {
    id: randomUUID().slice(0, 8),
    task,
    model,
    backend,
    cwd,
    launchCwd: extras.launchCwd,
    targetCwd: extras.targetCwd,
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
  const sessionStartEvent = {
    type: "session:start",
    message: "Session started",
    metadata: {
      id: record.id,
      task,
      model,
      backend,
      cwd,
      launchCwd: record.launchCwd,
      targetCwd: record.targetCwd,
      domain: record.domain,
    },
    timestamp: record.startTime,
  } as ServusEvent;
  record.events.push(sessionStartEvent);
  writeSession(record);
  appendSessionIndex(record, "created");
  appendProjectSessionEvent(record, sessionStartEvent);
  return record;
}

export function listSessions(): SessionRecord[] {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const byId = new Map<string, SessionRecord>();
  for (const entry of readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const statePath = join(SESSIONS_DIR, entry.name, "state.json");
    if (!existsSync(statePath)) continue;
    try {
      const record = JSON.parse(readFileSync(statePath, "utf-8")) as SessionRecord;
      if (record?.id) byId.set(record.id, record);
    } catch {
      /* skip corrupt folder state */
    }
  }
  const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
  for (const f of files) {
    try {
      const record = JSON.parse(readFileSync(join(SESSIONS_DIR, f), "utf-8")) as SessionRecord;
      if (record?.id && !byId.has(record.id)) byId.set(record.id, record);
    } catch {
      /* skip corrupt files */
    }
  }
  return [...byId.values()].sort((a, b) => b.startTime - a.startTime);
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
  const reason = sessionIndexReason(existing, updated);
  if (reason) appendSessionIndex(updated, reason);
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
    // Event JSONL persistence should never break session state writes.
  }
  appendProjectSessionEvent(existing, event);
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
    // Evidence JSONL persistence should never break session state writes.
  }
  appendProjectSessionEvent(existing, {
    type: "evidence:add",
    agent: "ServusRuntime",
    message: evidence.summary,
    metadata: { evidence },
    timestamp: evidence.timestamp,
  } as ServusEvent);
  writeSession(existing);
}

export function deleteSession(id: string): void {
  const p = sessionPath(id);
  if (existsSync(p)) rmSync(p);
  const dir = sessionDir(id);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

export function listSessionIndex(limit = 200): SessionIndexEntry[] {
  if (!existsSync(SESSION_INDEX_PATH)) return [];
  try {
    const latest = new Map<string, SessionIndexEntry>();
    for (const line of readFileSync(SESSION_INDEX_PATH, "utf-8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as SessionIndexEntry;
        if (!parsed?.id || !parsed.updatedAt) continue;
        latest.set(parsed.id, parsed);
      } catch {
        // Ignore corrupt append-only index rows.
      }
    }
    return [...latest.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  } catch {
    return [];
  }
}

export function findSessionIndex(query: string, limit = 20): SessionIndexEntry[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return listSessionIndex(limit);
  return listSessionIndex(1000)
    .filter((entry) => {
      const haystack = [
        entry.id,
        entry.title,
        entry.task,
        entry.cwd,
        entry.targetCwd,
        entry.domain,
        entry.status,
        entry.model,
      ].filter(Boolean).join("\n").toLowerCase();
      return haystack.includes(normalized);
    })
    .slice(0, limit);
}

function appendSessionIndex(record: SessionRecord, reason: SessionIndexEntry["reason"]): void {
  try {
    mkdirSync(SERVUS_DIR, { recursive: true });
    const entry: SessionIndexEntry = {
      id: record.id,
      title: deriveSessionTitle(record),
      task: record.task,
      cwd: record.cwd,
      targetCwd: record.targetCwd,
      domain: record.domain,
      status: record.status,
      runtimeStatus: record.runtimeStatus,
      model: record.model,
      backend: record.backend,
      updatedAt: Date.now(),
      startTime: record.startTime,
      endTime: record.endTime,
      cost: record.cost,
      reason,
    };
    appendFileSync(SESSION_INDEX_PATH, JSON.stringify(entry) + "\n");
  } catch {
    // Session index is a lookup accelerator; state.json remains authoritative.
  }
}

function deriveSessionTitle(record: SessionRecord): string {
  const finalLine = record.finalSummary
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const raw = finalLine || record.task;
  return raw.replace(/\s+/g, " ").trim().slice(0, 120) || record.id;
}

function sessionIndexReason(previous: SessionRecord, next: SessionRecord): SessionIndexEntry["reason"] | null {
  if (previous.targetCwd !== next.targetCwd || previous.cwd !== next.cwd) return "target";
  if (previous.finalSummary !== next.finalSummary) return "summary";
  if (
    previous.status !== next.status ||
    previous.runtimeStatus !== next.runtimeStatus ||
    previous.endTime !== next.endTime ||
    previous.cost !== next.cost
  ) return "status";
  return null;
}

function updateProjectIndex(record: SessionRecord): void {
  try {
    const workspaceCwd = recordWorkspaceCwd(record);
    const dir = projectDir(workspaceCwd);
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, "memory"), { recursive: true });
    const path = projectIndexPath(workspaceCwd);
    const current = readProjectIndex(path, workspaceCwd);
    const summary = {
      id: record.id,
      task: record.task,
      status: record.status,
      runtimeStatus: record.runtimeStatus,
      domain: record.domain,
      model: record.model,
      backend: record.backend,
      cwd: record.cwd,
      launchCwd: record.launchCwd,
      targetCwd: record.targetCwd,
      startTime: record.startTime,
      endTime: record.endTime,
      cost: record.cost,
      proofDir: record.proofDir,
      finalSummary: record.finalSummary,
      sessionFile: projectSessionPath(record),
    };
    const without = current.sessions.filter((item) => item.id !== record.id);
    const next = {
      version: 1,
      project: {
        key: projectKey(workspaceCwd),
        cwd: workspaceCwd,
      },
      updatedAt: Date.now(),
      sessions: [summary, ...without]
        .sort((a, b) => (b.startTime ?? 0) - (a.startTime ?? 0))
        .slice(0, 500),
    };
    writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
  } catch {
    // Project session mirrors are best-effort compatibility storage.
  }
}

function readProjectIndex(path: string, cwd: string): ProjectSessionIndex {
  if (!existsSync(path)) {
    return {
      version: 1,
      project: { key: projectKey(cwd), cwd },
      sessions: [],
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.sessions)) return parsed;
  } catch {
    // Fall through to empty index.
  }
  return {
    version: 1,
    project: { key: projectKey(cwd), cwd },
    sessions: [],
  };
}

function appendProjectSessionEvent(record: SessionRecord, event: ServusEvent): void {
  try {
    const dir = projectDir(recordWorkspaceCwd(record));
    mkdirSync(dir, { recursive: true });
    appendFileSync(projectSessionPath(record), JSON.stringify(event) + "\n");
  } catch {
    // Best-effort project transcript mirror.
  }
}

function recordWorkspaceCwd(record: Pick<SessionRecord, "cwd" | "targetCwd">): string {
  return record.targetCwd || record.cwd;
}
