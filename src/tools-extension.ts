import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { SERVUS_DIR } from "./config.js";
import { assessRisk, requestConsent } from "./consent.js";
import type { EngineContext, TaskDomain } from "./engine.js";
import {
  createPluginScaffold,
  createSkillScaffold,
  normalizeExtensionName,
  pluginBaseDir,
  skillBaseDir,
  validatePluginFile,
  validateSkillFile,
} from "./extension-builder.js";

const domainSchema = z.enum([
  "coding",
  "desktop",
  "browser",
  "media",
  "data",
  "extension",
  "security",
  "general",
]);

const targetSchema = z.enum(["project", "user"]).optional();
const hookEventSchema = z.enum([
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
const hookCommandSchema = z.object({
  type: z.enum(["command", "http", "prompt"]).optional(),
  command: z.string().optional(),
  url: z.string().url().optional(),
  prompt: z.string().optional(),
  model: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  statusMessage: z.string().optional(),
  blocking: z.boolean().optional(),
  async: z.boolean().optional(),
  once: z.boolean().optional(),
  headers: z.record(z.string(), z.string()).optional(),
}).refine((input) => input.command || input.url || input.prompt, {
  message: "Hook command requires command, url, or prompt.",
});
const pluginHooksSchema = z.record(
  hookEventSchema,
  z.array(z.object({
    matcher: z.string().optional(),
    hooks: z.array(hookCommandSchema).min(1),
  })),
).optional();

const createSkillSchema = z.object({
  name: z.string().min(1).describe("Short skill name. It will be normalized to kebab-case."),
  description: z.string().min(1).describe("One sentence explaining when the skill should trigger."),
  prompt: z.string().min(1).describe("The user's requested workflow or domain knowledge for the skill."),
  whenToUse: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
  target: targetSchema.describe("project writes to .servus/skills; user writes to ~/.servus/skills."),
  overwrite: z.boolean().optional(),
});

const createPluginSchema = z.object({
  id: z.string().min(1).describe("Plugin id. It will be normalized to kebab-case."),
  version: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  prompt: z.string().min(1).describe("What the plugin should provide."),
  domains: z.array(domainSchema).optional(),
  triggers: z.array(z.string()).optional(),
  capabilities: z.array(z.string()).optional(),
  tools: z.array(z.string()).optional(),
  hooks: pluginHooksSchema.describe("Optional Servus lifecycle hooks packaged with this plugin."),
  includeSkill: z.boolean().optional().describe("Create a bundled SKILL.md inside the plugin."),
  skillName: z.string().optional(),
  skillDescription: z.string().optional(),
  target: targetSchema.describe("project writes to .servus/plugins; user writes to ~/.servus/plugins."),
  overwrite: z.boolean().optional(),
});

const validateExtensionSchema = z.object({
  type: z.enum(["skill", "plugin"]),
  path: z.string().describe("Path to SKILL.md or servus.plugin.json."),
});

const importPackageSchema = z.object({
  packagePath: z.string().describe("Folder containing SKILL.md, servus.plugin.json, or agents.toml-style metadata."),
  type: z.enum(["skill", "plugin", "auto"]).optional(),
  target: targetSchema,
  name: z.string().optional().describe("Optional destination name override."),
  overwrite: z.boolean().optional(),
});

const exportPackageSchema = z.object({
  type: z.enum(["skill", "plugin"]),
  sourcePath: z.string().describe("Path to a skill/plugin folder or manifest file."),
  outputDir: z.string().describe("Directory where the portable package should be written."),
  overwrite: z.boolean().optional(),
});

const testActivationSchema = z.object({
  path: z.string().describe("Path to a skill/plugin folder, SKILL.md, or servus.plugin.json."),
});

const repairManifestSchema = z.object({
  path: z.string().describe("Path to servus.plugin.json or SKILL.md."),
  type: z.enum(["skill", "plugin", "auto"]).optional(),
  write: z.boolean().optional().describe("Write the repaired file. Defaults to false and returns the repaired content."),
  overwrite: z.boolean().optional(),
});

type ExtensionToolContext = Pick<EngineContext, "cwd" | "onConsent">;

export function createExtensionTools(ctx: ExtensionToolContext) {
  return {
    extension_readiness: tool({
      description: "Show where Servus can create custom skills and plugins.",
      inputSchema: z.object({}),
      execute: async () => [
        "Extension Builder readiness: ready",
        `Project skills: ${skillBaseDir(ctx.cwd, "project")}`,
        `Project plugins: ${pluginBaseDir(ctx.cwd, "project")}`,
        `User skills: ${skillBaseDir(ctx.cwd, "user")}`,
        `User plugins: ${pluginBaseDir(ctx.cwd, "user")}`,
        existsSync(SERVUS_DIR) ? `Servus home: ${SERVUS_DIR}` : `Servus home will be created: ${SERVUS_DIR}`,
      ].join("\n"),
    }),

    create_skill: tool({
      description: "Create a Servus SKILL.md scaffold from a user prompt.",
      inputSchema: createSkillSchema,
      execute: async (input: z.infer<typeof createSkillSchema>) => {
        const result = await createSkillScaffold(ctx, input);
        return [
          result.summary,
          result.files.length ? `Files:\n${result.files.map((file) => `- ${file}`).join("\n")}` : "",
        ].filter(Boolean).join("\n");
      },
    }),

    create_plugin: tool({
      description: "Create a Servus plugin manifest scaffold, optionally with a bundled skill.",
      inputSchema: createPluginSchema,
      execute: async (input: z.infer<typeof createPluginSchema>) => {
        const result = await createPluginScaffold(ctx, {
          ...input,
          domains: input.domains as TaskDomain[] | undefined,
        });
        return [
          result.summary,
          result.files.length ? `Files:\n${result.files.map((file) => `- ${file}`).join("\n")}` : "",
        ].filter(Boolean).join("\n");
      },
    }),

    validate_extension: tool({
      description: "Validate a generated Servus skill or plugin manifest.",
      inputSchema: validateExtensionSchema,
      execute: async (input: z.infer<typeof validateExtensionSchema>) => {
        const path = resolve(ctx.cwd, input.path);
        const issues = input.type === "skill"
          ? validateSkillFile(path)
          : validatePluginFile(path);
        return issues.length
          ? `Validation issues for ${path}:\n${issues.map((issue) => `- ${issue}`).join("\n")}`
          : `Validation passed: ${path}`;
      },
    }),

    extension_import_package: tool({
      description: "Import a portable Servus skill/plugin package into project or user .servus directories, then validate it.",
      inputSchema: importPackageSchema,
      execute: async (input: z.infer<typeof importPackageSchema>) => {
        const sourceRoot = resolve(ctx.cwd, input.packagePath);
        if (!existsSync(sourceRoot)) return `Error: package path not found — ${sourceRoot}`;
        const detected = detectExtensionPackage(sourceRoot, input.type ?? "auto");
        if (!detected) return `Error: could not detect a Servus skill/plugin package in ${sourceRoot}`;
        const target = input.target ?? "project";
        const name = normalizeExtensionName(input.name ?? detected.name ?? basename(sourceRoot), detected.kind === "skill" ? "imported-skill" : "imported-plugin");
        const destRoot = detected.kind === "skill"
          ? join(skillBaseDir(ctx.cwd, target), name)
          : join(pluginBaseDir(ctx.cwd, target), name);
        const blocked = await guardExtensionWrite(ctx, "extension_import_package", destRoot, input.overwrite);
        if (blocked) return blocked;
        if (existsSync(destRoot) && !input.overwrite) return `Error: destination exists — ${destRoot}. Set overwrite=true to replace it.`;
        copyDirectory(detected.root, destRoot);
        if (detected.metadata === "agents_toml" && !existsSync(join(destRoot, "servus.plugin.json"))) {
          writeFileSync(join(destRoot, "servus.plugin.json"), JSON.stringify(pluginManifestFromAgentsToml(join(destRoot, "agents.toml"), name), null, 2) + "\n", "utf-8");
        }
        const validationPath = detected.kind === "skill" ? join(destRoot, "SKILL.md") : join(destRoot, "servus.plugin.json");
        const issues = detected.kind === "skill" ? validateSkillFile(validationPath) : validatePluginFile(validationPath);
        return [
          `Imported ${detected.kind}: ${destRoot}`,
          `Source: ${detected.root}`,
          `Validation: ${issues.length ? "failed" : "passed"}`,
          ...issues.map((issue) => `- ${issue}`),
          `Artifact: ${destRoot}`,
        ].join("\n");
      },
    }),

    extension_export_package: tool({
      description: "Export a Servus skill/plugin folder to a portable package directory after validation.",
      inputSchema: exportPackageSchema,
      execute: async (input: z.infer<typeof exportPackageSchema>) => {
        const source = resolve(ctx.cwd, input.sourcePath);
        if (!existsSync(source)) return `Error: source not found — ${source}`;
        const sourceRoot = statSync(source).isFile() ? dirname(source) : source;
        const validationPath = input.type === "skill" ? join(sourceRoot, "SKILL.md") : join(sourceRoot, "servus.plugin.json");
        const issues = input.type === "skill" ? validateSkillFile(validationPath) : validatePluginFile(validationPath);
        if (issues.length) return `Export blocked: validation failed for ${validationPath}\n${issues.map((issue) => `- ${issue}`).join("\n")}`;
        const outputRoot = resolve(ctx.cwd, input.outputDir, basename(sourceRoot));
        const blocked = await guardExtensionWrite(ctx, "extension_export_package", outputRoot, input.overwrite);
        if (blocked) return blocked;
        if (existsSync(outputRoot) && !input.overwrite) return `Error: output exists — ${outputRoot}. Set overwrite=true to replace it.`;
        copyDirectory(sourceRoot, outputRoot);
        writeFileSync(join(outputRoot, "SERVUS_PACKAGE.md"), [
          `# Servus ${input.type} package`,
          "",
          `Source: ${sourceRoot}`,
          `Exported: ${new Date().toISOString()}`,
          "",
          "Import with extension_import_package.",
          "",
        ].join("\n"), "utf-8");
        return `Exported ${input.type} package: ${outputRoot}\nArtifact: ${outputRoot}`;
      },
    }),

    extension_test_activation: tool({
      description: "Validate and summarize whether a skill/plugin can be discovered and activated by Servus.",
      inputSchema: testActivationSchema,
      execute: async (input: z.infer<typeof testActivationSchema>) => {
        const source = resolve(ctx.cwd, input.path);
        if (!existsSync(source)) return `Error: path not found — ${source}`;
        const detected = detectExtensionPackage(source, "auto");
        if (!detected) return `Activation test failed: no SKILL.md or servus.plugin.json found at ${source}`;
        if (detected.metadata === "agents_toml" && !existsSync(join(detected.root, "servus.plugin.json"))) {
          const manifest = pluginManifestFromAgentsToml(join(detected.root, "agents.toml"), detected.name ?? basename(detected.root));
          return [
            "Activation test: convertible",
            "Kind: plugin",
            `Root: ${detected.root}`,
            "Entrypoint: agents.toml",
            `Converted id: ${manifest.id}`,
            `Converted version: ${manifest.version}`,
            "Import this package with extension_import_package to generate servus.plugin.json.",
          ].join("\n");
        }
        const validationPath = detected.kind === "skill" ? join(detected.root, "SKILL.md") : join(detected.root, "servus.plugin.json");
        const issues = detected.kind === "skill" ? validateSkillFile(validationPath) : validatePluginFile(validationPath);
        return [
          `Activation test: ${issues.length ? "failed" : "passed"}`,
          `Kind: ${detected.kind}`,
          `Root: ${detected.root}`,
          `Entrypoint: ${validationPath}`,
          ...activationSummary(validationPath, detected.kind),
          ...issues.map((issue) => `Issue: ${issue}`),
        ].join("\n");
      },
    }),

    extension_repair_manifest: tool({
      description: "Repair a malformed Servus SKILL.md or servus.plugin.json. Returns repaired content unless write=true.",
      inputSchema: repairManifestSchema,
      execute: async (input: z.infer<typeof repairManifestSchema>) => {
        const path = resolve(ctx.cwd, input.path);
        if (!existsSync(path)) return `Error: path not found — ${path}`;
        const type = input.type === "auto"
          ? path.endsWith("SKILL.md") ? "skill" : "plugin"
          : input.type ?? (path.endsWith("SKILL.md") ? "skill" : "plugin");
        const repaired = type === "skill" ? repairSkillFile(path) : repairPluginFile(path);
        if (!input.write) return repaired;
        const blocked = await guardExtensionWrite(ctx, "extension_repair_manifest", path, input.overwrite);
        if (blocked) return blocked;
        if (existsSync(path) && !input.overwrite) {
          return `Error: ${path} exists. Set overwrite=true to write repaired content.`;
        }
        writeFileSync(path, repaired, "utf-8");
        const issues = type === "skill" ? validateSkillFile(path) : validatePluginFile(path);
        return [
          `Wrote repaired ${type}: ${path}`,
          `Validation: ${issues.length ? "failed" : "passed"}`,
          ...issues.map((issue) => `- ${issue}`),
        ].join("\n");
      },
    }),
  };
}

export function extensionToolPaths(cwd: string): string[] {
  return [
    join(skillBaseDir(cwd, "project"), "<skill>", "SKILL.md"),
    join(pluginBaseDir(cwd, "project"), "<plugin>", "servus.plugin.json"),
  ];
}

function detectExtensionPackage(path: string, expected: "skill" | "plugin" | "auto"): { kind: "skill" | "plugin"; root: string; name?: string; metadata?: "skill" | "plugin" | "agents_toml" } | null {
  const root = statSync(path).isFile() ? dirname(path) : path;
  if ((expected === "skill" || expected === "auto") && existsSync(join(root, "SKILL.md"))) {
    return { kind: "skill", root, name: readSkillName(join(root, "SKILL.md")), metadata: "skill" };
  }
  if ((expected === "plugin" || expected === "auto") && existsSync(join(root, "servus.plugin.json"))) {
    return { kind: "plugin", root, name: readPluginId(join(root, "servus.plugin.json")), metadata: "plugin" };
  }
  if ((expected === "plugin" || expected === "auto") && existsSync(join(root, "agents.toml"))) {
    return { kind: "plugin", root, name: readAgentsTomlName(join(root, "agents.toml")), metadata: "agents_toml" };
  }
  if (statSync(path).isFile() && basename(path) === "SKILL.md") {
    return { kind: "skill", root: dirname(path), name: readSkillName(path), metadata: "skill" };
  }
  if (statSync(path).isFile() && basename(path) === "servus.plugin.json") {
    return { kind: "plugin", root: dirname(path), name: readPluginId(path), metadata: "plugin" };
  }
  if (statSync(path).isFile() && basename(path) === "agents.toml") {
    return { kind: "plugin", root: dirname(path), name: readAgentsTomlName(path), metadata: "agents_toml" };
  }
  return null;
}

function copyDirectory(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const src = join(source, entry.name);
    const dst = join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(src, dst);
    else if (entry.isFile()) {
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
    }
  }
}

async function guardExtensionWrite(
  ctx: ExtensionToolContext,
  action: string,
  target: string,
  overwrite?: boolean,
): Promise<string | null> {
  const detail = [
    `Target: ${target}`,
    existsSync(target) ? "Target already exists." : "",
    relative(resolve(ctx.cwd), resolve(target)).startsWith("..") ? `This writes outside the working directory: ${ctx.cwd}` : "",
  ].filter(Boolean).join("\n");
  if (!existsSync(target) && !relative(resolve(ctx.cwd), resolve(target)).startsWith("..")) return null;
  if (existsSync(target) && !overwrite) return null;
  const assessed = assessRisk(`${action}\n${detail}`);
  const approved = ctx.onConsent
    ? await ctx.onConsent(action, detail)
    : await requestConsent({ action, detail, risk: assessed.risk === "low" ? "medium" : assessed.risk, engine: "extension" });
  return approved ? null : `Action blocked by consent gate: ${action}`;
}

function readSkillName(path: string): string | undefined {
  const text = readFileSync(path, "utf-8");
  return text.match(/^name:\s*["']?([^"'\n]+)["']?/m)?.[1]?.trim();
}

function readPluginId(path: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    return typeof parsed.id === "string" ? parsed.id : undefined;
  } catch {
    return undefined;
  }
}

