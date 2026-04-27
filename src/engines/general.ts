import { generateText } from "ai";
import { resolveModel } from "../provider.js";
import { log, formatDuration } from "../log.js";
import { bus } from "../events.js";
import type { Engine, EngineContext, EngineResult } from "../engine.js";
import { detectClarificationRequest, stripProtocolTags } from "../clarification.js";

const GENERAL_PROMPT = `
# Role: General Assistant

You are the **General Assistant** in the Servus agent system.
Answer general questions, summarize information already provided by the user,
and help with lightweight reasoning tasks.

## Boundaries

- Do not write, edit, delete, move, or create project files.
- Do not inspect the user's repository or run local commands.
- If the task needs web browsing, bookings, forms, research with current sources,
  or browser interaction, say that the browser engine should handle it.
- If the task needs code changes, say that the coding engine should handle it.
- If the task asks to create Servus skills or plugins, say that the extension engine should handle it.
- If the task asks for security testing or vulnerability analysis, say that the security engine should handle it.

## Output

When complete, include:
    <task_status>DONE</task_status>

If a required detail is missing, include:
    <task_status>NEEDS_INPUT</task_status>

Then ask one clear question.
`.trim();

export class GeneralEngine implements Engine {
  readonly name = "general";
  readonly description =
    "Handles non-coding, non-browser, non-desktop, non-media, non-data, non-extension, non-security general questions without mutating files.";

  async execute(ctx: EngineContext): Promise<EngineResult> {
    const startTime = Date.now();

    try {
      this.emitStatus("working");
      const resolved = resolveModel(ctx.model);
      const response = await generateText({
        model: resolved.model,
        system: GENERAL_PROMPT,
        prompt: [
          "## Task",
          ctx.task,
          "",
          "Answer directly. If another engine is required, say so clearly.",
        ].join("\n"),
        temperature: 0,
      });
      this.emitStatus("done");

      const cleaned = stripProtocolTags(response.text);
      const clarification = detectClarificationRequest(response.text, ctx.task);
      const cost = 0;
      bus.push({
        type: "cost",
        agent: "General",
        message: "cost update",
        metadata: { cost, provider: resolved.provider, modelId: resolved.modelId },
      });

      if (clarification) {
        log.warn("General task is waiting for user input.");
        return {
          success: false,
          needsInput: true,
          summary: clarification.message,
          question: clarification.message,
          questions: clarification.questions,
          questionContext: clarification.context,
          clarification,
          cost,
          error: "Needs user input",
        };
      }

      log.success("General task completed in " + formatDuration(Date.now() - startTime));
      return {
        success: true,
        summary: cleaned || response.text.trim(),
        cost,
      };
    } catch (err: unknown) {
      this.emitStatus("error");
      return {
        success: false,
        summary: "General engine failed: " + (err instanceof Error ? err.message : String(err)),
        cost: 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  close(): void {
    // No persistent local agent resources.
  }

  private emitStatus(status: "working" | "done" | "error"): void {
    bus.push({
      type: "agent:status",
      agent: "General",
      message: status,
    });
  }
}
