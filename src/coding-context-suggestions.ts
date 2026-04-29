import type { AgentToolEvent } from "./agent.js";

export type CodingContextSuggestionSeverity = "info" | "warning";

export interface CodingContextSuggestion {
  severity: CodingContextSuggestionSeverity;
  title: string;
  detail: string;
  savingsTokens?: number;
}

export interface CodingContextSuggestionInput {
  estimatedTokens: number;
  contextWindowTokens: number;
  compactAtTokens: number;
  historyTokens?: number;
  systemTokens?: number;
  toolEvents?: AgentToolEvent[];
  readStateFiles?: number;
  toolResultArtifacts?: number;
  compactions?: number;
}

const NEAR_COMPACT_THRESHOLD_PERCENT = 80;
const TOOL_RESULT_WARNING_CHARS = 24_000;
const TOOL_RESULT_INFO_CHARS = 10_000;
const MANY_READ_FILES = 24;
const MANY_ARTIFACTS = 4;

export function generateCodingContextSuggestions(input: CodingContextSuggestionInput): CodingContextSuggestion[] {
  const suggestions: CodingContextSuggestion[] = [];
  const compactPercent = input.compactAtTokens > 0
    ? Math.round((input.estimatedTokens / input.compactAtTokens) * 100)
    : 0;
  const windowPercent = input.contextWindowTokens > 0
    ? Math.round((input.estimatedTokens / input.contextWindowTokens) * 100)
    : 0;

  if (compactPercent >= NEAR_COMPACT_THRESHOLD_PERCENT) {
    suggestions.push({
      severity: "warning",
      title: `Context is ${compactPercent}% of the compaction threshold`,
      detail: "Servus will compact soon. Use /compact when you want to control the boundary, or ask for a focused summary before continuing.",
      savingsTokens: Math.max(1_000, Math.floor(input.estimatedTokens * 0.25)),
    });
  } else if (windowPercent >= 50) {
    suggestions.push({
      severity: "info",
      title: `Context is ${windowPercent}% of the model window`,
      detail: "Keep follow-ups focused. Prefer /status, /files, /diff, or targeted Read calls instead of broad re-scans.",
      savingsTokens: Math.max(500, Math.floor(input.estimatedTokens * 0.1)),
    });
  }

  const toolResults = (input.toolEvents ?? [])
    .filter((event) => event.type === "result" && typeof event.output === "string")
    .map((event) => ({ toolName: event.toolName, chars: String(event.output).length }));
  const largestToolResult = toolResults.sort((a, b) => b.chars - a.chars)[0];
  if (largestToolResult && largestToolResult.chars >= TOOL_RESULT_WARNING_CHARS) {
    suggestions.push({
      severity: "warning",
      title: `${largestToolResult.toolName} returned a large result`,
      detail: "Use narrower Grep/Glob filters, Read offset/limit, or ReadToolResult for stored artifacts instead of keeping the full output in active context.",
      savingsTokens: Math.floor(largestToolResult.chars / 6),
    });
  } else if (largestToolResult && largestToolResult.chars >= TOOL_RESULT_INFO_CHARS) {
    suggestions.push({
      severity: "info",
      title: `${largestToolResult.toolName} output is taking noticeable context`,
      detail: "If this output is not needed anymore, let Servus compact before broadening the task.",
      savingsTokens: Math.floor(largestToolResult.chars / 8),
    });
  }

  const readResultChars = toolResults
    .filter((event) => event.toolName === "Read" || event.toolName === "read")
    .reduce((sum, event) => sum + event.chars, 0);
  if (readResultChars >= TOOL_RESULT_INFO_CHARS * 2) {
    suggestions.push({
      severity: "info",
      title: "File reads are becoming the dominant context source",
      detail: "Use Read with offset/limit for specific regions, and avoid re-reading files that are already in session state.",
      savingsTokens: Math.floor(readResultChars / 8),
    });
  }

  if ((input.readStateFiles ?? 0) >= MANY_READ_FILES) {
    suggestions.push({
      severity: "info",
      title: `${input.readStateFiles} files have been read in this session`,
      detail: "Before continuing, use /files or /status to re-anchor on the selected files and avoid accidental scope drift.",
    });
  }

  if ((input.toolResultArtifacts ?? 0) >= MANY_ARTIFACTS) {
    suggestions.push({
      severity: "info",
      title: `${input.toolResultArtifacts} large tool outputs are stored as artifacts`,
      detail: "Use ReadToolResult only for the specific artifact slice you need. This keeps the live model context smaller.",
    });
  }

  if ((input.compactions ?? 0) > 0) {
    suggestions.push({
      severity: "info",
      title: `${input.compactions} compaction boundary recorded`,
      detail: "Servus preserved intent, todos, changed files, verification failures, and recent evidence across compaction.",
    });
  }

  return suggestions
    .sort((a, b) => {
      if (a.severity !== b.severity) return a.severity === "warning" ? -1 : 1;
      return (b.savingsTokens ?? 0) - (a.savingsTokens ?? 0);
    })
    .slice(0, 5);
}
