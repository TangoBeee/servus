import { tool } from "ai";
import { z } from "zod";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import mammoth from "mammoth";
import xlsx from "node-xlsx";
import { parse as parseCsv } from "csv-parse/sync";
import { extractText, getDocumentProxy } from "unpdf";
import { assessRisk, requestConsent } from "./consent.js";
import type { EngineContext } from "./engine.js";

const MAX_TEXT_CHARS = 80_000;
const MAX_TABLE_ROWS = 2_000;

const documentInfoSchema = z.object({
  path: z.string().describe("Path to a PDF, DOCX, TXT, CSV/TSV, XLS/XLSX, JSON, or Markdown file."),
});

const extractDocumentTextSchema = z.object({
  path: z.string().describe("Path to the document to extract text from."),
  maxChars: z.number().int().positive().max(500_000).optional(),
});

const extractTableSchema = z.object({
  path: z.string().describe("Path to a CSV, TSV, XLS, XLSX, or JSON table file."),
  sheet: z.union([z.string(), z.number()]).optional().describe("Sheet name or zero-based sheet index for Excel files."),
  delimiter: z.string().max(4).optional().describe("Delimiter for text tables. Defaults to comma or tab by extension."),
  maxRows: z.number().int().positive().max(20_000).optional(),
});

const writeTableSchema = z.object({
  outputPath: z.string().describe("Destination path. Extension chooses format: .csv, .tsv, .xlsx, or .json."),
  rows: z.array(z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())])).describe("Rows to write as objects or arrays."),
  sheetName: z.string().optional().describe("Sheet name for XLSX output."),
  overwrite: z.boolean().optional().describe("Allow overwriting an existing file."),
});

const convertTableSchema = z.object({
  inputPath: z.string().describe("Source table path."),
  outputPath: z.string().describe("Destination table path."),
  sheet: z.union([z.string(), z.number()]).optional(),
  overwrite: z.boolean().optional(),
});

const createReportSchema = z.object({
  title: z.string().describe("Report title."),
  outputPath: z.string().describe("Destination .md or .txt path."),
  sections: z.array(z.object({
    heading: z.string(),
    content: z.string(),
  })).describe("Report sections."),
  overwrite: z.boolean().optional(),
});

const dataProfileSchema = z.object({
  paths: z.array(z.string()).min(1).max(50).describe("Document/table paths to profile."),
  sampleRows: z.number().int().positive().max(500).optional(),
});

const dataSchemaInferSchema = z.object({
  path: z.string().describe("CSV, TSV, XLS/XLSX, or JSON table path."),
  sheet: z.union([z.string(), z.number()]).optional(),
  sampleRows: z.number().int().positive().max(20_000).optional(),
});

const dataQueryTableSchema = z.object({
  path: z.string().describe("CSV, TSV, XLS/XLSX, or JSON table path."),
  sheet: z.union([z.string(), z.number()]).optional(),
  select: z.array(z.string()).optional().describe("Columns to include. Defaults to all columns."),
  where: z.array(z.object({
    column: z.string(),
    op: z.enum(["eq", "neq", "contains", "gt", "gte", "lt", "lte", "empty", "not_empty"]),
    value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  })).optional(),
  orderBy: z.string().optional(),
  order: z.enum(["asc", "desc"]).optional(),
  limit: z.number().int().positive().max(1000).optional(),
});

const dataSummarizeTableSchema = z.object({
  path: z.string().describe("CSV, TSV, XLS/XLSX, or JSON table path."),
  sheet: z.union([z.string(), z.number()]).optional(),
  groupBy: z.array(z.string()).max(3).optional().describe("Optional categorical columns to group by."),
  sampleRows: z.number().int().positive().max(20_000).optional(),
});

const dataMergeTablesSchema = z.object({
  leftPath: z.string(),
  rightPath: z.string(),
  leftKey: z.string(),
  rightKey: z.string().optional(),
  outputPath: z.string().describe("Destination .csv, .tsv, .xlsx, or .json path."),
  join: z.enum(["inner", "left"]).optional(),
  overwrite: z.boolean().optional(),
});

