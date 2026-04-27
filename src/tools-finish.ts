import { tool } from "ai";
import { z } from "zod";
import type { AgentFinalization } from "./agent.js";

const confidenceSchema = z.enum(["low", "medium", "high"]);

const evidenceSchema = z.object({
  type: z.string().describe("Evidence type, for example desktop_search, path_verified, screenshot, artifact, test, or scope_check."),
  source: z.string().describe("Tool, file, URL, or artifact that produced the evidence."),
  summary: z.string().describe("Short factual evidence summary."),
  confidence: confidenceSchema.optional(),
  data: z.unknown().optional(),
});

const doneSchema = z.object({
  summary: z.string().describe("What was completed."),
  evidence: z.array(evidenceSchema).min(1).describe("Evidence proving the task is complete."),
  satisfiedCriteria: z.array(z.string()).optional().describe("Acceptance criteria satisfied by this result."),
  artifacts: z.array(z.string()).optional().describe("Created or relevant artifact paths."),
  remainingRisks: z.array(z.string()).optional().describe("Known limitations or residual risk."),
  confidence: confidenceSchema.describe("Overall confidence that the task is actually complete."),
});

const needInputSchema = z.object({
  question: z.string().describe("One clear question needed to continue."),
  questions: z.array(z.string()).optional().describe("Only use multiple questions when they are truly independent and required together."),
  context: z.string().optional().describe("Brief context for why input is needed."),
});

export function createFinishTools(onFinalize: (finalization: AgentFinalization) => void) {
  return {
    servus_done: tool({
      description: [
        "Finish the current Servus task only after tool evidence proves the task is complete.",
        "Do not call this if evidence is missing, ambiguous, stale, or contradicted by verification.",
      ].join("\n"),
      inputSchema: doneSchema,
      execute: async (input: z.infer<typeof doneSchema>) => {
        onFinalize({
          kind: "done",
          summary: input.summary,
          evidence: input.evidence,
          satisfiedCriteria: input.satisfiedCriteria,
          artifacts: input.artifacts,
          remainingRisks: input.remainingRisks,
          confidence: input.confidence,
        });
        return `Servus completion submitted with ${input.evidence.length} evidence item(s), confidence=${input.confidence}.`;
      },
    }),

    servus_need_input: tool({
      description: "Pause the current Servus task and ask the user one clear question when required information is missing or results are ambiguous.",
      inputSchema: needInputSchema,
      execute: async (input: z.infer<typeof needInputSchema>) => {
        onFinalize({
          kind: "need_input",
          question: input.question,
          questions: input.questions?.length ? input.questions : [input.question],
          summary: input.context ?? input.question,
          confidence: "high",
        });
        return `Servus is waiting for user input: ${input.question}`;
      },
    }),
  };
}
