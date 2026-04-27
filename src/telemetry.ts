/**
 * Telemetry — tracks per-engine costs, timings, and usage statistics.
 *
 * Provides a session-level dashboard of how resources were consumed
 * across all engines. Emits events for TUI display.
 */

import { bus } from "./events.js";
import { log } from "./log.js";
import type { EngineResult, TaskDomain } from "./engine.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface EngineMetrics {
  engine: string;
  domain: TaskDomain;
  invocations: number;
  successes: number;
  failures: number;
  totalCostUsd: number;
  totalDurationMs: number;
  lastInvokedAt: string | null;
}

export interface SessionMetrics {
  sessionId: string;
  startedAt: string;
  engines: Map<string, EngineMetrics>;
  totalCostUsd: number;
  totalDurationMs: number;
  totalInvocations: number;
}

// ─── Telemetry Tracker ──────────────────────────────────────────────────────

export class TelemetryTracker {
  private session: SessionMetrics;

  constructor(sessionId?: string) {
    this.session = {
      sessionId: sessionId ?? `session-${Date.now()}`,
      startedAt: new Date().toISOString(),
      engines: new Map(),
      totalCostUsd: 0,
      totalDurationMs: 0,
      totalInvocations: 0,
    };
  }

  /** Record an engine execution result */
  recordExecution(
    engineName: string,
    domain: TaskDomain,
    result: EngineResult,
    durationMs: number,
  ): void {
    let metrics = this.session.engines.get(engineName);
    if (!metrics) {
      metrics = {
        engine: engineName,
        domain,
        invocations: 0,
        successes: 0,
        failures: 0,
        totalCostUsd: 0,
        totalDurationMs: 0,
        lastInvokedAt: null,
      };
      this.session.engines.set(engineName, metrics);
    }

    metrics.invocations++;
    metrics.totalCostUsd += result.cost;
    metrics.totalDurationMs += durationMs;
    metrics.lastInvokedAt = new Date().toISOString();

    if (result.success) {
      metrics.successes++;
    } else {
      metrics.failures++;
    }

    // Update session totals
    this.session.totalCostUsd += result.cost;
    this.session.totalDurationMs += durationMs;
    this.session.totalInvocations++;

    // Emit telemetry event for TUI
    bus.push({
      type: "cost",
      message: `${engineName}: $${result.cost.toFixed(4)} (total: $${this.session.totalCostUsd.toFixed(4)})`,
      metadata: {
        engine: engineName,
        cost: result.cost,
        totalCost: this.session.totalCostUsd,
        durationMs,
      },
    });
  }

  /** Get a snapshot of all session metrics */
  getSessionMetrics(): SessionMetrics {
    return this.session;
  }

  /** Print a summary to the log */
  printSummary(): void {
    log.phase("SESSION TELEMETRY");

    if (this.session.engines.size === 0) {
      log.info("No engine executions recorded.");
      return;
    }

    log.info(`Session: ${this.session.sessionId}`);
    log.info(`Started: ${this.session.startedAt}`);
    log.info(`Total invocations: ${this.session.totalInvocations}`);
    log.info(`Total cost: $${this.session.totalCostUsd.toFixed(4)}`);
    log.info(`Total duration: ${(this.session.totalDurationMs / 1000).toFixed(1)}s`);
    log.info("");

    for (const [name, m] of this.session.engines) {
      log.info(`  ${name}: ${m.invocations} invocations, ${m.successes} ✓, ${m.failures} ✗, $${m.totalCostUsd.toFixed(4)}`);
    }
  }
}
