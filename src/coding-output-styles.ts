import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, relative, resolve } from "node:path";
import { findServusProjectRoot } from "./coding-project.js";
import { SERVUS_DIR } from "./config.js";

export interface CodingOutputStyle {
  id: string;
  name: string;
  description: string;
  prompt: string;
  source: "project" | "user";
  path: string;
  keepCodingInstructions?: boolean;
  truncated: boolean;
}

const MAX_STYLE_FILES = 60;
const MAX_STYLE_BYTES = 128_000;
const MAX_STYLE_PROMPT_CHARS = 14_000;

export function loadCodingOutputStyles(cwd: string): CodingOutputStyle[] {
  const root = findServusProjectRoot(cwd);
  const dirs = [
    { source: "project" as const, dir: resolve(root, ".servus/output-styles"), displayRoot: root },
    { source: "user" as const, dir: join(SERVUS_DIR, "output-styles"), displayRoot: process.env.HOME || homedir() },
  ];
  const styles: CodingOutputStyle[] = [];
  const seen = new Set<string>();
  for (const item of dirs) {
    for (const style of loadStyleDir(item.dir, item.source, item.displayRoot)) {
      if (seen.has(style.id)) continue;
      seen.add(style.id);
      styles.push(style);
    }
  }
  return styles;
}

export function findCodingOutputStyle(styles: CodingOutputStyle[], requested?: string): CodingOutputStyle | undefined {
  const id = normalizeStyleId(requested ?? "");
  if (!id) return undefined;
  return styles.find((style) => style.id === id || normalizeStyleId(style.name) === id);
}

export function formatCodingOutputStyles(styles: CodingOutputStyle[], active?: CodingOutputStyle): string {
  if (styles.length === 0) {
    return "No Servus output styles found. Add project styles in .servus/output-styles/*.md or user styles in ~/.servus/output-styles/*.md.";
  }
  return [
    "Servus output styles:",
    "",
    ...styles.map((style) => [
      `- ${style.id}${active?.id === style.id ? " [active]" : ""}`,
      `  ${style.description}`,
      `  Source: ${style.source}`,
      `  Path: ${style.path}`,
      style.keepCodingInstructions === false ? "  Replaces optional style guidance only; core safety instructions remain active." : undefined,
      style.truncated ? "  Prompt: truncated by size limit" : undefined,
    ].filter(Boolean).join("\n")),
  ].join("\n");
}

export function setProjectOutputStyle(cwd: string, styleId: string): string {
  const root = findServusProjectRoot(cwd);
  const settingsPath = resolve(root, ".servus/settings.json");
  mkdirSync(resolve(root, ".servus"), { recursive: true });
  let current: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed;
    } catch {
      current = {};
    }
  }
  current.outputStyle = styleId;
  writeFileSync(settingsPath, JSON.stringify(current, null, 2) + "\n", "utf-8");
  return settingsPath;
}

function loadStyleDir(dir: string, source: CodingOutputStyle["source"], displayRoot: string): CodingOutputStyle[] {
  if (!existsSync(dir)) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && [".md", ".markdown"].includes(extname(entry.name).toLowerCase()))
      .slice(0, MAX_STYLE_FILES);
  } catch {
    return [];
  }
  const styles: CodingOutputStyle[] = [];
  for (const entry of entries) {
    const style = readStyleFile(resolve(dir, entry.name), source, displayRoot);
    if (style) styles.push(style);
  }
  return styles;
}

function readStyleFile(path: string, source: CodingOutputStyle["source"], displayRoot: string): CodingOutputStyle | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_STYLE_BYTES) return null;
    const raw = readFileSync(path, "utf-8").trim();
    if (!raw) return null;
    const parsed = parseStyleMarkdown(raw);
    const fallback = basename(path, extname(path));
    const id = normalizeStyleId(String(parsed.frontmatter.id ?? parsed.frontmatter.name ?? fallback));
    if (!id) return null;
    const prompt = parsed.body.slice(0, MAX_STYLE_PROMPT_CHARS).trim();
    if (!prompt) return null;
    return {
      id,
      name: String(parsed.frontmatter.name ?? fallback),
      description: String(parsed.frontmatter.description ?? `Servus output style ${id}`),
      prompt,
      source,
      path: source === "project" ? relative(displayRoot, path) || path : path.replace(displayRoot, "~"),
      keepCodingInstructions: parseBoolean(parsed.frontmatter.keepCodingInstructions ?? parsed.frontmatter.keep_coding_instructions ?? parsed.frontmatter["keep-coding-instructions"]),
      truncated: parsed.body.length > MAX_STYLE_PROMPT_CHARS,
    };
  } catch {
    return null;
  }
}

function parseStyleMarkdown(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  if (!raw.startsWith("---")) return { frontmatter: {}, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: {}, body: raw };
  const frontmatterText = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).trim();
  const frontmatter: Record<string, unknown> = {};
  for (const rawLine of frontmatterText.split(/\r?\n/)) {
    const idx = rawLine.indexOf(":");
    if (idx <= 0) continue;
    const key = rawLine.slice(0, idx).trim();
    const value = rawLine.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
    frontmatter[key] = value;
  }
  return { frontmatter, body };
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && /^(true|false)$/i.test(value)) return /^true$/i.test(value);
  return undefined;
}

function normalizeStyleId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