const dataReportTemplateSchema = z.object({
  title: z.string(),
  outputPath: z.string().optional().describe("Optional .md/.txt output path. If omitted, returns the template only."),
  sources: z.array(z.string()).optional(),
  sections: z.array(z.string()).optional().describe("Requested report sections."),
  overwrite: z.boolean().optional(),
});

type DataToolContext = Pick<EngineContext, "cwd" | "onConsent">;
type DataQueryCondition = NonNullable<z.infer<typeof dataQueryTableSchema>["where"]>[number];

export function createDataTools(ctx: DataToolContext) {
  return {
    data_readiness: tool({
      description: "Report Data & Docs parser readiness and supported formats.",
      inputSchema: z.object({}),
      execute: async () => [
        "Data & Docs readiness: ready",
        "PDF: unpdf",
        "DOCX: mammoth",
        "CSV/TSV: csv-parse",
        "XLS/XLSX: node-xlsx",
        "Outputs: markdown, text, csv, tsv, json, xlsx",
      ].join("\n"),
    }),

    document_info: tool({
      description: "Inspect a document/table file and return file type, size, and basic structure.",
      inputSchema: documentInfoSchema,
      execute: async (input: z.infer<typeof documentInfoSchema>) => {
        const path = resolveInputPath(ctx.cwd, input.path);
        if (!existsSync(path)) return `Error: file not found — ${path}`;
        const stat = statSync(path);
        if (stat.isDirectory()) return `Error: expected a file, got directory — ${path}`;
        const ext = extname(path).toLowerCase();
        const lines = [
          `Path: ${path}`,
          `Type: ${ext || "unknown"}`,
          `Size: ${formatBytes(stat.size)}`,
        ];

        if (ext === ".pdf") {
          const pdf = await getPdf(path);
          const { totalPages } = await extractText(pdf, { mergePages: true });
          lines.push(`Pages: ${totalPages}`);
        } else if (ext === ".xlsx" || ext === ".xls") {
          const sheets = xlsx.parse(path);
          lines.push(`Sheets: ${sheets.length}`);
          for (const sheet of sheets.slice(0, 12)) {
            lines.push(`- ${sheet.name}: ${sheet.data.length} row(s)`);
          }
        } else if (isTableExt(ext)) {
          const rows = readDelimitedTable(path, ext, undefined, 100);
          lines.push(`Rows sampled: ${rows.length}`);
          if (rows[0]) lines.push(`Columns: ${Object.keys(rows[0]).join(", ")}`);
        } else if (ext === ".docx") {
          const text = await mammoth.extractRawText({ path });
          lines.push(`Characters: ${text.value.length}`);
        } else {
          const text = readFileSync(path, "utf-8");
          lines.push(`Characters: ${text.length}`);
          lines.push(`Lines: ${text.split(/\r?\n/).length}`);
        }

        return lines.join("\n");
      },
    }),

    extract_document_text: tool({
      description: "Extract readable text from PDF, DOCX, TXT, Markdown, CSV/TSV, XLS/XLSX, or JSON.",
      inputSchema: extractDocumentTextSchema,
      execute: async (input: z.infer<typeof extractDocumentTextSchema>) => {
        const path = resolveInputPath(ctx.cwd, input.path);
        if (!existsSync(path)) return `Error: file not found — ${path}`;
        const maxChars = input.maxChars ?? MAX_TEXT_CHARS;
        const ext = extname(path).toLowerCase();
        const text = await readDocumentText(path, ext);
        return clamp([
          `Path: ${path}`,
          `Type: ${ext || "unknown"}`,
          "",
          text,
        ].join("\n"), maxChars);
      },
    }),

    extract_table: tool({
      description: "Extract rows from CSV, TSV, XLS, XLSX, or JSON into a compact preview with JSON data.",
      inputSchema: extractTableSchema,
      execute: async (input: z.infer<typeof extractTableSchema>) => {
        const path = resolveInputPath(ctx.cwd, input.path);
        if (!existsSync(path)) return `Error: file not found — ${path}`;
        const rows = readTable(path, input.sheet, input.delimiter, input.maxRows ?? MAX_TABLE_ROWS);
        const columns = collectColumns(rows);
        return [
          `Path: ${path}`,
          `Rows: ${rows.length}`,
          `Columns: ${columns.join(", ") || "(none)"}`,
          "",
          "Preview:",
          tablePreview(rows.slice(0, 20)),
          "",
          "JSON:",
          JSON.stringify(rows.slice(0, input.maxRows ?? 200), null, 2),
        ].join("\n");
      },
    }),

    data_profile: tool({
      description: [
        "Profile one or more data/doc files before extraction or reporting.",
        "Returns document/table metadata, previews, row/page/sheet counts, and artifact evidence.",
      ].join("\n"),
      inputSchema: dataProfileSchema,
      execute: async (input: z.infer<typeof dataProfileSchema>) => {
        const profiles: string[] = [];
        for (const rawPath of input.paths) {
          const path = resolveInputPath(ctx.cwd, rawPath);
          profiles.push(await profileDataPath(path, input.sampleRows ?? 50));
        }
        return [
          `Data profile collection: ${profiles.length} source(s)`,
          "",
          profiles.join("\n\n---\n\n"),
        ].join("\n");
      },
    }),

    data_schema_infer: tool({
      description: [
        "Infer table schema, column types, null counts, distinct samples, and numeric summaries.",
        "Use before transforming, joining, or reporting on tabular data.",
      ].join("\n"),
      inputSchema: dataSchemaInferSchema,
      execute: async (input: z.infer<typeof dataSchemaInferSchema>) => {
        const path = resolveInputPath(ctx.cwd, input.path);
        if (!existsSync(path)) return `Error: file not found — ${path}`;
        const rows = readTable(path, input.sheet, undefined, input.sampleRows ?? MAX_TABLE_ROWS);
        return renderSchemaInference(path, rows);
      },
    }),

    data_query_table: tool({
      description: [
        "Run a safe SQL-style query over CSV/TSV/XLSX/JSON table data.",
        "Supports select, simple where filters, order, and limit.",
      ].join("\n"),
      inputSchema: dataQueryTableSchema,
      execute: async (input: z.infer<typeof dataQueryTableSchema>) => {
        const path = resolveInputPath(ctx.cwd, input.path);
        if (!existsSync(path)) return `Error: file not found — ${path}`;
        const rows = readTable(path, input.sheet, undefined, MAX_TABLE_ROWS);
        const queried = queryRows(rows, input);
        const columns = collectColumns(queried);
        return [
          `Query source: ${path}`,
          `Input rows: ${rows.length}`,
          `Output rows: ${queried.length}`,
          `Columns: ${columns.join(", ") || "(none)"}`,
          "",
          tablePreview(queried),
          "",
          "JSON:",
          JSON.stringify(queried.slice(0, input.limit ?? 200), null, 2),
        ].join("\n");
      },
    }),

    data_summarize_table: tool({
      description: [
        "Summarize table data with row counts, column profiles, numeric stats, top categorical values, and optional group counts.",
        "Use this for SQL-style summaries and project reports before writing a final report.",
      ].join("\n"),
      inputSchema: dataSummarizeTableSchema,
      execute: async (input: z.infer<typeof dataSummarizeTableSchema>) => {
        const path = resolveInputPath(ctx.cwd, input.path);
        if (!existsSync(path)) return `Error: file not found — ${path}`;
        const rows = readTable(path, input.sheet, undefined, input.sampleRows ?? MAX_TABLE_ROWS);
        return summarizeRows(path, rows, input.groupBy ?? []);
      },
    }),

    data_merge_tables: tool({
      description: [
        "Merge two table files by key and write the result to CSV/TSV/XLSX/JSON.",
        "Use data_schema_infer first when column names or key quality are uncertain.",
      ].join("\n"),
      inputSchema: dataMergeTablesSchema,
      execute: async (input: z.infer<typeof dataMergeTablesSchema>) => {
        const leftPath = resolveInputPath(ctx.cwd, input.leftPath);
        const rightPath = resolveInputPath(ctx.cwd, input.rightPath);
        if (!existsSync(leftPath)) return `Error: left table not found — ${leftPath}`;
        if (!existsSync(rightPath)) return `Error: right table not found — ${rightPath}`;
        const outputPath = resolveOutputPath(ctx.cwd, input.outputPath);
        const consent = await guardWrite(ctx, "data_merge_tables", outputPath, input.overwrite);
        if (consent) return consent;
        const left = readTable(leftPath, undefined, undefined, MAX_TABLE_ROWS);
        const right = readTable(rightPath, undefined, undefined, MAX_TABLE_ROWS);
        const merged = mergeRows(left, right, input.leftKey, input.rightKey ?? input.leftKey, input.join ?? "inner");
        writeRows(outputPath, merged, "Merged");
        return [
          `Merged tables: ${merged.length} row(s)`,
          `Left: ${leftPath} (${left.length} rows)`,
          `Right: ${rightPath} (${right.length} rows)`,
          `Join: ${input.join ?? "inner"} on ${input.leftKey} = ${input.rightKey ?? input.leftKey}`,
          `Output: ${outputPath}`,
          `Artifact: ${outputPath}`,
        ].join("\n");
      },
    }),

    data_report_template: tool({
      description: [
        "Create or return a structured report template based on source profiles and desired sections.",
        "Use before create_report when the report structure is unclear.",
      ].join("\n"),
      inputSchema: dataReportTemplateSchema,
      execute: async (input: z.infer<typeof dataReportTemplateSchema>) => {
        const sections = input.sections?.length
          ? input.sections
          : ["Executive summary", "Sources inspected", "Key findings", "Data quality notes", "Recommended next steps"];
        const markdown = [
          `# ${input.title}`,
          "",
          "## Executive summary",
          "",
          "<write the concise answer here after inspecting source evidence>",
          "",
          ...sections
            .filter((section) => section.toLowerCase() !== "executive summary")
            .flatMap((section) => [
              `## ${section}`,
              "",
              section.toLowerCase().includes("source")
                ? (input.sources?.map((source) => `- ${source}`).join("\n") || "- <source path>")
                : "- <evidence-backed note>",
              "",
            ]),
        ].join("\n").trimEnd() + "\n";
        if (!input.outputPath) return markdown;
        const outputPath = resolveOutputPath(ctx.cwd, input.outputPath);
        const consent = await guardWrite(ctx, "data_report_template", outputPath, input.overwrite);
        if (consent) return consent;
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, markdown, "utf-8");
        return `Created report template: ${outputPath}\nSections: ${sections.length}\nArtifact: ${outputPath}`;
      },
    }),

    write_table: tool({
      description: "Write table rows to CSV, TSV, XLSX, or JSON. Requires overwrite=true for existing files.",
      inputSchema: writeTableSchema,
      execute: async (input: z.infer<typeof writeTableSchema>) => {
        const outputPath = resolveOutputPath(ctx.cwd, input.outputPath);
        const consent = await guardWrite(ctx, "write_table", outputPath, input.overwrite);
        if (consent) return consent;
        writeRows(outputPath, normalizeRows(input.rows), input.sheetName ?? "Sheet1");
        return `Wrote ${input.rows.length} row(s) to ${outputPath}`;
      },
    }),

    convert_table: tool({
      description: "Convert between CSV, TSV, XLS/XLSX, and JSON table formats.",
      inputSchema: convertTableSchema,
      execute: async (input: z.infer<typeof convertTableSchema>) => {
        const inputPath = resolveInputPath(ctx.cwd, input.inputPath);
        if (!existsSync(inputPath)) return `Error: file not found — ${inputPath}`;
        const outputPath = resolveOutputPath(ctx.cwd, input.outputPath);
        const consent = await guardWrite(ctx, "convert_table", outputPath, input.overwrite);
        if (consent) return consent;
        const rows = readTable(inputPath, input.sheet, undefined, MAX_TABLE_ROWS);
        writeRows(outputPath, rows, "Sheet1");
        return `Converted ${rows.length} row(s)\nFrom: ${inputPath}\nTo: ${outputPath}`;
      },
    }),

    create_report: tool({
      description: "Create a Markdown or text report artifact from structured sections.",
      inputSchema: createReportSchema,
      execute: async (input: z.infer<typeof createReportSchema>) => {
        const outputPath = resolveOutputPath(ctx.cwd, input.outputPath);
        const consent = await guardWrite(ctx, "create_report", outputPath, input.overwrite);
        if (consent) return consent;
        const ext = extname(outputPath).toLowerCase();
        if (ext && ext !== ".md" && ext !== ".txt") {
          return "Error: reports must be written as .md or .txt files.";
        }
        const markdown = [
          `# ${input.title}`,
          "",
          ...input.sections.flatMap((section) => [
            `## ${section.heading}`,
            "",
            section.content.trim(),
            "",
          ]),
        ].join("\n").trimEnd() + "\n";
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, markdown, "utf-8");
        return `Created report: ${outputPath}\nSections: ${input.sections.length}`;
      },
    }),
  };
}

