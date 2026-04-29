import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { loadConfig, SERVUS_DIR } from "./config.js";
import { getProjectMemoryDir, getProjectSessionKey } from "./session-store.js";

interface MemoryCandidate {
  category: MemoryCategory;
  text: string;
  source: string;
  confidence: "high" | "medium" | "low";
  promote: "immediate" | "repeated";
}

export type ProjectMemoryCategory =
  | "project_profile"
  | "architecture"
  | "verification"
  | "workflow"
  | "important_files";

type MemoryCategory = ProjectMemoryCategory;

interface MemoryItem {
  id: string;
  category: MemoryCategory;
  text: string;
  source: string;
  confidence: "high" | "medium" | "low";
  occurrences: number;
  createdAt: number;
  updatedAt: number;
  lastSeenAt: number;
}

interface MemoryObservation {
  key: string;
  category: MemoryCategory;
  text: string;
  source: string;
  occurrences: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

interface ProjectMemoryIndex {
  version: 1;
  projectKey: string;
  projectCwd: string;
  updatedAt: number;
  items: MemoryItem[];
  observations: MemoryObservation[];
}

export interface ProjectMemoryUpdateInput {
  cwd: string;
  sessionId: string;
  task: string;
  summary: string;
  success: boolean;
  repo?: {
    packageManager?: string;
    projectType?: string[];
    scripts?: Record<string, string>;
    entrypoints?: string[];
    configFiles?: string[];
    importantFiles?: string[];
  };
  checkpoints?: Array<{ changedFiles?: string[] }>;
  verificationAttempts?: Array<{ command?: string; status?: string }>;
}

export interface ProjectMemoryUpdateResult {
  updated: boolean;
  memoryPath: string;
  indexPath: string;
  added: string[];
  observed: string[];
}

export interface ProjectMemoryReadResult {
  enabled: boolean;
  memoryPath: string;
  indexPath: string;
  text: string;
  truncated: boolean;
}

export interface ProjectMemoryFactInput {
  cwd: string;
  sessionId: string;
  text: string;
  category: ProjectMemoryCategory;
  source: string;
  reason: string;
  confidence?: "high" | "medium" | "low";
}

const MEMORY_FILE = "MEMORY.md";
const INDEX_FILE = "memory-index.json";
const OBSERVATIONS_FILE = "OBSERVATIONS.jsonl";
const START_MARKER = "<!-- SERVUS_AUTO_MEMORY_START -->";
const END_MARKER = "<!-- SERVUS_AUTO_MEMORY_END -->";
const MAX_ITEMS = 80;
const REPEATED_PROMOTION_THRESHOLD = 2;

export function updateProjectMemoryFromCodingRun(input: ProjectMemoryUpdateInput): ProjectMemoryUpdateResult {
  const config = loadConfig();
  if (config.memory?.enabled === false) {
    const memoryDir = join(SERVUS_DIR, "projects", getProjectSessionKey(input.cwd), "memory");
    return {
      updated: false,
      memoryPath: join(memoryDir, MEMORY_FILE),
      indexPath: join(memoryDir, INDEX_FILE),
      added: [],
      observed: [],
    };
  }
  const memoryDir = getProjectMemoryDir(input.cwd);
  const memoryPath = join(memoryDir, MEMORY_FILE);
  const indexPath = join(memoryDir, INDEX_FILE);
  const index = readMemoryIndex(indexPath, input.cwd);
  const candidates = input.success ? deriveMemoryCandidates(input) : [];
  const now = Date.now();
  const added: string[] = [];
  const observed: string[] = [];

  for (const candidate of candidates) {
    const normalized = normalizeMemoryText(candidate.text);
    if (!isUsefulMemoryText(normalized)) continue;
    const key = memoryKey(candidate.category, normalized);
    const observation = upsertObservation(index, {
      key,
      category: candidate.category,
      text: normalized,
      source: candidate.source,
      occurrences: 0,
      firstSeenAt: now,
      lastSeenAt: now,
    }, now);
    observed.push(normalized);

    const shouldPromote =
      candidate.promote === "immediate" ||
      observation.occurrences >= REPEATED_PROMOTION_THRESHOLD ||
      isIntrinsicallyImportantMemory(candidate.category, normalized);
    if (!shouldPromote) continue;

    const item = upsertMemoryItem(index, {
      id: `mem-${hashString(key)}`,
      category: candidate.category,
      text: normalized,
      source: candidate.source,
      confidence: candidate.confidence,
      occurrences: observation.occurrences,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
    }, now);
    if (item.updatedAt === now && item.createdAt === now) added.push(item.text);
  }

  index.items = pruneMemoryItems(index.items);
  index.updatedAt = now;
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n", "utf-8");
  appendObservationLog(memoryDir, input, observed);
  const nextMemory = mergeManagedMemory(readText(memoryPath, config.memory?.maxBytes), renderMemoryMarkdown(index));
  writeFileSync(memoryPath, clampMemoryFile(nextMemory, config.memory?.maxBytes), "utf-8");

  return {
    updated: added.length > 0 || observed.length > 0,
    memoryPath,
    indexPath,
    added,
    observed,
  };
}

export function readProjectMemory(cwd: string, maxChars = 24_000): ProjectMemoryReadResult {
  const config = loadConfig();
  const memoryDir = config.memory?.enabled === false
    ? join(SERVUS_DIR, "projects", getProjectSessionKey(cwd), "memory")
    : getProjectMemoryDir(cwd);
  const memoryPath = join(memoryDir, MEMORY_FILE);
  const indexPath = join(memoryDir, INDEX_FILE);
  if (config.memory?.enabled === false) {
    return {
      enabled: false,
      memoryPath,
      indexPath,
      text: "Project memory is disabled in Servus config (memory.enabled=false).",
      truncated: false,
    };
  }
  const text = readText(memoryPath, config.memory?.maxBytes);
  const limit = Math.max(1000, Math.min(maxChars, normalizeMemoryMaxBytes(config.memory?.maxBytes)));
  return {
    enabled: true,
    memoryPath,
    indexPath,
    text: text.length > limit ? text.slice(0, limit) : text,
    truncated: text.length > limit,
  };
}

export function rememberProjectMemoryFact(input: ProjectMemoryFactInput): ProjectMemoryUpdateResult {
  const config = loadConfig();
  const memoryDir = config.memory?.enabled === false
    ? join(SERVUS_DIR, "projects", getProjectSessionKey(input.cwd), "memory")
    : getProjectMemoryDir(input.cwd);
  const memoryPath = join(memoryDir, MEMORY_FILE);
  const indexPath = join(memoryDir, INDEX_FILE);
  if (config.memory?.enabled === false) {
    return { updated: false, memoryPath, indexPath, added: [], observed: [] };
  }

  const normalized = normalizeMemoryText(input.text);
  if (!isUsefulMemoryText(normalized) || isLikelyTransientMemory(normalized)) {
    return { updated: false, memoryPath, indexPath, added: [], observed: [] };
  }

  const now = Date.now();
  const index = readMemoryIndex(indexPath, input.cwd);
  const key = memoryKey(input.category, normalized);
  const observation = upsertObservation(index, {
    key,
    category: input.category,
    text: normalized,
    source: input.source,
    occurrences: 0,
    firstSeenAt: now,
    lastSeenAt: now,
  }, now);
  const item = upsertMemoryItem(index, {
    id: `mem-${hashString(key)}`,
    category: input.category,
    text: normalized,
    source: input.source,
    confidence: input.confidence ?? "high",
    occurrences: observation.occurrences,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  }, now);

  index.items = pruneMemoryItems(index.items);
  index.updatedAt = now;
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n", "utf-8");
  appendObservationLog(memoryDir, {
    cwd: input.cwd,
    sessionId: input.sessionId,
    task: `Manual project memory: ${input.reason}`,
    summary: normalized,
    success: true,
  }, [normalized]);
  const nextMemory = mergeManagedMemory(readText(memoryPath, config.memory?.maxBytes), renderMemoryMarkdown(index));
  writeFileSync(memoryPath, clampMemoryFile(nextMemory, config.memory?.maxBytes), "utf-8");
  return {
    updated: true,
    memoryPath,
    indexPath,
    added: item.createdAt === now ? [item.text] : [],
    observed: [normalized],
  };
}

function deriveMemoryCandidates(input: ProjectMemoryUpdateInput): MemoryCandidate[] {
  const candidates: MemoryCandidate[] = [];
  const repo = input.repo;
  if (repo?.packageManager) {
    candidates.push({
      category: "project_profile",
      text: `Package manager: ${repo.packageManager}.`,
      source: "repo_context",
      confidence: "high",
      promote: "immediate",
    });
  }
  if (repo?.projectType?.length) {
    candidates.push({
      category: "project_profile",
      text: `Project type signals: ${repo.projectType.slice(0, 8).join(", ")}.`,
      source: "repo_context",
      confidence: "medium",
      promote: "immediate",
    });
  }
  const usefulScripts = usefulProjectScripts(repo?.scripts ?? {});
  if (usefulScripts.length) {
    candidates.push({
      category: "workflow",
      text: `Useful project scripts: ${usefulScripts.join("; ")}.`,
      source: "package_scripts",
      confidence: "high",
      promote: "immediate",
    });
  }
  if (repo?.entrypoints?.length) {
    candidates.push({
      category: "architecture",
      text: `Likely entrypoints: ${repo.entrypoints.slice(0, 10).join(", ")}.`,
      source: "repo_context",
      confidence: "medium",
      promote: "immediate",
    });
  }
  if (repo?.configFiles?.length) {
    candidates.push({
      category: "architecture",
      text: `Key config files: ${repo.configFiles.slice(0, 12).join(", ")}.`,
      source: "repo_context",
      confidence: "medium",
      promote: "immediate",
    });
  }
  for (const attempt of input.verificationAttempts ?? []) {
    if (attempt.status !== "passed" || !attempt.command) continue;
    candidates.push({
      category: "verification",
      text: `Known passing verification command: ${attempt.command}.`,
      source: "verification",
      confidence: "high",
      promote: "immediate",
    });
  }
  for (const file of changedFiles(input)) {
    const source = importantFileReason(file);
    candidates.push({
      category: "important_files",
      text: source
        ? `Important file: ${file} (${source}).`
        : `File often relevant to recent Servus coding work: ${file}.`,
      source: "changed_files",
      confidence: source ? "medium" : "low",
      promote: source ? "immediate" : "repeated",
    });
  }
  return candidates;
}

function usefulProjectScripts(scripts: Record<string, string>): string[] {
  const preferred = ["dev", "start", "build", "test", "typecheck", "lint", "format", "check"];
  return preferred
    .filter((name) => typeof scripts[name] === "string")
    .map((name) => `${name}=${scripts[name]}`)
    .slice(0, 10);
}

function changedFiles(input: ProjectMemoryUpdateInput): string[] {
  const files = (input.checkpoints ?? [])
    .flatMap((checkpoint) => checkpoint.changedFiles ?? [])
    .map((file) => normalizeProjectPath(input.cwd, file))
    .filter(Boolean);
  return [...new Set(files)].slice(0, 40);
}

function importantFileReason(file: string): string | null {
  if (/^(package\.json|pnpm-workspace\.yaml|tsconfig\.json|vite\.config\.[cm]?[jt]s|next\.config\.[cm]?js)$/.test(file)) return "project configuration";
  if (/^(src|app|pages|cmd|server|client)\/(?:index|main|app)\.[cm]?[jt]sx?$/.test(file)) return "entrypoint";
  if (/\/(?:router|routes|server|app|index|main)\.[cm]?[jt]sx?$/.test(file)) return "core flow file";
  if (/^(README\.md|SERVUS\.md|\.servus\/instructions\.md)$/.test(file)) return "project guidance";
  return null;
}

function normalizeProjectPath(cwd: string, file: string): string {
  const root = resolve(cwd);
  const resolved = resolve(root, file);
  const rel = relative(root, resolved);
  if (!rel || rel.startsWith("..") || rel.includes("\0")) return file.replace(/\\/g, "/");
  return rel.replace(/\\/g, "/");
}

function readMemoryIndex(path: string, cwd: string): ProjectMemoryIndex {
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<ProjectMemoryIndex>;
      return {
        version: 1,
        projectKey: parsed.projectKey ?? getProjectSessionKey(cwd),
        projectCwd: parsed.projectCwd ?? resolve(cwd),
        updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
        items: Array.isArray(parsed.items) ? parsed.items.filter(isMemoryItem) : [],
        observations: Array.isArray(parsed.observations) ? parsed.observations.filter(isObservation) : [],
      };
    } catch {
      // Fall through to a fresh index.
    }
  }
  return {
    version: 1,
    projectKey: getProjectSessionKey(cwd),
    projectCwd: resolve(cwd),
    updatedAt: Date.now(),
    items: [],
    observations: [],
  };
}

