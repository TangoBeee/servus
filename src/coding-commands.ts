import type { CodingMode } from "./coding-runtime.js";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, relative, resolve } from "node:path";
import { findServusProjectRoot } from "./coding-project.js";

export type BuiltInCodingCommandName =
  | "plan"
  | "build"
  | "coordinate"
  | "review"
  | "explore"
  | "verify"
  | "diff"
  | "revert"
  | "help"
  | "status"
  | "transcript"
  | "tools"
  | "sessions"
  | "search"
  | "compact"
  | "context"
  | "remember"
  | "memory"
  | "files"
  | "agents"
  | "commands"
  | "model"
  | "models"
  | "permissions"
  | "hooks"
  | "settings"
  | "skills"
  | "output-style"
  | "doctor"
  | "init";

export interface CustomCodingCommand {
  id: string;
  description: string;
  prompt: string;
  source: "project" | "user";
  path: string;
  mode?: CodingMode;
  model?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  argumentHint?: string;
  truncated: boolean;
}

export interface CodingCommand {
  name: string;
  args: string;
  raw: string;
  mode?: CodingMode;
  immediate?: boolean;
  custom?: CustomCodingCommand;
}

const MODE_COMMANDS: Record<string, CodingMode> = {
  plan: "plan",
  build: "build",
  coordinate: "coordinate",
  review: "review",
  explore: "explore",
};

const IMMEDIATE_COMMANDS = new Set([
  "help",
  "verify",
  "diff",
  "revert",
  "status",
  "transcript",
  "tools",
  "sessions",
  "search",
  "compact",
  "context",
  "remember",
  "memory",
  "files",
  "agents",
  "commands",
  "model",
  "models",
  "permissions",
  "hooks",
  "settings",
  "skills",
  "output-style",
  "doctor",
  "init",
]);

const CUSTOM_COMMAND_DIRS = [
  { source: "project" as const, path: ".servus/commands" },
];

const USER_CUSTOM_COMMAND_DIRS = [
  ".servus/commands",
];

const MAX_CUSTOM_COMMANDS = 80;
const MAX_COMMAND_BYTES = 256_000;
const MAX_COMMAND_PROMPT_CHARS = 18_000;

export function parseCodingCommand(task: string, cwd = process.cwd()): CodingCommand | undefined {
  const trimmed = task.trim();
  const match = trimmed.match(/^\/([a-z][a-z0-9_:-]*)(?:\s+([\s\S]*))?$/i);
  if (!match) return undefined;

  const name = match[1]!.toLowerCase();
  const args = (match[2] ?? "").trim();
  if (name in MODE_COMMANDS) {
    return {
      name,
      args,
      raw: trimmed,
      mode: MODE_COMMANDS[name],
      immediate: false,
    };
  }
  if (IMMEDIATE_COMMANDS.has(name)) {
    return {
      name,
      args,
      raw: trimmed,
      immediate: true,
      mode: name === "verify" ? "build" : "plan",
    };
  }

  const custom = loadCustomCodingCommands(cwd).find((item) => item.id === name);
  if (custom) {
    return {
      name: custom.id,
      args,
      raw: trimmed,
      mode: custom.mode,
      immediate: false,
      custom,
    };
  }

  return undefined;
}

export function stripCodingCommand(task: string, command = parseCodingCommand(task)): string {
  if (!command) return task;
  if (command.custom) return renderCustomCommand(command.custom, command.args);
  if (command.args) return command.args;
  if (command.name === "verify") return "Run project verification and report the exact result.";
  if (command.name === "diff") return "Show the current coding session diff.";
  if (command.name === "revert") return "Revert the latest coding checkpoint.";
  if (command.name === "help") return "Show Servus coding slash command help.";
  if (command.name === "status") return "Summarize the current coding session and repository status.";
  if (command.name === "transcript") return "Show the recent coding session transcript.";
  if (command.name === "tools") return "Show Servus coding tool catalog.";
  if (command.name === "sessions") return command.args ? `Search Servus project sessions for: ${command.args}` : "List recent Servus project sessions.";
  if (command.name === "search") return command.args ? `Search Servus project sessions for: ${command.args}` : "Search Servus project sessions.";
  if (command.name === "compact") return "Compact the current coding session context.";
  if (command.name === "context") return "Show coding context budget and compaction status.";
  if (command.name === "remember") return command.args ? `Remember this project instruction: ${command.args}` : "Remember a project instruction.";
  if (command.name === "memory") return "Show loaded coding memory and instructions.";
  if (command.name === "files") return "Show files currently attached, read, or changed in this coding session.";
  if (command.name === "agents") return "Show available coding subagents.";
  if (command.name === "commands") return "Show available Servus coding slash commands.";
  if (command.name === "model" || command.name === "models") return "Show provider-aware Servus model options.";
  if (command.name === "permissions") return "Show active coding permission rules.";
  if (command.name === "hooks") return "Show active coding hooks.";
  if (command.name === "settings") return "Show loaded Servus coding settings.";
  if (command.name === "skills") return "Show loaded and selected Servus coding skills.";
  if (command.name === "output-style") return command.args ? `Set Servus output style to ${command.args}.` : "Show Servus output styles.";
  if (command.name === "doctor") return "Run Servus coding project diagnostics.";
  if (command.name === "init") return "Initialize Servus project coding files.";
  return task;
}

