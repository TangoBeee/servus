import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, resolve, relative } from "node:path";
import {
  isBlockedDevicePath,
  isWorkspaceExcludedPath,
  pathSuggestion,
  toWorkspaceRelative,
} from "./coding-workspace-policy.js";
import { findServusProjectRoot } from "./coding-project.js";

export interface CodingContextAttachment {
  id: string;
  requested: string;
  path: string;
  absolutePath: string;
  kind: "file" | "directory" | "missing" | "blocked";
  content?: string;
  lineStart?: number;
  lineEnd?: number;
  size?: number;
  truncated: boolean;
  reason?: string;
}

const MAX_ATTACHMENTS = 8;
const MAX_ATTACHMENT_BYTES = 512_000;
const MAX_ATTACHMENT_CHARS = 20_000;
const MAX_ATTACHMENT_LINES = 400;

export function resolveCodingMentions(task: string, cwd: string): CodingContextAttachment[] {
  const mentions = extractMentionSpecs(task).slice(0, MAX_ATTACHMENTS);
  return mentions.map((mention, index) => resolveMention(mention, cwd, index + 1));
}

export function formatCodingAttachments(attachments: CodingContextAttachment[]): string {
  if (attachments.length === 0) return "";
  return [
    "# User-Mentioned Context Attachments",
    "The user explicitly mentioned these paths. Use them as starting context, but still verify before editing.",
    "",
    ...attachments.map((attachment) => formatAttachment(attachment)),
  ].join("\n\n").trim();
}

function extractMentionSpecs(task: string): Array<{ raw: string; path: string; lineStart?: number; lineEnd?: number }> {
  const specs: Array<{ raw: string; path: string; lineStart?: number; lineEnd?: number }> = [];
  const seen = new Set<string>();
  const regex = /(^|[\s([{,])@(?:"([^"]+)"|'([^']+)'|([^\s)\]},;]+))/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(task)) !== null) {
    const rawValue = match[2] ?? match[3] ?? match[4] ?? "";
    const parsed = parseMentionPath(rawValue);
    if (!parsed.path || seen.has(parsed.path)) continue;
    seen.add(parsed.path);
    specs.push({ raw: `@${rawValue}`, ...parsed });
  }
  return specs;
}

function parseMentionPath(raw: string): { path: string; lineStart?: number; lineEnd?: number } {
  let value = raw.trim().replace(/^<|>$/g, "");
  const hashLine = value.match(/^(.*)#L(\d+)(?:-L?(\d+))?$/i);
  if (hashLine?.[1]) {
    value = hashLine[1];
    const lineStart = Number(hashLine[2]);
    const lineEnd = Number(hashLine[3] ?? hashLine[2]);
    return { path: value, lineStart, lineEnd };
  }
  const colonLine = value.match(/^(.*):(\d+)(?:-(\d+))?$/);
  if (colonLine?.[1] && !/^[a-zA-Z]:[\\/]/.test(value)) {
    value = colonLine[1];
    const lineStart = Number(colonLine[2]);
    const lineEnd = Number(colonLine[3] ?? colonLine[2]);
    return { path: value, lineStart, lineEnd };
  }
  return { path: value };
}

function resolveMention(
  mention: { raw: string; path: string; lineStart?: number; lineEnd?: number },
  cwd: string,
  index: number,
): CodingContextAttachment {
  const root = findServusProjectRoot(cwd);
  const candidates = [
    resolve(cwd, mention.path),
    resolve(root, mention.path),
  ];
  const abs = candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
  const workspacePath = toWorkspaceRelative(root, abs);
  const base = {
    id: `mention-${index}`,
    requested: mention.raw,
    path: workspacePath,
    absolutePath: abs,
    lineStart: mention.lineStart,
    lineEnd: mention.lineEnd,
  };

  if (isBlockedDevicePath(abs)) {
    return { ...base, kind: "blocked", truncated: false, reason: "blocked device path" };
  }

  if (!existsSync(abs)) {
    const suggestion = pathSuggestion(root, mention.path) ?? pathSuggestion(cwd, mention.path);
    return {
      ...base,
      kind: "missing",
      truncated: false,
      reason: suggestion ? `not found; did you mean ${suggestion}?` : "not found",
    };
  }

  const stat = statSync(abs);
  if (stat.isDirectory()) {
    return {
      ...base,
      kind: "directory",
      size: stat.size,
      truncated: false,
      reason: "directory mention; use LS/Glob/Read for specific files",
    };
  }

  const excluded = isWorkspaceExcludedPath(root, abs);
  if (excluded.excluded && excluded.reason !== "servus_internal") {
    return {
      ...base,
      kind: "blocked",
      size: stat.size,
      truncated: false,
      reason: `generated/dependency path hidden by workspace policy (${excluded.reason})`,
    };
  }

  if (stat.size > MAX_ATTACHMENT_BYTES) {
    return {
      ...base,
      kind: "blocked",
      size: stat.size,
      truncated: false,
      reason: `file is too large to attach (${(stat.size / 1024).toFixed(1)} KB)`,
    };
  }

  const content = readFileSync(abs, "utf-8");
  const selected = selectLineRange(content, mention.lineStart, mention.lineEnd);
  const truncatedContent = selected.text.length > MAX_ATTACHMENT_CHARS
    ? selected.text.slice(0, MAX_ATTACHMENT_CHARS)
    : selected.text;
  return {
    ...base,
    kind: "file",
    path: toWorkspaceRelative(root, abs),
    size: stat.size,
    content: truncatedContent,
    lineStart: selected.lineStart,
    lineEnd: selected.lineEnd,
    truncated: selected.truncated || truncatedContent.length < selected.text.length,
  };
}

function selectLineRange(content: string, lineStart?: number, lineEnd?: number): {
  text: string;
  lineStart: number;
  lineEnd: number;
  truncated: boolean;
} {
  const lines = content.split(/\r?\n/);
  const start = Math.max(1, lineStart ?? 1);
  const requestedEnd = Math.max(start, lineEnd ?? Math.min(lines.length, start + MAX_ATTACHMENT_LINES - 1));
  const end = Math.min(lines.length, requestedEnd, start + MAX_ATTACHMENT_LINES - 1);
  const text = lines
    .slice(start - 1, end)
    .map((line, idx) => `${String(start + idx).padStart(6)}|${line}`)
    .join("\n");
  return {
    text,
    lineStart: start,
    lineEnd: end,
    truncated: end < requestedEnd || end < lines.length,
  };
}

function formatAttachment(attachment: CodingContextAttachment): string {
  const header = `## ${attachment.requested} -> ${attachment.path}`;
  if (attachment.kind !== "file") {
    return [
      header,
      `Status: ${attachment.kind}`,
      attachment.reason ? `Reason: ${attachment.reason}` : undefined,
    ].filter(Boolean).join("\n");
  }
  return [
    header,
    `Lines: ${attachment.lineStart}-${attachment.lineEnd}${attachment.truncated ? " [truncated]" : ""}`,
    `File: ${attachment.path}`,
    "",
    "```",
    attachment.content ?? "",
    "```",
  ].join("\n");
}

export function mentionDisplayName(path: string): string {
  const name = basename(path) || basename(dirname(path));
  return name || path;
}