function upsertObservation(index: ProjectMemoryIndex, next: MemoryObservation, now: number): MemoryObservation {
  const existing = index.observations.find((item) => item.key === next.key);
  if (!existing) {
    next.occurrences = 1;
    index.observations.push(next);
    return next;
  }
  existing.occurrences++;
  existing.lastSeenAt = now;
  existing.source = next.source;
  existing.text = next.text;
  existing.category = next.category;
  return existing;
}

function upsertMemoryItem(index: ProjectMemoryIndex, next: MemoryItem, now: number): MemoryItem {
  const existing = index.items.find((item) => item.id === next.id);
  if (!existing) {
    index.items.push(next);
    return next;
  }
  existing.text = next.text;
  existing.source = next.source;
  existing.confidence = confidenceMax(existing.confidence, next.confidence);
  existing.occurrences = Math.max(existing.occurrences, next.occurrences);
  existing.updatedAt = now;
  existing.lastSeenAt = now;
  return existing;
}

function pruneMemoryItems(items: MemoryItem[]): MemoryItem[] {
  return items
    .filter((item) => isUsefulMemoryText(item.text))
    .sort((a, b) => categoryRank(a.category) - categoryRank(b.category) || b.occurrences - a.occurrences || b.updatedAt - a.updatedAt)
    .slice(0, MAX_ITEMS);
}

