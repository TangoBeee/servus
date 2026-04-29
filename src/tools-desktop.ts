/**
 * Desktop/File tools — specialized tools for file management and OS automation.
 *
 * These supplement the base tools (bash, read, write, etc.) with desktop-specific
 * capabilities like Spotlight search, opening files, and clipboard access.
 */

import { tool } from "ai";
import { z } from "zod";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, type Stats } from "node:fs";
import { resolve, basename, dirname, extname, isAbsolute, relative, join } from "node:path";
import { assessRisk, requestConsent } from "./consent.js";
import type { EngineContext } from "./engine.js";

const execFileAsync = promisify(execFile);

// ─── Schemas ────────────────────────────────────────────────────────────────

const openSchema = z.object({
  path: z.string().describe("Absolute path to a file, folder, or URL to open"),
  app: z.string().optional().describe("Optional application name to open with (e.g. 'Visual Studio Code', 'Preview')"),
});

const spotlightSchema = z.object({
  query: z.string().describe("Search query — can be a filename, file type, or content keyword"),
  directory: z.string().optional().describe("Optional directory to scope the search to (default: user home)"),
  kind: z.string().optional().describe("Optional file kind filter: pdf, image, document, folder, presentation, music, movie"),
  limit: z.number().optional().describe("Max results to return (default: 20)"),
});

const desktopSearchSchema = z.object({
  query: z.string().describe("Filename, partial name, extension, or descriptive term to locate."),
  directory: z.string().optional().describe("Optional directory to search first. Defaults to cwd, then home."),
  kind: z.string().optional().describe("Optional kind: pdf, image, document, folder, presentation, music, movie, code, archive"),
  limit: z.number().int().positive().max(50).optional().describe("Max ranked candidates to return."),
  preferRecent: z.boolean().optional().describe("Prefer recently modified matches."),
});

const inspectPathSchema = z.object({
  path: z.string().describe("Path to inspect and verify."),
});

const selectCandidateSchema = z.object({
  id: z.string().optional().describe("Candidate id from desktop_search."),
  path: z.string().optional().describe("Explicit path if no candidate id is available."),
  expectedQuery: z.string().optional().describe("Original query or expected filename for match validation."),
});

const verifyActionSchema = z.object({
  action: z.enum(["locate", "open", "move", "copy", "trash", "write", "other"]).optional(),
  target: z.string().describe("Path to verify after the operation."),
  expectedExists: z.boolean().optional().describe("Whether target should exist after the operation. Defaults to true."),
});

const clipboardReadSchema = z.object({
  format: z.enum(["text", "info"]).optional().describe("What to read: 'text' for clipboard content, 'info' for metadata (default: text)"),
});

const clipboardWriteSchema = z.object({
  text: z.string().describe("Text to copy to the clipboard"),
});

const fileMoveSchema = z.object({
  source: z.string().describe("Source file or folder path"),
  destination: z.string().describe("Destination path (file or directory)"),
  overwrite: z.boolean().optional().describe("Allow overwriting an existing destination path."),
});

const fileCopySchema = z.object({
  source: z.string().describe("Source file or folder path"),
  destination: z.string().describe("Destination path (file or directory)"),
  overwrite: z.boolean().optional().describe("Allow overwriting an existing destination path."),
});

const trashSchema = z.object({
  path: z.string().describe("Path to move to Trash (safer than rm)"),
});

const diskUsageSchema = z.object({
  path: z.string().optional().describe("Path to check disk usage for (default: home directory)"),
});

const previewSchema = z.object({
  path: z.string().describe("Exact path to preview before opening, moving, copying, or reporting."),
  maxBytes: z.number().int().positive().max(200_000).optional(),
  maxEntries: z.number().int().positive().max(200).optional(),
});

const recentSchema = z.object({
  directory: z.string().optional().describe("Directory to scan. Defaults to cwd first, then home."),
  kind: z.string().optional().describe("Optional kind filter: pdf, image, document, folder, presentation, music, movie, code, archive"),
  limit: z.number().int().positive().max(50).optional(),
  sinceDays: z.number().positive().max(3650).optional(),
});

const operationPlanSchema = z.object({
  action: z.enum(["open", "move", "copy", "trash", "rename", "clipboard_read", "clipboard_write", "other"]),
  source: z.string().optional().describe("Source path for path operations."),
  destination: z.string().optional().describe("Destination path for move/copy/rename operations."),
  overwrite: z.boolean().optional(),
});

const batchPlanSchema = z.object({
  action: z.enum(["move", "copy", "trash", "open", "other"]),
  paths: z.array(z.string()).min(1).max(100).describe("Explicit paths or candidate paths."),
  destinationDir: z.string().optional().describe("Destination directory for move/copy batch operations."),
  overwrite: z.boolean().optional(),
});

export interface DesktopCandidate {
  id: string;
  path: string;
  basename: string;
  extension: string;
  kind: string;
  size: number | null;
  mtimeMs: number;
  source: "cwd" | "home" | "specified" | "spotlight";
  score: number;
  matchReason: string;
}