async function getPdf(path: string) {
  const data = readFileSync(path);
  return await getDocumentProxy(new Uint8Array(data));
}

async function readDocumentText(path: string, ext: string): Promise<string> {
  if (ext === ".pdf") {
    const pdf = await getPdf(path);
    const { text } = await extractText(pdf, { mergePages: true });
    return Array.isArray(text) ? text.join("\n\n") : text;
  }
  if (ext === ".docx") {
    const result = await mammoth.extractRawText({ path });
    return result.value;
  }
  if (ext === ".xlsx" || ext === ".xls" || isTableExt(ext)) {
    const rows = readTable(path, undefined, undefined, 500);
    return tablePreview(rows);
  }
  return readFileSync(path, "utf-8");
}

function readTable(path: string, sheet?: string | number, delimiter?: string, maxRows = MAX_TABLE_ROWS): Record<string, unknown>[] {
  const ext = extname(path).toLowerCase();
  if (ext === ".xlsx" || ext === ".xls") return readWorkbook(path, sheet, maxRows);
  if (ext === ".json") return normalizeRows(JSON.parse(readFileSync(path, "utf-8")) as unknown);
  return readDelimitedTable(path, ext, delimiter, maxRows);
}

function readWorkbook(path: string, sheet: string | number | undefined, maxRows: number): Record<string, unknown>[] {
  const sheets = xlsx.parse(path);
  const selected = typeof sheet === "number"
    ? sheets[sheet]
    : typeof sheet === "string"
      ? sheets.find((candidate) => candidate.name === sheet)
      : sheets[0];
  if (!selected) return [];
  return arrayRowsToObjects(selected.data.slice(0, maxRows) as unknown[][]);
}