function renderMemoryMarkdown(index: ProjectMemoryIndex): string {
  const byCategory = new Map<MemoryCategory, MemoryItem[]>();
  for (const item of index.items) {
    const list = byCategory.get(item.category) ?? [];
    list.push(item);
    byCategory.set(item.category, list);
  }
  const sections: Array<[MemoryCategory, string]> = [
    ["project_profile", "Project Profile"],
    ["architecture", "Architecture"],
    ["workflow", "Workflow"],
    ["verification", "Verification"],
    ["important_files", "Important Files"],
  ];
  return [
    START_MARKER,
    "# Servus Project Memory",
    "",
    "These notes are maintained by Servus from successful coding sessions. Keep only durable facts that are useful across future tasks.",
    `Updated: ${new Date(index.updatedAt).toISOString()}`,
    "",
    ...sections.flatMap(([category, title]) => {
      const items = byCategory.get(category) ?? [];
      if (items.length === 0) return [];
      return [
        `## ${title}`,
        "",
        ...items.map((item) =>
          `- ${item.text} (${item.confidence} confidence, seen ${item.occurrences} time${item.occurrences === 1 ? "" : "s"})`
        ),
        "",
      ];
    }),
    END_MARKER,
    "",
  ].join("\n");
}

function mergeManagedMemory(existing: string, generated: string): string {
  const start = existing.indexOf(START_MARKER);
  const end = existing.indexOf(END_MARKER);
  if (start !== -1 && end !== -1 && end > start) {
    return `${existing.slice(0, start).trimEnd()}\n\n${generated}${existing.slice(end + END_MARKER.length).trimStart()}`.trimEnd() + "\n";
  }
  if (!existing.trim()) return generated;
  return `${existing.trimEnd()}\n\n${generated}`;
}

