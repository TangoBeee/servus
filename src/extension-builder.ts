import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { SERVUS_DIR } from "./config.js";
import { assessRisk, requestConsent } from "./consent.js";
import type { EngineContext, TaskDomain } from "./engine.js";

export type ExtensionTarget = "project" | "user";
export type ExtensionKind = "skill" | "plugin" | "skill_and_plugin";

export interface SkillScaffoldInput {
  name: string;
  description: string;
  prompt: string;
  whenToUse?: string;
  allowedTools?: string[];
  target?: ExtensionTarget;
  overwrite?: boolean;
}

export interface PluginScaffoldInput {
  id: string;
  version?: string;
  name?: string;
  description?: string;
  prompt: string;
  domains?: TaskDomain[];
  triggers?: string[];
  capabilities?: string[];
  tools?: string[];
  hooks?: Record<string, Array<{
    matcher?: string;
    hooks: Array<{
      type?: "command" | "http" | "prompt";
      command?: string;
      url?: string;
      prompt?: string;
      model?: string;
      timeoutMs?: number;
      statusMessage?: string;
      blocking?: boolean;
      async?: boolean;
      once?: boolean;
      headers?: Record<string, string>;
    }>;
  }>>;
  includeSkill?: boolean;
  skillName?: string;
  skillDescription?: string;
  target?: ExtensionTarget;
  overwrite?: boolean;
}

export interface ScaffoldResult {
  kind: "skill" | "plugin";
  root: string;
  files: string[];
  summary: string;
}

type BuilderContext = Pick<EngineContext, "cwd" | "onConsent">;

const VALID_DOMAINS: TaskDomain[] = [
  "coding",
  "desktop",
  "browser",
  "media",
  "data",
  "extension",
  "security",
  "general",
];

const DEFAULT_SKILL_BODY = `
## Workflow

1. Understand the user's goal and identify the exact output they need.
2. Use the allowed tools conservatively and prefer project-local files.
3. Keep generated artifacts concise, validated, and easy to inspect.
4. Stop and ask one clear question if a required detail is missing.

## Guardrails

- Do not invent external credentials, private data, or unverifiable facts.
- Do not perform irreversible actions without explicit user approval.
- Prefer small, testable changes over broad rewrites.
`.trim();

export function normalizeExtensionName(value: string, fallback = "custom-extension"): string {
  const slug = value
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 64);
  return slug || fallback;
}

export async function createSkillScaffold(
  ctx: BuilderContext,
  input: SkillScaffoldInput,
): Promise<ScaffoldResult> {
  const name = normalizeExtensionName(input.name, "custom-skill");
  const target = input.target ?? "project";
  const root = join(skillBaseDir(ctx.cwd, target), name);
  const skillPath = join(root, "SKILL.md");

  if (existsSync(root) && !input.overwrite) {
    return {
      kind: "skill",
      root,
      files: [],
      summary: `Error: skill directory exists — ${root}. Set overwrite=true to update it.`,
    };
  }

  const blocked = await guardWrite(ctx, "create_skill", skillPath, input.overwrite, target);
  if (blocked) {
    return { kind: "skill", root, files: [], summary: blocked };
  }

  mkdirSync(root, { recursive: true });
  const body = skillMarkdown({
    name,
    description: input.description,
    whenToUse: input.whenToUse ?? input.prompt,
    allowedTools: input.allowedTools,
    body: buildSkillBody(input.prompt),
  });
  writeFileSync(skillPath, body, "utf-8");

  return {
    kind: "skill",
    root,
    files: [skillPath],
    summary: `Created Servus skill "${name}" at ${skillPath}`,
  };
}

