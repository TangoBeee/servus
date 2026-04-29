/**
 * Data Engine — handles PDFs, documents, spreadsheets, CSV/TSV files,
 * structured extraction, format conversion, and report generation.
 */

import { createAgent, type IAgent } from "../agent.js";
import { log, ANSI, formatDuration } from "../log.js";
import { bus } from "../events.js";
import { createDataTools } from "../tools-data.js";
import type { Engine, EngineContext, EngineResult } from "../engine.js";
import { SERVUS_OPERATING_LOOP } from "../prompts/operating-loop.js";
import { runDomainWorkflowRuntime } from "../domain-workflow-runtime.js";

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
- \`data_profile\` — profile one or more documents/tables before analysis.
- \`data_schema_infer\` — infer table schema, types, nulls, samples, and stats.
- \`data_query_table\` — run safe SQL-style table filters/select/order/limit.
- \`data_summarize_table\` — produce row/column/group summaries and data-quality notes.
- \`data_merge_tables\` — merge two table files by key with artifact verification.
- \`data_report_template\` — create a structured report skeleton when planning output.
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
        domain: "data",
        prompt: DATA_PROMPT,
        extraTools: dataTools as Record<string, unknown>,
        disallowedTools: ["bash", "write", "edit", "patch", "webfetch"],
        sessionId: ctx.sessionId,
      }, { cwd: ctx.cwd });

      log.success("Data & Docs agent initialized");
      this.emitStatus("working");

      const result = await runDomainWorkflowRuntime({
        agent: this.agent,
        ctx,
        domain: "data",
        progressRequired: true,
        plan: [
          "Profile source files and infer schema when tabular.",
          "Extract/query/merge/convert only after source inspection.",
          "Verify output artifacts and metadata before completion.",
        ],
        evidenceTypes: ["document_profile", "table_schema", "extraction_result", "report_artifact"],
        initialMessage: [
        "## Data & Docs Task",
        ctx.task,
        "",
        "## Working Directory",
        "`" + ctx.cwd + "`",
        "",
        "Complete this task using servus_done with source/output evidence.",
        "If required user details are missing and you cannot proceed safely, call servus_need_input and ask only the necessary question.",
      ].join("\n"),
      });
      const elapsed = Date.now() - startTime;
      if (result.needsInput) {
        log.warn("Data task is waiting for user input.");
        this.emitStatus("waiting_input");
        return result;
      }
      if (result.success) {
        log.success("Data task completed in " + formatDuration(elapsed));
        this.emitStatus("done");
        return result;
      }

      this.emitStatus("error");
      return result;
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
