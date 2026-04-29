import { generateText } from "ai";
import { existsSync } from "node:fs";
import { z } from "zod";
import { createAgent, type IAgent } from "../agent.js";
import { resolveModel } from "../provider.js";
import { bus } from "../events.js";
import { log, formatDuration, ANSI } from "../log.js";
import type { Engine, EngineContext, EngineResult, TaskDomain } from "../engine.js";
import { createExtensionTools } from "../tools-extension.js";
import {
  createPluginScaffold,
  createSkillScaffold,
  validatePluginFile,
  validateSkillFile,
  type ExtensionKind,
  type ExtensionTarget,
} from "../extension-builder.js";
import {
  createInitialWorkflowState,
  emitDomainWorkflowState,
  type DomainWorkflowPhase,
  runDomainWorkflowRuntime,
} from "../domain-workflow-runtime.js";

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
- Ask a question only when the user did not provide enough detail to decide skill/plugin/both safely.
- Prefer skill for reusable workflows, prompts, standards, domain instructions, or procedural knowledge.
- Prefer plugin for packaging skills/tools/MCP/config/activation together.
- For custom executable tools, scaffold the manifest but keep tools as names only; tool runtime activation is a separate implementation step.
- Use extension_readiness before writing.
- Use create_skill/create_plugin or import/export/repair tools for package operations.
- Always validate with validate_extension or extension_test_activation before servus_done.
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
  private currentTask = "";
  private agent: IAgent | null = null;

  async execute(ctx: EngineContext): Promise<EngineResult> {
    const startTime = Date.now();
    this.currentTask = ctx.task;
    this.emitStatus("working");
    this.emitProgress("orienting", "I’m translating your request into a Servus extension plan.", "Decide whether this should be a skill, plugin, or both.", "extension type, target scope, and generated files");

    try {
      this.agent = await createAgent(ctx.backend, {
        name: "Extension",
        role: "extension-architect",
        color: ANSI.magenta,
        model: ctx.model,
        domain: "extension",
        prompt: EXTENSION_PROMPT,
        extraTools: createExtensionTools(ctx) as Record<string, unknown>,
        disallowedTools: ["bash", "write", "edit", "patch", "webfetch"],
        sessionId: ctx.sessionId,
      }, { cwd: ctx.cwd });

      const result = await runDomainWorkflowRuntime({
        agent: this.agent,
        ctx,
        domain: "extension",
        progressRequired: true,
        plan: [
          "Identify whether the package should be a skill, plugin, or both.",
          "Create, import, export, or repair the extension package.",
          "Validate manifests/skills and run activation checks.",
        ],
        evidenceTypes: ["extension_spec", "manifest_validation", "skill_validation", "activation_test"],
        initialMessage: [
          "## Extension Task",
          ctx.task,
          "",
          "## Working Directory",
          "`" + ctx.cwd + "`",
          "",
          "Use extension tools to create/import/export/repair packages.",
          "Before finalizing, validate the generated or inspected package and call servus_done with concrete files and validation evidence.",
        ].join("\n"),
      });

      if (result.needsInput) {
        this.emitStatus("waiting_input");
        return result;
      }
      if (result.success) {
        this.emitStatus("done");
        log.success("Extension task completed in " + formatDuration(Date.now() - startTime));
        return result;
      }
      this.emitStatus("error");
      return result;
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
    this.agent?.close();
  }

  private emitStatus(status: "working" | "waiting_input" | "done" | "error"): void {
    bus.push({
      type: "agent:status",
      agent: "Extension",
      message: status,
    });
  }

  private emitProgress(
    phase: "orienting" | "planning" | "waiting_input" | "finalizing" | "blocked",
    note: string,
    nextAction: string,
    evidenceNeeded: string,
    confidence: "low" | "medium" | "high" = "medium",
    blocker?: string,
  ): void {
    bus.push({
      type: blocker || phase === "blocked" ? "agent:blocker" : "agent:working_note",
      agent: "Extension",
      message: note,
      color: "#8b5cf6",
      metadata: {
        phase,
        note,
        nextAction,
        evidenceNeeded,
        confidence,
        blocker,
      },
    });
    emitDomainWorkflowState({
      ...createInitialWorkflowState({
        domain: "extension",
        task: this.currentTask,
        activeStep: note,
      }),
      phase: mapExtensionPhase(phase),
      activeStep: note,
      evidence: [{
        type: "extension_spec",
        source: "extension_engine",
        summary: evidenceNeeded,
        confidence,
      }],
      verification: blocker ? [blocker] : [],
    }, "Extension");
  }
}

function mapExtensionPhase(phase: "orienting" | "planning" | "waiting_input" | "finalizing" | "blocked"): DomainWorkflowPhase {
  if (phase === "orienting") return "orient";
  if (phase === "planning") return "plan";
  if (phase === "waiting_input") return "waiting_input";
  if (phase === "blocked") return "failed";
  return "finalize";
}

function validateScaffoldResults(results: Array<{ kind: "skill" | "plugin"; files: string[] }>): string[] {
  const issues: string[] = [];
  for (const result of results) {
    if (result.files.length === 0) {
      issues.push(`No files were created for ${result.kind}.`);
      continue;
    }
    for (const file of result.files) {
      if (!existsSync(file)) {
        issues.push(`Missing expected generated file: ${file}`);
        continue;
      }
      if (file.endsWith("SKILL.md")) issues.push(...validateSkillFile(file));
      if (file.endsWith("servus.plugin.json")) issues.push(...validatePluginFile(file));
    }
  }
  return [...new Set(issues)];
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
