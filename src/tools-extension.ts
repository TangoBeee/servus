import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { SERVUS_DIR } from "./config.js";
import type { EngineContext, TaskDomain } from "./engine.js";
import {
  createPluginScaffold,
  createSkillScaffold,
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
  };
}

export function extensionToolPaths(cwd: string): string[] {
  return [
    join(skillBaseDir(cwd, "project"), "<skill>", "SKILL.md"),
    join(pluginBaseDir(cwd, "project"), "<plugin>", "servus.plugin.json"),
  ];
}