function readAgentsTomlName(path: string): string | undefined {
  const text = readFileSync(path, "utf-8");
  return text.match(/^\s*(?:id|name)\s*=\s*["']([^"']+)["']/m)?.[1]?.trim();
}

function pluginManifestFromAgentsToml(path: string, fallbackName: string): Record<string, unknown> {
  const text = readFileSync(path, "utf-8");
  const id = normalizeExtensionName(readAgentsTomlName(path) ?? fallbackName, "imported-agent-package");
  const description =
    text.match(/^\s*description\s*=\s*["']([^"']+)["']/m)?.[1]?.trim() ??
    `Imported Servus plugin converted from agents.toml package ${id}.`;
  const triggers = [...text.matchAll(/^\s*(?:trigger|when|description)\s*=\s*["']([^"']+)["']/gm)]
    .map((match) => match[1]?.trim())
    .filter((item): item is string => Boolean(item))
    .slice(0, 8);
  return {
    id,
    version: text.match(/^\s*version\s*=\s*["']([^"']+)["']/m)?.[1]?.trim() ?? "0.1.0",
    description,
    tools: [],
    skills: existsSync(join(dirname(path), "SKILL.md")) ? ["."] : [],
    mcpServers: {},
    configSchema: {},
    activation: {
      ...(triggers.length ? { triggers } : {}),
    },
    importedFrom: "agents.toml",
  };
}