export async function createPluginScaffold(
  ctx: BuilderContext,
  input: PluginScaffoldInput,
): Promise<ScaffoldResult> {
  const id = normalizeExtensionName(input.id || input.name || "custom-plugin", "custom-plugin");
  const target = input.target ?? "project";
  const root = join(pluginBaseDir(ctx.cwd, target), id);
  const manifestPath = join(root, "servus.plugin.json");

  if (existsSync(root) && !input.overwrite) {
    return {
      kind: "plugin",
      root,
      files: [],
      summary: `Error: plugin directory exists — ${root}. Set overwrite=true to update it.`,
    };
  }

  const blocked = await guardWrite(ctx, "create_plugin", manifestPath, input.overwrite, target);
  if (blocked) {
    return { kind: "plugin", root, files: [], summary: blocked };
  }

  mkdirSync(root, { recursive: true });
  const files = [manifestPath];
  const skillNames: string[] = [];

  if (input.includeSkill) {
    const skillName = normalizeExtensionName(input.skillName || input.name || id, id);
    const skillDir = join(root, "skills", skillName);
    const skillPath = join(skillDir, "SKILL.md");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillPath, skillMarkdown({
      name: skillName,
      description: input.skillDescription || input.description || `Skill bundled with ${id}.`,
      whenToUse: input.prompt,
      allowedTools: input.tools,
      body: buildSkillBody(input.prompt),
    }), "utf-8");
    files.push(skillPath);
    skillNames.push(`skills/${skillName}`);
  }

  const manifest = {
    id,
    version: input.version || "0.1.0",
    ...(input.name ? { name: input.name } : {}),
    description: input.description || input.prompt,
    tools: input.tools ?? [],
    skills: skillNames,
    mcpServers: {},
    ...(input.hooks ? { hooks: sanitizePluginHooks(input.hooks) } : {}),
    configSchema: {},
    activation: {
      ...(input.triggers?.length ? { triggers: input.triggers } : {}),
      ...(input.domains?.length ? { domains: sanitizeDomains(input.domains) } : {}),
      ...(input.capabilities?.length ? { capabilities: input.capabilities } : {}),
    },
  };

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");

  return {
    kind: "plugin",
    root,
    files,
    summary: `Created Servus plugin "${id}" at ${manifestPath}`,
  };
}

export function validateSkillFile(path: string): string[] {
  const issues: string[] = [];
  if (!existsSync(path)) return [`Missing skill file: ${path}`];
  const stat = statSync(path);
  if (!stat.isFile()) return [`Skill path is not a file: ${path}`];
  if (stat.size > 128_000) issues.push("SKILL.md is larger than the recommended 128KB limit.");
  const text = readFileSync(path, "utf-8");
  if (!text.startsWith("---\n")) issues.push("Missing YAML frontmatter.");
  if (!/^name:\s*\S+/m.test(text)) issues.push("Missing frontmatter name.");
  if (!/^description:\s*\S+/m.test(text)) issues.push("Missing frontmatter description.");
  if (!text.includes("\n---")) issues.push("Frontmatter is not closed.");
  return issues;
}

