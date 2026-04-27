/**
 * Built-in tool definitions for the custom Servus agent runtime.
 *
 * Each tool is defined using the Vercel AI SDK v6 `tool()` function
 * with a Zod input schema and an async execute function.
 */

import { tool } from "ai";
import { z } from "zod";
import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";
import { registerChild, unregisterChild } from "./child-registry.js";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";

const execAsync = promisify(exec);

// ─── Helpers ────────────────────────────────────────────────────────────────

const MAX_OUTPUT = 50_000;

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

// ─── Schemas ────────────────────────────────────────────────────────────────

const bashSchema = z.object({
  command: z.string().describe("The bash command to execute"),
  timeout: z.number().optional().describe("Timeout in milliseconds (default: 120000)"),
  description: z.string().describe("Brief 5-10 word description of what this command does"),
});

const readSchema = z.object({
  filePath: z.string().describe("Absolute or relative path to the file"),
  offset: z.number().optional().describe("1-based starting line number (default: 1)"),
  limit: z.number().optional().describe("Max number of lines to return (default: 2000)"),
});

const writeSchema = z.object({
  filePath: z.string().describe("Path to the file to write"),
  content: z.string().describe("Complete file contents"),
});

const editSchema = z.object({
  filePath: z.string().describe("Path to the file to edit"),
  oldString: z.string().describe("Exact text to find (must be unique)"),
  newString: z.string().describe("Replacement text"),
  replaceAll: z.boolean().optional().describe("Replace all occurrences (default: false)"),
});

const globSchema = z.object({
  pattern: z.string().describe("Glob pattern to match files against"),
  path: z.string().optional().describe("Directory to search in (default: project root)"),
});

const grepSchema = z.object({
  pattern: z.string().describe("Regular expression pattern to search for"),
  path: z.string().optional().describe("Directory or file to search in (default: project root)"),
  include: z.string().optional().describe("Glob to filter files (e.g. '*.ts')"),
});

