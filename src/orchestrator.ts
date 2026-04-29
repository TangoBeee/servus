import {
  type IAgent,
  type AgentBackend,
} from "./agent.js";
import { log, ANSI, formatDuration } from "./log.js";
import { bus } from "./events.js";
import type { Engine, EngineContext, EngineResult, TaskDomain } from "./engine.js";
import { classifyTask } from "./router.js";
import { CodingEngine } from "./engines/coding.js";
import { DesktopEngine } from "./engines/desktop.js";
import { BrowserEngine } from "./engines/browser.js";
import { MediaEngine } from "./engines/media.js";
import { DataEngine } from "./engines/data.js";
import { ExtensionEngine } from "./engines/extension.js";
import { SecurityEngine } from "./engines/security.js";
import { GeneralEngine } from "./engines/general.js";
import { ProofCollector } from "./proof.js";
import { TelemetryTracker } from "./telemetry.js";
import { AgentRuntime, createRunSession, type RunStatus } from "./runtime.js";
import { getSession, updateSession } from "./session-store.js";
import { createRunContract } from "./completion-validator.js";
import { resolveCodingTargetWorkspace } from "./coding-project.js";

// ─── Configuration ──────────────────────────────────────────────────────────

export interface OrchestratorConfig {
  task: string;
  cwd: string;
  model: string;
  backend: AgentBackend;
  maxConsecutiveFailures: number;
  verifyCommand?: string;
  maxBudgetUsd?: number;
  preferredDomain?: TaskDomain | "auto";
  /** If set, session logs are appended here (e.g. for TUI runs). */
  sessionId?: string;
}

export interface OrchestratorRunOutcome {
  status: RunStatus;
  domain?: TaskDomain;
  engine?: string;
  result?: EngineResult;
  question?: string;
  questionContext?: string;
  clarification?: EngineResult["clarification"];
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

/**
 * Orchestrator — the supervisor that routes tasks to the appropriate engine.
 *
 * Flow:
 *   1. Classify the user's task into a domain (coding/desktop/browser/media/data/extension/security/general)
 *   2. Route to the appropriate engine
 *   3. Engine executes the task end-to-end
 *   4. Collect proof artifacts + telemetry
 *   5. Report results
 */
export class Orchestrator {
  private config: OrchestratorConfig;
  private engines: Map<TaskDomain, Engine> = new Map();
  private activeEngine: Engine | null = null;
  private telemetry: TelemetryTracker;
  private startTime: number;

  constructor(config: OrchestratorConfig) {
    this.config = config;
    this.startTime = Date.now();
    this.telemetry = new TelemetryTracker(config.sessionId);
    this.registerEngines();
  }

  // ── Engine Registration ────────────────────────────────────────────────

  private registerEngines(): void {
    this.engines.set("coding", new CodingEngine());
    this.engines.set("desktop", new DesktopEngine());
    this.engines.set("browser", new BrowserEngine());
    this.engines.set("media", new MediaEngine());
    this.engines.set("data", new DataEngine());
    this.engines.set("extension", new ExtensionEngine());
    this.engines.set("security", new SecurityEngine());
    this.engines.set("general", new GeneralEngine());
  }

  // ── Public API ──────────────────────────────────────────────────────────

