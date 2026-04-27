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

type DataToolContext = Pick<EngineContext, "cwd" | "onConsent">;

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
