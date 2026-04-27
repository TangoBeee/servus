import { generateText } from "ai";
import { z } from "zod";
import { resolveModel } from "../provider.js";
import { bus } from "../events.js";
import { log, formatDuration } from "../log.js";
import type { Engine, EngineContext, EngineResult, TaskDomain } from "../engine.js";
import {
  createPluginScaffold,
  createSkillScaffold,
  type ExtensionKind,
  type ExtensionTarget,
} from "../extension-builder.js";

const EXTENSION_PROMPT = `
# Role: Servus Extension Architect

You convert a user's natural-language request into a safe Servus skill/plugin
scaffold plan.

Servus extension types:
- skill: a SKILL.md instruction pack that teaches Servus a workflow.
- plugin: a servus.plugin.json manifest that can activate tools, skills, MCP servers,
  or capability-specific behavior.
- skill_and_plugin: a plugin manifest with a bundled SKILL.md.

Return ONLY valid JSON matching this shape:
{
  "kind": "skill" | "plugin" | "skill_and_plugin" | "question",
  "target": "project" | "user",
  "question": "only if kind is question",
  "skill": {
    "name": "kebab-case-ish name",
    "description": "one sentence trigger description",
    "whenToUse": "when Servus should use it",
    "allowedTools": ["optional-tool-name"]
  },
  "plugin": {
    "id": "kebab-case-ish id",
    "name": "human display name",
    "description": "one sentence plugin description",
    "domains": ["coding" | "desktop" | "browser" | "media" | "data" | "extension" | "security" | "general"],
    "triggers": ["short trigger phrase"],
    "capabilities": ["short capability label"],
    "tools": ["optional future tool name"],
    "includeSkill": true
  }
}

Rules:
- Default target is "project" unless the user explicitly asks for a global/user skill or plugin.
- Ask a question only when the user did not say whether they want a skill, plugin, or both.
- Prefer skill for reusable workflows, prompts, standards, domain instructions, or procedural knowledge.
- Prefer plugin for packaging skills/tools/MCP/config/activation together.
- For custom executable tools, scaffold the manifest but keep tools as names only; tool runtime activation is a separate implementation step.
`.trim();

const DomainSchema = z.enum([
  "coding",
  "desktop",
  "browser",
  "media",
  "data",
  "extension",
  "security",
  "general",
]);

const ExtensionSpecSchema = z.object({
  kind: z.enum(["skill", "plugin", "skill_and_plugin", "question"]),
  target: z.enum(["project", "user"]).optional(),
  question: z.string().optional(),
  skill: z.object({
    name: z.string().optional(),
    description: z.string().optional(),
    whenToUse: z.string().optional(),
    allowedTools: z.array(z.string()).optional(),
  }).optional(),
  plugin: z.object({
    id: z.string().optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    domains: z.array(DomainSchema).optional(),
    triggers: z.array(z.string()).optional(),
    capabilities: z.array(z.string()).optional(),
    tools: z.array(z.string()).optional(),
    includeSkill: z.boolean().optional(),
  }).optional(),
});

type ExtensionSpec = z.infer<typeof ExtensionSpecSchema>;

export class ExtensionEngine implements Engine {
  readonly name = "extension";
  readonly description =
    "Creates Servus custom skills and local plugin manifests from natural-language prompts.";

  async execute(ctx: EngineContext): Promise<EngineResult> {
    const startTime = Date.now();
    this.emitStatus("working");

    try {
      const spec = await inferExtensionSpec(ctx);
      if (spec.kind === "question") {
        const question = spec.question || "Do you want to create a skill, a plugin, or a plugin with a bundled skill?";
        this.emitStatus("waiting_input");
        return {
          success: false,
          needsInput: true,
          summary: question,
          question,
          questions: [question],
          cost: 0,
          error: "Needs user input",
        };
      }

      const target = spec.target ?? "project";
      const results = [];

      if (spec.kind === "skill") {
        const skill = spec.skill ?? {};
        results.push(await createSkillScaffold(ctx, {
          name: skill.name || fallbackName(ctx.task, "skill"),
          description: skill.description || `Custom Servus skill for: ${shortTask(ctx.task)}`,
          prompt: ctx.task,
          whenToUse: skill.whenToUse || ctx.task,
          allowedTools: skill.allowedTools,
          target,
        }));
      } else {
        const plugin = spec.plugin ?? {};
        const skill = spec.skill ?? {};
        results.push(await createPluginScaffold(ctx, {
          id: plugin.id || fallbackName(ctx.task, "plugin"),
          name: plugin.name,
          description: plugin.description || `Custom Servus plugin for: ${shortTask(ctx.task)}`,
          prompt: ctx.task,
          domains: plugin.domains as TaskDomain[] | undefined,
          triggers: plugin.triggers ?? triggerWords(ctx.task),
          capabilities: plugin.capabilities,
          tools: plugin.tools,
          includeSkill: spec.kind === "skill_and_plugin" || plugin.includeSkill,
          skillName: skill.name || plugin.id || plugin.name,
          skillDescription: skill.description || plugin.description,
          target,
        }));
      }

      const blocked = results.find((result) => result.summary.startsWith("Error:") || result.summary.startsWith("Action blocked"));
      if (blocked) {
        this.emitStatus("error");
        return {
          success: false,
          summary: blocked.summary,
          cost: 0,
          error: blocked.summary,
        };
      }

      this.emitStatus("done");
      log.success("Extension scaffold completed in " + formatDuration(Date.now() - startTime));
      return {
        success: true,
        summary: [
          "Extension scaffold complete.",
          ...results.map((result) => result.summary),
        ].join("\n"),
        artifacts: results.flatMap((result) => result.files),
        cost: 0,
      };
    } catch (err) {
      this.emitStatus("error");
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        summary: `Extension engine failed: ${message}`,
        cost: 0,
        error: message,
      };
    }
  }

  close(): void {
    // No persistent resources.
  }

  private emitStatus(status: "working" | "waiting_input" | "done" | "error"): void {
    bus.push({
      type: "agent:status",
      agent: "Extension",
      message: status,
    });
  }
}