function activationSummary(path: string, kind: "skill" | "plugin"): string[] {
  if (kind === "skill") {
    const text = readFileSync(path, "utf-8");
    return [
      `Name: ${readSkillName(path) ?? "(missing)"}`,
      `Description: ${text.match(/^description:\s*["']?([^"'\n]+)["']?/m)?.[1]?.trim() ?? "(missing)"}`,
      `Size: ${statSync(path).size} bytes`,
    ];
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    const activation = parsed.activation && typeof parsed.activation === "object" ? parsed.activation as Record<string, unknown> : {};
    return [
      `Id: ${typeof parsed.id === "string" ? parsed.id : "(missing)"}`,
      `Version: ${typeof parsed.version === "string" ? parsed.version : "(missing)"}`,
      `Tools: ${Array.isArray(parsed.tools) ? parsed.tools.length : 0}`,
      `Skills: ${Array.isArray(parsed.skills) ? parsed.skills.length : 0}`,
      `MCP servers: ${parsed.mcpServers && typeof parsed.mcpServers === "object" ? Object.keys(parsed.mcpServers).length : 0}`,
      `Triggers: ${Array.isArray(activation.triggers) ? activation.triggers.join(", ") : "(none)"}`,
      `Domains: ${Array.isArray(activation.domains) ? activation.domains.join(", ") : "(none)"}`,
    ];
  } catch (err) {
    const agentsToml = join(dirname(path), "agents.toml");
    if (existsSync(agentsToml)) {
      const converted = pluginManifestFromAgentsToml(agentsToml, basename(dirname(path)));
      return [
        "Metadata: agents.toml package",
        `Id: ${converted.id}`,
        `Version: ${converted.version}`,
        `Triggers: ${JSON.stringify((converted.activation as Record<string, unknown>).triggers ?? [])}`,
      ];
    }
    return [`Manifest read error: ${(err as Error).message}`];
  }
}