export function codingCommandHelp(cwd?: string): string {
  const custom = cwd ? loadCustomCodingCommands(cwd) : [];
  const builtIns = [
    "Supported coding slash commands:",
    "- /plan <task>: read-only implementation plan with repo evidence.",
    "- /build <task>: force build/edit mode.",
    "- /coordinate <task>: coordinator mode with focused workers and scratchpad.",
    "- /review <task>: read-only review mode.",
    "- /explore <task>: read-only codebase exploration mode.",
    "- /verify [command]: run detected verification or the provided command without invoking the model.",
    "- /diff [checkpoint-id|latest|current]: show the session or working-tree diff.",
    "- /revert [checkpoint-id|latest]: safely reverse a Servus checkpoint diff.",
    "- /help: show this command help.",
    "- /status: show indexed repository/session status.",
    "- /transcript [limit]: show recent coding transcript messages.",
    "- /tools: show the coding tool catalog and when to use each tool.",
    "- /sessions [query]: list or search recent Servus sessions for this project.",
    "- /search <query>: search recent Servus sessions for this project.",
    "- /compact: acknowledge manual compaction; automatic model-aware compaction remains active.",
    "- /context: show coding context budget and compaction status.",
    "- /remember <instruction>: save a durable project instruction for future coding runs.",
    "- /memory: show loaded project/user coding instructions.",
    "- /files: show files currently attached, read, or changed in this coding session.",
    "- /agents: show available built-in and custom coding subagents.",
    "- /commands: show available project/user Servus commands.",
    "- /model or /models: show selectable models available from configured provider keys.",
    "- /permissions: show active coding permission rules.",
    "- /hooks: show active coding hooks.",
    "- /settings: show loaded project/user Servus coding settings.",
    "- /skills: show loaded and selected Servus coding skills.",
    "- /output-style [name]: list or select a Servus output style.",
    "- /doctor: run Servus coding project diagnostics.",
    "- /init: create Servus project coding files without overwriting existing files.",
  ];
  if (custom.length === 0) return builtIns.join("\n");
  return [
    ...builtIns,
    "",
    "Project/user Servus commands:",
    ...custom.map((command) =>
      `- /${command.id}${command.argumentHint ? ` ${command.argumentHint}` : ""}: ${command.description} (${command.source})`
    ),
  ].join("\n");
}

export function loadCustomCodingCommands(cwd: string): CustomCodingCommand[] {
  const commands: CustomCodingCommand[] = [];
  const seen = new Set<string>();
  const root = findServusProjectRoot(cwd);

  for (const dir of CUSTOM_COMMAND_DIRS) {
    for (const command of loadCommandDir(resolve(root, dir.path), dir.source, root)) {
      if (seen.has(command.id)) continue;
      seen.add(command.id);
      commands.push(command);
    }
  }

  const home = process.env.HOME || homedir();
  for (const dir of USER_CUSTOM_COMMAND_DIRS) {
    for (const command of loadCommandDir(join(home, dir), "user", cwd)) {
      if (seen.has(command.id)) continue;
      seen.add(command.id);
      commands.push(command);
    }
  }

  return commands.slice(0, MAX_CUSTOM_COMMANDS);
}

export function formatCustomCodingCommands(commands: CustomCodingCommand[]): string {
  if (commands.length === 0) {
    return "No custom Servus commands found. Add project commands in .servus/commands/*.md or user commands in ~/.servus/commands/*.md.";
  }
  return [
    "Custom Servus coding commands:",
    "",
    ...commands.map((command) => [
      `- /${command.id}${command.argumentHint ? ` ${command.argumentHint}` : ""}`,
      `  ${command.description}`,
      `  Mode: ${command.mode ?? "auto"}`,
      command.model ? `  Model: ${command.model}` : undefined,
      command.allowedTools?.length ? `  Allowed tools: ${command.allowedTools.join(", ")}` : undefined,
      command.disallowedTools?.length ? `  Disallowed tools: ${command.disallowedTools.join(", ")}` : undefined,
      `  Source: ${command.source}`,
      `  Path: ${command.path}`,
      command.truncated ? "  Prompt: truncated by size limit" : undefined,
    ].filter(Boolean).join("\n")),
  ].join("\n");
}