function appendObservationLog(memoryDir: string, input: ProjectMemoryUpdateInput, observed: string[]): void {
  if (observed.length === 0) return;
  try {
    const path = join(memoryDir, OBSERVATIONS_FILE);
    appendFileSync(
      path,
      JSON.stringify({
        timestamp: Date.now(),
        sessionId: input.sessionId,
        task: input.task.slice(0, 500),
        observed,
      }) + "\n",
      "utf-8",
    );
  } catch {
    // Memory learning is best-effort.
  }
}

function readText(path: string, maxBytes?: number): string {
  try {
    if (!existsSync(path)) return "";
    const text = readFileSync(path, "utf-8");
    const limit = normalizeMemoryMaxBytes(maxBytes);
    if (text.length <= limit) return text;
    return text.slice(0, limit);
  } catch {
    return "";
  }
}

function clampMemoryFile(text: string, maxBytes?: number): string {
  const limit = normalizeMemoryMaxBytes(maxBytes);
  if (text.length <= limit) return text;
  const marker = "\n\n<!-- SERVUS_MEMORY_TRUNCATED: older unmanaged content exceeded configured memory.maxBytes -->\n";
  const keep = Math.max(4000, limit - marker.length);
  return text.slice(0, keep).trimEnd() + marker;
}

function normalizeMemoryMaxBytes(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 512_000;
  return Math.max(32_000, Math.floor(value));
}