function repairSkillFile(path: string): string {
  const raw = readFileSync(path, "utf-8");
  if (raw.startsWith("---\n") && /^name:\s*\S+/m.test(raw) && /^description:\s*\S+/m.test(raw)) return raw;
  const name = normalizeExtensionName(readSkillName(path) ?? basename(dirname(path)) ?? "custom-skill", "custom-skill");
  const body = raw.replace(/^---[\s\S]*?---\s*/m, "").trim() || "Use this skill for the custom workflow described by the user.";
  return [
    "---",
    `name: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(`Servus skill for ${name}.`)}`,
    `when_to_use: ${JSON.stringify(`Use when the task matches ${name}.`)}`,
    "---",
    "",
    body,
    "",
  ].join("\n");
}

function repairPluginFile(path: string): string {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  const id = normalizeExtensionName(typeof parsed.id === "string" ? parsed.id : basename(dirname(path)), "custom-plugin");
  const repaired = {
    id,
    version: typeof parsed.version === "string" ? parsed.version : "0.1.0",
    description: typeof parsed.description === "string" ? parsed.description : `Servus plugin for ${id}.`,
    tools: Array.isArray(parsed.tools) ? parsed.tools.filter((item) => typeof item === "string") : [],
    skills: Array.isArray(parsed.skills) ? parsed.skills.filter((item) => typeof item === "string") : [],
    mcpServers: parsed.mcpServers && typeof parsed.mcpServers === "object" ? parsed.mcpServers : {},
    configSchema: parsed.configSchema && typeof parsed.configSchema === "object" ? parsed.configSchema : {},
    activation: parsed.activation && typeof parsed.activation === "object" ? parsed.activation : {},
  };
  return JSON.stringify(repaired, null, 2) + "\n";
}