const lsSchema = z.object({
  path: z.string().optional().describe("Directory to list (default: project root)"),
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

export function createTools(cwd: string) {
  return {
    bash: tool({
      description: [
        "Execute a shell command in bash.",
        "Use for: git, npm/pnpm/yarn, make, cargo, go, python, docker, curl, build scripts, test runners, etc.",
        "Guidelines: prefer single commands, set timeout for long-running processes, never use interactive commands.",
        "For large output redirect to a file: `cmd > /tmp/out.log 2>&1 && tail -50 /tmp/out.log`",
      ].join("\n"),
      inputSchema: bashSchema,
      execute: async (input: z.infer<typeof bashSchema>) => {
        const cmd = input.command;
        const wouldRemovePlan =
          /\b(rm|unlink|delete)\b/i.test(cmd) &&
          /servus-plan\.json|init\.sh/.test(cmd);
        if (wouldRemovePlan) {
          return `Error: Cannot remove servus-plan.json or init.sh — these are required by the orchestrator. Use a subdirectory for scaffolding, then move contents to cwd.`;
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
        return new Promise<string>((resolve) => {
          const child = spawn("/bin/bash", ["-c", input.command], {
            cwd,
            env: { ...process.env, FORCE_COLOR: "0" },
            stdio: ["ignore", "pipe", "pipe"],
            detached: process.platform !== "win32",
          });
          registerChild(child.pid!, { processGroup: process.platform !== "win32" });
          const chunks: { out: Buffer[]; err: Buffer[] } = { out: [], err: [] };
          child.stdout?.on("data", (d: Buffer) => chunks.out.push(d));
          child.stderr?.on("data", (d: Buffer) => chunks.err.push(d));
          let settled = false;
          const done = (code: number | null, killed?: boolean) => {
            if (settled) return;
            settled = true;
            unregisterChild(child.pid!);
            const stdout = Buffer.concat(chunks.out).toString("utf-8");
            const stderr = Buffer.concat(chunks.err).toString("utf-8");
            const out = [
              stdout ? `STDOUT:\n${stdout}` : "",
              stderr ? `STDERR:\n${stderr}` : "",
            ].filter(Boolean).join("\n");
            if (code === 0 && !killed) resolve(clamp(out || "(no output)"));
            else {
              const parts = [`Exit code: ${code ?? 1}`];
              if (killed) parts.push("(process killed — timeout?)");
              if (stdout) parts.push(`STDOUT:\n${stdout}`);
              if (stderr) parts.push(`STDERR:\n${stderr}`);
              resolve(clamp(parts.join("\n")));
            }
          };
          const t = setTimeout(() => {
            try {
              (child as { killed?: boolean }).killed = true;
              if (process.platform !== "win32") process.kill(-child.pid!, "SIGKILL");
              else child.kill("SIGKILL");
            } catch {
              /* already dead */
            }
            done(null, true);
          }, timeoutMs);
          child.on("close", (code) => {
            clearTimeout(t);
            done(code ?? null, (child as { killed?: boolean }).killed);
          });
        });
      },
    }),

    read: tool({
      description: [
        "Read a file with optional line-range. If path is a directory, lists entries.",
        "Lines are 1-indexed. Use offset+limit for large files. Binary files are detected and skipped.",
      ].join("\n"),
      inputSchema: readSchema,
      execute: async (input: z.infer<typeof readSchema>) => {
        const abs = resolveP(input.filePath, cwd);
        if (!existsSync(abs)) return `Error: file not found — ${abs}`;
        const st = statSync(abs);
        if (st.isDirectory()) {
          const entries = readdirSync(abs, { withFileTypes: true });
          return `Directory: ${abs}\n\n${entries.map((e) => e.isDirectory() ? `${e.name}/` : e.name).join("\n")}`;
        }
        if (isBinary(abs)) return `Error: binary file — cannot display ${abs}`;
        const offset = input.offset ?? 1;
        const limit = input.limit ?? 2000;
        const lines: string[] = [];
        let lineNum = 0;
        const rl = createInterface({ input: createReadStream(abs, { encoding: "utf-8" }), crlfDelay: Infinity });
        for await (const line of rl) {
          lineNum++;
          if (lineNum < offset) continue;
          if (lines.length >= limit) break;
          const display = line.length > 2000 ? line.slice(0, 2000) + "…(truncated)" : line;
          lines.push(`${String(lineNum).padStart(6)}|${display}`);
        }
        return `File: ${relative(cwd, abs) || abs}  (lines ${offset}–${offset + lines.length - 1} of ${lineNum}+)\n${lines.join("\n")}`;
      },
    }),

    write: tool({
      description: "Create or overwrite a file. Parent directories are created automatically. Prefer edit for existing files.",
      inputSchema: writeSchema,
      execute: async (input: z.infer<typeof writeSchema>) => {
        const abs = resolveP(input.filePath, cwd);
        mkdirSync(dirname(abs), { recursive: true });
        const existed = existsSync(abs);
        writeFileSync(abs, input.content, "utf-8");
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
        const abs = resolveP(input.filePath, cwd);
        if (!existsSync(abs)) return `Error: file not found — ${abs}`;
        const original = readFileSync(abs, "utf-8");
        const count = original.split(input.oldString).length - 1;
        if (count === 0) return `Error: oldString not found in ${relative(cwd, abs)}. Ensure exact match including whitespace.`;
        if (count > 1 && !input.replaceAll) return `Error: oldString appears ${count} times. Include more context or set replaceAll.`;
        const updated = input.replaceAll
          ? original.split(input.oldString).join(input.newString)
          : original.replace(input.oldString, input.newString);
        writeFileSync(abs, updated, "utf-8");
        const delta = input.newString.split("\n").length - input.oldString.split("\n").length;
        return `Edited ${relative(cwd, abs)}: replaced ${input.replaceAll ? `all ${count}` : "1"} occurrence(s) (${delta >= 0 ? "+" : ""}${delta} lines)`;
      },
    }),

    glob: tool({
      description: "Find files matching a glob pattern (e.g. '**/*.ts'). Results sorted by modification time.",
      inputSchema: globSchema,
      execute: async (input: z.infer<typeof globSchema>) => {
        const searchDir = input.path ? resolveP(input.path, cwd) : cwd;
        try {
          const { stdout } = await execAsync(
            `rg --files --glob '${input.pattern}' --sort modified 2>/dev/null | head -100`,
            { cwd: searchDir, timeout: 15_000 },
          );
          const files = stdout.trim().split("\n").filter(Boolean);
          return files.length ? `Found ${files.length} files:\n${files.join("\n")}` : `No files matching '${input.pattern}'`;
        } catch {
          return globFallback(searchDir, input.pattern);
        }
      },
    }),

    grep: tool({
      description: "Search file contents for a regex pattern using ripgrep. Returns matching lines with paths and line numbers.",
      inputSchema: grepSchema,
      execute: async (input: z.infer<typeof grepSchema>) => {
        const searchPath = input.path ? resolveP(input.path, cwd) : cwd;
        const globArg = input.include ? `--glob '${input.include}'` : "";
        try {
          const { stdout } = await execAsync(
            `rg -nH --no-heading --color never ${globArg} -- '${input.pattern.replace(/'/g, "'\\''")}' '${searchPath}' 2>/dev/null | head -100`,
            { cwd, timeout: 15_000, maxBuffer: 5 * 1024 * 1024 },
          );
          return stdout.trim() ? `Matches:\n${stdout.trim()}` : `No matches for '${input.pattern}'`;
        } catch {
          return `No matches for '${input.pattern}' in ${searchPath}`;
        }
      },
    }),

    ls: tool({
      description: "List the contents of a directory with file sizes.",
      inputSchema: lsSchema,
      execute: async (input: z.infer<typeof lsSchema>) => {
        const abs = input.path ? resolveP(input.path, cwd) : cwd;
        if (!existsSync(abs)) return `Error: not found — ${abs}`;
        if (!statSync(abs).isDirectory()) return `Error: not a directory — ${abs}`;
        const entries = readdirSync(abs, { withFileTypes: true });
        const lines = entries.map((e) => {
          if (e.isDirectory()) return `  ${e.name}/`;
          try { return `  ${e.name}  (${(statSync(resolve(abs, e.name)).size / 1024).toFixed(1)} KB)`; }
          catch { return `  ${e.name}`; }
        });
        return `Directory: ${relative(cwd, abs) || "."}\n\n${lines.join("\n")}\n\n${entries.length} entries`;
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
      description: "Apply a unified diff patch to files (standard `diff -u` or `git diff` format).",
      inputSchema: patchSchema,
      execute: async (input: z.infer<typeof patchSchema>) => {
        try {
          const { stdout, stderr } = await execAsync(
            `echo ${JSON.stringify(input.patchText)} | patch -p1 --forward --no-backup-if-mismatch 2>&1`,
            { cwd, timeout: 30_000 },
          );
          return `Patch applied:\n${stdout}${stderr ? `\n${stderr}` : ""}`;
        } catch (err: unknown) {
          const e = err as { stdout?: string; stderr?: string; message?: string };
          return `Patch failed:\n${e.stdout ?? ""}${e.stderr ?? e.message ?? "Unknown error"}`;
        }
      },
    }),

    todowrite: tool({
      description: "Create or update a structured TODO list for tracking multi-step tasks.",
      inputSchema: todoSchema,
      execute: async (input: z.infer<typeof todoSchema>) => {
        return `TODO list updated:\n${input.todos.map((t) => `[${t.status.toUpperCase()}] ${t.id}: ${t.content}`).join("\n")}`;
      },
    }),
  };
}

// ─── Glob Fallback ──────────────────────────────────────────────────────────

function globFallback(dir: string, pattern: string): string {
  const results: string[] = [];
  const re = globToRegex(pattern);
  function walk(d: string) {
    if (results.length >= 100) return;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (results.length >= 100) break;
      const full = resolve(d, entry.name);
      const rel = relative(dir, full);
      if (["node_modules", ".git", "dist"].includes(entry.name)) continue;
      if (entry.isDirectory()) walk(full);
      else if (re.test(rel)) results.push(rel);
    }
  }
  walk(dir);
  return results.length ? `Found ${results.length} files:\n${results.join("\n")}` : `No files matching '${pattern}'`;
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "§§").replace(/\*/g, "[^/]*").replace(/§§/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}