function readDelimitedTable(path: string, ext: string, delimiter: string | undefined, maxRows: number): Record<string, unknown>[] {
  const content = readFileSync(path, "utf-8");
  const parsed = parseCsv(content, {
    columns: true,
    skip_empty_lines: true,
    delimiter: delimiter ?? (ext === ".tsv" ? "\t" : ","),
    bom: true,
    relax_column_count: true,
  }) as Record<string, unknown>[];
  return parsed.slice(0, maxRows);
}

function writeRows(outputPath: string, rows: Record<string, unknown>[], sheetName: string): void {
  mkdirSync(dirname(outputPath), { recursive: true });
  const ext = extname(outputPath).toLowerCase();
  if (ext === ".json") {
    writeFileSync(outputPath, JSON.stringify(rows, null, 2) + "\n", "utf-8");
    return;
  }
  if (ext === ".xlsx" || ext === ".xls") {
    const data = objectsToArrayRows(rows);
    writeFileSync(outputPath, xlsx.build([{ name: sheetName, data, options: {} }]));
    return;
  }
  if (ext === ".csv" || ext === ".tsv") {
    const delimiter = ext === ".tsv" ? "\t" : ",";
    writeFileSync(outputPath, serializeDelimited(rows, delimiter), "utf-8");
    return;
  }
  throw new Error("Unsupported output table format. Use .csv, .tsv, .xlsx, or .json.");
}