// ─── Tool Factory ───────────────────────────────────────────────────────────

export function createDesktopTools(cwd: string) {
  return createDesktopToolsWithContext({ cwd });
}

export function createDesktopToolsWithContext(ctx: Pick<EngineContext, "cwd" | "onConsent">) {
  const cwd = ctx.cwd;
  const home = process.env.HOME ?? "/tmp";
  const lastCandidates = new Map<string, DesktopCandidate>();

  return {
    open: tool({
      description: [
        "Open a file, folder, or URL with the default system application.",
        "On macOS uses `open`, on Linux uses `xdg-open`.",
        "Optionally specify an application name to open with.",
      ].join("\n"),
      inputSchema: openSchema,
      execute: async (input: z.infer<typeof openSchema>) => {
        const isWebUrl = isUrl(input.path);
        const target = isWebUrl ? input.path : resolveDesktopPath(cwd, input.path);
        if (!isWebUrl) {
          const allowed = await guardPathAccess(ctx, "open", target, "Open file/folder");
          if (allowed) return allowed;
        }
        if (!isWebUrl && !existsSync(target)) {
          return `Error: path not found — ${target}`;
        }
        const command = process.platform === "darwin" ? "open" : "xdg-open";
        const args = process.platform === "darwin" && input.app
          ? ["-a", input.app, target]
          : [target];
        try {
          await execFileAsync(command, args, { timeout: 10_000 });
          return `Opened: ${input.path}${input.app ? ` with ${input.app}` : ""}`;
        } catch (err: unknown) {
          const e = err as { stderr?: string; message?: string };
          return `Error opening: ${e.stderr ?? e.message ?? "Unknown error"}`;
        }
      },
    }),

    desktop_search: tool({
      description: [
        "Search for local files/folders and return ranked structured candidates.",
        "Default order is current working directory first, then the user's home directory.",
        "Use this instead of choosing the first Spotlight result. Follow with desktop_select_candidate or desktop_inspect_path.",
      ].join("\n"),
      inputSchema: desktopSearchSchema,
      execute: async (input: z.infer<typeof desktopSearchSchema>) => {
        const limit = input.limit ?? 12;
        const roots: Array<{ path: string; source: DesktopCandidate["source"]; maxFiles: number }> = input.directory
          ? [{ path: resolveDesktopPath(cwd, input.directory), source: "specified", maxFiles: 8_000 }]
          : [
              { path: cwd, source: "cwd", maxFiles: 8_000 },
              { path: home, source: "home", maxFiles: 12_000 },
            ];

        const all: DesktopCandidate[] = [];
        for (const root of roots) {
          const allowed = await guardPathAccess(ctx, "desktop_search", root.path, "Search files");
          if (allowed) return allowed;
          if (!existsSync(root.path)) continue;
          all.push(...collectDesktopCandidates(root.path, root.source, input.query, input.kind, root.maxFiles));
          if (all.length >= limit * 3 && root.source === "cwd") break;
        }

        const deduped = dedupeCandidates(all);
        const ranked = rankCandidates(deduped, input.query, input.preferRecent).slice(0, limit);
        lastCandidates.clear();
        ranked.forEach((candidate, index) => {
          candidate.id = `d${index + 1}`;
          lastCandidates.set(candidate.id, candidate);
        });

        if (ranked.length === 0) {
          return `Found 0 candidate(s) for "${input.query}". Search order: ${roots.map((root) => root.source).join(" -> ")}.`;
        }

        return [
          `Found ${ranked.length} ranked candidate(s) for "${input.query}".`,
          `Search order: ${roots.map((root) => root.source).join(" -> ")}`,
          `Ambiguity: ${ranked.length > 1 && Math.abs(ranked[0]!.score - ranked[1]!.score) < 12 ? "high - ask the user before acting" : "low"}`,
          "",
          ...ranked.map((candidate) => renderCandidate(candidate, cwd)),
          "",
          "Structured candidates:",
          JSON.stringify(ranked, null, 2),
        ].join("\n");
      },
    }),

    desktop_inspect_path: tool({
      description: "Inspect and verify one exact file/folder path. Use before reporting a located path or before acting on it.",
      inputSchema: inspectPathSchema,
      execute: async (input: z.infer<typeof inspectPathSchema>) => {
        const target = resolveDesktopPath(cwd, input.path);
        const allowed = await guardPathAccess(ctx, "desktop_inspect_path", target, "Inspect path");
        if (allowed) return allowed;
        return inspectPath(target, cwd);
      },
    }),

    desktop_preview: tool({
      description: [
        "Preview an exact path before acting or reporting it.",
        "For text files returns a bounded text preview; for directories returns sampled entries.",
        "Use this to avoid opening/moving the wrong file when names are similar.",
      ].join("\n"),
      inputSchema: previewSchema,
      execute: async (input: z.infer<typeof previewSchema>) => {
        const target = resolveDesktopPath(cwd, input.path);
        const allowed = await guardPathAccess(ctx, "desktop_preview", target, "Preview path");
        if (allowed) return allowed;
        if (!existsSync(target)) return `Preview failed: path does not exist - ${target}`;
        return previewPath(target, cwd, input.maxBytes ?? 32_000, input.maxEntries ?? 40);
      },
    }),

    desktop_recent: tool({
      description: [
        "List recently modified files/folders as structured candidates.",
        "Useful when the user asks for the latest/recent file or when name matching is ambiguous.",
      ].join("\n"),
      inputSchema: recentSchema,
      execute: async (input: z.infer<typeof recentSchema>) => {
        const roots: Array<{ path: string; source: DesktopCandidate["source"]; maxFiles: number }> = input.directory
          ? [{ path: resolveDesktopPath(cwd, input.directory), source: "specified", maxFiles: 8_000 }]
          : [
              { path: cwd, source: "cwd", maxFiles: 8_000 },
              { path: home, source: "home", maxFiles: 12_000 },
            ];
        const limit = input.limit ?? 12;
        const sinceMs = input.sinceDays ? Date.now() - input.sinceDays * 86_400_000 : 0;
        const candidates: DesktopCandidate[] = [];
        for (const root of roots) {
          const allowed = await guardPathAccess(ctx, "desktop_recent", root.path, "Inspect recent files");
          if (allowed) return allowed;
          if (!existsSync(root.path)) continue;
          candidates.push(...collectRecentCandidates(root.path, root.source, input.kind, root.maxFiles, sinceMs));
        }
        const ranked = dedupeCandidates(candidates)
          .sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path))
          .slice(0, limit)
          .map((candidate, index) => ({ ...candidate, id: `r${index + 1}` }));
        ranked.forEach((candidate) => lastCandidates.set(candidate.id, candidate));
        return [
          `Recent candidates: ${ranked.length}`,
          input.kind ? `Kind filter: ${input.kind}` : "",
          input.sinceDays ? `Since: ${input.sinceDays} day(s)` : "",
          "",
          ...ranked.map((candidate) => renderCandidate(candidate, cwd)),
          "",
          "Structured candidates:",
          JSON.stringify(ranked, null, 2),
        ].filter(Boolean).join("\n");
      },
    }),

    desktop_operation_plan: tool({
      description: [
        "Dry-run a desktop file/OS operation and report preconditions, risks, and required approvals.",
        "Use before open/move/copy/trash/rename when the exact path or postcondition matters.",
      ].join("\n"),
      inputSchema: operationPlanSchema,
      execute: async (input: z.infer<typeof operationPlanSchema>) => {
        const source = input.source ? resolveDesktopPath(cwd, input.source) : undefined;
        const destination = input.destination ? resolveDesktopPath(cwd, input.destination) : undefined;
        if (source) {
          const allowed = await guardPathAccess(ctx, "desktop_operation_plan", source, "Plan source path operation");
          if (allowed) return allowed;
        }
        if (destination) {
          const allowed = await guardPathAccess(ctx, "desktop_operation_plan", destination, "Plan destination path operation");
          if (allowed) return allowed;
        }
        return renderOperationPlan(ctx.cwd, input.action, source, destination, Boolean(input.overwrite));
      },
    }),

    desktop_batch_plan: tool({
      description: [
        "Dry-run a batch desktop operation over explicit paths.",
        "Reports missing paths, destination collisions, and whether consent is needed before mutation.",
      ].join("\n"),
      inputSchema: batchPlanSchema,
      execute: async (input: z.infer<typeof batchPlanSchema>) => {
        const destinationDir = input.destinationDir ? resolveDesktopPath(cwd, input.destinationDir) : undefined;
        if (destinationDir) {
          const allowed = await guardPathAccess(ctx, "desktop_batch_plan", destinationDir, "Plan batch destination");
          if (allowed) return allowed;
        }
        const planned: string[] = [];
        const issues: string[] = [];
        for (const raw of input.paths) {
          const source = resolveDesktopPath(cwd, raw);
          const allowed = await guardPathAccess(ctx, "desktop_batch_plan", source, "Plan batch source");
          if (allowed) return allowed;
          if (!existsSync(source)) {
            issues.push(`missing: ${source}`);
            continue;
          }
          const destination = destinationDir ? join(destinationDir, basename(source)) : undefined;
          planned.push(renderOperationPlan(ctx.cwd, input.action, source, destination, Boolean(input.overwrite)));
        }
        return [
          `Batch operation plan: ${input.action}`,
          `Items: ${input.paths.length}`,
          destinationDir ? `Destination directory: ${destinationDir}` : "",
          issues.length ? `Issues:\n${issues.map((issue) => `- ${issue}`).join("\n")}` : "Issues: none",
          "",
          planned.join("\n\n---\n\n"),
        ].filter(Boolean).join("\n");
      },
    }),

    desktop_select_candidate: tool({
      description: "Select and verify a candidate from desktop_search by id, or verify an explicit path.",
      inputSchema: selectCandidateSchema,
      execute: async (input: z.infer<typeof selectCandidateSchema>) => {
        const candidate = input.id ? lastCandidates.get(input.id) : undefined;
        const target = candidate?.path ?? (input.path ? resolveDesktopPath(cwd, input.path) : "");
        if (!target) return "Error: provide a candidate id from desktop_search or an explicit path.";
        const allowed = await guardPathAccess(ctx, "desktop_select_candidate", target, "Select candidate");
        if (allowed) return allowed;
        if (!existsSync(target)) return `Selection failed: path does not exist - ${target}`;
        const mismatch = input.expectedQuery && !candidateMatchesQuery(target, input.expectedQuery)
          ? `\nWarning: selected path does not strongly match expected query "${input.expectedQuery}".`
          : "";
        return [
          "Selected candidate verified.",
          candidate ? renderCandidate(candidate, cwd) : inspectPath(target, cwd),
          mismatch,
        ].filter(Boolean).join("\n");
      },
    }),

    desktop_verify_action: tool({
      description: "Verify a desktop action postcondition, such as a located/opened/moved/copied/trashed path.",
      inputSchema: verifyActionSchema,
      execute: async (input: z.infer<typeof verifyActionSchema>) => {
        const target = resolveDesktopPath(cwd, input.target);
        const expectedExists = input.expectedExists ?? true;
        const allowed = await guardPathAccess(ctx, "desktop_verify_action", target, "Verify desktop action");
        if (allowed) return allowed;
        const exists = existsSync(target);
        const ok = exists === expectedExists;
        return [
          `Desktop action verification: ${ok ? "passed" : "failed"}`,
          `Action: ${input.action ?? "other"}`,
          `Target: ${target}`,
          `Expected exists: ${expectedExists}`,
          `Actual exists: ${exists}`,
          exists ? inspectPath(target, cwd) : "",
        ].filter(Boolean).join("\n");
      },
    }),

    spotlight: tool({
      description: [
        "Search for files using macOS Spotlight (mdfind) or `find` on Linux.",
        "Prefer desktop_search for agentic tasks because it returns ranked candidates and match reasons.",
        "Supports filename search, content search, and file kind filtering.",
        "Kinds: pdf, image, document, folder, presentation, music, movie.",
      ].join("\n"),
      inputSchema: spotlightSchema,
      execute: async (input: z.infer<typeof spotlightSchema>) => {
        const dir = input.directory ? resolveDesktopPath(cwd, input.directory) : home;
        const limit = input.limit ?? 20;
        const allowed = await guardPathAccess(ctx, "spotlight", dir, "Search files");
        if (allowed) return allowed;

        if (process.platform === "darwin") {
          const kindMap: Record<string, string> = {
            pdf: "kMDItemContentType == 'com.adobe.pdf'",
            image: "kMDItemContentTypeTree == 'public.image'",
            document: "kMDItemContentTypeTree == 'public.content'",
            folder: "kMDItemContentType == 'public.folder'",
            presentation: "kMDItemContentTypeTree == 'public.presentation'",
            music: "kMDItemContentTypeTree == 'public.audio'",
            movie: "kMDItemContentTypeTree == 'public.movie'",
          };
          const args = input.kind && kindMap[input.kind]
            ? ["-onlyin", dir, `${kindMap[input.kind]} && kMDItemDisplayName == "*${escapeSpotlightString(input.query)}*"c`]
            : ["-onlyin", dir, "-name", input.query];

          try {
            const { stdout } = await execFileAsync("mdfind", args, { timeout: 15_000, maxBuffer: 5 * 1024 * 1024 });
            const files = stdout.trim().split("\n").filter(Boolean).slice(0, limit);
            if (files.length === 0) return `No files found matching "${input.query}" in ${dir}`;

            const results = files.map((f) => {
              try {
                const st = statSync(f);
                const size = st.isDirectory() ? "dir" : `${(st.size / 1024).toFixed(1)} KB`;
                return `  ${f}  (${size})`;
              } catch {
                return `  ${f}`;
              }
            });
            return `Found ${files.length} result(s):\n${results.join("\n")}`;
          } catch {
            return `No files found matching "${input.query}" in ${dir}`;
          }
        } else {
          try {
            const { stdout } = await execFileAsync(
              "find",
              [dir, "-maxdepth", "5", "-iname", `*${input.query}*`],
              { timeout: 15_000, maxBuffer: 5 * 1024 * 1024 },
            );
            const files = stdout.trim().split("\n").filter(Boolean)
              .filter((file) => kindMatches(file, input.kind))
              .slice(0, limit);
            if (files.length === 0) return `No files found matching "${input.query}" in ${dir}`;
            return `Found ${files.length} result(s):\n${files.map((f) => `  ${f}`).join("\n")}`;
          } catch {
            return `No files found matching "${input.query}" in ${dir}`;
          }
        }
      },
    }),

    clipboard_read: tool({
      description: "Read the current system clipboard contents.",
      inputSchema: clipboardReadSchema,
      execute: async (input: z.infer<typeof clipboardReadSchema>) => {
        const blocked = await guardConsent(ctx, "clipboard_read", "Read current system clipboard contents.", "medium");
        if (blocked) return blocked;
        const command = process.platform === "darwin" ? "pbpaste" : "xclip";
        const args = process.platform === "darwin" ? [] : ["-selection", "clipboard", "-o"];
        try {
          const { stdout } = await execFileAsync(command, args, { timeout: 5_000 });
          if (!stdout.trim()) return "Clipboard is empty.";
          const content = stdout.length > 5000 ? stdout.slice(0, 5000) + "\n…(truncated)" : stdout;
          return `Clipboard contents:\n${content}`;
        } catch (err: unknown) {
          return `Error reading clipboard: ${(err as Error).message}`;
        }
      },
    }),

    clipboard_write: tool({
      description: "Write text to the system clipboard.",
      inputSchema: clipboardWriteSchema,
      execute: async (input: z.infer<typeof clipboardWriteSchema>) => {
        const blocked = await guardConsent(ctx, "clipboard_write", `Overwrite clipboard with ${input.text.length} character(s).`, "medium");
        if (blocked) return blocked;
        const command = process.platform === "darwin" ? "pbcopy" : "xclip";
        const args = process.platform === "darwin" ? [] : ["-selection", "clipboard"];
        try {
          await writeToProcess(command, args, input.text);
          return `Copied ${input.text.length} characters to clipboard.`;
        } catch (err: unknown) {
          return `Error writing to clipboard: ${(err as Error).message}`;
        }
      },
    }),

    file_move: tool({
      description: "Move or rename a file or folder. Creates destination directories if needed.",
      inputSchema: fileMoveSchema,
      execute: async (input: z.infer<typeof fileMoveSchema>) => {
        const src = resolveDesktopPath(cwd, input.source);
        const dst = resolveDesktopPath(cwd, input.destination);
        const sourceAllowed = await guardPathAccess(ctx, "file_move", src, "Move source path");
        if (sourceAllowed) return sourceAllowed;
        const destinationAllowed = await guardPathAccess(ctx, "file_move", dst, "Move destination path");
        if (destinationAllowed) return destinationAllowed;
        if (!existsSync(src)) return `Error: source not found — ${src}`;
        if (existsSync(dst) && !input.overwrite) return `Error: destination exists — ${dst}. Set overwrite=true to replace it.`;
        if (existsSync(dst) && input.overwrite) {
          const blocked = await guardConsent(ctx, "file_move overwrite", `Overwrite destination path: ${dst}`, "high");
          if (blocked) return blocked;
        }
        try {
          mkdirSync(dirname(dst), { recursive: true });
          renameSync(src, dst);
          return `Moved: ${basename(src)} → ${dst}`;
        } catch (err: unknown) {
          return `Error moving file: ${(err as Error).message}`;
        }
      },
    }),

    file_copy: tool({
      description: "Copy a file or folder after exact source/destination verification. Creates destination directories if needed.",
      inputSchema: fileCopySchema,
      execute: async (input: z.infer<typeof fileCopySchema>) => {
        const src = resolveDesktopPath(cwd, input.source);
        const dst = resolveDesktopPath(cwd, input.destination);
        const sourceAllowed = await guardPathAccess(ctx, "file_copy", src, "Copy source path");
        if (sourceAllowed) return sourceAllowed;
        const destinationAllowed = await guardPathAccess(ctx, "file_copy", dst, "Copy destination path");
        if (destinationAllowed) return destinationAllowed;
        if (!existsSync(src)) return `Error: source not found — ${src}`;
        if (existsSync(dst) && !input.overwrite) return `Error: destination exists — ${dst}. Set overwrite=true to replace it.`;
        if (existsSync(dst) && input.overwrite) {
          const blocked = await guardConsent(ctx, "file_copy overwrite", `Overwrite destination path: ${dst}`, "high");
          if (blocked) return blocked;
        }
        try {
          mkdirSync(dirname(dst), { recursive: true });
          cpSync(src, dst, { recursive: true, force: Boolean(input.overwrite), errorOnExist: !input.overwrite });
          return [
            `Copied: ${basename(src)} -> ${dst}`,
            "Postcondition: run desktop_verify_action on the destination path before finalizing.",
          ].join("\n");
        } catch (err: unknown) {
          return `Error copying file: ${(err as Error).message}`;
        }
      },
    }),

    trash: tool({
      description: "Move a file or folder to the system Trash. Requires approval and never permanently deletes.",
      inputSchema: trashSchema,
      execute: async (input: z.infer<typeof trashSchema>) => {
        const target = resolveDesktopPath(cwd, input.path);
        const allowed = await guardPathAccess(ctx, "trash", target, "Move path to trash");
        if (allowed) return allowed;
        if (!existsSync(target)) return `Error: not found — ${target}`;
        const blocked = await guardConsent(ctx, "trash", `Move to system Trash: ${target}`, "high");
        if (blocked) return blocked;
        try {
          if (process.platform === "darwin") {
            await execFileAsync("osascript", [
              "-e", "on run argv",
              "-e", "tell application \"Finder\" to move POSIX file (item 1 of argv) to trash",
              "-e", "end run",
              target,
            ], { timeout: 10_000 });
          } else {
            await execFileAsync("gio", ["trash", target], { timeout: 10_000 });
          }
          return `Moved to trash: ${basename(target)}`;
        } catch (err: unknown) {
          return `Error trashing safely: ${(err as Error).message}`;
        }
      },
    }),

    disk_usage: tool({
      description: "Check disk usage and available space for a path.",
      inputSchema: diskUsageSchema,
      execute: async (input: z.infer<typeof diskUsageSchema>) => {
        const target = input.path ? resolveDesktopPath(cwd, input.path) : home;
        const allowed = await guardPathAccess(ctx, "disk_usage", target, "Check disk usage");
        if (allowed) return allowed;
        try {
          const [df, du] = await Promise.all([
            execFileAsync("df", ["-h", target], { timeout: 10_000 }),
            execFileAsync("du", ["-sh", target], { timeout: 10_000 }).catch((err: unknown) => ({ stdout: `du unavailable: ${(err as Error).message}` })),
          ]);
          return `${df.stdout.trim()}\n---\n${du.stdout.trim()}`;
        } catch (err: unknown) {
          return `Error checking disk: ${(err as Error).message}`;
        }
      },
    }),
  };
}