async function inferExtensionSpec(ctx: EngineContext): Promise<ExtensionSpec> {
  try {
    const resolved = resolveModel(ctx.model);
    const response = await generateText({
      model: resolved.model,
      system: EXTENSION_PROMPT,
      prompt: ctx.task,
      temperature: 0,
    });
    const parsed = ExtensionSpecSchema.safeParse(parseJson(response.text));
    if (parsed.success) return parsed.data;
    log.warn("Extension planner returned invalid JSON; using heuristic scaffold.");
  } catch (err) {
    log.warn(`Extension planner unavailable: ${err instanceof Error ? err.message : String(err)}. Using heuristic scaffold.`);
  }
  return heuristicSpec(ctx.task);
}

function parseJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fenced?.[1] ?? text).trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("No JSON object found.");
  return JSON.parse(raw.slice(start, end + 1));
}

function heuristicSpec(task: string): ExtensionSpec {
  const lowered = task.toLowerCase();
  const mentionsSkill = /\bskill\b/.test(lowered);
  const mentionsPlugin = /\bplugin\b/.test(lowered);
  if (!mentionsSkill && !mentionsPlugin) {
    return {
      kind: "question",
      question: "Do you want me to create a Servus skill, a plugin, or a plugin with a bundled skill?",
    };
  }
  const target: ExtensionTarget = /\b(global|user|home|all projects)\b/i.test(task) ? "user" : "project";
  const name = fallbackName(task, mentionsPlugin ? "plugin" : "skill");
  const domains = inferDomains(task);
  if (mentionsSkill && mentionsPlugin) {
    return {
      kind: "skill_and_plugin",
      target,
      skill: {
        name,
        description: `Custom Servus skill for: ${shortTask(task)}`,
        whenToUse: task,
      },
      plugin: {
        id: name,
        name,
        description: `Custom Servus plugin for: ${shortTask(task)}`,
        domains,
        triggers: triggerWords(task),
        includeSkill: true,
      },
    };
  }
  if (mentionsPlugin) {
    return {
      kind: "plugin",
      target,
      plugin: {
        id: name,
        name,
        description: `Custom Servus plugin for: ${shortTask(task)}`,
        domains,
        triggers: triggerWords(task),
      },
    };
  }
  return {
    kind: "skill",
    target,
    skill: {
      name,
      description: `Custom Servus skill for: ${shortTask(task)}`,
      whenToUse: task,
    },
  };
}

function fallbackName(task: string, suffix: "skill" | "plugin"): string {
  const named = task.match(/\b(?:called|named|for)\s+["']?([a-z0-9][a-z0-9 _-]{2,48})["']?/i)?.[1];
  const base = named || task.split(/\s+/).slice(0, 5).join(" ") || `custom ${suffix}`;
  return `${base} ${suffix}`;
}

function shortTask(task: string): string {
  return task.trim().replace(/\s+/g, " ").slice(0, 120);
}

function triggerWords(task: string): string[] {
  const words = task
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 4 && !["skill", "plugin", "create", "build", "custom"].includes(word));
  return [...new Set(words)].slice(0, 6);
}

function inferDomains(task: string): TaskDomain[] {
  const lower = task.toLowerCase();
  const domains: TaskDomain[] = [];
  if (/\b(code|repo|typescript|javascript|test|debug|build)\b/.test(lower)) domains.push("coding");
  if (/\b(browser|web|site|booking|form|scrape)\b/.test(lower)) domains.push("browser");
  if (/\b(file|desktop|folder|clipboard|local)\b/.test(lower)) domains.push("desktop");
  if (/\b(video|audio|media|ffmpeg|download)\b/.test(lower)) domains.push("media");
  if (/\b(pdf|docx|spreadsheet|csv|table|report|data)\b/.test(lower)) domains.push("data");
  if (/\bskill|plugin|extension\b/.test(lower)) domains.push("extension");
  if (/\b(security|vulnerability|owasp|xss|sql|secret|pentest|audit)\b/.test(lower)) domains.push("security");
  return domains.length ? domains : ["general"];
}
