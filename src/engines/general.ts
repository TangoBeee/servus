import { createAgent, type IAgent } from "../agent.js";
import { log, formatDuration, ANSI } from "../log.js";
import { bus } from "../events.js";
import type { Engine, EngineContext, EngineResult } from "../engine.js";
import { SERVUS_OPERATING_LOOP } from "../prompts/operating-loop.js";
import { runDomainWorkflowRuntime } from "../domain-workflow-runtime.js";
import { createGeneralTools } from "../tools-general.js";

const GENERAL_PROMPT = `
# Role: General Assistant

You are the **General Assistant** in the Servus agent system.
Answer general questions, summarize information already provided by the user,
and help with lightweight reasoning tasks.

${SERVUS_OPERATING_LOOP}

## Boundaries

- Do not write, edit, delete, move, or create project files.
- Do not inspect the user's repository or run local commands.
- If the task needs web browsing, bookings, forms, research with current sources,
  or browser interaction, say that the browser engine should handle it.
- If the task needs code changes, say that the coding engine should handle it.
- If the task asks to create Servus skills or plugins, say that the extension engine should handle it.
- If the task asks for security testing or vulnerability analysis, say that the security engine should handle it.

## Output

When complete, call servus_done with evidence from the user prompt or conversation.
Use \`general_route_task\` when the request may belong to another domain.
Use \`general_answer_with_basis\` before finalizing direct answers so the basis is explicit.
If a required detail is missing, call servus_need_input and ask one clear question.
`.trim();

export class GeneralEngine implements Engine {
  readonly name = "general";
  readonly description =
    "Handles non-coding, non-browser, non-desktop, non-media, non-data, non-extension, non-security general questions without mutating files.";

  private agent: IAgent | null = null;

  async execute(ctx: EngineContext): Promise<EngineResult> {
    const startTime = Date.now();

    try {
      this.emitStatus("working");

      this.agent = await createAgent(ctx.backend, {
        name: "General",
        role: "general-assistant",
        color: ANSI.cyan,
        model: ctx.model,
        domain: "general",
        prompt: GENERAL_PROMPT,
        extraTools: createGeneralTools() as Record<string, unknown>,
        disallowedTools: [
          "bash", "Bash", "BashOutput", "KillBash",
          "write", "Write", "edit", "Edit", "MultiEdit", "patch",
          "read", "Read", "grep", "Grep", "glob", "Glob", "ls", "LS",
          "webfetch", "WebFetch", "McpCallTool",
        ],
        sessionId: ctx.sessionId,
      }, { cwd: ctx.cwd });

      const result = await runDomainWorkflowRuntime({
        agent: this.agent,
        ctx,
        domain: "general",
        progressRequired: true,
        plan: [
          "Decide whether the request is directly answerable.",
          "Route to a specialized domain when tool-backed evidence is required.",
          "Answer with explicit basis and limitations.",
        ],
        evidenceTypes: ["general: user_supplied_context", "general: routing_decision", "general: answer_basis"],
        initialMessage: [
          "## General Task",
          ctx.task,
          "",
          "Answer directly when the task is genuinely general.",
          "If another Servus engine is required, say which engine should handle it and why.",
          "Do not claim file, web, security, code, or automation evidence unless the user supplied it in the prompt.",
        ].join("\n"),
      });
      if (result.needsInput) {
        log.warn("General task is waiting for user input.");
        this.emitStatus("waiting_input");
        return result;
      }
      if (result.success) {
        this.emitStatus("done");
        log.success("General task completed in " + formatDuration(Date.now() - startTime));
        return result;
      }
      this.emitStatus("error");
      return result;
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
    this.agent?.close();
  }

  private emitStatus(status: "working" | "waiting_input" | "done" | "error"): void {
    bus.push({
      type: "agent:status",
      agent: "General",
      message: status,
    });
  }
}