export function validatePluginFile(path: string): string[] {
  const issues: string[] = [];
  if (!existsSync(path)) return [`Missing plugin manifest: ${path}`];
  const stat = statSync(path);
  if (!stat.isFile()) return [`Plugin path is not a file: ${path}`];
  if (stat.size > 256_000) issues.push("Plugin manifest is larger than the recommended 256KB limit.");
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    if (typeof parsed.id !== "string" || !parsed.id.trim()) issues.push("Missing plugin id.");
    if (typeof parsed.version !== "string" || !parsed.version.trim()) issues.push("Missing plugin version.");
    if (parsed.activation != null && typeof parsed.activation !== "object") {
      issues.push("activation must be an object.");
    }
    if (parsed.hooks != null && typeof parsed.hooks !== "object") {
      issues.push("hooks must be an object keyed by Servus hook event name.");
    }
  } catch (err) {
    issues.push(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return issues;
}

export function skillBaseDir(cwd: string, target: ExtensionTarget): string {
  return target === "user"
    ? join(SERVUS_DIR, "skills")
    : resolve(cwd, ".servus", "skills");
}

export function pluginBaseDir(cwd: string, target: ExtensionTarget): string {
  return target === "user"
    ? join(SERVUS_DIR, "plugins")
    : resolve(cwd, ".servus", "plugins");
}

function skillMarkdown(input: {
  name: string;
  description: string;
  whenToUse: string;
  allowedTools?: string[];
  body: string;
}): string {
  return [
    "---",
    `name: ${yamlString(input.name)}`,
    `description: ${yamlString(input.description)}`,
    `when_to_use: ${yamlString(input.whenToUse)}`,
    input.allowedTools?.length
      ? `allowed_tools: [${input.allowedTools.map((tool) => yamlString(tool)).join(", ")}]`
      : "",
    "---",
    "",
    input.body.trim(),
    "",
  ].filter((line) => line !== "").join("\n");
}

function buildSkillBody(prompt: string): string {
  const cleaned = prompt.trim();
  return [
    "# Purpose",
    "",
    cleaned || "Use this skill for the custom workflow described by the user.",
    "",
    DEFAULT_SKILL_BODY,
  ].join("\n");
}

function yamlString(value: string): string {
  return JSON.stringify(value.trim().replace(/\s+/g, " "));
}

function sanitizeDomains(domains: TaskDomain[]): TaskDomain[] {
  const unique = new Set<TaskDomain>();
  for (const domain of domains) {
    if (VALID_DOMAINS.includes(domain)) unique.add(domain);
  }
  return [...unique];
}

function sanitizePluginHooks(input: NonNullable<PluginScaffoldInput["hooks"]>): NonNullable<PluginScaffoldInput["hooks"]> {
  const validEvents = new Set([
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "Notification",
    "PreCompact",
    "PostCompact",
    "Stop",
    "StopFailure",
    "SubagentStop",
    "TaskCreated",
    "TaskCompleted",
  ]);
  const result: NonNullable<PluginScaffoldInput["hooks"]> = {};
  for (const [event, matchers] of Object.entries(input)) {
    if (!validEvents.has(event) || !Array.isArray(matchers)) continue;
    const nextMatchers = matchers
      .map((matcher) => ({
        ...(matcher.matcher ? { matcher: matcher.matcher } : {}),
        hooks: (matcher.hooks ?? [])
          .filter((hook) => hook.command || hook.url || hook.prompt)
          .map((hook) => ({
            type: hook.type ?? (hook.url ? "http" : hook.prompt ? "prompt" : "command"),
            ...(hook.command ? { command: hook.command } : {}),
            ...(hook.url ? { url: hook.url } : {}),
            ...(hook.prompt ? { prompt: hook.prompt } : {}),
            ...(hook.model ? { model: hook.model } : {}),
            ...(hook.timeoutMs ? { timeoutMs: hook.timeoutMs } : {}),
            ...(hook.statusMessage ? { statusMessage: hook.statusMessage } : {}),
            ...(hook.blocking !== undefined ? { blocking: hook.blocking } : {}),
            ...(hook.async !== undefined ? { async: hook.async } : {}),
            ...(hook.once !== undefined ? { once: hook.once } : {}),
            ...(hook.headers ? { headers: hook.headers } : {}),
          })),
      }))
      .filter((matcher) => matcher.hooks.length > 0);
    if (nextMatchers.length > 0) result[event] = nextMatchers;
  }
  return result;
}

async function guardWrite(
  ctx: BuilderContext,
  action: string,
  outputPath: string,
  overwrite?: boolean,
  target?: ExtensionTarget,
): Promise<string | null> {
  if (existsSync(outputPath) && !overwrite) {
    return `Error: output exists — ${outputPath}. Set overwrite=true to replace it.`;
  }

  const outsideCwd = isOutside(ctx.cwd, outputPath);
  const existing = existsSync(outputPath);
  if (!outsideCwd && !existing) return null;

  const detail = [
    `Output: ${outputPath}`,
    target === "user" ? `This writes to the user Servus directory: ${SERVUS_DIR}` : "",
    existing ? "This will overwrite an existing extension file." : "",
    outsideCwd ? `This writes outside the working directory: ${ctx.cwd}` : "",
  ].filter(Boolean).join("\n");

  const assessed = assessRisk(`${action}\n${detail}`);
  const risk = existing ? "high" : assessed.risk === "low" ? "medium" : assessed.risk;
  const approved = ctx.onConsent
    ? await ctx.onConsent(action, detail)
    : await requestConsent({ action, detail, risk, engine: "extension" });
  return approved ? null : `Action blocked by consent gate: ${action}`;
}

function isOutside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel.startsWith("..") || rel === ".." || isAbsolute(rel);
}
