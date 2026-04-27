/**
 * Desktop Engine — handles file management, OS automation, and local system tasks.
 *
 * Uses a single agent with desktop-specific tools (ranked search, candidate
 * selection, open files, clipboard, trash, disk usage) plus safe read-only base tools.
 */

import { createAgent, type IAgent } from "../agent.js";
import { log, ANSI, formatDuration } from "../log.js";
import { bus } from "../events.js";
import { createDesktopToolsWithContext } from "../tools-desktop.js";
import type { Engine, EngineContext, EngineResult } from "../engine.js";
import { SERVUS_OPERATING_LOOP } from "../prompts/operating-loop.js";
import { runValidatedAgentTask } from "../agentic-loop.js";

// ─── Desktop System Prompt ──────────────────────────────────────────────────

const DESKTOP_PROMPT = `
# Role: Desktop Assistant

You are the **Desktop Assistant** in the Servus agent system.
Your job is to handle file management, system operations, and local desktop tasks
with precision and efficiency. Operate autonomously when enough information is available.

${SERVUS_OPERATING_LOOP}

## Your Capabilities

1. **File Search & Discovery**
   - Use \`desktop_search\` to find ranked candidates by name, type, and recency
   - Use \`desktop_select_candidate\` to select and verify a candidate by id
   - Use \`desktop_inspect_path\` and \`desktop_verify_action\` to prove exact paths and postconditions
   - Use \`spotlight\` only as a fallback; never choose the first raw result without verification
   - Use \`glob\` and \`grep\` for precise pattern matching
   - Use \`ls\` to browse directory contents

2. **File Operations**
   - Use \`file_move\` to move or rename files/folders
   - Use \`trash\` to safely delete files (moves to system Trash)
   - Ask for a different engine if the task requires broad shell scripting or code edits

3. **System Interaction**
   - Use \`open\` to launch files/URLs with default or specific applications
   - Use \`clipboard_read\` / \`clipboard_write\` to interact with the system clipboard
   - Use \`disk_usage\` to check storage space

4. **Reading & Inspecting**
   - Use \`read\` to view file contents
   - Use \`desktop_inspect_path\` for metadata such as type, size, and modified time

## Workflow

1. **Understand the task** — parse what the user wants done
2. **Search/discover** — search cwd first, then home, and collect ranked candidates
3. **Act** — perform the operation (move, open, copy, etc.)
4. **Verify** — confirm the exact candidate/path and action postcondition
5. **Report** — summarize what was done

## Output Protocol

When the task is complete, call \`servus_done\` with concrete evidence.
For locate tasks, evidence must include ranked candidate search and path verification.

If the task cannot proceed safely without required user details, do NOT output
DONE. Call \`servus_need_input\` and ask one clear question.

## Rules

- NEVER modify source code files — you are for FILE MANAGEMENT, not coding
- NEVER delete files permanently — always use \`trash\` or ask for confirmation
- NEVER access files outside the user's home directory unless explicitly asked
- Prefer \`desktop_search\` because it ranks candidates and records match reasons
- If multiple candidates are close, ask which one instead of guessing
- Always verify your actions succeeded before reporting DONE
`.trim();

// ─── Desktop Engine ─────────────────────────────────────────────────────────

export class DesktopEngine implements Engine {
  readonly name = "desktop";
  readonly description =
    "Handles local file management, searching, opening applications, clipboard operations, " +
    "and OS-level automation. Use for tasks like finding files, organizing folders, " +
    "checking disk space, or opening documents.";

  private agent: IAgent | null = null;

  async execute(ctx: EngineContext): Promise<EngineResult> {
    const startTime = Date.now();

    try {
      const desktopTools = createDesktopToolsWithContext(ctx);

      // Create a single desktop agent with desktop tools + base tools
      this.agent = await createAgent(ctx.backend, {
        name: "Desktop",
        role: "file-manager",
        color: ANSI.cyan,
        model: ctx.model,
        prompt: DESKTOP_PROMPT,
        extraTools: desktopTools as Record<string, unknown>,
        disallowedTools: ["bash", "write", "edit", "patch", "webfetch"],
        sessionId: ctx.sessionId,
      }, { cwd: ctx.cwd });

      log.success("Desktop agent initialized");

      this.emitStatus("working");

      const home = process.env.HOME ?? "/tmp";

      const result = await runValidatedAgentTask({
        agent: this.agent,
        ctx,
        domain: "desktop",
        initialMessage:
        [
          "## Task",
          ctx.task,
          "",
          "## Working Directory",
          "`" + ctx.cwd + "`",
          "",
          "## Home Directory",
          "`" + home + "`",
          "",
          "Complete this task using the Servus Operating Loop.",
          "For file location tasks, search cwd first, then home, rank candidates, verify the selected path, and ask if ambiguous.",
        ].join("\n"),
      });

      const elapsed = Date.now() - startTime;
      if (result.needsInput) {
        log.warn("Desktop task is waiting for user input.");
        this.emitStatus("waiting_input");
        return result;
      }
      if (result.success) {
        this.emitStatus("done");
        log.success("Desktop task completed in " + formatDuration(elapsed));
        return result;
      }

      this.emitStatus("error");
      return result;
    } catch (err) {
      this.emitStatus("error");
      return {
        success: false,
        summary: "Desktop engine failed: " + (err instanceof Error ? err.message : String(err)),
        cost: this.agent?.cost ?? 0,
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
      agent: "Desktop",
      message: status,
    });
  }
}
