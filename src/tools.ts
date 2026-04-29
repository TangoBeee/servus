/**
 * Built-in tool definitions for the custom Servus agent runtime.
 *
 * Each tool is defined using the Vercel AI SDK v6 `tool()` function
 * with a Zod input schema and an async execute function.
 */

import { tool } from "ai";
import { z } from "zod";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { registerChild, unregisterChild } from "./child-registry.js";
import {
  existsSync,
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, join, resolve, relative } from "node:path";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import {
  createCodingWorkspacePolicy,
  filterWorkspacePaths,
  isBlockedDevicePath,
  isExplicitInternalRequest,
  isWorkspaceExcludedPath,
  pathSuggestion,
  rgExcludeArgs,
  stripExcludedGitStatus,
  toWorkspaceRelative,
} from "./coding-workspace-policy.js";
import { bus } from "./events.js";
import { createMcpTools } from "./tools-mcp.js";
import { summarizeLspAvailability, tryRealLsp } from "./lsp-client.js";
import { SERVUS_DIR } from "./config.js";

const execFileAsync = promisify(execFile);

// ─── Helpers ────────────────────────────────────────────────────────────────

const MAX_OUTPUT = 50_000;
const MAX_READ_FILE_SIZE = 10 * 1024 * 1024;
const ASSISTANT_BLOCKING_BUDGET_MS = 20_000;
const readTracker = new Map<string, Map<string, FileState>>();

interface FileState {
  content: string;
  mtimeMs: number;
  size: number;
  offset?: number;
  limit?: number;
  partial: boolean;
  timestamp: number;
}

type ShellTaskStatus = {
  id: string;
  command: string;
  description: string;
  cwd: string;
  outputPath: string;
  status: "running" | "completed" | "failed" | "timed_out" | "killed";
  startedAt: number;
  completedAt?: number;
  exitCode?: number | null;
  timedOut?: boolean;
  killed?: boolean;
};

type ShellTask = {
  id: string;
  child: ReturnType<typeof spawn>;
  status: ShellTaskStatus;
  statusPath: string;
  outputPath: string;
  timer: NodeJS.Timeout;
};

const shellTasks = new Map<string, ShellTask>();

function clamp(str: string, max = MAX_OUTPUT): string {
  if (str.length <= max) return str;
  const half = Math.floor((max - 80) / 2);
  return (
    str.slice(0, half) +
    `\n\n[… truncated ${str.length - max} characters …]\n\n` +
    str.slice(-half)
  );
}

function resolveP(p: string, cwd: string): string {
  return resolve(cwd, p);
}

function getFilePathInput(input: { filePath?: string; file_path?: string }): string {
  return (input.filePath ?? input.file_path ?? "").trim();
}

function getOldStringInput(input: { oldString?: string; old_string?: string }): string {
  return input.oldString ?? input.old_string ?? "";
}

function getNewStringInput(input: { newString?: string; new_string?: string }): string {
  return input.newString ?? input.new_string ?? "";
}

function isBinary(filePath: string): boolean {
  const binExts = new Set([
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico",
    ".mp3", ".mp4", ".wav", ".ogg", ".webm", ".avi",
    ".zip", ".gz", ".tar", ".bz2", ".7z", ".rar",
    ".pdf", ".doc", ".docx", ".xls", ".xlsx",
    ".woff", ".woff2", ".ttf", ".eot",
    ".exe", ".dll", ".so", ".dylib", ".o",
    ".pyc", ".class", ".wasm",
  ]);
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return binExts.has(ext);
}

function shellSessionDir(cwd: string, sessionId?: string): string {
  const key = sessionId ? sanitizeShellPathPart(sessionId) : sanitizeShellPathPart(cwd);
  return join(SERVUS_DIR, "sessions", key, "coding", "bash");
}

function sanitizeShellPathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "default";
}