function resolveDesktopPath(cwd: string, path: string): string {
  if (path === "~") return process.env.HOME ?? cwd;
  if (path.startsWith("~/")) return resolve(process.env.HOME ?? cwd, path.slice(2));
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function isUrl(value: string): boolean {
  return /^(https?|file):\/\//i.test(value);
}

function isInside(root: string, child: string): boolean {
  const rel = relative(resolve(root), resolve(child));
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

async function guardPathAccess(
  ctx: Pick<EngineContext, "cwd" | "onConsent">,
  action: string,
  path: string,
  detail: string,
): Promise<string | null> {
  const home = process.env.HOME ?? ctx.cwd;
  if (isInside(ctx.cwd, path) || isInside(home, path)) return null;
  return await guardConsent(
    ctx,
    action,
    `${detail}: ${path}\nThis path is outside the working directory and home directory.`,
    "high",
  );
}

async function guardConsent(
  ctx: Pick<EngineContext, "onConsent">,
  action: string,
  detail: string,
  fallbackRisk: "medium" | "high" | "critical",
): Promise<string | null> {
  const assessed = assessRisk(`${action}\n${detail}`);
  const risk = assessed.risk === "low" ? fallbackRisk : assessed.risk;
  const approved = ctx.onConsent
    ? await ctx.onConsent(action, detail)
    : await requestConsent({ action, detail, risk, engine: "desktop" });
  return approved ? null : `Action blocked by consent gate: ${action}`;
}

function escapeSpotlightString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function kindMatches(path: string, kind?: string): boolean {
  if (!kind) return true;
  const ext = path.toLowerCase().slice(path.lastIndexOf("."));
  if (kind === "pdf") return ext === ".pdf";
  if (kind === "image") return [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".heic"].includes(ext);
  if (kind === "document") return [".doc", ".docx", ".txt", ".rtf", ".md", ".pdf"].includes(ext);
  if (kind === "presentation") return [".ppt", ".pptx", ".key"].includes(ext);
  if (kind === "music") return [".mp3", ".wav", ".flac", ".aac", ".m4a", ".ogg"].includes(ext);
  if (kind === "movie") return [".mp4", ".mov", ".mkv", ".avi", ".webm"].includes(ext);
  if (kind === "code") return [".ts", ".tsx", ".js", ".jsx", ".py", ".rb", ".go", ".rs", ".java", ".cs", ".php"].includes(ext);
  if (kind === "archive") return [".zip", ".tar", ".gz", ".rar", ".7z"].includes(ext);
  if (kind === "folder") {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  }
  return true;
}

function collectDesktopCandidates(
  root: string,
  source: DesktopCandidate["source"],
  query: string,
  kind: string | undefined,
  maxFiles: number,
): DesktopCandidate[] {
  const results: DesktopCandidate[] = [];
  const stack = [root];
  const queryLower = query.toLowerCase().trim();
  let visited = 0;

  while (stack.length && visited < maxFiles) {
    const current = stack.pop()!;
    let st: Stats;
    try {
      st = statSync(current);
      visited++;
    } catch {
      continue;
    }

    const name = basename(current);
    if (shouldSkipEntry(name, current, root)) continue;

    if (st.isDirectory()) {
      if (candidateMatchesQuery(current, query) && kindMatches(current, kind)) {
        results.push(toCandidate(current, st, source, queryLower));
      }
      let entries: Array<{ name: string }>;
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries.reverse()) {
        if (shouldSkipEntry(entry.name, join(current, entry.name), root)) continue;
        stack.push(join(current, entry.name));
      }
      continue;
    }

    if (!kindMatches(current, kind)) continue;
    if (!candidateMatchesQuery(current, query)) continue;
    results.push(toCandidate(current, st, source, queryLower));
  }

  return results;
}

function toCandidate(
  path: string,
  st: Stats,
  source: DesktopCandidate["source"],
  queryLower: string,
): DesktopCandidate {
  const name = basename(path);
  const lower = name.toLowerCase();
  const stem = lower.replace(/\.[^.]+$/, "");
  const exact = lower === queryLower || stem === queryLower;
  const starts = lower.startsWith(queryLower) || stem.startsWith(queryLower);
  const includes = lower.includes(queryLower) || path.toLowerCase().includes(queryLower);
  const sourceBoost = source === "cwd" ? 24 : source === "specified" ? 30 : 0;
  const score =
    sourceBoost +
    (exact ? 70 : starts ? 48 : includes ? 28 : 0) +
    (st.isDirectory() ? 4 : 0) +
    recencyScore(st.mtimeMs);
  const matchReason = exact
    ? "exact basename match"
    : starts
      ? "basename starts with query"
      : includes
        ? "path or basename contains query"
        : "weak metadata match";
  return {
    id: "",
    path,
    basename: name,
    extension: st.isDirectory() ? "" : extname(path).toLowerCase(),
    kind: st.isDirectory() ? "folder" : kindFromPath(path),
    size: st.isDirectory() ? null : st.size,
    mtimeMs: st.mtimeMs,
    source,
    score,
    matchReason,
  };
}

function rankCandidates(candidates: DesktopCandidate[], query: string, preferRecent?: boolean): DesktopCandidate[] {
  const queryLower = query.toLowerCase().trim();
  return [...candidates].sort((a, b) => {
    if (preferRecent) return b.mtimeMs - a.mtimeMs || b.score - a.score;
    const aExact = a.basename.toLowerCase() === queryLower ? 1 : 0;
    const bExact = b.basename.toLowerCase() === queryLower ? 1 : 0;
    return bExact - aExact || b.score - a.score || b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path);
  });
}