  async run(): Promise<OrchestratorRunOutcome> {
    try {
      // Step 1: Classify the task
      const domain = await this.classifyAndRoute();
      if (this.config.sessionId) {
        updateSession(this.config.sessionId, {
          domain,
          runtimeStatus: "running",
        });
      }

      // Step 2: Get the engine
      const engine = this.engines.get(domain);
      if (!engine) {
        log.warn(`No engine registered for domain "${domain}". Falling back to general.`);
        const fallback = this.engines.get("general")!;
        this.activeEngine = fallback;
        return await this.executeWithEngine(fallback, "general");
      }

      this.activeEngine = engine;
      return await this.executeWithEngine(engine, domain);
    } catch (err) {
      log.error(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    } finally {
      this.telemetry.printSummary();
    }
  }

  closeAll(): void {
    for (const engine of this.engines.values()) {
      engine.close();
    }
  }

  // ── Task Classification ────────────────────────────────────────────────

  private async classifyAndRoute(): Promise<TaskDomain> {
    log.phase("TASK CLASSIFICATION");

    const lockedDomain = this.lockedSessionDomain();
    const domain = lockedDomain
      ?? (this.config.preferredDomain && this.config.preferredDomain !== "auto"
        ? this.config.preferredDomain
        : await classifyTask(this.config.task, this.config.model));

    if (lockedDomain) {
      log.info(`Continuing session ${this.config.sessionId} in existing ${lockedDomain} domain`);
    }

    bus.push({
      type: "engine:start",
      message: `Routing to ${domain} engine`,
      metadata: { domain, engine: this.engines.get(domain)?.name ?? "coding" },
    });
    bus.push({
      type: "runtime:state",
      message: "Task routed",
      metadata: {
        status: "running",
        domain,
        engine: this.engines.get(domain)?.name ?? "coding",
        model: this.config.model,
        backend: this.config.backend,
        budget: this.config.maxBudgetUsd,
      },
    });

    return domain;
  }

  private lockedSessionDomain(): TaskDomain | null {
    if (!this.config.sessionId) return null;
    const session = getSession(this.config.sessionId);
    if (!session || !isConcreteDomain(session.domain)) return null;
    const isContinuation =
      /\bsame servus session continuation\b/i.test(this.config.task) ||
      /\banswered (?:the )?(?:latest )?(?:clarification|approval)\b/i.test(this.config.task) ||
      /\bfollow-up from user\b/i.test(this.config.task);
    if (session.status === "waiting_input" || isContinuation) {
      return session.domain;
    }
    if (session.status === "running" && session.task !== this.config.task) {
      return session.domain;
    }
    return null;
  }

  // ── Engine Execution ────────────────────────────────────────────────────

  private async executeWithEngine(engine: Engine, domain: TaskDomain): Promise<OrchestratorRunOutcome> {
    log.phase(`ENGINE: ${engine.name.toUpperCase()}`);
    log.info(`Engine: ${engine.description}`);
    const workspace = domain === "coding"
      ? resolveCodingTargetWorkspace(this.config.task, this.config.cwd)
      : {
          launchCwd: this.config.cwd,
          targetCwd: this.config.cwd,
          reason: "launch_cwd" as const,
        };

    if (domain === "coding") {
      log.info(
        workspace.reason === "explicit_path"
          ? `Coding target workspace: ${workspace.targetCwd} (from ${workspace.explicitPath})`
          : `Coding target workspace: ${workspace.targetCwd}`,
      );
      if (this.config.sessionId) {
        updateSession(this.config.sessionId, {
          cwd: workspace.targetCwd,
          launchCwd: workspace.launchCwd,
          targetCwd: workspace.targetCwd,
        });
      }
      bus.push({
        type: "runtime:state",
        message: "Coding workspace resolved",
        metadata: {
          status: "running",
          domain,
          engine: engine.name,
          launchCwd: workspace.launchCwd,
          targetCwd: workspace.targetCwd,
          cwd: workspace.targetCwd,
          reason: workspace.reason,
          explicitPath: workspace.explicitPath,
        },
      });
    }

    // Initialize proof collector
    const proof = new ProofCollector(engine.name, this.config.task, workspace.targetCwd);
    proof.addNote(`Routed to ${engine.name} engine (domain: ${domain})`);

    const ctx: EngineContext = {
      task: this.config.task,
      cwd: workspace.targetCwd,
      launchCwd: workspace.launchCwd,
      targetCwd: workspace.targetCwd,
      model: this.config.model,
      backend: this.config.backend,
      maxConsecutiveFailures: this.config.maxConsecutiveFailures,
      verifyCommand: this.config.verifyCommand,
      maxBudgetUsd: this.config.maxBudgetUsd,
      sessionId: this.config.sessionId,
    };

    const runSession = createRunSession({
      task: this.config.task,
      cwd: workspace.targetCwd,
      domain,
      model: this.config.model,
      mode: this.config.backend,
      budget: this.config.maxBudgetUsd,
    });
    runSession.contract = createRunContract(ctx, domain);
    const runtime = new AgentRuntime(runSession);
    runtime.record("engine:route", `Routed to ${engine.name}`, { domain, engine: engine.name });
    if (this.config.sessionId) {
      updateSession(this.config.sessionId, {
        phase: "acting",
        contract: runSession.contract,
        cwd: workspace.targetCwd,
        launchCwd: workspace.launchCwd,
        targetCwd: workspace.targetCwd,
      });
    }

    const engineStart = Date.now();
    const result = await runtime.executeEngine(engine, ctx);
    const durationMs = Date.now() - engineStart;

    // Record telemetry
    this.telemetry.recordExecution(engine.name, domain, result, durationMs);

    // Finalize proof bundle
    const runStatus: RunStatus = result.needsInput
      ? "waiting_input"
      : result.success
        ? "completed"
        : "failed";
    const question = result.question ?? (result.needsInput ? result.summary : undefined);
    const questionContext = result.questionContext;

    if (result.needsInput) {
      proof.recordAction("Engine is waiting for user input: " + result.summary.slice(0, 200));
    } else if (result.success) {
      proof.recordAction("Engine completed successfully: " + result.summary.slice(0, 200));
    } else {
      proof.recordError("Engine failed: " + (result.error ?? result.summary).slice(0, 200));
    }
    const bundle = proof.finalize(result);
    if (this.config.sessionId) {
      updateSession(this.config.sessionId, {
        status: runStatus === "waiting_input" ? "waiting_input" : result.success ? "completed" : "failed",
        runtimeStatus: runStatus,
        phase: runStatus === "waiting_input" ? "waiting_input" : result.success ? "completed" : "failed",
        endTime: Date.now(),
        cost: result.cost,
        proofDir: proof.dir,
        finalSummary: result.summary,
        artifacts: result.artifacts ?? [],
        evidence: result.evidence ?? [],
      });
    }
    bus.push({
      type: "artifact:add",
      message: `Proof bundle: ${proof.dir}`,
      metadata: { proofDir: proof.dir, bundleId: bundle.id },
    });
    bus.push({
      type: "runtime:state",
      message: result.needsInput ? "Waiting for user input" : result.success ? "Run completed" : "Run failed",
      metadata: {
        status: runStatus,
        domain,
        engine: engine.name,
        cost: result.cost,
        durationMs,
        proofDir: proof.dir,
        artifacts: result.artifacts ?? [],
        ...(question ? { question } : {}),
        ...(result.questions ? { questions: result.questions } : {}),
        ...(questionContext ? { questionContext } : {}),
        ...(result.clarification ? { clarification: result.clarification } : {}),
      },
    });

    if (result.needsInput) {
      bus.push({
        type: "user_input:request",
        agent: engine.name,
        message: question ?? result.summary,
        metadata: {
          status: runStatus,
          domain,
          engine: engine.name,
          question: question ?? result.summary,
          questions: result.questions ?? [],
          ...(result.clarification ? { clarification: result.clarification } : {}),
          ...(questionContext ? { questionContext } : {}),
        },
      });
      bus.push({
        type: "engine:needs_input",
        message: question ?? result.summary,
        metadata: {
          engine: engine.name,
          success: false,
          cost: result.cost,
          proofDir: bundle.id,
          questions: result.questions ?? [],
          ...(result.clarification ? { clarification: result.clarification } : {}),
          ...(questionContext ? { questionContext } : {}),
        },
      });
      log.warn(`Engine "${engine.name}" needs user input`);
      log.info(`Proof: ${proof.dir}`);
      return { status: runStatus, domain, engine: engine.name, result, question, questionContext, clarification: result.clarification };
    }

    // Emit result
    bus.push({
      type: result.success ? "engine:complete" : "engine:error",
      message: result.summary,
      metadata: {
        engine: engine.name,
        success: result.success,
        cost: result.cost,
        proofDir: bundle.id,
        ...(result.artifacts ? { artifacts: result.artifacts } : {}),
      },
    });

    if (result.success) {
      log.success(`Engine "${engine.name}" completed successfully`);
      log.info(`Proof: ${proof.dir}`);
    } else {
      log.error(`Engine "${engine.name}" failed: ${result.error ?? result.summary}`);
      log.info(`Proof: ${proof.dir}`);
    }

    return { status: runStatus, domain, engine: engine.name, result };
  }
}

function isConcreteDomain(domain: unknown): domain is TaskDomain {
  return (
    domain === "coding" ||
    domain === "desktop" ||
    domain === "browser" ||
    domain === "media" ||
    domain === "data" ||
    domain === "extension" ||
    domain === "security" ||
    domain === "general"
  );
}