function normalizeRows(rows: unknown): Record<string, unknown>[] {
  if (!Array.isArray(rows)) return [];
  if (rows.length === 0) return [];
  if (Array.isArray(rows[0])) return arrayRowsToObjects(rows as unknown[][]);
  return rows.map((row) => row && typeof row === "object" && !Array.isArray(row)
    ? row as Record<string, unknown>
    : { value: row });
}

function arrayRowsToObjects(rows: unknown[][]): Record<string, unknown>[] {
  if (rows.length === 0) return [];
  const headers = rows[0].map((value, index) => String(value || `column_${index + 1}`));
  return rows.slice(1).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ""])));
}

function objectsToArrayRows(rows: Record<string, unknown>[]): unknown[][] {
  const columns = collectColumns(rows);
  return [columns, ...rows.map((row) => columns.map((column) => row[column] ?? ""))];
}

function collectColumns(rows: Record<string, unknown>[]): string[] {
  const columns = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) columns.add(key);
  }
  return [...columns];
}

function serializeDelimited(rows: Record<string, unknown>[], delimiter: string): string {
  const columns = collectColumns(rows);
  const lines = [
    columns.map((value) => quoteCell(value, delimiter)).join(delimiter),
    ...rows.map((row) => columns.map((column) => quoteCell(row[column], delimiter)).join(delimiter)),
  ];
  return lines.join("\n") + "\n";
}

