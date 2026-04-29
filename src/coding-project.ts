import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

const ROOT_MARKERS = [
  ".git",
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "SERVUS.md",
  ".servus",
];

export function findServusProjectRoot(cwd: string): string {
  const start = resolve(cwd);
  const home = resolve(process.env.HOME || homedir());
  const dirs = ancestorsFromLeaf(start);

  const gitRoot = dirs.find((dir) => existsSync(resolve(dir, ".git")));
  if (gitRoot) return gitRoot;

  const manifestRoot = dirs.find((dir) =>
    ["package.json", "Cargo.toml", "go.mod", "pyproject.toml"].some((marker) => existsSync(resolve(dir, marker)))
  );
  if (manifestRoot) return manifestRoot;

  const servusRoot = dirs.find((dir) =>
    dir !== home &&
    ["SERVUS.md", ".servus"].some((marker) => existsSync(resolve(dir, marker)))
  );
  return servusRoot ?? start;
}

export function projectDirsFromRootToCwd(cwd: string): string[] {
  const start = resolve(cwd);
  const root = findServusProjectRoot(start);
  const dirs = ancestorsFromLeaf(start);
  const rootIndex = dirs.findIndex((dir) => dir === root);
  if (rootIndex === -1) return [start];
  return dirs.slice(0, rootIndex + 1).reverse();
}

function ancestorsFromLeaf(start: string): string[] {
  const dirs: string[] = [];
  let current = resolve(start);
  while (true) {
    dirs.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

export function hasProjectMarker(cwd: string): boolean {
  return ROOT_MARKERS.some((marker) => existsSync(resolve(cwd, marker)));
}

export interface CodingWorkspaceResolution {
  launchCwd: string;
  targetCwd: string;
  explicitPath?: string;
  reason: "explicit_path" | "launch_cwd";
}

export function resolveCodingTargetWorkspace(task: string, launchCwd: string): CodingWorkspaceResolution {
  const launch = resolve(launchCwd);
  for (const candidate of extractPathCandidates(task)) {
    const resolved = resolveCandidatePath(candidate, launch);
    if (!resolved || !existsSync(resolved)) continue;
    const target = pathToWorkspaceRoot(resolved);
    return {
      launchCwd: launch,
      targetCwd: target,
      explicitPath: candidate,
      reason: "explicit_path",
    };
  }
  return {
    launchCwd: launch,
    targetCwd: findServusProjectRoot(launch),
    reason: "launch_cwd",
  };
}

function pathToWorkspaceRoot(path: string): string {
  try {
    const stat = statSync(path);
    const dir = stat.isDirectory() ? path : dirname(path);
    return findServusProjectRoot(dir);
  } catch {
    return findServusProjectRoot(path);
  }
}

function resolveCandidatePath(candidate: string, cwd: string): string | undefined {
  const cleaned = candidate
    .trim()
    .replace(/^['"`]+|['"`]+$/g, "")
    .replace(/[),.;:!?]+$/g, "");
  if (!cleaned || /^[a-z]+:\/\//i.test(cleaned)) return undefined;
  if (cleaned.startsWith("~/")) {
    return resolve(process.env.HOME || homedir(), cleaned.slice(2));
  }
  if (isAbsolute(cleaned)) return resolve(cleaned);
  if (/^[.]{1,2}\//.test(cleaned)) return resolve(cwd, cleaned);
  return undefined;
}

function extractPathCandidates(task: string): string[] {
  const candidates: string[] = [];
  const quoted = /[`'"]((?:~|\/|\.\.?\/)[^`'"]+)[`'"]/g;
  let match: RegExpExecArray | null;
  while ((match = quoted.exec(task))) {
    if (match[1]) candidates.push(match[1]);
  }

  const raw = /(?:^|\s)((?:~|\/|\.\.?\/)[^\s`'"]+)/g;
  while ((match = raw.exec(task))) {
    if (match[1]) candidates.push(match[1]);
  }
  return [...new Set(candidates)];
}
