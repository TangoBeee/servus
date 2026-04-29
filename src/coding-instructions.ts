import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { findServusProjectRoot, projectDirsFromRootToCwd } from "./coding-project.js";
import { loadConfig } from "./config.js";
import { getProjectMemoryDir, getProjectSessionKey } from "./session-store.js";

export interface CodingInstructionSource {
  label: string;
  path: string;
  scope: "project" | "user" | "project_memory";
  content: string;
  truncated: boolean;
}

const PROJECT_INSTRUCTION_FILES = [
  "SERVUS.md",
  ".servus/SERVUS.md",
  ".servus/instructions.md",
  ".servus/MEMORY.md",
  ".servus/memory.md",
];

const USER_INSTRUCTION_FILES = [
  ".servus/instructions.md",
  ".servus/MEMORY.md",
  ".servus/memory.md",
];

const MAX_FILE_CHARS = 10_000;
const MAX_TOTAL_CHARS = 30_000;
const MAX_READ_BYTES = 256_000;

export function loadCodingInstructions(cwd: string): CodingInstructionSource[] {
  const config = loadConfig();
  const sources: CodingInstructionSource[] = [];
  const root = findServusProjectRoot(cwd);
  const seen = new Set<string>();
  for (const dir of projectDirsFromRootToCwd(cwd)) {
    for (const file of PROJECT_INSTRUCTION_FILES) {
      const path = resolve(dir, file);
      if (seen.has(path)) continue;
      seen.add(path);
      const label = relative(root, path) || file;
      const source = readInstructionFile(path, "project", label);
      if (source) sources.push(source);
    }
  }

  const home = process.env.HOME || homedir();
  for (const file of USER_INSTRUCTION_FILES) {
    const source = readInstructionFile(join(home, file), "user", `~/${file}`);
    if (source) sources.push(source);
  }

  if (config.memory?.enabled !== false) {
    sources.push(...readProjectMemorySources(cwd, config.memory?.maxBytes));
  }

  let remaining = MAX_TOTAL_CHARS;
  const limited: CodingInstructionSource[] = [];
  for (const source of sources) {
    if (remaining <= 0) break;
    const content = source.content.slice(0, remaining);
    limited.push({
      ...source,
      content,
      truncated: source.truncated || content.length < source.content.length,
    });
    remaining -= content.length;
  }
  return limited;
}

export function formatCodingInstructions(sources: CodingInstructionSource[]): string {
  if (sources.length === 0) return "";
  return [
    "# Project And User Instructions",
    "The following instruction files were loaded before the run. Follow them unless they conflict with explicit user instructions or Servus safety rules.",
    "",
    ...sources.flatMap((source) => [
      `## ${source.label} (${source.scope})${source.truncated ? " [truncated]" : ""}`,
      "```md",
      source.content.trim(),
      "```",
      "",
    ]),
  ].join("\n").trim();
}

function readProjectMemorySources(cwd: string, maxMemoryBytes?: number): CodingInstructionSource[] {
  try {
    const dir = getProjectMemoryDir(cwd);
    const projectKey = getProjectSessionKey(cwd);
    const files = readdirSync(dir)
      .filter((file) => file.toLowerCase().endsWith(".md"))
      .sort((a, b) => {
        if (a === "MEMORY.md") return -1;
        if (b === "MEMORY.md") return 1;
        return a.localeCompare(b);
      })
      .slice(0, 8);
    const sources: CodingInstructionSource[] = [];
    for (const file of files) {
      const source = readInstructionFile(
        join(dir, file),
        "project_memory",
        `~/.servus/projects/${projectKey}/memory/${file}`,
        maxMemoryBytes,
      );
      if (source) sources.push(source);
    }
    return sources;
  } catch {
    return [];
  }
}

function readInstructionFile(
  path: string,
  scope: CodingInstructionSource["scope"],
  label: string,
  maxReadBytes = MAX_READ_BYTES,
): CodingInstructionSource | null {
  if (!existsSync(path)) return null;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size <= 0) return null;
    const limit = normalizeReadLimit(maxReadBytes);
    if (stat.size > limit) {
      return {
        label,
        path,
        scope,
        content: `File is ${(stat.size / 1024).toFixed(1)} KB and was not loaded because it exceeds the ${Math.floor(limit / 1024)} KB instruction-file limit.`,
        truncated: true,
      };
    }
    const raw = readFileSync(path, "utf-8").trim();
    if (!raw) return null;
    return {
      label,
      path,
      scope,
      content: raw.slice(0, MAX_FILE_CHARS),
      truncated: raw.length > MAX_FILE_CHARS,
    };
  } catch {
    return null;
  }
}

function normalizeReadLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return MAX_READ_BYTES;
  return Math.max(32_000, Math.floor(value));
}