function quoteCell(value: unknown, delimiter: string): string {
  const text = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);
  if (text.includes('"') || text.includes("\n") || text.includes("\r") || text.includes(delimiter)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function tablePreview(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "(no rows)";
  const columns = collectColumns(rows).slice(0, 12);
  const lines = [
    columns.join(" | "),
    columns.map(() => "---").join(" | "),
    ...rows.slice(0, 20).map((row) => columns.map((column) => String(row[column] ?? "").slice(0, 80)).join(" | ")),
  ];
  return lines.join("\n");
}

async function profileDataPath(path: string, sampleRows: number): Promise<string> {
  if (!existsSync(path)) return `Path: ${path}\nStatus: missing`;
  const stat = statSync(path);
  if (stat.isDirectory()) return `Path: ${path}\nStatus: directory (data_profile expects files)\nSize: ${formatBytes(stat.size)}`;
  const ext = extname(path).toLowerCase();
  const lines = [
    `Path: ${path}`,
    `Type: ${ext || "unknown"}`,
    `Size: ${formatBytes(stat.size)}`,
    `Modified: ${new Date(stat.mtimeMs).toISOString()}`,
  ];
  try {
    if (ext === ".pdf") {
      const pdf = await getPdf(path);
      const { text, totalPages } = await extractText(pdf, { mergePages: true });
      const body = Array.isArray(text) ? text.join("\n\n") : text;
      lines.push(`Pages: ${totalPages}`, `Characters sampled: ${Math.min(body.length, 2000)}`);
      lines.push("", body.slice(0, 2000));
    } else if (ext === ".docx") {
      const result = await mammoth.extractRawText({ path });
      lines.push(`Characters: ${result.value.length}`, "", result.value.slice(0, 2000));
    } else if (ext === ".xlsx" || ext === ".xls" || isTableExt(ext) || ext === ".json") {
      const rows = readTable(path, undefined, undefined, sampleRows);
      lines.push(`Rows sampled: ${rows.length}`, `Columns: ${collectColumns(rows).join(", ") || "(none)"}`, "", tablePreview(rows));
    } else {
      const text = readFileSync(path, "utf-8");
      lines.push(`Characters: ${text.length}`, `Lines: ${text.split(/\r?\n/).length}`, "", text.slice(0, 2000));
    }
  } catch (err) {
    lines.push(`Profile error: ${(err as Error).message}`);
  }
  return lines.join("\n");
}

function renderSchemaInference(path: string, rows: Record<string, unknown>[]): string {
  const columns = collectColumns(rows);
  const lines = [
    `Schema inference: ${path}`,
    `Rows sampled: ${rows.length}`,
    `Columns: ${columns.length}`,
    "",
  ];
  for (const column of columns) {
    const values = rows.map((row) => row[column]);
    const nonEmpty = values.filter((value) => !isEmptyValue(value));
    const type = inferColumnType(nonEmpty);
    const distinct = new Set(nonEmpty.map((value) => String(value))).size;
    lines.push(`- ${column}`);
    lines.push(`  type: ${type}`);
    lines.push(`  nonEmpty: ${nonEmpty.length}/${values.length}`);
    lines.push(`  distinct: ${distinct}`);
    const samples = [...new Set(nonEmpty.map((value) => String(value)).filter(Boolean))].slice(0, 5);
    if (samples.length) lines.push(`  samples: ${samples.join(", ")}`);
    if (type === "number") {
      const nums = nonEmpty.map((value) => Number(value)).filter((value) => Number.isFinite(value));
      if (nums.length) {
        lines.push(`  min: ${Math.min(...nums)}`);
        lines.push(`  max: ${Math.max(...nums)}`);
        lines.push(`  avg: ${Math.round((nums.reduce((sum, value) => sum + value, 0) / nums.length) * 100) / 100}`);
      }
    }
  }
  lines.push("", "Structured schema:");
  lines.push(JSON.stringify(columns.map((column) => columnProfile(column, rows)), null, 2));
  return lines.join("\n");
}

function columnProfile(column: string, rows: Record<string, unknown>[]): Record<string, unknown> {
  const values = rows.map((row) => row[column]);
  const nonEmpty = values.filter((value) => !isEmptyValue(value));
  return {
    column,
    type: inferColumnType(nonEmpty),
    rowCount: rows.length,
    nonEmpty: nonEmpty.length,
    empty: rows.length - nonEmpty.length,
    distinct: new Set(nonEmpty.map((value) => String(value))).size,
    samples: [...new Set(nonEmpty.map((value) => String(value)).filter(Boolean))].slice(0, 8),
  };
}

function inferColumnType(values: unknown[]): "empty" | "boolean" | "number" | "date" | "string" | "mixed" {
  if (!values.length) return "empty";
  const bool = values.filter((value) => /^(true|false|yes|no|0|1)$/i.test(String(value).trim())).length;
  const nums = values.filter((value) => String(value).trim() !== "" && Number.isFinite(Number(value))).length;
  const dates = values.filter((value) => {
    const text = String(value).trim();
    return text.length >= 6 && !Number.isFinite(Number(text)) && Number.isFinite(Date.parse(text));
  }).length;
  const threshold = Math.max(1, Math.floor(values.length * 0.8));
  if (bool >= threshold) return "boolean";
  if (nums >= threshold) return "number";
  if (dates >= threshold) return "date";
  if (bool || nums || dates) return "mixed";
  return "string";
}

function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === "";
}

