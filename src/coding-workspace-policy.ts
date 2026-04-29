import {
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";

export interface CodingWorkspacePolicy {
  cwd: string;
  internalPaths: string[];
  generatedPaths: string[];
  dependencyPaths: string[];
  cachePaths: string[];
  defaultExcludeGlobs: string[];
}

export interface FilterDecision {
  excluded: boolean;
  reason?: string;
}

const INTERNAL_PATHS = [
  ".git",
  ".servus",
  ".servus-proofs",
  ".servus-security-reports",
  "servus-plan.json",
  "init.sh",
];

const GENERATED_PATHS = [
  "dist",
  "build",
  "coverage",
  ".cache",
  ".turbo",
  ".next",
  ".nuxt",
  ".vite",
  ".parcel-cache",
  ".pytest_cache",
  "__pycache__",
];

const DEPENDENCY_PATHS = [
  "node_modules",
  "vendor",
  ".venv",
  "venv",
  ".tox",
  "target",
];

export function createCodingWorkspacePolicy(cwd: string): CodingWorkspacePolicy {
  const defaultExcludeGlobs = [
    ...INTERNAL_PATHS,
    ...INTERNAL_PATHS.map((path) => `${path}/**`),
    ...GENERATED_PATHS,
    ...GENERATED_PATHS.map((path) => `${path}/**`),
    ...DEPENDENCY_PATHS,
    ...DEPENDENCY_PATHS.map((path) => `${path}/**`),
  ];
  return {
    cwd,
    internalPaths: INTERNAL_PATHS,
    generatedPaths: GENERATED_PATHS,
    dependencyPaths: DEPENDENCY_PATHS,
    cachePaths: GENERATED_PATHS,
    defaultExcludeGlobs,
  };
}

export function toWorkspaceRelative(cwd: string, filePath: string): string {
  const abs = resolve(cwd, filePath);
  const rel = relative(cwd, abs);
  if (!rel || rel === ".") return ".";
  if (rel.startsWith("..") || rel.split(/[\\/]/).includes("..")) return abs;
  return normalizePath(rel);
}

export function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function isExplicitInternalRequest(cwd: string, inputPath?: string, pattern?: string): boolean {
  const candidates = [inputPath, pattern].filter((item): item is string => !!item?.trim());
  return candidates.some((item) => {
    const normalized = normalizePath(item.trim());
    if (isInternalRelativePath(normalized)) return true;
    if (normalized.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(normalized)) {
      return isWorkspaceExcludedPath(cwd, normalized).excluded;
    }
    return false;
  });
}

export function isWorkspaceExcludedPath(cwd: string, filePath: string): FilterDecision {
  const rel = toWorkspaceRelative(cwd, filePath);
  if (rel === "." || rel.startsWith("/")) return { excluded: false };
  if (isInternalRelativePath(rel)) return { excluded: true, reason: "servus_internal" };
  if (isGeneratedRelativePath(rel)) return { excluded: true, reason: "generated_or_cache" };
  if (isDependencyRelativePath(rel)) return { excluded: true, reason: "dependency" };
  return { excluded: false };
}

export function filterWorkspacePaths(cwd: string, paths: string[], options: { allowInternal?: boolean } = {}): string[] {
  if (options.allowInternal) return paths;
  return paths.filter((path) => !isWorkspaceExcludedPath(cwd, path).excluded);
}

export function rgExcludeArgs(policy: CodingWorkspacePolicy, options: { allowInternal?: boolean } = {}): string[] {
  if (options.allowInternal) return [];
  return policy.defaultExcludeGlobs.flatMap((pattern) => ["--glob", `!${pattern}`]);
}

export function gitPathspecExcludeArgs(policy: CodingWorkspacePolicy): string[] {
  return policy.defaultExcludeGlobs.map((pattern) => `:(exclude)${pattern}`);
}

export function stripExcludedGitStatus(cwd: string, output: string): string {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => {
      const rawPath = line.slice(3).trim();
      const filePath = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1)! : rawPath;
      return !isWorkspaceExcludedPath(cwd, filePath).excluded;
    })
    .join("\n");
}

export function pathSuggestion(cwd: string, requestedPath: string): string | undefined {
  const abs = resolve(cwd, requestedPath);
  const dir = dirname(abs);
  const name = basename(abs).toLowerCase();
  const ext = extname(name);
  const parent = existsSync(dir) && statSync(dir).isDirectory() ? dir : cwd;
  let entries: string[] = [];
  try {
    entries = readdirSync(parent)
      .filter((entry) => !isWorkspaceExcludedPath(cwd, resolve(parent, entry)).excluded);
  } catch {
    return undefined;
  }
  const scored = entries
    .map((entry) => {
      const lower = entry.toLowerCase();
      let score = 0;
      if (lower === name) score += 100;
      if (lower.includes(name) || name.includes(lower)) score += 35;
      if (ext && lower.endsWith(ext)) score += 10;
      score += commonPrefix(lower, name);
      return { entry, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((item) => normalizePath(relative(cwd, resolve(parent, item.entry))));
  return scored.length ? scored.join(", ") : undefined;
}

export function isBlockedDevicePath(filePath: string): boolean {
  const normalized = filePath.split(sep).join("/");
  return normalized === "/dev/zero" ||
    normalized === "/dev/random" ||
    normalized === "/dev/urandom" ||
    normalized === "/dev/full" ||
    normalized === "/dev/stdin" ||
    normalized === "/dev/stdout" ||
    normalized === "/dev/stderr" ||
    normalized === "/dev/tty" ||
    normalized === "/dev/console" ||
    /^\/proc\/[^/]+\/fd\/[0-2]$/.test(normalized);
}

function isInternalRelativePath(relPath: string): boolean {
  return matchesTopLevel(relPath, INTERNAL_PATHS);
}

function isGeneratedRelativePath(relPath: string): boolean {
  return matchesTopLevel(relPath, GENERATED_PATHS);
}

function isDependencyRelativePath(relPath: string): boolean {
  return matchesTopLevel(relPath, DEPENDENCY_PATHS);
}

function matchesTopLevel(relPath: string, names: string[]): boolean {
  const normalized = normalizePath(relPath);
  return names.some((name) => normalized === name || normalized.startsWith(`${name}/`));
}

function commonPrefix(a: string, b: string): number {
  let count = 0;
  while (count < a.length && count < b.length && a[count] === b[count]) count++;
  return count;
}