function shellTaskId(): string {
  return `shell-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function shellTaskPaths(cwd: string, sessionId: string | undefined, id: string): { dir: string; outputPath: string; statusPath: string } {
  const safe = sanitizeShellPathPart(id);
  const dir = shellSessionDir(cwd, sessionId);
  return {
    dir,
    outputPath: join(dir, `${safe}.log`),
    statusPath: join(dir, `${safe}.json`),
  };
}

function writeShellTaskStatus(path: string, status: ShellTaskStatus): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(status, null, 2));
}

function readShellTaskStatus(cwd: string, sessionId: string | undefined, id: string): ShellTaskStatus | undefined {
  const active = shellTasks.get(id);
  if (active) return active.status;
  const paths = shellTaskPaths(cwd, sessionId, id);
  if (!existsSync(paths.statusPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(paths.statusPath, "utf-8")) as Partial<ShellTaskStatus>;
    if (parsed.id !== id || typeof parsed.outputPath !== "string") return undefined;
    return parsed as ShellTaskStatus;
  } catch {
    return undefined;
  }
}

function appendShellOutput(outputPath: string, chunk: Buffer, stream: "stdout" | "stderr"): void {
  mkdirSync(dirname(outputPath), { recursive: true });
  const prefix = stream === "stderr" ? "\n[stderr] " : "";
  appendFileSync(outputPath, `${prefix}${chunk.toString("utf-8")}`);
}

function readFileTail(filePath: string, limit = 20_000): string {
  if (!existsSync(filePath)) return "";
  const maxBytes = Math.max(1000, Math.min(limit * 2, 250_000));
  const st = statSync(filePath);
  if (st.size <= maxBytes) return readFileSync(filePath, "utf-8");
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    readSync(fd, buffer, 0, maxBytes, st.size - maxBytes);
    return `[… output truncated to last ${maxBytes} bytes from ${st.size} total bytes …]\n${buffer.toString("utf-8")}`;
  } finally {
    closeSync(fd);
  }
}

function killShellTask(task: ShellTask, signal: NodeJS.Signals = "SIGTERM"): void {
  try {
    if (process.platform !== "win32" && task.child.pid) process.kill(-task.child.pid, signal);
    else task.child.kill(signal);
  } catch {
    try {
      task.child.kill(signal);
    } catch {
      /* already exited */
    }
  }
}

function startShellTask(input: {
  command: string;
  description: string;
  cwd: string;
  sessionId?: string;
  timeoutMs: number;
}): ShellTask {
  const id = shellTaskId();
  const paths = shellTaskPaths(input.cwd, input.sessionId, id);
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.outputPath, [
    `# Servus Bash task ${id}`,
    `# ${input.description}`,
    `# cwd: ${input.cwd}`,
    `# command: ${input.command}`,
    "",
  ].join("\n"));
  const status: ShellTaskStatus = {
    id,
    command: input.command,
    description: input.description,
    cwd: input.cwd,
    outputPath: paths.outputPath,
    status: "running",
    startedAt: Date.now(),
  };
  writeShellTaskStatus(paths.statusPath, status);

  const child = spawn("/bin/bash", ["-c", input.command], {
    cwd: input.cwd,
    env: { ...process.env, FORCE_COLOR: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  if (child.pid) registerChild(child.pid, { processGroup: process.platform !== "win32" });

  const task: ShellTask = {
    id,
    child,
    status,
    statusPath: paths.statusPath,
    outputPath: paths.outputPath,
    timer: setTimeout(() => {
      status.status = "timed_out";
      status.timedOut = true;
      status.completedAt = Date.now();
      appendFileSync(paths.outputPath, `\n[servus] command timed out after ${input.timeoutMs}ms\n`);
      writeShellTaskStatus(paths.statusPath, status);
      killShellTask(task, "SIGKILL");
    }, input.timeoutMs),
  };

  shellTasks.set(id, task);
  child.stdout?.on("data", (chunk: Buffer) => appendShellOutput(paths.outputPath, chunk, "stdout"));
  child.stderr?.on("data", (chunk: Buffer) => appendShellOutput(paths.outputPath, chunk, "stderr"));
  child.on("close", (code) => {
    clearTimeout(task.timer);
    if (child.pid) unregisterChild(child.pid);
    if (status.status === "running") {
      status.status = code === 0 ? "completed" : "failed";
      status.exitCode = code ?? null;
      status.completedAt = Date.now();
    }
    writeShellTaskStatus(paths.statusPath, status);
    shellTasks.delete(id);
  });

  return task;
}

function formatShellTaskOutput(status: ShellTaskStatus, limit = 20_000): string {
  const rawOutput = readFileTail(status.outputPath, Math.max(limit * 2, limit));
  const output = normalizeShellOutput(rawOutput, limit);
  const elapsed = ((status.completedAt ?? Date.now()) - status.startedAt) / 1000;
  const sandboxDenied = isLikelySandboxDenied(status, rawOutput);
  return [
    `Bash task ${status.id}`,
    `Status: ${status.status}${status.exitCode !== undefined ? ` (exit ${status.exitCode ?? "unknown"})` : ""}`,
    `Elapsed: ${elapsed.toFixed(1)}s`,
    `Output: ${status.outputPath}`,
    sandboxDenied
      ? "Sandbox: this command looks blocked by OS/sandbox permissions. Do not retry blindly; ask for approval, choose a narrower command, or use Servus tools."
      : undefined,
    "",
    output ? clamp(output, limit) : "(no output yet)",
  ].filter(Boolean).join("\n");
}

function isLikelySandboxDenied(status: ShellTaskStatus, output: string): boolean {
  if (status.exitCode === 0) return false;
  if (status.exitCode === 127) return false;
  return /operation not permitted|permission denied|sandbox|seccomp|deny\(1\)|network is unreachable|getaddrinfo ENOTFOUND|EPERM|EACCES/i.test(output);
}

function normalizeShellOutput(output: string, limit: number): string {
  if (!output.trim()) return "";
  const lines = output.split(/\r?\n/);
  const kept: string[] = [];
  let omittedProgress = 0;
  let omittedDuplicates = 0;
  let previous = "";
  for (const line of lines) {
    const stripped = stripAnsi(line).trim();
    if (isNoisyProgressLine(stripped)) {
      omittedProgress++;
      continue;
    }
    if (stripped && stripped === previous) {
      omittedDuplicates++;
      continue;
    }
    kept.push(line);
    if (stripped) previous = stripped;
  }
  const prefix: string[] = [];
  if (omittedProgress > 0) {
    prefix.push(`[servus] omitted ${omittedProgress} repetitive progress line${omittedProgress === 1 ? "" : "s"}`);
  }
  if (omittedDuplicates > 0) {
    prefix.push(`[servus] collapsed ${omittedDuplicates} duplicate line${omittedDuplicates === 1 ? "" : "s"}`);
  }
  return clamp([...prefix, ...kept].join("\n"), limit);
}

function isNoisyProgressLine(line: string): boolean {
  return /^(\[stderr\]\s*)?<s>\s+\[webpack\.Progress\]/i.test(line) ||
    /^(\[stderr\]\s*)?\d{1,3}%\s+(?:building|sealing|setup|compiling)\b/i.test(line) ||
    /^(\[stderr\]\s*)?(?:webpack|vite|rollup)\s+\d{1,3}%\b/i.test(line);
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function buildWorkspaceMapForTool(
  cwd: string,
  root: string,
  options: { allowInternal: boolean; maxDepth: number; limit: number },
): { lines: string[]; entries: number; totalSeen: number; truncated: boolean } {
  const lines: string[] = [];
  let totalSeen = 0;
  let truncated = false;
  const base = resolve(root);

  function walk(dir: string, depth: number, prefix: string): void {
    if (lines.length >= options.limit) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => options.allowInternal || !isWorkspaceExcludedPath(cwd, resolve(dir, entry.name)).excluded)
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    } catch {
      return;
    }

    for (const [index, entry] of entries.entries()) {
      totalSeen++;
      if (lines.length >= options.limit) {
        truncated = true;
        return;
      }
      const full = resolve(dir, entry.name);
      const isLast = index === entries.length - 1;
      const branch = prefix ? `${prefix}${isLast ? "`- " : "|- "}` : "";
      const rel = toWorkspaceRelative(cwd, full);
      lines.push(`${branch}${entry.name}${entry.isDirectory() ? "/" : ""}${rel.startsWith("/") ? ` (${rel})` : ""}`);
      if (entry.isDirectory() && depth < options.maxDepth) {
        walk(full, depth + 1, `${prefix}${isLast ? "   " : "|  "}`);
      } else if (entry.isDirectory() && depth >= options.maxDepth) {
        try {
          const visibleChildren = readdirSync(full, { withFileTypes: true })
            .filter((child) => options.allowInternal || !isWorkspaceExcludedPath(cwd, resolve(full, child.name)).excluded)
            .length;
          if (visibleChildren > 0 && lines.length < options.limit) {
            lines.push(`${prefix}${isLast ? "   " : "|  "}... ${visibleChildren} item${visibleChildren === 1 ? "" : "s"}`);
          }
        } catch {
          // Ignore unreadable children; the parent entry is still useful context.
        }
      }
    }

    if (dir === base && lines.length === 0 && totalSeen === 0) {
      lines.push("(no visible entries)");
    }
  }

  walk(base, 0, "");
  return { lines, entries: lines.length, totalSeen, truncated };
}

function buildProjectOverviewForTool(
  cwd: string,
  root: string,
  options: { allowInternal: boolean; maxDepth: number; excerptChars: number },
): string {
  const map = buildWorkspaceMapForTool(cwd, root, {
    allowInternal: options.allowInternal,
    maxDepth: options.maxDepth,
    limit: 140,
  });
  const docs = collectExistingFiles(root, [
    "README.md",
    "README.mdx",
    "SERVUS.md",
    "docs/README.md",
    "docs/index.md",
  ], cwd, options.allowInternal);
  const manifests = collectExistingFiles(root, [
    "package.json",
    "pnpm-workspace.yaml",
    "yarn.lock",
    "package-lock.json",
    "Cargo.toml",
    "pyproject.toml",
    "go.mod",
    "requirements.txt",
    "tsconfig.json",
    "vite.config.js",
    "vite.config.ts",
    "next.config.js",
    "next.config.mjs",
    "Dockerfile",
    "docker-compose.yml",
    ".github/workflows/publish.yml",
  ], cwd, options.allowInternal);
  const sourceDirs = collectExistingDirs(root, [
    "src",
    "app",
    "pages",
    "components",
    "frontend",
    "backend",
    "server",
    "client",
    "packages",
    "cmd",
    "lib",
    "test",
    "tests",
  ], cwd, options.allowInternal);
  const entrypoints = collectEntrypointFiles(root, cwd, options.allowInternal);
  const packageSummary = summarizePackageJson(root);
  const excerpts = [...docs, ...manifests.slice(0, 8), ...entrypoints.slice(0, 8)]
    .filter((file, index, all) => all.indexOf(file) === index)
    .map((file) => formatOverviewExcerpt(root, file, options.excerptChars))
    .filter(Boolean);

  return [
    `Project overview: ${toWorkspaceRelative(cwd, root)}`,
    `Ignored paths applied: ${options.allowInternal ? "no (explicit path)" : "yes"}`,
    "",
    "Workspace map:",
    map.lines.join("\n") || "(empty)",
    map.truncated ? "Workspace map truncated; use WorkspaceMap on a narrower path for more detail." : "",
    "",
    packageSummary,
    "",
    "Key files:",
    `Docs: ${overviewList(root, docs)}`,
    `Manifests/config: ${overviewList(root, manifests)}`,
    `Source/test dirs: ${overviewList(root, sourceDirs)}`,
    `Likely entrypoints: ${overviewList(root, entrypoints)}`,
    "",
    "Representative excerpts:",
    excerpts.length ? excerpts.join("\n\n") : "(no readable docs/manifests/entrypoints found)",
  ].filter(Boolean).join("\n");
}

function collectExistingFiles(root: string, relPaths: string[], cwd: string, allowInternal: boolean): string[] {
  return relPaths
    .map((rel) => resolve(root, rel))
    .filter((path) => existsSync(path) && statSync(path).isFile())
    .filter((path) => allowInternal || !isWorkspaceExcludedPath(cwd, path).excluded);
}

function collectExistingDirs(root: string, relPaths: string[], cwd: string, allowInternal: boolean): string[] {
  return relPaths
    .map((rel) => resolve(root, rel))
    .filter((path) => existsSync(path) && statSync(path).isDirectory())
    .filter((path) => allowInternal || !isWorkspaceExcludedPath(cwd, path).excluded);
}

function collectEntrypointFiles(root: string, cwd: string, allowInternal: boolean): string[] {
  const explicit = collectExistingFiles(root, [
    "src/index.ts",
    "src/index.tsx",
    "src/index.js",
    "src/index.jsx",
    "src/main.ts",
    "src/main.tsx",
    "src/main.js",
    "src/main.jsx",
    "src/app.ts",
    "src/app.tsx",
    "src/app.js",
    "src/app.jsx",
    "index.ts",
    "index.js",
    "main.ts",
    "main.js",
  ], cwd, allowInternal);
  const packageEntrypoints = packageJsonEntrypoints(root, cwd, allowInternal);
  return [...new Set([...packageEntrypoints, ...explicit])].slice(0, 16);
}

function packageJsonEntrypoints(root: string, cwd: string, allowInternal: boolean): string[] {
  const packagePath = resolve(root, "package.json");
  if (!existsSync(packagePath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(packagePath, "utf-8")) as Record<string, unknown>;
    const fields = [
      parsed.main,
      parsed.module,
      parsed.browser,
      parsed.types,
      parsed.typings,
      ...(typeof parsed.bin === "string"
        ? [parsed.bin]
        : parsed.bin && typeof parsed.bin === "object"
          ? Object.values(parsed.bin as Record<string, unknown>)
          : []),
    ].filter((item): item is string => typeof item === "string" && item.trim().length > 0);
    return fields
      .map((field) => resolve(root, field))
      .filter((path) => existsSync(path) && statSync(path).isFile())
      .filter((path) => allowInternal || !isWorkspaceExcludedPath(cwd, path).excluded);
  } catch {
    return [];
  }
}

function summarizePackageJson(root: string): string {
  const packagePath = resolve(root, "package.json");
  if (!existsSync(packagePath)) return "Package manifest: none found";
  try {
    const parsed = JSON.parse(readFileSync(packagePath, "utf-8")) as {
      name?: unknown;
      version?: unknown;
      type?: unknown;
      scripts?: unknown;
      dependencies?: unknown;
      devDependencies?: unknown;
    };
    const scripts = parsed.scripts && typeof parsed.scripts === "object"
      ? Object.keys(parsed.scripts as Record<string, unknown>).slice(0, 18)
      : [];
    const deps = parsed.dependencies && typeof parsed.dependencies === "object"
      ? Object.keys(parsed.dependencies as Record<string, unknown>).length
      : 0;
    const devDeps = parsed.devDependencies && typeof parsed.devDependencies === "object"
      ? Object.keys(parsed.devDependencies as Record<string, unknown>).length
      : 0;
    return [
      "Package manifest:",
      `- name: ${typeof parsed.name === "string" ? parsed.name : "(unnamed)"}`,
      typeof parsed.version === "string" ? `- version: ${parsed.version}` : undefined,
      typeof parsed.type === "string" ? `- module type: ${parsed.type}` : undefined,
      `- scripts: ${scripts.length ? scripts.join(", ") : "(none)"}`,
      `- dependencies: ${deps} runtime, ${devDeps} dev`,
    ].filter(Boolean).join("\n");
  } catch (err: unknown) {
    return `Package manifest: unreadable package.json (${err instanceof Error ? err.message : String(err)})`;
  }
}

function formatOverviewExcerpt(root: string, path: string, limit: number): string {
  try {
    if (isBinary(path)) return "";
    const stat = statSync(path);
    if (stat.size > MAX_READ_FILE_SIZE) return `### ${relative(root, path)}\nSkipped: file is too large (${Math.round(stat.size / 1024)} KB).`;
    const content = readFileSync(path, "utf-8").slice(0, limit).trim();
    if (!content) return "";
    return [
      `### ${relative(root, path)}${stat.size > limit ? " [excerpt]" : ""}`,
      "```",
      content,
      "```",
    ].join("\n");
  } catch {
    return "";
  }
}

function overviewList(root: string, paths: string[]): string {
  if (paths.length === 0) return "(none)";
  return paths.map((path) => relative(root, path) || ".").join(", ");
}

// ─── Schemas ────────────────────────────────────────────────────────────────

const bashSchema = z.object({
  command: z.string().describe("The bash command to execute"),
  timeout: z.number().optional().describe("Timeout in milliseconds (default: 120000)"),
  description: z.string().optional().describe("Brief 5-10 word description of what this command does"),
  run_in_background: z.boolean().optional().describe("Run this command in the background and return a task id. Use BashOutput to poll output later."),
  runInBackground: z.boolean().optional().describe("Alias for run_in_background."),
});

const bashOutputSchema = z.object({
  task_id: z.string().optional().describe("Background shell task id returned by Bash."),
  taskId: z.string().optional().describe("Alias for task_id."),
  limit: z.number().optional().describe("Maximum characters to return from the output tail (default: 20000)."),
}).refine((input) => !!(input.task_id ?? input.taskId), "task_id or taskId is required");

const killBashSchema = z.object({
  task_id: z.string().optional().describe("Background shell task id returned by Bash."),
  taskId: z.string().optional().describe("Alias for task_id."),
}).refine((input) => !!(input.task_id ?? input.taskId), "task_id or taskId is required");

const readSchema = z.object({
  filePath: z.string().optional().describe("Absolute or relative path to the file"),
  file_path: z.string().optional().describe("Servus-compatible alias for filePath"),
  offset: z.number().optional().describe("1-based starting line number (default: 1)"),
  limit: z.number().optional().describe("Max number of lines to return (default: 2000)"),
}).refine((input) => !!(input.filePath ?? input.file_path), "filePath or file_path is required");

const writeSchema = z.object({
  filePath: z.string().optional().describe("Path to the file to write"),
  file_path: z.string().optional().describe("Servus-compatible alias for filePath"),
  content: z.string().describe("Complete file contents"),
  explicitUserRequest: z.boolean().optional().describe("Set true only when the user explicitly requested creating this file, especially docs/README files."),
}).refine((input) => !!(input.filePath ?? input.file_path), "filePath or file_path is required");

const editSchema = z.object({
  filePath: z.string().optional().describe("Path to the file to edit"),
  file_path: z.string().optional().describe("Servus-compatible alias for filePath"),
  oldString: z.string().optional().describe("Exact text to find (must be unique)"),
  old_string: z.string().optional().describe("Servus-compatible alias for oldString"),
  newString: z.string().optional().describe("Replacement text"),
  new_string: z.string().optional().describe("Servus-compatible alias for newString"),
  replaceAll: z.boolean().optional().describe("Replace all occurrences (default: false)"),
  replace_all: z.boolean().optional().describe("Servus-compatible alias for replaceAll"),
}).refine((input) => !!(input.filePath ?? input.file_path), "filePath or file_path is required")
  .refine((input) => input.oldString !== undefined || input.old_string !== undefined, "oldString or old_string is required")
  .refine((input) => input.newString !== undefined || input.new_string !== undefined, "newString or new_string is required");

const multiEditSchema = z.object({
  filePath: z.string().optional().describe("Path to the file to edit"),
  file_path: z.string().optional().describe("Servus-compatible alias for filePath"),
  edits: z.array(z.object({
    oldString: z.string().optional().describe("Exact text to find (must be unique unless replaceAll is true)"),
    old_string: z.string().optional().describe("Servus-compatible alias for oldString"),
    newString: z.string().optional().describe("Replacement text"),
    new_string: z.string().optional().describe("Servus-compatible alias for newString"),
    replaceAll: z.boolean().optional().describe("Replace all occurrences for this edit"),
    replace_all: z.boolean().optional().describe("Servus-compatible alias for replaceAll"),
  })).min(1).describe("Ordered exact replacements to apply atomically."),
}).refine((input) => !!(input.filePath ?? input.file_path), "filePath or file_path is required")
  .refine((input) => input.edits.every((edit) => edit.oldString !== undefined || edit.old_string !== undefined), "each edit requires oldString or old_string")
  .refine((input) => input.edits.every((edit) => edit.newString !== undefined || edit.new_string !== undefined), "each edit requires newString or new_string");

const globSchema = z.object({
  pattern: z.string().describe("Glob pattern to match files against"),
  path: z.string().optional().describe("Directory to search in (default: project root)"),
  limit: z.number().optional().describe("Maximum number of files to return (default: 100)"),
  offset: z.number().optional().describe("Number of matching files to skip before returning results (default: 0)"),
});

const grepSchema = z.object({
  pattern: z.string().describe("Regular expression pattern to search for"),
  path: z.string().optional().describe("Directory or file to search in (default: project root)"),
  include: z.string().optional().describe("Glob to filter files (e.g. '*.ts')"),
  glob: z.string().optional().describe("Alias for include; glob pattern to filter searched files."),
  output_mode: z.enum(["content", "files_with_matches", "count"]).optional().describe("Output mode. Defaults to files_with_matches."),
  before: z.number().optional().describe("Lines of context before each match for content mode."),
  after: z.number().optional().describe("Lines of context after each match for content mode."),
  context: z.number().optional().describe("Lines of context before and after each match for content mode."),
  line_numbers: z.boolean().optional().describe("Show line numbers in content mode (default: true)."),
  ignore_case: z.boolean().optional().describe("Case-insensitive search."),
  type: z.string().optional().describe("Ripgrep file type filter, e.g. ts, js, py, rust."),
  head_limit: z.number().optional().describe("Maximum output rows/entries to return (default: 100 for content, 250 otherwise; 0 means unlimited)."),
  offset: z.number().optional().describe("Number of rows/entries to skip before returning results."),
});

const lspSchema = z.object({
  operation: z.enum([
    "goToDefinition",
    "findReferences",
    "hover",
    "documentSymbol",
    "workspaceSymbol",
    "goToImplementation",
    "prepareCallHierarchy",
    "incomingCalls",
    "outgoingCalls",
  ]).describe("Servus code intelligence operation."),
  filePath: z.string().describe("Absolute or relative file path used as the symbol context."),
  line: z.number().int().positive().describe("1-based line number."),
  character: z.number().int().positive().describe("1-based character offset."),
});

const lsSchema = z.object({
  path: z.string().optional().describe("Directory to list (default: project root)"),
  limit: z.number().optional().describe("Maximum entries to return (default: 200, 0 means unlimited)"),
  offset: z.number().optional().describe("Number of entries to skip before returning results (default: 0)"),
});

const workspaceMapSchema = z.object({
  path: z.string().optional().describe("Directory to map (default: project root)."),
  max_depth: z.number().int().min(0).max(5).optional().describe("Maximum directory depth from the selected path (default: 2)."),
  maxDepth: z.number().int().min(0).max(5).optional().describe("Alias for max_depth."),
  limit: z.number().int().positive().max(500).optional().describe("Maximum entries to return (default: 120)."),
});

const projectOverviewSchema = z.object({
  path: z.string().optional().describe("Project directory to summarize (default: project root)."),
  max_depth: z.number().int().min(0).max(4).optional().describe("Workspace map depth (default: 2)."),
  maxDepth: z.number().int().min(0).max(4).optional().describe("Alias for max_depth."),
  excerpt_chars: z.number().int().positive().max(6000).optional().describe("Maximum characters to read from each doc/manifest excerpt (default: 1800)."),
  excerptChars: z.number().int().positive().max(6000).optional().describe("Alias for excerpt_chars."),
});

const workspaceStatusSchema = z.object({
  includeIgnored: z.boolean().optional().describe("Include ignored files in the git status output (default: false)"),
});

const gitDiffSchema = z.object({
  filePath: z.string().optional().describe("Optional file path to show a diff for. Defaults to all changed tracked files."),
  staged: z.boolean().optional().describe("Show staged diff instead of unstaged diff (default: false)"),
  stat: z.boolean().optional().describe("Show diff stat instead of full diff (default: false)"),
  limit: z.number().optional().describe("Maximum characters to return (default: 30000)"),
});

const webfetchSchema = z.object({
  url: z.string().describe("The URL to fetch"),
  timeout: z.number().optional().describe("Timeout in ms (default: 30000)"),
});

const patchSchema = z.object({
  patchText: z.string().describe("The unified diff patch to apply"),
});

const todoSchema = z.object({
  todos: z.array(z.object({
    id: z.string().describe("Unique identifier for the TODO"),
    content: z.string().describe("Description of the task"),
    status: z.enum(["pending", "in_progress", "completed", "cancelled"]).describe("Current status"),
  })),
});

// ─── Tool Factory ───────────────────────────────────────────────────────────

export function createTools(cwd: string, options: { sessionId?: string; agentName?: string } = {}) {
  const policy = createCodingWorkspacePolicy(cwd);
  const readSessionId = [options.sessionId ?? `cwd:${cwd}`, options.agentName].filter(Boolean).join(":");
  const reads = getReadSet(readSessionId, cwd);
  const tools = {
    bash: tool({
      description: [
        "Execute a shell command in bash.",
        "Use for: git, npm/pnpm/yarn, make, cargo, go, python, docker, curl, build scripts, test runners, etc.",
        "Guidelines: prefer single commands, set timeout for long-running processes, never use interactive commands.",
        "For long-running commands set run_in_background=true, then use BashOutput to poll and KillBash to stop.",
      ].join("\n"),
      inputSchema: bashSchema,
      execute: async (input: z.infer<typeof bashSchema>) => {
        const cmd = input.command;
        const description = input.description?.trim() || "Run shell command";
        const wouldRemovePlan =
          /\b(rm|unlink|delete)\b/i.test(cmd) &&
          /servus-plan\.json|init\.sh/.test(cmd);
        if (wouldRemovePlan) {
          return `Error: Refusing to remove servus-plan.json or init.sh without explicit user cleanup approval. These files are no longer required by the runtime, but may be user-owned. Ask before deleting them.`;
        }
        const destructiveReason = destructiveShellReason(cmd);
        if (destructiveReason) {
          return `Error: Refusing high-risk shell command (${destructiveReason}). Ask the user for explicit approval and prefer a reversible, scoped command.`;
        }
        const makeProblem = makeTargetProblem(cmd, cwd);
        if (makeProblem?.kind === "missing") {
          return `Error: ${makeProblem.message}`;
        }
        const consentReason = shellConsentReason(cmd) ?? makeProblem?.message;
        if (consentReason) {
          const approved = await bus.requestApproval({
            action: "Run shell command",
            detail: `${description}\n\n${cmd}\n\nReason: ${consentReason}`,
            risk: shellConsentRisk(cmd),
            engine: "Coding",
          });
          if (!approved) {
            return `Error: shell command requires explicit user approval (${consentReason}). Use safer read-only tools or ask the user.`;
          }
        }
        const hasPackageJson = existsSync(resolveP("package.json", cwd));
        const looksLikeInit =
          /\bnpm\s+init\b/i.test(cmd) ||
          /\byarn\s+init\b/i.test(cmd) ||
          /\bbun\s+init\b/i.test(cmd);
        const looksLikeScaffoldInCwd =
          /\bnpx\s+create-react-app\b/.test(cmd) ||
          /\bcreate-next-app\b/.test(cmd) ||
          /\bnpm\s+create\b.+vite/i.test(cmd);
        if (hasPackageJson && (looksLikeInit || looksLikeScaffoldInCwd)) {
          return [
            "Error: This directory already contains a project (package.json found).",
            "Do not run `npm init` or scaffold a new app here.",
            "Instead, modify the existing code and, if needed, use `npm install <pkg>` to add dependencies.",
          ].join(" ");
        }
        const timeoutMs = input.timeout ?? 120_000;
        const background = input.run_in_background ?? input.runInBackground ?? false;
        const task = startShellTask({
          command: input.command,
          description,
          cwd,
          sessionId: options.sessionId,
          timeoutMs,
        });
        if (background) {
          return [
            `Bash task running in background: ${task.id}`,
            `Output: ${task.outputPath}`,
            `Use BashOutput with task_id="${task.id}" to inspect progress.`,
            `Use KillBash with task_id="${task.id}" to stop it.`,
          ].join("\n");
        }
        return new Promise<string>((resolve) => {
          let settled = false;
          const maybeAutoBackground = timeoutMs > ASSISTANT_BLOCKING_BUDGET_MS + 5000
            ? setTimeout(() => {
              if (settled) return;
              settled = true;
              resolve([
                `Bash task exceeded the foreground blocking budget and is still running: ${task.id}`,
                `Output: ${task.outputPath}`,
                `Use BashOutput with task_id="${task.id}" to inspect progress.`,
                `Use KillBash with task_id="${task.id}" to stop it.`,
              ].join("\n"));
            }, ASSISTANT_BLOCKING_BUDGET_MS)
            : undefined;
          task.child.on("close", () => {
            if (maybeAutoBackground) clearTimeout(maybeAutoBackground);
            if (settled) return;
            settled = true;
            resolve(formatShellTaskOutput(task.status));
          });
        });
      },
    }),

    BashOutput: tool({
      description: [
        "Read output from a background Bash task started with Bash(run_in_background=true).",
        "Use this to poll long-running builds, tests, dev servers, watchers, and verification commands without restarting them.",
      ].join("\n"),
      inputSchema: bashOutputSchema,
      execute: async (input: z.infer<typeof bashOutputSchema>) => {
        const taskId = input.task_id ?? input.taskId ?? "";
        const status = readShellTaskStatus(cwd, options.sessionId, taskId);
        if (!status) return `Error: Bash task not found in this Servus session: ${taskId}`;
        return formatShellTaskOutput(status, input.limit ?? 20_000);
      },
    }),

    KillBash: tool({
      description: "Stop a running background Bash task started by Servus.",
      inputSchema: killBashSchema,
      execute: async (input: z.infer<typeof killBashSchema>) => {
        const taskId = input.task_id ?? input.taskId ?? "";
        const task = shellTasks.get(taskId);
        if (!task) {
          const status = readShellTaskStatus(cwd, options.sessionId, taskId);
          return status
            ? `Bash task ${taskId} is not running (status: ${status.status}).`
            : `Error: Bash task not found in this Servus session: ${taskId}`;
        }
        task.status.status = "killed";
        task.status.killed = true;
        task.status.completedAt = Date.now();
        appendFileSync(task.outputPath, "\n[servus] command killed by request\n");
        writeShellTaskStatus(task.statusPath, task.status);
        killShellTask(task, "SIGTERM");
        return `Bash task ${taskId} was stopped. Output: ${task.outputPath}`;
      },
    }),

    read: tool({
      description: [
        "Read a file with optional line-range. If path is a directory, lists entries.",
        "Lines are 1-indexed. Use offset+limit for large files. Binary files are detected and skipped.",
      ].join("\n"),
      inputSchema: readSchema,
      execute: async (input: z.infer<typeof readSchema>) => {
        const filePath = getFilePathInput(input);
        const abs = resolveP(filePath, cwd);
        if (isBlockedDevicePath(abs)) return `Error: blocked device path — ${filePath}`;
        const excluded = isWorkspaceExcludedPath(cwd, abs);
        if (excluded.excluded && !isExplicitInternalRequest(cwd, filePath)) {
          return `Error: ${filePath} is Servus/internal or generated workspace state and is hidden from coding context. Ask the user before inspecting it explicitly.`;
        }
        if (!existsSync(abs)) {
          const suggestion = pathSuggestion(cwd, filePath);
          return suggestion
            ? `Error: file not found — ${abs}\nDid you mean: ${suggestion}?`
            : `Error: file not found — ${abs}`;
        }
        const st = statSync(abs);
        if (st.isDirectory()) {
          const allowInternal = isExplicitInternalRequest(cwd, filePath);
          const entries = readdirSync(abs, { withFileTypes: true })
            .filter((e) => allowInternal || !isWorkspaceExcludedPath(cwd, resolve(abs, e.name)).excluded);
          return [
            `Directory: ${toWorkspaceRelative(cwd, abs)}`,
            `Ignored paths applied: ${allowInternal ? "no (explicit path)" : "yes"}`,
            "",
            entries.map((e) => e.isDirectory() ? `${e.name}/` : e.name).join("\n"),
          ].join("\n");
        }
        if (st.size > MAX_READ_FILE_SIZE) {
          return `Error: file too large to read safely (${(st.size / 1024 / 1024).toFixed(1)} MB). Use grep or a narrower file.`;
        }
        if (isBinary(abs)) return `Error: binary file — cannot display ${abs}`;
        const offset = input.offset ?? 1;
        const limit = input.limit ?? 2000;
        const lines: string[] = [];
        let lineNum = 0;
        const fileContent = readFileSync(abs, "utf-8");
        const rl = createInterface({ input: createReadStream(abs, { encoding: "utf-8" }), crlfDelay: Infinity });
        for await (const line of rl) {
          lineNum++;
          if (lineNum < offset) continue;
          if (lines.length >= limit) break;
          const display = line.length > 2000 ? line.slice(0, 2000) + "…(truncated)" : line;
          lines.push(`${String(lineNum).padStart(6)}|${display}`);
        }
        rememberRead(reads, abs, fileContent, st, {
          offset,
          limit,
          partial: offset > 1 || lines.length < fileContent.split(/\r?\n/).length,
        });
        persistReadSet(readSessionId, cwd, reads);
        return [
          `File: ${toWorkspaceRelative(cwd, abs)}  (lines ${offset}-${offset + lines.length - 1} of ${lineNum}+)`,
          `Read session: ${readSessionId}`,
          "",
          lines.join("\n"),
        ].join("\n");
      },
    }),

    write: tool({
      description: "Create or overwrite a file. Parent directories are created automatically. Prefer edit for existing files.",
      inputSchema: writeSchema,
      execute: async (input: z.infer<typeof writeSchema>) => {
        const filePath = getFilePathInput(input);
        const abs = resolveP(filePath, cwd);
        const scoped = scopedRelativePath(filePath, cwd);
        if (!scoped.ok) return scoped.error;
        const excluded = isWorkspaceExcludedPath(cwd, abs);
        if (excluded.excluded && !isExplicitInternalRequest(cwd, filePath)) {
          return `Error: refusing to write Servus/internal or generated workspace path without explicit user scope — ${filePath}`;
        }
        const existed = existsSync(abs);
        if (existed) {
          const stateCheck = validateReadState(reads, abs, cwd);
          if (!stateCheck.ok) {
            return stateCheck.error.replace("read-before-edit", "read-before-write");
          }
          if (stateCheck.partial) {
            return `Error: full-file read required before overwriting existing file ${toWorkspaceRelative(cwd, abs)}. Use read with enough limit to include the whole file, then retry.`;
          }
          if (isBinary(abs)) return `Error: binary file — refusing to overwrite ${toWorkspaceRelative(cwd, abs)}`;
          if (statSync(abs).size > MAX_READ_FILE_SIZE) {
            return `Error: file too large to overwrite safely (${(statSync(abs).size / 1024 / 1024).toFixed(1)} MB).`;
          }
          if (!reads.has(abs)) {
            return `Error: read-before-write required for existing file ${toWorkspaceRelative(cwd, abs)}. Use read first so edits preserve user-owned content.`;
          }
          const previous = readFileSync(abs, "utf-8");
          if (previous === input.content) {
            return `No-op: ${relative(cwd, abs)} already has the requested contents.`;
          }
        } else if (isDocumentationPath(abs) && !input.explicitUserRequest) {
          return `Error: refusing to create documentation file ${toWorkspaceRelative(cwd, abs)} without an explicit user request. Prefer editing existing project files.`;
        }
        recordPreMutationSnapshot(cwd, options.sessionId, abs, existed ? "write_existing" : "write_new");
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, input.content, "utf-8");
        rememberRead(reads, abs, input.content, statSync(abs), { partial: false });
        persistReadSet(readSessionId, cwd, reads);
        const lines = input.content.split("\n").length;
        return existed
          ? `Updated ${relative(cwd, abs)} (${lines} lines)`
          : `Created ${relative(cwd, abs)} (${lines} lines)`;
      },
    }),

    edit: tool({
      description: [
        "Precise string replacement in an existing file.",
        "oldString must appear exactly once unless replaceAll is true.",
        "Include enough context in oldString to make it unique. Preserve indentation.",
      ].join("\n"),
      inputSchema: editSchema,
      execute: async (input: z.infer<typeof editSchema>) => {
        const filePath = getFilePathInput(input);
        const oldInput = getOldStringInput(input);
        const newInput = getNewStringInput(input);
        const abs = resolveP(filePath, cwd);
        const scoped = scopedRelativePath(filePath, cwd);
        if (!scoped.ok) return scoped.error;
        const excluded = isWorkspaceExcludedPath(cwd, abs);
        if (excluded.excluded && !isExplicitInternalRequest(cwd, filePath)) {
          return `Error: refusing to edit Servus/internal or generated workspace path without explicit user scope — ${filePath}`;
        }
        if (!existsSync(abs)) {
          const suggestion = pathSuggestion(cwd, filePath);
          return suggestion
            ? `Error: file not found — ${abs}\nDid you mean: ${suggestion}?`
            : `Error: file not found — ${abs}`;
        }
        const stateCheck = validateReadState(reads, abs, cwd);
        if (!stateCheck.ok) return stateCheck.error;
        if (isBinary(abs)) return `Error: binary file — cannot edit ${toWorkspaceRelative(cwd, abs)}`;
        if (statSync(abs).size > MAX_READ_FILE_SIZE) {
          return `Error: file too large to edit safely (${(statSync(abs).size / 1024 / 1024).toFixed(1)} MB).`;
        }
        if (!oldInput) return "Error: oldString cannot be empty.";
        const original = readFileSync(abs, "utf-8");
        const count = original.split(oldInput).length - 1;
        let oldString = oldInput;
        let newString = newInput;
        let matchCount = count;
        let matchedBy = "exact";

        if (matchCount === 0) {
          const lineEndingMatch = findLineEndingVariant(original, oldInput, newInput);
          if (!lineEndingMatch) {
            return [
              `Error: oldString not found in ${relative(cwd, abs)}.`,
              "Read the target lines again and retry with exact, unique context.",
              editMissHint(original, oldInput),
            ].filter(Boolean).join("\n");
          }
          oldString = lineEndingMatch.oldString;
          newString = lineEndingMatch.newString;
          matchCount = lineEndingMatch.count;
          matchedBy = lineEndingMatch.label;
        }

        const replaceAll = input.replaceAll ?? input.replace_all ?? false;
        if (matchCount > 1 && !replaceAll) {
          return [
            `Error: oldString appears ${matchCount} times in ${relative(cwd, abs)}.`,
            "Include more surrounding context or set replaceAll when replacing every occurrence is intended.",
            `Approximate occurrence lines: ${occurrenceLines(original, oldString).slice(0, 12).join(", ")}`,
          ].join("\n");
        }

        const updated = replaceAll
          ? original.split(oldString).join(newString)
          : original.replace(oldString, newString);
        if (updated === original) return `No-op: replacement did not change ${relative(cwd, abs)}.`;
        recordPreMutationSnapshot(cwd, options.sessionId, abs, "edit");
        writeFileSync(abs, updated, "utf-8");
        rememberRead(reads, abs, updated, statSync(abs), { partial: false });
        persistReadSet(readSessionId, cwd, reads);
        const delta = newString.split("\n").length - oldString.split("\n").length;
        return `Edited ${relative(cwd, abs)}: replaced ${replaceAll ? `all ${matchCount}` : "1"} occurrence(s), match=${matchedBy} (${delta >= 0 ? "+" : ""}${delta} lines)`;
      },
    }),

    MultiEdit: tool({
      description: [
        "Apply multiple exact string replacements to one existing file atomically.",
        "The file must be read first. Each oldString must match in sequence and be unique unless replaceAll is true.",
        "If any edit is unsafe, no changes are written.",
      ].join("\n"),
      inputSchema: multiEditSchema,
      execute: async (input: z.infer<typeof multiEditSchema>) => {
        const filePath = getFilePathInput(input);
        const abs = resolveP(filePath, cwd);
        const scoped = scopedRelativePath(filePath, cwd);
        if (!scoped.ok) return scoped.error;
        const excluded = isWorkspaceExcludedPath(cwd, abs);
        if (excluded.excluded && !isExplicitInternalRequest(cwd, filePath)) {
          return `Error: refusing to edit Servus/internal or generated workspace path without explicit user scope — ${filePath}`;
        }
        if (!existsSync(abs)) {
          const suggestion = pathSuggestion(cwd, filePath);
          return suggestion
            ? `Error: file not found — ${abs}\nDid you mean: ${suggestion}?`
            : `Error: file not found — ${abs}`;
        }
        const stateCheck = validateReadState(reads, abs, cwd);
        if (!stateCheck.ok) return stateCheck.error;
        const st = statSync(abs);
        if (st.size > MAX_READ_FILE_SIZE) {
          return `Error: file too large to edit safely (${(st.size / 1024 / 1024).toFixed(1)} MB).`;
        }
        if (isBinary(abs)) return `Error: binary file — cannot edit ${toWorkspaceRelative(cwd, abs)}`;

        const original = readFileSync(abs, "utf-8");
        let working = original;
        const applied: string[] = [];
        for (const [index, edit] of input.edits.entries()) {
          const oldInput = getOldStringInput(edit);
          const newInput = getNewStringInput(edit);
          if (!oldInput) return `Error: edit ${index + 1} oldString cannot be empty. No changes written.`;
          let oldString = oldInput;
          let newString = newInput;
          let matchCount = working.split(oldString).length - 1;
          let matchedBy = "exact";
          if (matchCount === 0) {
            const lineEndingMatch = findLineEndingVariant(working, oldInput, newInput);
            if (!lineEndingMatch) {
              return [
                `Error: edit ${index + 1} oldString not found in ${relative(cwd, abs)}. No changes written.`,
                editMissHint(working, oldInput),
              ].filter(Boolean).join("\n");
            }
            oldString = lineEndingMatch.oldString;
            newString = lineEndingMatch.newString;
            matchCount = lineEndingMatch.count;
            matchedBy = lineEndingMatch.label;
          }
          const replaceAll = edit.replaceAll ?? edit.replace_all ?? false;
          if (matchCount > 1 && !replaceAll) {
            return [
              `Error: edit ${index + 1} oldString appears ${matchCount} times in ${relative(cwd, abs)}. No changes written.`,
              "Include more surrounding context or set replaceAll when replacing every occurrence is intended.",
              `Approximate occurrence lines: ${occurrenceLines(working, oldString).slice(0, 12).join(", ")}`,
            ].join("\n");
          }
          working = replaceAll
            ? working.split(oldString).join(newString)
            : working.replace(oldString, newString);
          applied.push(`#${index + 1}: ${replaceAll ? `all ${matchCount}` : "1"} occurrence(s), match=${matchedBy}`);
        }
        if (working === original) return `No-op: MultiEdit did not change ${relative(cwd, abs)}.`;
        recordPreMutationSnapshot(cwd, options.sessionId, abs, "multiedit");
        writeFileSync(abs, working, "utf-8");
        rememberRead(reads, abs, working, statSync(abs), { partial: false });
        persistReadSet(readSessionId, cwd, reads);
        return [
          `MultiEdit applied to ${relative(cwd, abs)} (${input.edits.length} edit${input.edits.length === 1 ? "" : "s"}).`,
          ...applied,
        ].join("\n");
      },
    }),

    glob: tool({
      description: "Find files matching a glob pattern (e.g. '**/*.ts'). Results sorted by modification time.",
      inputSchema: globSchema,
      execute: async (input: z.infer<typeof globSchema>) => {
        const searchDir = input.path ? resolveP(input.path, cwd) : cwd;
        const allowInternal = isExplicitInternalRequest(cwd, input.path, input.pattern);
        const limit = input.limit === 0 ? Number.POSITIVE_INFINITY : Math.max(1, input.limit ?? 100);
        const offset = Math.max(0, input.offset ?? 0);
        try {
          const { stdout } = await execFileAsync(
            "rg",
            ["--files", "--hidden", "--glob", input.pattern, ...rgExcludeArgs(policy, { allowInternal }), "--sort", "modified"],
            { cwd: searchDir, timeout: 15_000, maxBuffer: 5 * 1024 * 1024 },
          );
          const allFiles = filterWorkspacePaths(cwd, stdout.trim().split("\n").filter(Boolean), { allowInternal });
          const page = allFiles.slice(offset, Number.isFinite(limit) ? offset + limit : undefined);
          const truncated = Number.isFinite(limit) && allFiles.length > offset + limit;
          return filesResult(page, {
            total: allFiles.length,
            offset,
            limit,
            truncated,
            ignored: !allowInternal,
            empty: `No files matching '${input.pattern}'`,
          });
        } catch {
          return globFallback(searchDir, input.pattern, cwd, allowInternal, limit, offset);
        }
      },
    }),

    grep: tool({
      description: "Search file contents for a regex pattern using ripgrep. Returns matching lines with paths and line numbers.",
      inputSchema: grepSchema,
      execute: async (input: z.infer<typeof grepSchema>) => {
        const searchPath = input.path ? resolveP(input.path, cwd) : cwd;
        const include = input.glob ?? input.include;
        const allowInternal = isExplicitInternalRequest(cwd, input.path, include);
        const outputMode = input.output_mode ?? "files_with_matches";
        const headLimit = input.head_limit === 0 ? Number.POSITIVE_INFINITY : Math.max(1, input.head_limit ?? (outputMode === "content" ? 100 : 250));
        const offset = Math.max(0, input.offset ?? 0);
        try {
          const args = ["--no-heading", "--color", "never", "--hidden", ...rgExcludeArgs(policy, { allowInternal })];
          if (include) args.push("--glob", include);
          if (input.type) args.push("--type", input.type);
          if (input.ignore_case) args.push("-i");
          if (outputMode === "files_with_matches") args.push("--files-with-matches");
          if (outputMode === "count") args.push("--count-matches");
          if (outputMode === "content") {
            if (input.line_numbers !== false) args.push("-nH");
            const context = input.context;
            if (context !== undefined) args.push("-C", String(context));
            else {
              if (input.before !== undefined) args.push("-B", String(input.before));
              if (input.after !== undefined) args.push("-A", String(input.after));
            }
          }
          args.push("--", input.pattern, searchPath);
          const { stdout } = await execFileAsync(
            "rg",
            args,
            { cwd, timeout: 15_000, maxBuffer: 5 * 1024 * 1024 },
          );
          const lines = filterGrepOutput(cwd, stdout.trim().split("\n").filter(Boolean), outputMode, allowInternal);
          const page = lines.slice(offset, Number.isFinite(headLimit) ? offset + headLimit : undefined);
          const truncated = Number.isFinite(headLimit) && lines.length > offset + headLimit;
          return grepResult(page, {
            pattern: input.pattern,
            mode: outputMode,
            total: lines.length,
            offset,
            limit: headLimit,
            truncated,
            ignored: !allowInternal,
          });
        } catch {
          return `No matches for '${input.pattern}' in ${searchPath}`;
        }
      },
    }),

    LSP: tool({
      description: [
        "Servus code intelligence tool.",
        "Uses a real configured/detected LSP server when available, then falls back to local source text and ripgrep.",
        "Supports definitions, references, document/workspace symbols, hover, implementation, and call hierarchy hints.",
      ].join("\n"),
      inputSchema: lspSchema,
      execute: async (input: z.infer<typeof lspSchema>) => {
        const scoped = scopedRelativePath(input.filePath, cwd);
        if (!scoped.ok) return scoped.error;
        const abs = resolveP(input.filePath, cwd);
        const excluded = isWorkspaceExcludedPath(cwd, abs);
        if (excluded.excluded && !isExplicitInternalRequest(cwd, input.filePath)) {
          return `Error: refusing LSP inspection of Servus/internal or generated path — ${input.filePath}`;
        }
        if (!existsSync(abs)) {
          const suggestion = pathSuggestion(cwd, input.filePath);
          return suggestion
            ? `Error: file not found — ${abs}\nDid you mean: ${suggestion}?`
            : `Error: file not found — ${abs}`;
        }
        if (statSync(abs).size > MAX_READ_FILE_SIZE) {
          return `Error: file too large for lightweight LSP (${(statSync(abs).size / 1024 / 1024).toFixed(1)} MB).`;
        }
        if (isBinary(abs)) return `Error: binary file — cannot inspect ${input.filePath}`;

        const realLsp = await tryRealLsp(cwd, input);
        if (realLsp) return realLsp;

        const text = readFileSync(abs, "utf-8");
        const lines = text.split(/\r?\n/);
        const targetLine = lines[input.line - 1] ?? "";
        const symbol = wordAt(targetLine, input.character - 1);
        if ((input.operation !== "documentSymbol") && !symbol) {
          return [
            `No symbol found at ${toWorkspaceRelative(cwd, abs)}:${input.line}:${input.character}.`,
            `Line: ${targetLine}`,
          ].join("\n");
        }

        if (input.operation === "documentSymbol") {
          return formatSymbolResult(
            "Document symbols",
            toWorkspaceRelative(cwd, abs),
            extractDocumentSymbols(text).slice(0, 120),
          );
        }

        if (input.operation === "hover") {
          return [
            `Hover context for "${symbol}"`,
            `File: ${toWorkspaceRelative(cwd, abs)}:${input.line}:${input.character}`,
            "",
            localContext(lines, input.line),
          ].join("\n");
        }

        if (input.operation === "findReferences" || input.operation === "incomingCalls") {
          return await ripgrepSymbol(cwd, symbol, {
            title: input.operation === "incomingCalls" ? `Possible incoming references for "${symbol}"` : `References for "${symbol}"`,
          });
        }

        if (input.operation === "goToDefinition" || input.operation === "goToImplementation" || input.operation === "workspaceSymbol") {
          const definition = await ripgrepDefinitions(cwd, symbol);
          if (definition.trim()) {
            return [
              `${input.operation} results for "${symbol}"`,
              "",
              definition,
            ].join("\n");
          }
          return await ripgrepSymbol(cwd, symbol, { title: `Workspace matches for "${symbol}"` });
        }

        if (input.operation === "prepareCallHierarchy" || input.operation === "outgoingCalls") {
          const block = nearbyFunctionBlock(lines, input.line);
          return [
            `${input.operation} for "${symbol}"`,
            `File: ${toWorkspaceRelative(cwd, abs)}:${input.line}:${input.character}`,
            "",
            block || localContext(lines, input.line),
          ].join("\n");
        }

        return `Unsupported LSP operation: ${input.operation}`;
      },
    }),

    lsp_status: tool({
      description: "Show configured or auto-detected LSP servers available to Servus coding mode.",
      inputSchema: z.object({}),
      execute: async () => summarizeLspAvailability(cwd),
    }),

    workspace_map: tool({
      description: [
        "Return a bounded tree-style map of the workspace.",
        "Use this for project summaries, architecture orientation, and choosing focused search paths.",
        "Servus/internal, dependency, generated, and cache folders stay hidden unless the path explicitly targets them.",
      ].join("\n"),
      inputSchema: workspaceMapSchema,
      execute: async (input: z.infer<typeof workspaceMapSchema>) => {
        const root = input.path ? resolveP(input.path, cwd) : cwd;
        if (!existsSync(root)) {
          const suggestion = input.path ? pathSuggestion(cwd, input.path) : undefined;
          return suggestion
            ? `Error: workspace map path not found — ${root}\nDid you mean: ${suggestion}?`
            : `Error: workspace map path not found — ${root}`;
        }
        if (!statSync(root).isDirectory()) return `Error: workspace map path is not a directory — ${root}`;
        const allowInternal = isExplicitInternalRequest(cwd, input.path);
        const maxDepth = input.max_depth ?? input.maxDepth ?? 2;
        const limit = input.limit ?? 120;
        const map = buildWorkspaceMapForTool(cwd, root, { allowInternal, maxDepth, limit });
        return [
          `Workspace map: ${toWorkspaceRelative(cwd, root)}`,
          `Ignored paths applied: ${allowInternal ? "no (explicit path)" : "yes"}`,
          `Entries: ${map.entries}/${map.totalSeen} (maxDepth=${maxDepth}, limit=${limit}, truncated=${map.truncated ? "yes" : "no"})`,
          "",
          map.lines.join("\n") || "(empty)",
          map.truncated ? "\nUse a narrower path or higher limit to inspect more." : "",
        ].filter(Boolean).join("\n");
      },
    }),

    project_overview: tool({
      description: [
        "Build a policy-safe project overview from docs, manifests, source layout, configs, and likely entrypoints.",
        "Use this first for project summary, architecture explanation, onboarding, or repo-understanding tasks.",
        "This is read-only and hides Servus/internal, dependency, generated, and cache folders by default.",
      ].join("\n"),
      inputSchema: projectOverviewSchema,
      execute: async (input: z.infer<typeof projectOverviewSchema>) => {
        const root = input.path ? resolveP(input.path, cwd) : cwd;
        if (!existsSync(root)) {
          const suggestion = input.path ? pathSuggestion(cwd, input.path) : undefined;
          return suggestion
            ? `Error: project overview path not found — ${root}\nDid you mean: ${suggestion}?`
            : `Error: project overview path not found — ${root}`;
        }
        if (!statSync(root).isDirectory()) return `Error: project overview path is not a directory — ${root}`;
        const allowInternal = isExplicitInternalRequest(cwd, input.path);
        return buildProjectOverviewForTool(cwd, root, {
          allowInternal,
          maxDepth: input.max_depth ?? input.maxDepth ?? 2,
          excerptChars: input.excerpt_chars ?? input.excerptChars ?? 1800,
        });
      },
    }),

    ls: tool({
      description: "List the contents of a directory with file sizes.",
      inputSchema: lsSchema,
      execute: async (input: z.infer<typeof lsSchema>) => {
        const abs = input.path ? resolveP(input.path, cwd) : cwd;
        if (!existsSync(abs)) return `Error: not found — ${abs}`;
        if (!statSync(abs).isDirectory()) return `Error: not a directory — ${abs}`;
        const allowInternal = isExplicitInternalRequest(cwd, input.path);
        const entries = readdirSync(abs, { withFileTypes: true })
          .filter((e) => allowInternal || !isWorkspaceExcludedPath(cwd, resolve(abs, e.name)).excluded)
          .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
        const offset = Math.max(0, input.offset ?? 0);
        const limit = input.limit === 0 ? Number.POSITIVE_INFINITY : Math.max(1, input.limit ?? 200);
        const page = entries.slice(offset, Number.isFinite(limit) ? offset + limit : undefined);
        const truncated = Number.isFinite(limit) && entries.length > offset + limit;
        const lines = page.map((e) => {
          if (e.isDirectory()) return `  ${e.name}/`;
          try { return `  ${e.name}  (${(statSync(resolve(abs, e.name)).size / 1024).toFixed(1)} KB)`; }
          catch { return `  ${e.name}`; }
        });
        return [
          `Directory: ${relative(cwd, abs) || "."}`,
          `Ignored paths applied: ${allowInternal ? "no (explicit path)" : "yes"}`,
          `Entries: ${page.length}/${entries.length} (offset=${offset}, limit=${Number.isFinite(limit) ? limit : "all"}, truncated=${truncated ? "yes" : "no"})`,
          "",
          lines.join("\n"),
          "",
          truncated ? `Use LS with offset=${offset + page.length} to continue.` : `${entries.length} entries total`,
        ].join("\n");
      },
    }),

    workspace_status: tool({
      description: [
        "Read-only repository status summary.",
        "Use before and after coding changes to understand branch, dirty files, and user-owned changes.",
        "Prefer this over shelling out to git status.",
      ].join("\n"),
      inputSchema: workspaceStatusSchema,
      execute: async (input: z.infer<typeof workspaceStatusSchema>) => {
        const repoCheck = await gitCommand(cwd, ["rev-parse", "--is-inside-work-tree"]);
        if (!repoCheck.ok || repoCheck.stdout.trim() !== "true") {
          return [
            "Workspace status:",
            "Git: not a repository",
            "Changed tracked files: 0",
            "Untracked files: unknown (git unavailable)",
            input.includeIgnored ? "Ignored files: unknown (git unavailable)" : "Servus/generated paths hidden: yes",
            "",
            "This directory can still be used as a coding workspace. Use LS/Glob/Read to inspect files.",
          ].join("\n");
        }
        const branch = await gitCommand(cwd, ["branch", "--show-current"]);
        const statusArgs = ["status", "--short"];
        if (input.includeIgnored) statusArgs.push("--ignored");
        const status = await gitCommand(cwd, statusArgs);
        if (!status.ok) return `Error: ${status.stderr || status.stdout || "git status failed"}`;
        const filteredStatus = input.includeIgnored ? status.stdout : stripExcludedGitStatus(cwd, status.stdout);
        const lines = filteredStatus.split(/\r?\n/).filter(Boolean);
        const tracked = lines.filter((line) => !line.startsWith("??") && !line.startsWith("!!"));
        const untracked = lines.filter((line) => line.startsWith("??"));
        const ignored = lines.filter((line) => line.startsWith("!!"));
        return [
          "Workspace status:",
          `Branch: ${branch.ok ? branch.stdout.trim() || "(detached)" : "unknown"}`,
          `Changed tracked files: ${tracked.length}`,
          `Untracked files: ${untracked.length}`,
          input.includeIgnored ? `Ignored files: ${ignored.length}` : undefined,
          input.includeIgnored ? undefined : "Servus/generated paths hidden: yes",
          "",
          lines.length
            ? lines.slice(0, 200).join("\n")
            : "Working tree clean.",
          lines.length > 200 ? `\n... ${lines.length - 200} more entries omitted` : undefined,
        ].filter(Boolean).join("\n");
      },
    }),

    git_diff: tool({
      description: [
        "Read-only git diff for the current workspace.",
        "Use after edits to inspect exactly what changed before finalizing.",
        "For summaries set stat=true. For a single file pass filePath.",
      ].join("\n"),
      inputSchema: gitDiffSchema,
      execute: async (input: z.infer<typeof gitDiffSchema>) => {
        const repoCheck = await gitCommand(cwd, ["rev-parse", "--is-inside-work-tree"]);
        if (!repoCheck.ok || repoCheck.stdout.trim() !== "true") {
          return "No git diff available because this workspace is not a git repository.";
        }
        const args = ["diff"];
        if (input.staged) args.push("--cached");
        if (input.stat) args.push("--stat");
        args.push("--");
        if (input.filePath?.trim()) {
          const scoped = scopedRelativePath(input.filePath, cwd);
          if (!scoped.ok) return scoped.error;
          const excluded = isWorkspaceExcludedPath(cwd, scoped.path);
          if (excluded.excluded && !isExplicitInternalRequest(cwd, input.filePath)) {
            return `No diff shown for Servus/internal or generated path ${input.filePath}. Ask explicitly if you need to inspect it.`;
          }
          args.push(scoped.path);
        } else {
          args.push(...policy.defaultExcludeGlobs.map((pattern) => `:(exclude)${pattern}`));
        }
        const result = await gitCommand(cwd, args);
        if (!result.ok) return `Error: ${result.stderr || result.stdout || "git diff failed"}`;
        const output = result.stdout.trim();
        if (!output) {
          return input.filePath
            ? `No ${input.staged ? "staged " : ""}diff for ${input.filePath}.`
            : `No ${input.staged ? "staged " : ""}tracked-file diff.`;
        }
        return clamp(output, input.limit ?? 30_000);
      },
    }),

    webfetch: tool({
      description: "Fetch URL content as text. HTML is stripped to readable text. Max 100 KB response.",
      inputSchema: webfetchSchema,
      execute: async (input: z.infer<typeof webfetchSchema>) => {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), input.timeout ?? 30_000);
          const resp = await fetch(input.url, {
            signal: controller.signal,
            headers: { "User-Agent": "Mozilla/5.0 (compatible; Servus/2.0)", Accept: "text/html,text/plain,*/*" },
          });
          clearTimeout(timer);
          if (!resp.ok) return `Error: HTTP ${resp.status} ${resp.statusText}`;
          const text = await resp.text();
          const ct = resp.headers.get("content-type") ?? "";
          if (ct.includes("html")) {
            const cleaned = text
              .replace(/<script[\s\S]*?<\/script>/gi, "")
              .replace(/<style[\s\S]*?<\/style>/gi, "")
              .replace(/<[^>]+>/g, " ")
              .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
              .replace(/\s+/g, " ").trim();
            return clamp(cleaned, 100_000);
          }
          return clamp(text, 100_000);
        } catch (err: unknown) {
          return `Error fetching ${input.url}: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    patch: tool({
      description: "Apply a patch to files. Supports standard unified diffs (`diff -u` / `git diff`) and Servus apply-patch blocks with *** Begin Patch / Add File / Update File / Delete File / *** End Patch.",
      inputSchema: patchSchema,
      execute: async (input: z.infer<typeof patchSchema>) => {
        const patchFiles = filesFromPatch(input.patchText);
        const blocked = patchFiles.find((file) => isWorkspaceExcludedPath(cwd, file).excluded);
        if (blocked) return `Error: refusing to patch Servus/internal or generated workspace path — ${blocked}`;
        const unread = patchFiles
          .map((file) => resolveP(file, cwd))
          .filter((file) => existsSync(file) && !reads.has(file));
        if (unread.length > 0) {
          return `Error: read-before-patch required for existing file(s): ${unread.map((file) => toWorkspaceRelative(cwd, file)).join(", ")}. Use read first, then retry.`;
        }
        for (const file of patchFiles) {
          recordPreMutationSnapshot(cwd, options.sessionId, resolveP(file, cwd), "patch");
        }
        const result = applyNativeUnifiedPatch(input.patchText, cwd);
        if (!result.ok) return result.error;
        for (const file of result.files) {
          const abs = resolveP(file, cwd);
          if (!existsSync(abs) || statSync(abs).isDirectory() || isBinary(abs)) continue;
          const content = readFileSync(abs, "utf-8");
          rememberRead(reads, abs, content, statSync(abs), { partial: false });
        }
        persistReadSet(readSessionId, cwd, reads);
        return [
          `Patch applied natively by Servus (${result.files.length} file${result.files.length === 1 ? "" : "s"}).`,
          ...result.files.map((file) => `- ${file}`),
        ].join("\n");
      },
    }),

    todowrite: tool({
      description: "Create or update a structured TODO list for tracking multi-step tasks.",
      inputSchema: todoSchema,
      execute: async (input: z.infer<typeof todoSchema>) => {
        return `TODO list updated:\n${input.todos.map((t) => `[${t.status.toUpperCase()}] ${t.id}: ${t.content}`).join("\n")}`;
      },
    }),
    ...createMcpTools(cwd),
  };

  return {
    ...tools,
    Bash: tools.bash,
    BashOutput: tools.BashOutput,
    KillBash: tools.KillBash,
    Read: tools.read,
    Write: tools.write,
    Edit: tools.edit,
    MultiEdit: tools.MultiEdit,
    Glob: tools.glob,
    Grep: tools.grep,
    LS: tools.ls,
    WorkspaceMap: tools.workspace_map,
    ProjectOverview: tools.project_overview,
    WebFetch: tools.webfetch,
    TodoWrite: tools.todowrite,
  };
}

function findLineEndingVariant(
  original: string,
  oldString: string,
  newString: string,
): { oldString: string; newString: string; count: number; label: string } | null {
  const variants = [
    {
      oldString: oldString.replace(/\r?\n/g, "\r\n"),
      newString: newString.replace(/\r?\n/g, "\r\n"),
      label: "crlf-normalized",
    },
    {
      oldString: oldString.replace(/\r\n/g, "\n"),
      newString: newString.replace(/\r\n/g, "\n"),
      label: "lf-normalized",
    },
  ];

  for (const variant of variants) {
    if (variant.oldString === oldString) continue;
    const count = original.split(variant.oldString).length - 1;
    if (count > 0) return { ...variant, count };
  }
  return null;
}

function occurrenceLines(text: string, needle: string): number[] {
  const lines: number[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const index = text.indexOf(needle, cursor);
    if (index === -1) break;
    lines.push(text.slice(0, index).split(/\r?\n/).length);
    cursor = index + Math.max(needle.length, 1);
  }
  return lines;
}

function editMissHint(original: string, oldString: string): string {
  const probe = oldString
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length >= 12);
  if (!probe) return "";

  const lines = original.split(/\r?\n/);
  const index = lines.findIndex((line) => line.includes(probe));
  if (index === -1) return `No line containing this probe was found: ${probe.slice(0, 120)}`;

  const start = Math.max(0, index - 3);
  const end = Math.min(lines.length, index + 4);
  const snippet = lines
    .slice(start, end)
    .map((line, offset) => `${String(start + offset + 1).padStart(6)}|${line}`)
    .join("\n");
  return `Closest matching context:\n${snippet}`;
}

function wordAt(line: string, zeroBasedCharacter: number): string {
  const index = Math.max(0, Math.min(line.length, zeroBasedCharacter));
  const left = line.slice(0, index + 1).match(/[A-Za-z_$][\w$]*$/)?.[0] ?? "";
  const right = line.slice(index + 1).match(/^[\w$]*/)?.[0] ?? "";
  const word = `${left}${right}`;
  return /^[A-Za-z_$][\w$]*$/.test(word) ? word : "";
}

function extractDocumentSymbols(text: string): string[] {
  const symbols: string[] = [];
  const patterns: Array<{ kind: string; regex: RegExp }> = [
    { kind: "class", regex: /\b(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/ },
    { kind: "interface", regex: /\b(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
    { kind: "type", regex: /\b(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/ },
    { kind: "function", regex: /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/ },
    { kind: "const", regex: /\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)/ },
    { kind: "method", regex: /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[:{]/ },
  ];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const pattern of patterns) {
      const match = line.match(pattern.regex);
      if (match?.[1]) {
        symbols.push(`${index + 1}: ${pattern.kind} ${match[1]}`);
        break;
      }
    }
  });
  return symbols;
}

function formatSymbolResult(title: string, filePath: string, symbols: string[]): string {
  if (symbols.length === 0) return `${title}: no symbols found in ${filePath}`;
  return [
    `${title}: ${symbols.length} in ${filePath}`,
    "",
    symbols.join("\n"),
  ].join("\n");
}

function localContext(lines: string[], oneBasedLine: number): string {
  const start = Math.max(0, oneBasedLine - 4);
  const end = Math.min(lines.length, oneBasedLine + 3);
  return lines
    .slice(start, end)
    .map((line, index) => `${String(start + index + 1).padStart(6)}|${line}`)
    .join("\n");
}

function nearbyFunctionBlock(lines: string[], oneBasedLine: number): string {
  const startLine = Math.max(0, oneBasedLine - 1);
  let start = startLine;
  for (let index = startLine; index >= 0; index--) {
    if (/\b(function|class|const|let|var)\b.+[({=>]/.test(lines[index] ?? "") || /^\s*(?:async\s+)?[A-Za-z_$][\w$]*\s*\([^)]*\)\s*[:{]/.test(lines[index] ?? "")) {
      start = index;
      break;
    }
  }
  const end = Math.min(lines.length, start + 40);
  const block = lines.slice(start, end).join("\n");
  const calls = [...block.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)]
    .map((match) => match[1]!)
    .filter((name) => !["if", "for", "while", "switch", "catch", "function", "return"].includes(name))
    .slice(0, 80);
  if (calls.length === 0) return localContext(lines, oneBasedLine);
  return [
    "Nearby callable block:",
    localContext(lines, start + 1),
    "",
    `Possible outgoing calls: ${[...new Set(calls)].join(", ")}`,
  ].join("\n");
}

async function ripgrepSymbol(cwd: string, symbol: string, options: { title: string }): Promise<string> {
  const policy = createCodingWorkspacePolicy(cwd);
  try {
    const { stdout } = await execFileAsync(
      "rg",
      ["-n", "--hidden", "--color", "never", ...rgExcludeArgs(policy), "--", symbol, cwd],
      { cwd, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 },
    );
    const lines = filterGrepOutput(cwd, stdout.trim().split("\n").filter(Boolean), "content", false).slice(0, 120);
    return [
      `${options.title}: ${lines.length} match${lines.length === 1 ? "" : "es"}`,
      "",
      lines.join("\n") || "No references found.",
    ].join("\n");
  } catch {
    return `${options.title}: no matches found.`;
  }
}

async function ripgrepDefinitions(cwd: string, symbol: string): Promise<string> {
  const policy = createCodingWorkspacePolicy(cwd);
  const pattern = String.raw`\b(export\s+)?(default\s+)?(async\s+)?(function|class|interface|type|const|let|var)\s+${escapeRegex(symbol)}\b|^\s*(async\s+)?${escapeRegex(symbol)}\s*\(`;
  try {
    const { stdout } = await execFileAsync(
      "rg",
      ["-n", "--hidden", "--color", "never", ...rgExcludeArgs(policy), "--", pattern, cwd],
      { cwd, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 },
    );
    return filterGrepOutput(cwd, stdout.trim().split("\n").filter(Boolean), "content", false)
      .slice(0, 80)
      .join("\n");
  } catch {
    return "";
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function gitCommand(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, stdout: String(stdout), stderr: String(stderr) };
  } catch (err: unknown) {
    const maybe = err as { stdout?: unknown; stderr?: unknown };
    return {
      ok: false,
      stdout: typeof maybe.stdout === "string" ? maybe.stdout : "",
      stderr: typeof maybe.stderr === "string" ? maybe.stderr : err instanceof Error ? err.message : String(err),
    };
  }
}

function scopedRelativePath(filePath: string, cwd: string): { ok: true; path: string } | { ok: false; error: string } {
  const abs = resolveP(filePath, cwd);
  const rel = relative(cwd, abs);
  if (!rel || rel.startsWith("..") || rel === "." || rel.split(/[\\/]/).includes("..")) {
    return { ok: false, error: `Error: path must stay inside workspace — ${filePath}` };
  }
  return { ok: true, path: rel };
}

function getReadSet(sessionId: string, cwd?: string): Map<string, FileState> {
  const existing = readTracker.get(sessionId);
  if (existing) return existing;
  const created = new Map<string, FileState>();
  if (cwd) loadPersistedReadSet(sessionId, cwd, created);
  readTracker.set(sessionId, created);
  return created;
}

function rememberRead(
  reads: Map<string, FileState>,
  abs: string,
  content: string,
  stat: { mtimeMs: number; size: number },
  options: { offset?: number; limit?: number; partial?: boolean } = {},
): void {
  reads.set(abs, {
    content,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    ...(options.offset !== undefined ? { offset: options.offset } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    partial: options.partial ?? false,
    timestamp: Date.now(),
  });
}

function persistReadSet(sessionId: string, cwd: string, reads: Map<string, FileState>): void {
  try {
    const path = readStatePath(sessionId);
    mkdirSync(dirname(path), { recursive: true });
    const files = [...reads.entries()]
      .map(([abs, state]) => ({
        path: toWorkspaceRelative(cwd, abs),
        mtimeMs: state.mtimeMs,
        size: state.size,
        offset: state.offset,
        limit: state.limit,
        partial: state.partial,
        timestamp: state.timestamp,
      }))
      .filter((item) => !item.path.startsWith(".."));
    writeFileSync(path, JSON.stringify({ version: 1, cwd, files }, null, 2) + "\n", "utf-8");
  } catch {
    // File state persistence is a safety convenience; in-memory tracking remains authoritative.
  }
}

function loadPersistedReadSet(sessionId: string, cwd: string, reads: Map<string, FileState>): void {
  const path = readStatePath(sessionId);
  if (!existsSync(path)) return;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
      cwd?: string;
      files?: Array<{
        path?: string;
        mtimeMs?: number;
        size?: number;
        offset?: number;
        limit?: number;
        partial?: boolean;
        timestamp?: number;
      }>;
    };
    if (parsed.cwd && resolve(parsed.cwd) !== resolve(cwd)) return;
    for (const item of parsed.files ?? []) {
      if (!item.path || item.path.startsWith("..")) continue;
      const abs = resolveP(item.path, cwd);
      if (!existsSync(abs)) continue;
      const st = statSync(abs);
      if (typeof item.mtimeMs === "number" && st.mtimeMs !== item.mtimeMs) continue;
      if (typeof item.size === "number" && st.size !== item.size) continue;
      reads.set(abs, {
        content: "",
        mtimeMs: st.mtimeMs,
        size: st.size,
        ...(typeof item.offset === "number" ? { offset: item.offset } : {}),
        ...(typeof item.limit === "number" ? { limit: item.limit } : {}),
        partial: item.partial ?? false,
        timestamp: item.timestamp ?? Date.now(),
      });
    }
  } catch {
    // Ignore corrupt persisted read state.
  }
}

export interface CodingReadStateFile {
  path: string;
  agent: string;
  size?: number;
  partial?: boolean;
  timestamp?: number;
}

export function listCodingReadStateFiles(sessionId: string | undefined, cwd: string): CodingReadStateFile[] {
  if (!sessionId) return [];
  const dir = resolve(SERVUS_DIR, "sessions", sanitizeFileName(sessionId), "coding");
  if (!existsSync(dir)) return [];
  const files: CodingReadStateFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith("read-state-") || !entry.name.endsWith(".json")) continue;
    const agent = entry.name.slice("read-state-".length, -".json".length);
    try {
      const parsed = JSON.parse(readFileSync(resolve(dir, entry.name), "utf-8")) as {
        cwd?: string;
        files?: Array<{ path?: string; size?: number; partial?: boolean; timestamp?: number }>;
      };
      if (parsed.cwd && resolve(parsed.cwd) !== resolve(cwd)) continue;
      for (const item of parsed.files ?? []) {
        if (!item.path || item.path.startsWith("..")) continue;
        files.push({
          path: item.path,
          agent,
          ...(typeof item.size === "number" ? { size: item.size } : {}),
          ...(typeof item.partial === "boolean" ? { partial: item.partial } : {}),
          ...(typeof item.timestamp === "number" ? { timestamp: item.timestamp } : {}),
        });
      }
    } catch {
      // Ignore corrupt read-state files.
    }
  }
  const deduped = new Map<string, CodingReadStateFile>();
  for (const file of files) {
    const key = `${file.agent}:${file.path}`;
    const prev = deduped.get(key);
    if (!prev || (file.timestamp ?? 0) > (prev.timestamp ?? 0)) deduped.set(key, file);
  }
  return [...deduped.values()].sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
}

function readStatePath(sessionId: string): string {
  const [first, ...rest] = sessionId.split(":");
  if (first && !first.startsWith("cwd")) {
    const agent = rest.join("-") || "agent";
    return resolve(SERVUS_DIR, "sessions", first, "coding", `read-state-${sanitizeFileName(agent)}.json`);
  }
  return resolve(SERVUS_DIR, "coding-file-state", `${sanitizeFileName(sessionId)}.json`);
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}

function validateReadState(
  reads: Map<string, FileState>,
  abs: string,
  cwd: string,
): { ok: true; partial: boolean } | { ok: false; error: string } {
  const state = reads.get(abs);
  const display = toWorkspaceRelative(cwd, abs);
  if (!state) {
    return {
      ok: false,
      error: `Error: read-before-edit required for ${display}. Use Read first with the surrounding lines, then retry with exact unique context.`,
    };
  }
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    return { ok: false, error: `Error: file disappeared after read — ${display}. Re-check the path before editing.` };
  }
  if (stat.mtimeMs !== state.mtimeMs || stat.size !== state.size) {
    return {
      ok: false,
      error: [
        `Error: stale read for ${display}.`,
        "The file changed after Servus read it, likely due to user or tool activity.",
        "Read the target lines again before editing so user-owned changes are preserved.",
      ].join(" "),
    };
  }
  return { ok: true, partial: state.partial };
}

function isDocumentationPath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  const ext = extname(lower);
  return ext === ".md" || lower.endsWith("/readme") || lower.endsWith("/readme.md");
}

function filesFromPatch(patchText: string): string[] {
  const files = new Set<string>();
  if (/^\s*\*\*\* Begin Patch/m.test(patchText)) {
    for (const line of patchText.split(/\r?\n/)) {
      const match = line.match(/^\*\*\* (?:Add|Update|Delete) File:\s+(.+)$/);
      if (match?.[1]) files.add(match[1].trim());
    }
    return [...files];
  }
  for (const line of patchText.split(/\r?\n/)) {
    if (!line.startsWith("+++ ")) continue;
    const raw = line.slice(4).trim().split(/\s+/)[0] ?? "";
    if (!raw || raw === "/dev/null") continue;
    files.add(raw.replace(/^b\//, ""));
  }
  return [...files];
}

type NativePatchFile = {
  oldPath?: string;
  newPath?: string;
  deleteWholeFile?: boolean;
  hunks: NativePatchHunk[];
};

type NativePatchHunk = {
  oldStart: number;
  lines: Array<{ kind: "context" | "remove" | "add"; text: string }>;
};

function applyNativeUnifiedPatch(patchText: string, cwd: string): { ok: true; files: string[] } | { ok: false; error: string } {
  const parsed = /^\s*\*\*\* Begin Patch/m.test(patchText)
    ? parseServusApplyPatch(patchText)
    : parseNativeUnifiedPatch(patchText);
  if (!parsed.ok) return parsed;
  const touched: string[] = [];

  for (const filePatch of parsed.files) {
    const targetRel = filePatch.newPath ?? filePatch.oldPath;
    if (!targetRel) return { ok: false, error: "Error: patch contains a file with no target path." };
    const scoped = scopedRelativePath(targetRel, cwd);
    if (!scoped.ok) return { ok: false, error: scoped.error };
    const abs = resolveP(scoped.path, cwd);
    const excluded = isWorkspaceExcludedPath(cwd, abs);
    if (excluded.excluded && !isExplicitInternalRequest(cwd, scoped.path)) {
      return { ok: false, error: `Error: refusing to patch Servus/internal or generated workspace path — ${scoped.path}` };
    }
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      return { ok: false, error: `Error: refusing to patch directory path — ${scoped.path}` };
    }
    if (existsSync(abs) && isBinary(abs)) {
      return { ok: false, error: `Error: refusing to patch binary file — ${scoped.path}` };
    }
    if (!existsSync(abs) && filePatch.oldPath === undefined && isDocumentationPath(scoped.path)) {
      return {
        ok: false,
        error: `Error: refusing to create documentation file via patch without explicit user request — ${scoped.path}. Use Write with explicitUserRequest=true when the user asked for this file.`,
      };
    }

    const deleting = filePatch.deleteWholeFile === true || filePatch.newPath === undefined;
    const original = existsSync(abs) ? readFileSync(abs, "utf-8") : "";
    const eol = original.includes("\r\n") ? "\r\n" : "\n";
    const applied = filePatch.deleteWholeFile
      ? { ok: true as const, content: "" }
      : applyNativePatchHunks(original, filePatch.hunks, scoped.path);
    if (!applied.ok) return applied;

    if (deleting) {
      if (applied.content.trim().length > 0) {
        return {
          ok: false,
          error: `Error: deletion patch for ${scoped.path} left non-empty content. Refusing unsafe delete.`,
        };
      }
      if (existsSync(abs)) unlinkSync(abs);
    } else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, applied.content.replace(/\n/g, eol), "utf-8");
    }
    touched.push(scoped.path);
  }

  return { ok: true, files: [...new Set(touched)] };
}

function parseNativeUnifiedPatch(patchText: string): { ok: true; files: NativePatchFile[] } | { ok: false; error: string } {
  const lines = patchText.replace(/\r\n/g, "\n").split("\n");
  const files: NativePatchFile[] = [];
  let current: NativePatchFile | undefined;
  let currentHunk: NativePatchHunk | undefined;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (line.startsWith("--- ")) {
      const oldPath = normalizePatchPath(line.slice(4));
      const next = lines[index + 1] ?? "";
      if (!next.startsWith("+++ ")) {
        return { ok: false, error: `Error: malformed patch near line ${index + 1}; expected +++ after ---.` };
      }
      const newPath = normalizePatchPath(next.slice(4));
      current = {
        ...(oldPath ? { oldPath } : {}),
        ...(newPath ? { newPath } : {}),
        hunks: [],
      };
      files.push(current);
      currentHunk = undefined;
      index++;
      continue;
    }

    if (line.startsWith("@@ ")) {
      if (!current) return { ok: false, error: `Error: hunk found before file header at line ${index + 1}.` };
      const match = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
      if (!match?.[1]) return { ok: false, error: `Error: malformed hunk header at line ${index + 1}: ${line}` };
      currentHunk = { oldStart: Number.parseInt(match[1], 10), lines: [] };
      current.hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) continue;
    if (line.startsWith("\\ No newline at end of file")) continue;
    const marker = line[0];
    if (marker === " ") currentHunk.lines.push({ kind: "context", text: line.slice(1) });
    else if (marker === "-") currentHunk.lines.push({ kind: "remove", text: line.slice(1) });
    else if (marker === "+") currentHunk.lines.push({ kind: "add", text: line.slice(1) });
    else if (line === "") continue;
    else return { ok: false, error: `Error: unsupported patch line ${index + 1}: ${line}` };
  }

  const invalid = files.find((file) => file.hunks.length === 0);
  if (invalid) return { ok: false, error: `Error: patch for ${invalid.newPath ?? invalid.oldPath ?? "(unknown)"} has no hunks.` };
  if (files.length === 0) return { ok: false, error: "Error: no unified diff file headers found in patch." };
  return { ok: true, files };
}

function parseServusApplyPatch(patchText: string): { ok: true; files: NativePatchFile[] } | { ok: false; error: string } {
  const lines = patchText.replace(/\r\n/g, "\n").split("\n");
  if (!lines.some((line) => line.trim() === "*** Begin Patch")) {
    return { ok: false, error: "Error: apply patch is missing *** Begin Patch." };
  }
  if (!lines.some((line) => line.trim() === "*** End Patch")) {
    return { ok: false, error: "Error: apply patch is missing *** End Patch." };
  }

  const files: NativePatchFile[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const add = line.match(/^\*\*\* Add File:\s+(.+)$/);
    const update = line.match(/^\*\*\* Update File:\s+(.+)$/);
    const del = line.match(/^\*\*\* Delete File:\s+(.+)$/);

    if (add?.[1]) {
      const path = add[1].trim();
      const hunk: NativePatchHunk = { oldStart: 1, lines: [] };
      index++;
      while (index < lines.length && !lines[index]!.startsWith("*** ")) {
        const current = lines[index] ?? "";
        if (!current.startsWith("+")) {
          return { ok: false, error: `Error: Add File ${path} line ${index + 1} must start with +.` };
        }
        hunk.lines.push({ kind: "add", text: current.slice(1) });
        index++;
      }
      files.push({ newPath: path, hunks: [hunk] });
      continue;
    }

    if (update?.[1]) {
      const path = update[1].trim();
      const hunks: NativePatchHunk[] = [];
      let currentHunk: NativePatchHunk = { oldStart: 1, lines: [] };
      hunks.push(currentHunk);
      index++;
      while (index < lines.length && !lines[index]!.startsWith("*** ")) {
        const current = lines[index] ?? "";
        if (current.startsWith("@@")) {
          if (currentHunk.lines.length === 0 && hunks.length > 0) {
            hunks.pop();
          }
          currentHunk = { oldStart: parseApplyPatchOldStart(current) ?? 1, lines: [] };
          hunks.push(currentHunk);
          index++;
          continue;
        }
        if (current.startsWith("\\ No newline at end of file")) {
          index++;
          continue;
        }
        const marker = current[0];
        if (marker === " ") currentHunk.lines.push({ kind: "context", text: current.slice(1) });
        else if (marker === "-") currentHunk.lines.push({ kind: "remove", text: current.slice(1) });
        else if (marker === "+") currentHunk.lines.push({ kind: "add", text: current.slice(1) });
        else if (current === "") currentHunk.lines.push({ kind: "context", text: "" });
        else {
          return { ok: false, error: `Error: unsupported apply-patch update line ${index + 1}: ${current}` };
        }
        index++;
      }
      const nonEmptyHunks = hunks.filter((hunk) => hunk.lines.length > 0);
      if (nonEmptyHunks.length === 0) {
        return { ok: false, error: `Error: Update File ${path} has no changes.` };
      }
      files.push({ oldPath: path, newPath: path, hunks: nonEmptyHunks });
      continue;
    }

    if (del?.[1]) {
      const path = del[1].trim();
      files.push({ oldPath: path, deleteWholeFile: true, hunks: [] });
      index++;
      continue;
    }

    index++;
  }

  if (files.length === 0) return { ok: false, error: "Error: no Add/Update/Delete File sections found in apply patch." };
  return { ok: true, files };
}

function parseApplyPatchOldStart(header: string): number | undefined {
  const match = header.match(/@@\s+-(\d+)(?:,\d+)?/);
  return match?.[1] ? Number.parseInt(match[1], 10) : undefined;
}

function normalizePatchPath(raw: string): string | undefined {
  const token = raw.trim().split(/\s+/)[0]?.replace(/^"|"$/g, "") ?? "";
  if (!token || token === "/dev/null") return undefined;
  return token.replace(/^[ab]\//, "");
}

function applyNativePatchHunks(
  original: string,
  hunks: NativePatchHunk[],
  displayPath: string,
): { ok: true; content: string } | { ok: false; error: string } {
  const hadTrailingNewline = original.endsWith("\n") || original.endsWith("\r\n");
  const normalized = original.replace(/\r\n/g, "\n");
  const lines = normalized.length ? normalized.replace(/\n$/, "").split("\n") : [];
  let offset = 0;

  for (const [hunkIndex, hunk] of hunks.entries()) {
    const oldChunk = hunk.lines
      .filter((line) => line.kind !== "add")
      .map((line) => line.text);
    const newChunk = hunk.lines
      .filter((line) => line.kind !== "remove")
      .map((line) => line.text);
    const suggested = Math.max(0, hunk.oldStart - 1 + offset);
    const position = findPatchPosition(lines, oldChunk, suggested);
    if (position === -1) {
      return {
        ok: false,
        error: [
          `Error: patch hunk ${hunkIndex + 1} did not match ${displayPath}.`,
          "Read the current file and regenerate the patch from the latest contents.",
        ].join("\n"),
      };
    }
    lines.splice(position, oldChunk.length, ...newChunk);
    offset += newChunk.length - oldChunk.length;
  }

  const content = lines.join("\n") + (hadTrailingNewline || lines.length > 0 ? "\n" : "");
  return { ok: true, content };
}

function findPatchPosition(lines: string[], oldChunk: string[], suggested: number): number {
  if (oldChunk.length === 0) return Math.min(Math.max(0, suggested), lines.length);
  if (sequenceMatches(lines, oldChunk, suggested)) return suggested;
  const matches: number[] = [];
  for (let index = 0; index <= lines.length - oldChunk.length; index++) {
    if (sequenceMatches(lines, oldChunk, index)) matches.push(index);
  }
  return matches.length === 1 ? matches[0]! : -1;
}

function sequenceMatches(lines: string[], chunk: string[], start: number): boolean {
  if (start < 0 || start + chunk.length > lines.length) return false;
  for (let offset = 0; offset < chunk.length; offset++) {
    if (lines[start + offset] !== chunk[offset]) return false;
  }
  return true;
}

function recordPreMutationSnapshot(cwd: string, sessionId: string | undefined, abs: string, operation: string): void {
  if (!sessionId) return;
  try {
    const scoped = scopedRelativePath(abs, cwd);
    if (!scoped.ok) return;
    const excluded = isWorkspaceExcludedPath(cwd, abs);
    if (excluded.excluded) return;
    const existed = existsSync(abs);
    const entry = {
      id: `snapshot-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      operation,
      path: scoped.path,
      existed,
      content: existed && !statSync(abs).isDirectory() && !isBinary(abs) && statSync(abs).size <= MAX_READ_FILE_SIZE
        ? readFileSync(abs, "utf-8")
        : undefined,
    };
    const dir = resolve(SERVUS_DIR, "sessions", sanitizeFileName(sessionId), "coding", "snapshots");
    mkdirSync(dir, { recursive: true });
    appendFileSync(resolve(dir, "pre-mutation.jsonl"), JSON.stringify(entry) + "\n");
  } catch {
    // Snapshotting should never block an otherwise safe mutation.
  }
}

function filesResult(
  files: string[],
  meta: {
    total: number;
    offset: number;
    limit: number;
    truncated: boolean;
    ignored: boolean;
    empty: string;
  },
): string {
  if (files.length === 0) return `${meta.empty}\nIgnored paths applied: ${meta.ignored ? "yes" : "no"}`;
  return [
    `Found ${files.length} file${files.length === 1 ? "" : "s"} (${meta.total} total, offset ${meta.offset}, limit ${formatLimit(meta.limit)}, truncated ${meta.truncated ? "yes" : "no"})`,
    `Ignored paths applied: ${meta.ignored ? "yes" : "no"}`,
    "",
    files.join("\n"),
  ].join("\n");
}

function grepResult(
  lines: string[],
  meta: {
    pattern: string;
    mode: "content" | "files_with_matches" | "count";
    total: number;
    offset: number;
    limit: number;
    truncated: boolean;
    ignored: boolean;
  },
): string {
  if (lines.length === 0) {
    return `No matches for '${meta.pattern}'\nMode: ${meta.mode}\nIgnored paths applied: ${meta.ignored ? "yes" : "no"}`;
  }
  return [
    `Matches (${meta.mode}): ${lines.length} returned / ${meta.total} total, offset ${meta.offset}, limit ${formatLimit(meta.limit)}, truncated ${meta.truncated ? "yes" : "no"}`,
    `Ignored paths applied: ${meta.ignored ? "yes" : "no"}`,
    "",
    lines.join("\n"),
  ].join("\n");
}

function filterGrepOutput(
  cwd: string,
  lines: string[],
  mode: "content" | "files_with_matches" | "count",
  allowInternal: boolean,
): string[] {
  if (allowInternal) return lines;
  return lines.filter((line) => {
    const candidate = mode === "content"
      ? line.split(":")[0] ?? line
      : mode === "count"
        ? line.split(":")[0] ?? line
        : line;
    return !isWorkspaceExcludedPath(cwd, candidate).excluded;
  });
}

function formatLimit(limit: number): string {
  return Number.isFinite(limit) ? String(limit) : "unlimited";
}

function destructiveShellReason(command: string): string | null {
  const text = command.toLowerCase();
  if (/\bgit\s+reset\s+--hard\b/.test(text)) return "git reset --hard discards user work";
  if (/\bgit\s+clean\b.*\-[^\s]*f/.test(text)) return "git clean -f deletes untracked files";
  if (/\brm\s+(-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r)\b/.test(text) && /(\s\/|\s~|\s\.{1,2}(?:\s|\/|$))/.test(text)) {
    return "broad recursive removal";
  }
  if (/\bsudo\s+rm\b/.test(text)) return "privileged deletion";
  if (/\b(chown|chmod)\s+-r\b/.test(text)) return "recursive permission change";
  if (/\b(mkfs|dd\s+if=|diskutil\s+erase|format)\b/.test(text)) return "disk-level destructive operation";
  return null;
}

function shellConsentReason(command: string): string | null {
  const text = command.toLowerCase();
  if (/\b(npm\s+(install|i)|pnpm\s+(add|install)|yarn\s+(add|install)|bun\s+(add|install))\b/.test(text)) {
    return "dependency install or lockfile mutation";
  }
  if (/\b(git\s+(commit|push|pull|merge|rebase|checkout|switch|restore|stash|tag))\b/.test(text)) {
    return "git operation that can alter history, branch state, or remote state";
  }
  if (/\b(chmod|chown|xattr|codesign)\b/.test(text)) {
    return "filesystem permission or metadata change";
  }
  if (/\b(mv|cp|mkdir|touch|truncate)\b/.test(text)) {
    return "shell-side file mutation";
  }
  if (/\b(sed\s+-i|perl\s+-pi|python(?:3)?\b.+\b(open|write_text|write_bytes|unlink|rename|replace)\b|node\b.+\bwriteFile|appendFile|rmSync|renameSync)\b/s.test(text)) {
    return "scripted file mutation";
  }
  if (/(^|[^>])>>?[^&]|<\s*\(/.test(command) || /\btee\b/.test(text)) {
    return "shell redirection can write files outside Servus edit tracking";
  }
  return null;
}

function makeTargetProblem(command: string, cwd: string): { kind: "missing" | "consent"; message: string } | null {
  const target = parseSingleMakeTarget(command);
  if (!target) return null;
  const block = readMakeTargetBlock(cwd, target);
  if (!block) {
    return {
      kind: "missing",
      message: `Makefile target "${target}" was not found. Do not create verification targets just to satisfy Servus; use an existing package/test command or report verification unavailable.`,
    };
  }
  const reason = shellConsentReason(block);
  if (!reason) return null;
  return {
    kind: "consent",
    message: `make ${target} target contains command(s) that require approval: ${reason}`,
  };
}

function parseSingleMakeTarget(command: string): string | null {
  const match = command.trim().match(/^make(?:\s+-[A-Za-z0-9_.=-]+)*\s+([A-Za-z0-9_.-]+)\s*$/);
  return match?.[1] ?? null;
}

function readMakeTargetBlock(cwd: string, target: string): string | null {
  const makefile = ["Makefile", "makefile", "GNUmakefile"]
    .map((name) => resolve(cwd, name))
    .find((path) => existsSync(path));
  if (!makefile) return null;
  try {
    const lines = readFileSync(makefile, "utf-8").split(/\r?\n/);
    const targetPattern = new RegExp(`^${escapeRegExp(target)}\\s*:`);
    const start = lines.findIndex((line) => targetPattern.test(line));
    if (start === -1) return null;
    const block: string[] = [];
    for (let index = start + 1; index < lines.length; index++) {
      const line = lines[index] ?? "";
      if (/^[^\s#][^:]*:/.test(line)) break;
      if (/^\s+/.test(line)) block.push(line.trim());
    }
    return block.join("\n");
  } catch {
    return null;
  }
}

function shellConsentRisk(command: string): "medium" | "high" {
  const text = command.toLowerCase();
  if (/\b(git\s+(push|rebase|reset|clean)|npm\s+(install|i)|pnpm\s+(add|install)|yarn\s+(add|install)|bun\s+(add|install))\b/.test(text)) {
    return "high";
  }
  return "medium";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function runProcessWithInput(
  command: string,
  args: string[],
  input: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    registerChild(child.pid!, { processGroup: process.platform !== "win32" });
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (d: Buffer) => chunks.push(d));
    child.stderr?.on("data", (d: Buffer) => chunks.push(d));
    child.stdin?.end(input);
    let settled = false;
    const timer = setTimeout(() => {
      try {
        if (process.platform !== "win32") process.kill(-child.pid!, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // already exited
      }
    }, timeoutMs);
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unregisterChild(child.pid!);
      resolve({ code, output: clamp(Buffer.concat(chunks).toString("utf-8")) });
    });
  });
}

// ─── Glob Fallback ──────────────────────────────────────────────────────────

function globFallback(
  dir: string,
  pattern: string,
  cwd: string,
  allowInternal: boolean,
  limit: number,
  offset: number,
): string {
  const results: string[] = [];
  const re = globToRegex(pattern);
  function walk(d: string) {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = resolve(d, entry.name);
      const rel = relative(dir, full);
      if (!allowInternal && isWorkspaceExcludedPath(cwd, full).excluded) continue;
      if (entry.name === ".git") continue;
      if (entry.isDirectory()) walk(full);
      else if (re.test(rel)) results.push(rel);
    }
  }
  walk(dir);
  const filtered = filterWorkspacePaths(cwd, results, { allowInternal });
  const page = filtered.slice(offset, Number.isFinite(limit) ? offset + limit : undefined);
  const truncated = Number.isFinite(limit) && filtered.length > offset + limit;
  return filesResult(page, {
    total: filtered.length,
    offset,
    limit,
    truncated,
    ignored: !allowInternal,
    empty: `No files matching '${pattern}'`,
  });
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "§§").replace(/\*/g, "[^/]*").replace(/§§/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}