function queryRows(rows: Record<string, unknown>[], input: z.infer<typeof dataQueryTableSchema>): Record<string, unknown>[] {
  let result = rows.filter((row) => (input.where ?? []).every((condition) => matchCondition(row, condition)));
  if (input.orderBy) {
    const direction = input.order === "desc" ? -1 : 1;
    result = [...result].sort((a, b) => compareValues(a[input.orderBy!], b[input.orderBy!]) * direction);
  }
  if (input.select?.length) {
    result = result.map((row) => Object.fromEntries(input.select!.map((column) => [column, row[column] ?? ""])));
  }
  return result.slice(0, input.limit ?? 100);
}

function matchCondition(row: Record<string, unknown>, condition: DataQueryCondition): boolean {
  const raw = row[condition.column];
  const text = String(raw ?? "");
  const expected = condition.value;
  if (condition.op === "empty") return isEmptyValue(raw);
  if (condition.op === "not_empty") return !isEmptyValue(raw);
  if (condition.op === "contains") return text.toLowerCase().includes(String(expected ?? "").toLowerCase());
  if (condition.op === "eq") return text === String(expected ?? "");
  if (condition.op === "neq") return text !== String(expected ?? "");
  const actualNumber = Number(raw);
  const expectedNumber = Number(expected);
  if (!Number.isFinite(actualNumber) || !Number.isFinite(expectedNumber)) return false;
  if (condition.op === "gt") return actualNumber > expectedNumber;
  if (condition.op === "gte") return actualNumber >= expectedNumber;
  if (condition.op === "lt") return actualNumber < expectedNumber;
  if (condition.op === "lte") return actualNumber <= expectedNumber;
  return false;
}

function compareValues(a: unknown, b: unknown): number {
  const an = Number(a);
  const bn = Number(b);
  if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
  return String(a ?? "").localeCompare(String(b ?? ""));
}