function isUsefulMemoryText(text: string): boolean {
  if (text.length < 12 || text.length > 800) return false;
  if (/^(done|completed|fixed|updated|changed)$/i.test(text.trim())) return false;
  if (/\b(no files|unknown|undefined|null)\b/i.test(text)) return false;
  return true;
}

function isLikelyTransientMemory(text: string): boolean {
  return /\b(today|tomorrow|yesterday|right now|temporary|for this run|this session|latest error|current error|todo|next step)\b/i.test(text) ||
    /\b(sk-[A-Za-z0-9_-]{12,}|password|secret|token|api key)\b/i.test(text);
}

function isIntrinsicallyImportantMemory(category: MemoryCategory, text: string): boolean {
  return category !== "important_files" || /\((project configuration|entrypoint|core flow file|project guidance)\)/.test(text);
}

function normalizeMemoryText(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/\s+\./g, ".");
}

function memoryKey(category: MemoryCategory, text: string): string {
  return `${category}:${normalizeMemoryText(text).toLowerCase().replace(/['"`]/g, "")}`;
}

function hashString(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index++) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(index);
  }
  return Math.abs(hash >>> 0).toString(36);
}

function categoryRank(category: MemoryCategory): number {
  return ["project_profile", "architecture", "workflow", "verification", "important_files"].indexOf(category);
}

function confidenceMax(a: MemoryItem["confidence"], b: MemoryItem["confidence"]): MemoryItem["confidence"] {
  const rank = { low: 0, medium: 1, high: 2 };
  return rank[b] > rank[a] ? b : a;
}

function isMemoryItem(value: unknown): value is MemoryItem {
  return !!value && typeof value === "object" &&
    typeof (value as MemoryItem).id === "string" &&
    typeof (value as MemoryItem).text === "string" &&
    typeof (value as MemoryItem).category === "string";
}

function isObservation(value: unknown): value is MemoryObservation {
  return !!value && typeof value === "object" &&
    typeof (value as MemoryObservation).key === "string" &&
    typeof (value as MemoryObservation).text === "string" &&
    typeof (value as MemoryObservation).category === "string";
}
