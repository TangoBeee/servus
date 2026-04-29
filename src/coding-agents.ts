import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, relative, resolve } from "node:path";
import { findServusProjectRoot } from "./coding-project.js";

export interface CodingAgentDefinition {
  id: string;
  description: string;
  prompt: string;
  source: "project" | "user";
  path: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  effort?: string;
  maxTurns?: number;
  readOnly: boolean;
  truncated: boolean;
}

const AGENT_DIRS = [
  { scope: "project" as const, path: ".servus/agents" },
];

const USER_AGENT_DIRS = [
  ".servus/agents",
];

const MAX_AGENT_FILES = 40;
const MAX_AGENT_BYTES = 256_000;
const MAX_AGENT_PROMPT_CHARS = 18_000;

export function loadCodingAgents(cwd: string): CodingAgentDefinition[] {
  const loaded: CodingAgentDefinition[] = [];
  const seen = new Set<string>();
  const root = findServusProjectRoot(cwd);

  for (const dir of AGENT_DIRS) {
    for (const agent of loadAgentDir(resolve(root, dir.path), dir.scope, root)) {
      if (seen.has(agent.id)) continue;
      seen.add(agent.id);
      loaded.push(agent);
    }
  }

  const home = process.env.HOME || homedir();
  for (const dir of USER_AGENT_DIRS) {
    for (const agent of loadAgentDir(join(home, dir), "user", cwd)) {
      if (seen.has(agent.id)) continue;
      seen.add(agent.id);
      loaded.push(agent);
    }
  }

  return loaded;
}

export function formatCodingAgents(agents: CodingAgentDefinition[]): string {
  if (agents.length === 0) return "";
  return [
    "# Available Coding Subagents",
    "Use the Task tool with subagent_type set to one of these ids when a focused helper would reduce uncertainty. Custom subagents are read-only unless explicitly configured otherwise and Servus safety rules still apply.",
    "",
    ...agents.map((agent) => [
      `- ${agent.id} (${agent.source})`,
      `  Description: ${agent.description}`,
      `  Tools: ${agent.tools?.length ? agent.tools.join(", ") : "default read-only coding tools"}`,
      agent.disallowedTools?.length ? `  Disallowed: ${agent.disallowedTools.join(", ")}` : undefined,
      agent.model ? `  Model: ${agent.model}` : undefined,
      agent.truncated ? "  Prompt: truncated by size limit" : undefined,
    ].filter(Boolean).join("\n")),
  ].join("\n");
}

function loadAgentDir(dir: string, source: CodingAgentDefinition["source"], cwd: string): CodingAgentDefinition[] {
  if (!existsSync(dir)) return [];
  const agents: CodingAgentDefinition[] = [];
  for (const file of collectAgentFiles(dir, dir)) {
    const agent = readAgentFile(file.path, source, cwd, file.id);
    if (agent) agents.push(agent);
    if (agents.length >= MAX_AGENT_FILES) break;
  }
  return agents;
}

function collectAgentFiles(
  dir: string,
  root: string,
  depth = 0,
): Array<{ path: string; id: string }> {
  if (depth > 3) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
  const files: Array<{ path: string; id: string }> = [];
  for (const entry of entries) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      files.push(...collectAgentFiles(path, root, depth + 1));
      continue;
    }
    if (!entry.isFile() || ![".md", ".markdown"].includes(extname(entry.name).toLowerCase())) continue;
    const rel = relative(root, path).replace(/\.[^.]+$/, "");
    files.push({ path, id: normalizeAgentId(rel) });
    if (files.length >= MAX_AGENT_FILES) break;
  }
  return files.slice(0, MAX_AGENT_FILES);
}

function readAgentFile(
  path: string,
  source: CodingAgentDefinition["source"],
  cwd: string,
  fallbackId?: string,
): CodingAgentDefinition | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_AGENT_BYTES) return null;
    const raw = readFileSync(path, "utf-8").trim();
    if (!raw) return null;
    const parsed = parseAgentMarkdown(raw);
    const fallbackName = fallbackId ?? basename(path, extname(path));
    const rawId = parsed.frontmatter.name ?? parsed.frontmatter.agentType;
    const id = normalizeAgentId(typeof rawId === "string" ? rawId : fallbackName);
    if (!id) return null;
    const prompt = parsed.body.slice(0, MAX_AGENT_PROMPT_CHARS).trim();
    if (!prompt) return null;
    const tools = parseList(parsed.frontmatter.tools);
    const disallowedTools = parseList(parsed.frontmatter.disallowedTools ?? parsed.frontmatter.disallowed_tools);
    return {
      id,
      description: String(parsed.frontmatter.description ?? parsed.frontmatter.when_to_use ?? parsed.frontmatter.whenToUse ?? `Custom coding subagent ${id}`),
      prompt,
      source,
      path: source === "project" ? relative(cwd, path) || path : path.replace(process.env.HOME || homedir(), "~"),
      ...(tools.length ? { tools } : {}),
      ...(disallowedTools.length ? { disallowedTools } : {}),
      ...(typeof parsed.frontmatter.model === "string" ? { model: parsed.frontmatter.model } : {}),
      ...(typeof parsed.frontmatter.effort === "string" ? { effort: parsed.frontmatter.effort } : {}),
      ...(typeof parsed.frontmatter.maxTurns === "number" ? { maxTurns: parsed.frontmatter.maxTurns } : {}),
      readOnly: parseBoolean(parsed.frontmatter.readOnly ?? parsed.frontmatter.read_only, true),
      truncated: parsed.body.length > MAX_AGENT_PROMPT_CHARS,
    };
  } catch {
    return null;
  }
}

function parseAgentMarkdown(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  if (!raw.startsWith("---")) return { frontmatter: {}, body: raw };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: {}, body: raw };
  const frontmatterText = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).trim();
  return { frontmatter: parseSimpleFrontmatter(frontmatterText), body };
}

function parseSimpleFrontmatter(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!match?.[1]) continue;
    const key = normalizeFrontmatterKey(match[1]);
    const rawValue = match[2]?.trim() ?? "";
    result[key] = parseFrontmatterValue(rawValue);
  }
  return result;
}

function parseFrontmatterValue(value: string): unknown {
  const unquoted = value.replace(/^['"]|['"]$/g, "");
  if (value.startsWith("[") && value.endsWith("]")) {
    return value.slice(1, -1).split(",").map((item) => item.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
  }
  if (/^(true|false)$/i.test(unquoted)) return /^true$/i.test(unquoted);
  if (/^\d+$/.test(unquoted)) return Number(unquoted);
  return unquoted;
}

function parseList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value !== "string") return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string" && /^(true|false)$/i.test(value)) return /^true$/i.test(value);
  return fallback;
}

function normalizeFrontmatterKey(key: string): string {
  if (key === "agent-type" || key === "agent_type") return "agentType";
  if (key === "disallowed-tools") return "disallowedTools";
  if (key === "max-turns" || key === "max_turns") return "maxTurns";
  return key;
}

function normalizeAgentId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\\/]+/g, ":")
    .replace(/[^a-z0-9_:-]+/g, "-")
    .replace(/:{2,}/g, ":")
    .replace(/-+/g, "-")
    .replace(/^[-:]+|[-:]+$/g, "")
    .slice(0, 80);
}