function mergeRows(
  left: Record<string, unknown>[],
  right: Record<string, unknown>[],
  leftKey: string,
  rightKey: string,
  joinType: "inner" | "left",
): Record<string, unknown>[] {
  const rightIndex = new Map<string, Record<string, unknown>[]>();
  for (const row of right) {
    const key = String(row[rightKey] ?? "");
    if (!rightIndex.has(key)) rightIndex.set(key, []);
    rightIndex.get(key)!.push(row);
  }
  const merged: Record<string, unknown>[] = [];
  for (const leftRow of left) {
    const matches = rightIndex.get(String(leftRow[leftKey] ?? ""));
    if (!matches?.length) {
      if (joinType === "left") merged.push(prefixRow("left", leftRow));
      continue;
    }
    for (const rightRow of matches) {
      merged.push({
        ...prefixRow("left", leftRow),
        ...prefixRow("right", rightRow),
      });
    }
  }
  return merged;
}

function prefixRow(prefix: string, row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [`${prefix}.${key}`, value]));
}

function summarizeRows(path: string, rows: Record<string, unknown>[], groupBy: string[]): string {
  const columns = collectColumns(rows);
  const lines = [
    `Table summary: ${path}`,
    `Rows sampled: ${rows.length}`,
    `Columns: ${columns.length}`,
    "",
    "Column summaries:",
  ];
  for (const column of columns) {
    const profile = columnProfile(column, rows);
    lines.push(`- ${column}: ${profile.type}, non-empty ${profile.nonEmpty}/${profile.rowCount}, distinct ${profile.distinct}`);
    const type = String(profile.type);
    const values = rows.map((row) => row[column]).filter((value) => !isEmptyValue(value));
    if (type === "number") {
      const nums = values.map((value) => Number(value)).filter((value) => Number.isFinite(value));
      if (nums.length) {
        lines.push(`  min=${Math.min(...nums)} max=${Math.max(...nums)} avg=${Math.round((nums.reduce((sum, value) => sum + value, 0) / nums.length) * 100) / 100}`);
      }
    } else {
      lines.push(`  top=${topValues(values).join(", ") || "(none)"}`);
    }
  }
  if (groupBy.length) {
    lines.push("", "Group counts:");
    for (const group of groupBy) {
      const counts = new Map<string, number>();
      for (const row of rows) {
        const key = String(row[group] ?? "");
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      lines.push(`- ${group}`);
      for (const [key, count] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
        lines.push(`  ${key || "(empty)"}: ${count}`);
      }
    }
  }
  lines.push("", "Data quality notes:");
  const sparse = columns
    .map((column) => columnProfile(column, rows))
    .filter((profile) => typeof profile.empty === "number" && profile.rowCount && Number(profile.empty) / Number(profile.rowCount) > 0.5)
    .map((profile) => profile.column);
  lines.push(sparse.length ? `- Sparse columns over 50% empty: ${sparse.join(", ")}` : "- No columns sampled over 50% empty.");
  return lines.join("\n");
}

function topValues(values: unknown[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = String(value ?? "");
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([value, count]) => `${value} (${count})`);
}

async function guardWrite(
  ctx: DataToolContext,
  action: string,
  outputPath: string,
  overwrite?: boolean,
): Promise<string | null> {
  if (existsSync(outputPath) && !overwrite) {
    return `Error: output exists — ${outputPath}. Set overwrite=true to replace it.`;
  }
  const outside = isOutside(ctx.cwd, outputPath);
  if (!outside && !existsSync(outputPath)) return null;

  const detail = [
    `Output: ${outputPath}`,
    existsSync(outputPath) ? "This will overwrite an existing file." : "",
    outside ? `This writes outside the working directory: ${ctx.cwd}` : "",
  ].filter(Boolean).join("\n");
  const assessed = assessRisk(`${action}\n${detail}`);
  const risk = outside || existsSync(outputPath)
    ? "high"
    : assessed.risk === "low" ? "medium" : assessed.risk;
  const approved = ctx.onConsent
    ? await ctx.onConsent(action, detail)
    : await requestConsent({
        action,
        detail,
        risk,
        engine: "data",
      });
  return approved ? null : `Action blocked by consent gate: ${action}`;
}

function resolveInputPath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function resolveOutputPath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function isOutside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel.startsWith("..") || rel === ".." || isAbsolute(rel);
}

function isTableExt(ext: string): boolean {
  return ext === ".csv" || ext === ".tsv";
}

function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = Math.floor((max - 80) / 2);
  return `${text.slice(0, keep)}\n\n[... truncated ${text.length - max} characters ...]\n\n${text.slice(-keep)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
