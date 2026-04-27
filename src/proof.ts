/**
 * Proof Collector — captures proof artifacts for each engine execution.
 *
 * Records what the agent did, screenshots taken, files modified, costs incurred,
 * and verification results. Produces a proof bundle that can be reviewed by
 * humans to verify what the agent accomplished.
 *
 * Inspired by proofshot (https://github.com/nichochar/proofshot).
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { resolve, basename } from "node:path";
import { log } from "./log.js";
import type { EngineResult } from "./engine.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ProofEntry {
  timestamp: string;
  type: "action" | "screenshot" | "file_change" | "verification" | "cost" | "error" | "note";
  engine: string;
  detail: string;
  path?: string;
}

export interface ProofBundle {
  id: string;
  task: string;
  engine: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  success: boolean;
  status: "success" | "waiting_input" | "failed";
  entries: ProofEntry[];
  totalCost: number;
  summary: string;
}

// ─── Proof Collector ────────────────────────────────────────────────────────

export class ProofCollector {
  private entries: ProofEntry[] = [];
  private engine: string;
  private startTime: number;
  private task: string;
  private proofDir: string;

  constructor(engine: string, task: string, cwd: string) {
    this.engine = engine;
    this.task = task;
    this.startTime = Date.now();

    // Create proof output directory
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    this.proofDir = resolve(cwd, ".servus-proofs", `${engine}-${timestamp}`);
    mkdirSync(this.proofDir, { recursive: true });
  }

  // ── Recording Methods ──────────────────────────────────────────────────

  /** Record an action the agent took */
  recordAction(detail: string): void {
    this.entries.push({
      timestamp: new Date().toISOString(),
      type: "action",
      engine: this.engine,
      detail,
    });
  }

  /** Record a screenshot path */
  recordScreenshot(path: string, description?: string): void {
    this.entries.push({
      timestamp: new Date().toISOString(),
      type: "screenshot",
      engine: this.engine,
      detail: description ?? `Screenshot captured`,
      path,
    });
  }

  /** Record a file change */
  recordFileChange(path: string, action: "created" | "modified" | "deleted"): void {
    this.entries.push({
      timestamp: new Date().toISOString(),
      type: "file_change",
      engine: this.engine,
      detail: `${action}: ${path}`,
      path,
    });
  }

  /** Record a verification result */
  recordVerification(passed: boolean, detail: string): void {
    this.entries.push({
      timestamp: new Date().toISOString(),
      type: "verification",
      engine: this.engine,
      detail: `${passed ? "PASS" : "FAIL"}: ${detail}`,
    });
  }

  /** Record an error */
  recordError(detail: string): void {
    this.entries.push({
      timestamp: new Date().toISOString(),
      type: "error",
      engine: this.engine,
      detail,
    });
  }

  /** Record a cost entry */
  recordCost(amount: number, label: string): void {
    this.entries.push({
      timestamp: new Date().toISOString(),
      type: "cost",
      engine: this.engine,
      detail: `$${amount.toFixed(4)} — ${label}`,
    });
  }

  /** Add a general note */
  addNote(detail: string): void {
    this.entries.push({
      timestamp: new Date().toISOString(),
      type: "note",
      engine: this.engine,
      detail,
    });
  }

  // ── Bundle Generation ──────────────────────────────────────────────────

  /** Finalize and save the proof bundle */
  finalize(result: EngineResult): ProofBundle {
    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - this.startTime;

    // Record final cost
    if (result.cost > 0) {
      this.recordCost(result.cost, "total session cost");
    }

    const bundle: ProofBundle = {
      id: `proof-${Date.now()}`,
      task: this.task,
      engine: this.engine,
      startedAt: new Date(this.startTime).toISOString(),
      completedAt,
      durationMs,
      success: result.success,
      status: result.needsInput ? "waiting_input" : result.success ? "success" : "failed",
      entries: this.entries,
      totalCost: result.cost,
      summary: result.summary,
    };

    // Save as JSON
    const jsonPath = resolve(this.proofDir, "proof.json");
    writeFileSync(jsonPath, JSON.stringify(bundle, null, 2), "utf-8");

    // Save human-readable markdown report
    const mdPath = resolve(this.proofDir, "proof.md");
    writeFileSync(mdPath, this.generateMarkdown(bundle), "utf-8");

    log.success(`Proof bundle saved: ${this.proofDir}`);

    return bundle;
  }

  // ── Markdown Report ────────────────────────────────────────────────────

  private generateMarkdown(bundle: ProofBundle): string {
    const lines: string[] = [];

    lines.push(`# Proof Report: ${bundle.engine}`);
    lines.push("");
    lines.push(`**Task:** ${bundle.task}`);
    lines.push(`**Engine:** ${bundle.engine}`);
    lines.push(`**Status:** ${formatProofStatus(bundle.status)}`);
    lines.push(`**Duration:** ${(bundle.durationMs / 1000).toFixed(1)}s`);
    lines.push(`**Cost:** $${bundle.totalCost.toFixed(4)}`);
    lines.push(`**Started:** ${bundle.startedAt}`);
    lines.push(`**Completed:** ${bundle.completedAt}`);
    lines.push("");

    lines.push("## Summary");
    lines.push(bundle.summary);
    lines.push("");

    // Group entries by type
    const actions = bundle.entries.filter((e) => e.type === "action");
    const screenshots = bundle.entries.filter((e) => e.type === "screenshot");
    const fileChanges = bundle.entries.filter((e) => e.type === "file_change");
    const verifications = bundle.entries.filter((e) => e.type === "verification");
    const errors = bundle.entries.filter((e) => e.type === "error");

    if (actions.length > 0) {
      lines.push("## Actions Taken");
      for (const entry of actions) {
        lines.push(`- ${entry.detail}`);
      }
      lines.push("");
    }

    if (fileChanges.length > 0) {
      lines.push("## File Changes");
      for (const entry of fileChanges) {
        lines.push(`- ${entry.detail}`);
      }
      lines.push("");
    }

    if (verifications.length > 0) {
      lines.push("## Verification Results");
      for (const entry of verifications) {
        lines.push(`- ${entry.detail}`);
      }
      lines.push("");
    }

    if (screenshots.length > 0) {
      lines.push("## Screenshots");
      for (const entry of screenshots) {
        lines.push(`- ${entry.detail}: \`${entry.path}\``);
      }
      lines.push("");
    }

    if (errors.length > 0) {
      lines.push("## Errors");
      for (const entry of errors) {
        lines.push(`- ⚠️ ${entry.detail}`);
      }
      lines.push("");
    }

    lines.push("## Full Timeline");
    lines.push("");
    lines.push("| Time | Type | Detail |");
    lines.push("|------|------|--------|");
    for (const entry of bundle.entries) {
      const time = entry.timestamp.slice(11, 19);
      lines.push(`| ${time} | ${entry.type} | ${entry.detail} |`);
    }

    return lines.join("\n");
  }

  /** Get the proof directory path */
  get dir(): string {
    return this.proofDir;
  }
}

function formatProofStatus(status: ProofBundle["status"]): string {
  if (status === "success") return "Success";
  if (status === "waiting_input") return "Waiting for user input";
  return "Failed";
}
