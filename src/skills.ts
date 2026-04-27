import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { SERVUS_DIR } from "./config.js";
import type { SkillManifest } from "./runtime.js";

const MAX_CANDIDATES_PER_ROOT = 200;
const MAX_SKILLS_LOADED_PER_SOURCE = 50;
const MAX_SKILL_FILE_BYTES = 128_000;
const DEFAULT_MAX_PROMPT_CHARS = 24_000;

type SkillSource = SkillManifest["source"];

interface SkillRoot {
  source: SkillSource;
  root: string;
}

interface ParsedFrontmatter {
  data: Record<string, string | string[] | boolean>;
  body: string;
}

export interface LoadSkillsOptions {
  cwd: string;
  extraDirs?: string[];
  maxPromptChars?: number;
}

export function loadSkills(options: LoadSkillsOptions): SkillManifest[] {
  const roots = skillRoots(options.cwd, options.extraDirs);
  const skills: SkillManifest[] = [];

  for (const root of roots) {
    if (!existsSync(root.root)) continue;
    const files = findSkillFiles(root.root).slice(0, MAX_CANDIDATES_PER_ROOT);
    let loadedForSource = 0;

    for (const file of files) {
      if (loadedForSource >= MAX_SKILLS_LOADED_PER_SOURCE) break;
      const skill = readSkill(file, root.root, root.source);
      if (!skill) continue;
      skills.push(skill);
      loadedForSource++;
    }
  }

  return dedupeSkills(skills);
}

export function selectSkillsForTask(
  task: string,
  skills: SkillManifest[],
  limit = 5,
): SkillManifest[] {
  const words = tokenize(task);
  return skills
    .map((skill) => ({ skill, score: scoreSkill(skill, words) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
    .slice(0, limit)
    .map((item) => item.skill);
}

export function buildSkillsPrompt(skills: SkillManifest[], maxChars = DEFAULT_MAX_PROMPT_CHARS): string {
  let prompt = "";
  for (const skill of skills) {
    const block = [
      `## Skill: ${skill.name}`,
      skill.description,
      skill.whenToUse ? `When to use: ${skill.whenToUse}` : "",
      skill.allowedTools?.length ? `Allowed tools: ${skill.allowedTools.join(", ")}` : "",
      "",
      skill.body.trim(),
      "",
    ].filter(Boolean).join("\n");

    if (prompt.length + block.length > maxChars) break;
    prompt += block + "\n";
  }
  return prompt.trim();
}

function skillRoots(cwd: string, extraDirs: string[] = []): SkillRoot[] {
  const srcDir = dirname(fileURLToPath(import.meta.url));
  return [
    { source: "bundled", root: join(srcDir, "skills") },
    { source: "project", root: resolve(cwd, ".servus", "skills") },
    { source: "user", root: join(SERVUS_DIR, "skills") },
    { source: "plugin", root: resolve(cwd, ".servus", "plugins") },
    { source: "plugin", root: join(SERVUS_DIR, "plugins") },
    ...extraDirs.map((root) => ({
      source: root.startsWith(homedir()) ? "user" as const : "project" as const,
      root: resolve(cwd, root),
    })),
  ];
}

function findSkillFiles(root: string): string[] {
  const realRoot = safeRealpath(root);
  if (!realRoot) return [];

  const files: string[] = [];
  const stack = [realRoot];

  while (stack.length > 0 && files.length < MAX_CANDIDATES_PER_ROOT) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (files.length >= MAX_CANDIDATES_PER_ROOT) break;
      if (entry.name.startsWith(".") && entry.name !== ".servus") continue;
      if (["node_modules", "dist", ".git"].includes(entry.name)) continue;

      const full = join(current, entry.name);
      const real = safeRealpath(full);
      if (!real || !isInside(realRoot, real)) continue;

      if (entry.isDirectory()) stack.push(real);
      else if (entry.isFile() && entry.name === "SKILL.md") files.push(real);
    }
  }

  return files.sort();
}

function readSkill(path: string, root: string, source: SkillSource): SkillManifest | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_SKILL_FILE_BYTES) return null;

    const parsed = parseFrontmatter(readFileSync(path, "utf-8"));
    const name = stringValue(parsed.data.name) || dirname(relative(root, path)).split("/").pop() || "unnamed";
    const description = stringValue(parsed.data.description);
    if (!description) return null;

    return {
      name,
      description,
      whenToUse: stringValue(parsed.data.when_to_use) || stringValue(parsed.data.whenToUse),
      allowedTools: arrayValue(parsed.data.allowed_tools) || arrayValue(parsed.data.allowedTools),
      model: stringValue(parsed.data.model),
      effort: effortValue(parsed.data.effort),
      disableModelInvocation: booleanValue(parsed.data.disable_model_invocation),
      source,
      path,
      body: parsed.body.trim(),
    };
  } catch {
    return null;
  }
}

function parseFrontmatter(text: string): ParsedFrontmatter {
  if (!text.startsWith("---\n")) return { data: {}, body: text };
  const end = text.indexOf("\n---", 4);
  if (end === -1) return { data: {}, body: text };

  const raw = text.slice(4, end).trim();
  const body = text.slice(end + 4).replace(/^\s*\n/, "");
  const data: Record<string, string | string[] | boolean> = {};

  for (const line of raw.split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    data[key] = parseValue(value);
  }

  return { data, body };
}

function parseValue(value: string): string | string[] | boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((item) => item.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  return value.replace(/^["']|["']$/g, "");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function arrayValue(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string" && value.trim()) {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function effortValue(value: unknown): SkillManifest["effort"] | undefined {
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh") return value;
  return undefined;
}

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2));
}

function scoreSkill(skill: SkillManifest, words: Set<string>): number {
  const haystack = tokenize([
    skill.name,
    skill.description,
    skill.whenToUse ?? "",
  ].join(" "));
  let score = 0;
  for (const word of words) {
    if (haystack.has(word)) score++;
  }
  return score;
}

function dedupeSkills(skills: SkillManifest[]): SkillManifest[] {
  const seen = new Set<string>();
  const result: SkillManifest[] = [];
  for (const skill of skills) {
    const key = `${skill.source}:${skill.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(skill);
  }
  return result;
}

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function isInside(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}
