import { tool } from "ai";
import { z } from "zod";
import type { TaskDomain } from "./engine.js";

const routeTaskSchema = z.object({
  task: z.string().describe("The user's task or follow-up."),
  proposedDomain: z.enum(["coding", "desktop", "browser", "media", "data", "extension", "security", "general"]).optional(),
  reason: z.string().optional(),
});

const answerWithBasisSchema = z.object({
  answer: z.string().describe("Direct answer to the user."),
  basis: z.array(z.object({
    type: z.enum(["user_supplied_context", "general_knowledge", "routing_decision", "limitation"]),
    summary: z.string(),
  })).min(1),
  routeTo: z.enum(["coding", "desktop", "browser", "media", "data", "extension", "security", "general"]).optional(),
  confidence: z.enum(["low", "medium", "high"]).optional(),
});

export function createGeneralTools() {
  return {
    general_route_task: tool({
      description: [
        "Classify whether a user request can be answered directly or should be handled by another Servus domain.",
        "Use this when the task mentions files, code, browser/web work, media, data, extensions, or security.",
      ].join("\n"),
      inputSchema: routeTaskSchema,
      execute: async (input: z.infer<typeof routeTaskSchema>) => {
        const domain = input.proposedDomain ?? inferGeneralRoute(input.task);
        return [
          `Routing decision: ${domain}`,
          `Reason: ${input.reason ?? routeReason(input.task, domain)}`,
          `Actionable: ${domain !== "general"}`,
          domain === "general"
            ? "General can answer directly from supplied context or general knowledge."
            : `Use the ${domain} engine for tool-backed work.`,
        ].join("\n");
      },
    }),

    general_answer_with_basis: tool({
      description: [
        "Provide a direct answer with explicit basis and limitations.",
        "Do not claim file/web/code/security evidence unless it was supplied by the user.",
      ].join("\n"),
      inputSchema: answerWithBasisSchema,
      execute: async (input: z.infer<typeof answerWithBasisSchema>) => [
        "General answer basis:",
        ...input.basis.map((item) => `- ${item.type}: ${item.summary}`),
        input.routeTo && input.routeTo !== "general" ? `Recommended engine: ${input.routeTo}` : "",
        `Confidence: ${input.confidence ?? "medium"}`,
        "",
        input.answer,
      ].filter(Boolean).join("\n"),
    }),
  };
}

function inferGeneralRoute(task: string): TaskDomain {
  const text = task.toLowerCase();
  if (/\b(code|bug|test|typecheck|repo|component|function|class|api route|compile|build)\b/.test(text)) return "coding";
  if (/\b(file|folder|desktop|clipboard|open app|locate|find my|move|rename|trash)\b/.test(text)) return "desktop";
  if (/\b(browser|website|web page|book|checkout|form|click|navigate|research online)\b/.test(text)) return "browser";
  if (/\b(video|audio|mp4|mp3|ffmpeg|download video|thumbnail|trim|compress)\b/.test(text)) return "media";
  if (/\b(pdf|docx|spreadsheet|csv|xlsx|table|report|extract data|merge)\b/.test(text)) return "data";
  if (/\b(skill|plugin|extension|hook|mcp manifest)\b/.test(text)) return "extension";
  if (/\b(security|vulnerability|xss|sql injection|pentest|threat|hardening|audit)\b/.test(text)) return "security";
  return "general";
}

function routeReason(task: string, domain: TaskDomain): string {
  if (domain === "general") return "The request does not require local tools or specialized domain evidence.";
  return `The request contains ${domain}-specific actions or evidence requirements: ${task.slice(0, 180)}`;
}
