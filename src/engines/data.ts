/**
 * Data Engine — handles PDFs, documents, spreadsheets, CSV/TSV files,
 * structured extraction, format conversion, and report generation.
 */

import { createAgent, type IAgent } from "../agent.js";
import { log, ANSI, formatDuration } from "../log.js";
import { bus } from "../events.js";
import { createDataTools } from "../tools-data.js";
import type { Engine, EngineContext, EngineResult } from "../engine.js";
import { detectClarificationRequest, stripProtocolTags } from "../clarification.js";
import { SERVUS_OPERATING_LOOP } from "../prompts/operating-loop.js";
import { resultFromValidatedResponse } from "../agentic-loop.js";

const DATA_PROMPT = `
# Role: Data & Docs Assistant

You are the **Data & Docs Assistant** in the Servus agent system.
Your job is to inspect, extract, convert, summarize, and create document/data
artifacts from PDFs, DOCX files, spreadsheets, CSV/TSV files, JSON, Markdown,
and plain text.

${SERVUS_OPERATING_LOOP}

## Capabilities

- \`data_readiness\` — check parser and format support.
- \`document_info\` — inspect file type, size, pages, sheets, rows, and columns.
- \`extract_document_text\` — extract readable text from PDFs, DOCX, TXT/MD, and tables.
- \`extract_table\` — extract rows from CSV, TSV, XLS/XLSX, or JSON.
- \`write_table\` — write CSV, TSV, XLSX, or JSON.
- \`convert_table\` — convert table formats.
- \`create_report\` — create Markdown/text report artifacts.

## Workflow

1. Identify the source file(s), output format, and requested transformation.
2. Inspect source files before extracting or converting.
3. Use structured table tools for tabular data; use text extraction for documents.
4. Do not overwrite files unless the user asked for it or \`overwrite=true\` is required and approved.
5. Verify output paths and report row/page/sheet counts when available.

## Output Protocol

When complete, call \`servus_done\` with source/output evidence.

Include source path, output path, and a concise summary of extracted or created data.

If required details are missing, call \`servus_need_input\` and ask one clear question.

## Rules

- Do not fabricate extracted data.
- Prefer Markdown reports for human-readable outputs unless the user asks otherwise.
- Keep large extracted text/table previews concise and mention truncation.
- Ask for confirmation or rely on the consent gate before writing outside the working directory or overwriting files.
`.trim();

export class DataEngine implements Engine {
  readonly name = "data";
  readonly description =
    "Handles PDFs, documents, spreadsheets, CSV/TSV files, structured extraction, " +
    "table conversion, and report generation.";

  private agent: IAgent | null = null;

  async execute(ctx: EngineContext): Promise<EngineResult> {
    const startTime = Date.now();

    try {
      const dataTools = createDataTools(ctx);
      this.agent = await createAgent(ctx.backend, {
        name: "Data",
        role: "data-docs",
        color: ANSI.green,
        model: ctx.model,
        prompt: DATA_PROMPT,
        extraTools: dataTools as Record<string, unknown>,
        disallowedTools: ["bash", "write", "edit", "patch", "webfetch"],
        sessionId: ctx.sessionId,
      }, { cwd: ctx.cwd });

      log.success("Data & Docs agent initialized");
      this.emitStatus("working");

      const response = await this.agent.send([
        "## Data & Docs Task",
        ctx.task,
        "",
        "## Working Directory",
        "`" + ctx.cwd + "`",
        "",
        "Complete this task using servus_done with source/output evidence.",
        "If required user details are missing and you cannot proceed safely, call servus_need_input and ask only the necessary question.",
      ].join("\n"));

      this.emitStatus("done");

      const cost = this.agent.cost;
      const elapsed = Date.now() - startTime;
      const clarification = detectClarificationRequest(response.text, ctx.task);
      const cleaned = stripProtocolTags(response.text);
      const finalized = resultFromValidatedResponse(ctx, "data", response);
      if (finalized) {
        this.emitStatus(finalized.needsInput ? "waiting_input" : finalized.success ? "done" : "error");
        return finalized;
      }

      if (clarification) {
        log.warn("Data task is waiting for user input.");
        this.emitStatus("waiting_input");
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

      if (response.text.includes("<task_status>DONE</task_status>")) {
        log.success("Data task completed in " + formatDuration(elapsed));
        return {
          success: true,
          summary: cleaned,
          cost,
        };
      }

      log.warn("Data agent did not signal completion.");
      this.emitStatus("error");
      return {
        success: false,
        summary: "Data agent did not complete the task within the allowed turns.",
        cost,
        error: "Agent did not signal DONE",
      };
    } catch (err) {
      this.emitStatus("error");
      return {
        success: false,
        summary: "Data engine failed: " + (err instanceof Error ? err.message : String(err)),
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
      agent: "Data",
      message: status,
    });
  }
}