function dedupeCandidates(candidates: DesktopCandidate[]): DesktopCandidate[] {
  const seen = new Set<string>();
  const result: DesktopCandidate[] = [];
  for (const candidate of candidates) {
    const key = resolve(candidate.path);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

function renderCandidate(candidate: DesktopCandidate, cwd: string): string {
  const size = candidate.size == null ? "dir" : `${(candidate.size / 1024).toFixed(1)} KB`;
  const modified = new Date(candidate.mtimeMs).toISOString();
  return [
    `[${candidate.id}] ${candidate.path}`,
    `  basename=${candidate.basename} kind=${candidate.kind} size=${size} source=${candidate.source} score=${candidate.score.toFixed(1)}`,
    `  modified=${modified}`,
    `  match=${candidate.matchReason}`,
    `  relative=${relative(cwd, candidate.path) || "."}`,
  ].join("\n");
}

function inspectPath(target: string, cwd: string): string {
  if (!existsSync(target)) return `Path verification failed: ${target} does not exist.`;
  const st = statSync(target);
  return [
    "Path verified.",
    `Path: ${target}`,
    `Relative: ${relative(cwd, target) || "."}`,
    `Type: ${st.isDirectory() ? "directory" : "file"}`,
    `Kind: ${st.isDirectory() ? "folder" : kindFromPath(target)}`,
    `Size: ${st.isDirectory() ? "dir" : `${(st.size / 1024).toFixed(1)} KB`}`,
    `Modified: ${new Date(st.mtimeMs).toISOString()}`,
  ].join("\n");
}

function previewPath(target: string, cwd: string, maxBytes: number, maxEntries: number): string {
  const st = statSync(target);
  const header = [
    "Path preview.",
    `Path: ${target}`,
    `Relative: ${relative(cwd, target) || "."}`,
    `Type: ${st.isDirectory() ? "directory" : "file"}`,
    `Kind: ${st.isDirectory() ? "folder" : kindFromPath(target)}`,
    `Size: ${st.isDirectory() ? "dir" : `${(st.size / 1024).toFixed(1)} KB`}`,
    `Modified: ${new Date(st.mtimeMs).toISOString()}`,
  ];
  if (st.isDirectory()) {
    let entries: string[] = [];
    try {
      entries = readdirSync(target)
        .filter((name) => !shouldSkipEntry(name, join(target, name), target))
        .slice(0, maxEntries);
    } catch (err) {
      return [...header, `Preview error: ${(err as Error).message}`].join("\n");
    }
    return [
      ...header,
      `Entries sampled: ${entries.length}`,
      ...entries.map((name) => `- ${name}`),
    ].join("\n");
  }
  if (isLikelyBinary(target, st)) {
    return [...header, "Preview: binary or non-text file; metadata only."].join("\n");
  }
  try {
    const content = readFileSync(target, "utf-8");
    const truncated = content.length > maxBytes;
    const preview = truncated ? content.slice(0, maxBytes) : content;
    return [
      ...header,
      `Preview bytes: ${Math.min(content.length, maxBytes)}${truncated ? ` of ${content.length} (truncated)` : ""}`,
      "",
      preview,
    ].join("\n");
  } catch (err) {
    return [...header, `Preview error: ${(err as Error).message}`].join("\n");
  }
}

function collectRecentCandidates(
  root: string,
  source: DesktopCandidate["source"],
  kind: string | undefined,
  maxFiles: number,
  sinceMs: number,
): DesktopCandidate[] {
  const results: DesktopCandidate[] = [];
  const stack = [root];
  let visited = 0;
  while (stack.length && visited < maxFiles) {
    const current = stack.pop()!;
    let st: Stats;
    try {
      st = statSync(current);
      visited++;
    } catch {
      continue;
    }
    const name = basename(current);
    if (shouldSkipEntry(name, current, root)) continue;
    if (st.isDirectory()) {
      let entries: Array<{ name: string }>;
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch {
        entries = [];
      }
      for (const entry of entries.reverse()) {
        if (shouldSkipEntry(entry.name, join(current, entry.name), root)) continue;
        stack.push(join(current, entry.name));
      }
      if (kind !== "folder") continue;
    }
    if (sinceMs && st.mtimeMs < sinceMs) continue;
    if (!kindMatches(current, kind)) continue;
    const candidate = toCandidate(current, st, source, basename(current).toLowerCase());
    candidate.matchReason = "recent modification";
    results.push(candidate);
  }
  return results;
}

function renderOperationPlan(
  cwd: string,
  action: string,
  source: string | undefined,
  destination: string | undefined,
  overwrite: boolean,
): string {
  const sourceExists = source ? existsSync(source) : undefined;
  const destinationExists = destination ? existsSync(destination) : undefined;
  const mutates = ["move", "copy", "trash", "rename", "clipboard_write"].includes(action);
  const needsOverwriteApproval = Boolean(destinationExists && overwrite);
  const blockedByCollision = Boolean(destinationExists && !overwrite);
  const lines = [
    `Operation plan: ${action}`,
    source ? `Source: ${source}` : "",
    source ? `Source exists: ${sourceExists}` : "",
    source && sourceExists ? `Source relative: ${relative(cwd, source) || "."}` : "",
    destination ? `Destination: ${destination}` : "",
    destination ? `Destination exists: ${destinationExists}` : "",
    `Mutating: ${mutates}`,
    `Consent needed: ${mutates || needsOverwriteApproval}`,
    blockedByCollision ? "Blocked: destination exists and overwrite=false." : "",
    !sourceExists && source ? "Blocked: source path is missing." : "",
    "Required verification after action: desktop_verify_action with the exact target path.",
  ];
  return lines.filter(Boolean).join("\n");
}

function isLikelyBinary(path: string, st: Stats): boolean {
  if (st.size > 2 * 1024 * 1024) return true;
  return ["image", "movie", "music", "archive", "pdf", "presentation"].includes(kindFromPath(path));
}

function candidateMatchesQuery(path: string, query: string): boolean {
  const queryLower = query.toLowerCase().trim();
  if (!queryLower) return true;
  const name = basename(path).toLowerCase();
  const stem = name.replace(/\.[^.]+$/, "");
  return name === queryLower || stem === queryLower || name.includes(queryLower) || path.toLowerCase().includes(queryLower);
}

function recencyScore(mtimeMs: number): number {
  const ageDays = Math.max(0, (Date.now() - mtimeMs) / 86_400_000);
  if (ageDays <= 1) return 12;
  if (ageDays <= 7) return 8;
  if (ageDays <= 30) return 4;
  return 0;
}

function kindFromPath(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".heic"].includes(ext)) return "image";
  if ([".doc", ".docx", ".txt", ".rtf", ".md"].includes(ext)) return "document";
  if ([".ppt", ".pptx", ".key"].includes(ext)) return "presentation";
  if ([".mp3", ".wav", ".flac", ".aac", ".m4a", ".ogg"].includes(ext)) return "music";
  if ([".mp4", ".mov", ".mkv", ".avi", ".webm"].includes(ext)) return "movie";
  if ([".ts", ".tsx", ".js", ".jsx", ".py", ".rb", ".go", ".rs", ".java", ".cs", ".php"].includes(ext)) return "code";
  if ([".zip", ".tar", ".gz", ".rar", ".7z"].includes(ext)) return "archive";
  return ext ? ext.slice(1) : "file";
}

function shouldSkipEntry(name: string, path: string, root: string): boolean {
  if ([".git", "node_modules", "dist", "build", ".next", "Library", ".Trash"].includes(name)) return true;
  if (name.startsWith(".") && root !== path) return true;
  return false;
}

function writeToProcess(command: string, args: string[], input: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"] });
    const errors: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer) => errors.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(Buffer.concat(errors).toString("utf-8") || `Command exited with code ${code}`));
    });
    child.stdin.end(input);
  });
}
