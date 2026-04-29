import { tool } from "ai";
import { z } from "zod";
import type { AgentFinalization } from "./agent.js";
import { bus } from "./events.js";

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
  header: z.string().optional().describe("Short 1-3 word label for the question, e.g. Scope, Approach, Target."),
  question: z.string().describe("One clear question needed to continue."),
  questions: z.array(z.string()).optional().describe("Only use multiple questions when they are truly independent and required together."),
  options: z.array(z.object({
    label: z.string().describe("Short selectable option label."),
    description: z.string().optional().describe("Brief explanation of what this option means."),
  })).min(2).max(4).optional().describe("Meaningful choices when the user can decide between concrete alternatives. Do not include an Other option."),
  context: z.string().optional().describe("Brief context for why input is needed."),
});

const askUserQuestionSchema = z.object({
  questions: z.array(z.object({
    header: z.string().describe("Very short label for this question, e.g. Scope, Approach, Target."),
    question: z.string().describe("One clear, concrete question to ask the user."),
    options: z.array(z.object({
      label: z.string().describe("Short selectable option label."),
      description: z.string().describe("Brief explanation of what this option means."),
      preview: z.string().optional().describe("Optional short markdown preview for comparing concrete options."),
    })).min(2).max(4),
    multiSelect: z.boolean().optional().default(false),
  })).min(1).max(1).describe("Ask one question at a time. Use a later turn if more information is still needed."),
  context: z.string().optional().describe("Brief context for why input is needed."),
});

const progressSchema = z.object({
  phase: z.enum(["orienting", "discovering", "planning", "acting", "verifying", "waiting_input", "finalizing", "blocked"]).describe("Current public work phase."),
  note: z.string().describe("Short public note explaining what you are checking or deciding. Do not reveal hidden chain-of-thought."),
  nextAction: z.string().optional().describe("Concrete next action you intend to take."),
  evidenceNeeded: z.array(z.string()).optional().describe("Evidence still needed before completion."),
  confidence: confidenceSchema.optional().describe("Current confidence in the path you are taking."),
  blocker: z.string().optional().describe("Blocker that prevents progress, if any."),
});

export function createFinishTools(
  onFinalize: (finalization: AgentFinalization) => void,
  options: { agentName?: string; color?: string } = {},
) {
  return {
    servus_progress: tool({
      description: [
        "Report a concise public working note to the user.",
        "Use this at the start of work, before meaningful tool use, after important evidence, before asking input, and before finalizing.",
        "This is not hidden reasoning. Summarize intent, evidence, next action, and blockers in plain English.",
      ].join("\n"),
      inputSchema: progressSchema,
      execute: async (input: z.infer<typeof progressSchema>) => {
        const lines = [
          input.note,
          input.nextAction ? `Next: ${input.nextAction}` : undefined,
          input.evidenceNeeded?.length ? `Evidence needed: ${input.evidenceNeeded.join(", ")}` : undefined,
          input.blocker ? `Blocker: ${input.blocker}` : undefined,
        ].filter(Boolean).join("\n");
        bus.push({
          type: input.blocker || input.phase === "blocked" ? "agent:blocker" : "agent:working_note",
          agent: options.agentName,
          color: options.color,
          message: lines,
          metadata: {
            phase: input.phase,
            note: input.note,
            nextAction: input.nextAction,
            evidenceNeeded: input.evidenceNeeded,
            confidence: input.confidence,
            blocker: input.blocker,
          },
        });
        return `Progress noted: ${input.phase}`;
      },
    }),

    ReportProgress: tool({
      description: "Alias of servus_progress for reporting public working notes.",
      inputSchema: progressSchema,
      execute: async (input: z.infer<typeof progressSchema>) => {
        const lines = [
          input.note,
          input.nextAction ? `Next: ${input.nextAction}` : undefined,
          input.evidenceNeeded?.length ? `Evidence needed: ${input.evidenceNeeded.join(", ")}` : undefined,
          input.blocker ? `Blocker: ${input.blocker}` : undefined,
        ].filter(Boolean).join("\n");
        bus.push({
          type: input.blocker || input.phase === "blocked" ? "agent:blocker" : "agent:working_note",
          agent: options.agentName,
          color: options.color,
          message: lines,
          metadata: {
            phase: input.phase,
            note: input.note,
            nextAction: input.nextAction,
            evidenceNeeded: input.evidenceNeeded,
            confidence: input.confidence,
            blocker: input.blocker,
          },
        });
        return `Progress noted: ${input.phase}`;
      },
    }),

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
          ...(input.options?.length
            ? { choices: [{
                id: "coding_choice",
                label: input.header ?? "Choice",
                options: input.options.map((option) => option.description ? `${option.label} - ${option.description}` : option.label),
                required: true,
              }] }
            : {}),
          summary: input.context ?? input.question,
          confidence: "high",
        });
        return `Servus is waiting for user input: ${input.question}`;
      },
    }),

    AskUserQuestion: tool({
      description: [
        "Servus question tool.",
        "Use only when you need one user decision before continuing.",
        "Ask one concrete question with 2-4 meaningful options. Do not ask for generic approval of a plan; use ExitPlanMode for that.",
      ].join("\n"),
      inputSchema: askUserQuestionSchema,
      execute: async (input: z.infer<typeof askUserQuestionSchema>) => {
        const first = input.questions[0];
        onFinalize({
          kind: "need_input",
          question: first.question,
          questions: [first.question],
          choices: [{
            id: "ask_user_question",
            label: first.header,
            options: first.options.map((option) => {
              const preview = option.preview ? ` Preview: ${option.preview}` : "";
              return `${option.label} - ${option.description}${preview}`;
            }),
            required: true,
          }],
          summary: input.context ?? first.question,
          confidence: "high",
        });
        return `Servus is waiting for user input: ${first.question}`;
      },
    }),
  };
}