function renderCustomCommand(command: CustomCodingCommand, args: string): string {
  const rendered = command.prompt
    .replaceAll("$ARGUMENTS", args)
    .replaceAll("{{args}}", args)
    .replaceAll("{{ARGUMENTS}}", args);
  return [
    `## Servus Command: /${command.id}`,
    `Source: ${command.path}`,
    command.description ? `Description: ${command.description}` : undefined,
    args ? `Arguments: ${args}` : undefined,
    "",
    rendered,
  ].filter(Boolean).join("\n");
}

function loadCommandDir(dir: string, source: CustomCodingCommand["source"], cwd: string): CustomCodingCommand[] {
  if (!existsSync(dir)) return [];
  const commands: CustomCodingCommand[] = [];
  for (const file of collectCommandFiles(dir, dir)) {
    const command = readCommandFile(file.path, source, cwd, file.id);
    if (command) commands.push(command);
    if (commands.length >= MAX_CUSTOM_COMMANDS) break;
  }
  return commands;
}

function collectCommandFiles(
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
      files.push(...collectCommandFiles(path, root, depth + 1));
      continue;
    }
    if (!entry.isFile() || ![".md", ".markdown"].includes(extname(entry.name).toLowerCase())) continue;
    const rel = relative(root, path).replace(/\.[^.]+$/, "");
    files.push({ path, id: normalizeCommandId(rel) });
    if (files.length >= MAX_CUSTOM_COMMANDS) break;
  }
  return files.slice(0, MAX_CUSTOM_COMMANDS);
}

function readCommandFile(
  path: string,
  source: CustomCodingCommand["source"],
  cwd: string,
  fallbackId?: string,
): CustomCodingCommand | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_COMMAND_BYTES) return null;
    const raw = readFileSync(path, "utf-8").trim();
    if (!raw) return null;
    const parsed = parseCommandMarkdown(raw);
    const fallbackName = fallbackId ?? basename(path, extname(path));
    const rawId = parsed.frontmatter.name ?? parsed.frontmatter.command;
    const id = normalizeCommandId(typeof rawId === "string" ? rawId : fallbackName);
    if (!id) return null;
    const prompt = parsed.body.slice(0, MAX_COMMAND_PROMPT_CHARS).trim();
    if (!prompt) return null;
    const rawMode = parsed.frontmatter.mode;
    const mode = isCodingMode(rawMode) ? rawMode : undefined;
    const model = typeof parsed.frontmatter.model === "string" && parsed.frontmatter.model.trim()
      ? parsed.frontmatter.model.trim()
      : undefined;
    const allowedTools = frontmatterStringList(parsed.frontmatter.allowedTools ?? parsed.frontmatter.tools);
    const disallowedTools = frontmatterStringList(parsed.frontmatter.disallowedTools);
    const displayPath = source === "project"
      ? relative(cwd, path) || path
      : path.replace(process.env.HOME || homedir(), "~");
    return {
      id,
      description: String(parsed.frontmatter.description ?? `Custom Servus command /${id}`),
      prompt,
      source,
      path: displayPath,
      ...(mode ? { mode } : {}),
      ...(model ? { model } : {}),
      ...(allowedTools.length ? { allowedTools } : {}),
      ...(disallowedTools.length ? { disallowedTools } : {}),
      ...(typeof parsed.frontmatter.argumentHint === "string" ? { argumentHint: parsed.frontmatter.argumentHint } : {}),
      truncated: parsed.body.length > MAX_COMMAND_PROMPT_CHARS,
    };
  } catch {
    return null;
  }
}

function parseCommandMarkdown(raw: string): { frontmatter: Record<string, unknown>; body: string } {
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
    return value
      .slice(1, -1)
      .split(",")
      .map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);
  }
  if (/^(true|false)$/i.test(unquoted)) return /^true$/i.test(unquoted);
  if (/^\d+$/.test(unquoted)) return Number(unquoted);
  return unquoted;
}

function normalizeFrontmatterKey(key: string): string {
  if (key === "argument-hint" || key === "argument_hint") return "argumentHint";
  if (key === "allowed-tools" || key === "allowed_tools") return "allowedTools";
  if (key === "disallowed-tools" || key === "disallowed_tools") return "disallowedTools";
  return key;
}

function frontmatterStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item).trim())
      .filter(Boolean)
      .slice(0, 40);
  }
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 40);
}

function isCodingMode(value: unknown): value is CodingMode {
  return value === "build" || value === "plan" || value === "review" || value === "explore" || value === "coordinate";
}

function normalizeCommandId(value: string): string {
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
