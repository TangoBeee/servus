/**
 * Coding Engine — normal execution uses the Servus coding runtime.
 *
 * The historical role-loop remains as an internal emergency fallback only.
 * Its planner/developer/tester modules are loaded lazily so the normal coding
 * import path stays runtime-first.
 */

import { log, ANSI, truncate, formatDuration } from "../log.js";
import { bus } from "../events.js";
import type { Engine, EngineContext, EngineResult } from "../engine.js";
import {
  CodingRuntime,
  changedFilesLabel,
  type CodingHelperRequest,
  type CodingHelperType,
  type VerificationAttempt,
} from "../coding-runtime.js";
import {
  finalizationToSummary,
  getFinalization,
} from "../completion-validator.js";
import { CodingConversationLoop } from "../coding-conversation-loop.js";
import {
  ServusCodingSession,
  codingAgentColorForMode,
  codingAgentNameForMode,
} from "../coding-session.js";
import { updateProjectMemoryFromCodingRun } from "../project-memory.js";


// ─── Coding Engine ──────────────────────────────────────────────────────────

export class CodingEngine implements Engine {
  readonly name = "coding";
  readonly description =
    "Handles software development tasks with a session-owned coding runtime, evidence-backed completion, checkpoints, and verification.";

  private primary?: CodingConversationLoop;
  private codingSession?: ServusCodingSession;
  private helpers: Array<{ close(): void }> = [];
  private legacy?: Engine;
  private helperCost = 0;

  async execute(ctx: EngineContext): Promise<EngineResult> {
    this.helperCost = 0;
    this.helpers = [];
    if (process.env.SERVUS_INTERNAL_CODING_LEGACY === "1") {
      const { LegacyCodingEngine } = await import("./coding-legacy.js");
      this.legacy = new LegacyCodingEngine();
      return await this.legacy.execute(ctx);
    }

    this.codingSession = await ServusCodingSession.start(ctx);
    const startTime = this.codingSession.startedAt;
    const runtime = this.codingSession.runtime;

    const immediate = await this.tryRunImmediateCommand(runtime, startTime);
    if (immediate) return immediate;

    const intentQuestion = runtime.intentQuestion();
    if (intentQuestion) {
      runtime.setPhase("waiting_input", intentQuestion.question);
      this.printRuntimeSummary(runtime, startTime);
      return {
        success: false,
        needsInput: true,
        summary: intentQuestion.question,
        question: intentQuestion.question,
        questions: [intentQuestion.question],
        questionContext: intentQuestion.summary,
        evidence: runtime.state.evidence,
        cost: 0,
        error: "Needs intent clarification",
      };
    }

    await this.runPreflightHelpers(ctx, runtime);
    if (this.isRuntimeBudgetExceeded(ctx)) {
      return await this.finalizeRuntime(runtime, startTime, {
        success: false,
        summary: `Coding budget limit reached during preflight helpers. Budget: $${ctx.maxBudgetUsd?.toFixed(4)}, cost: $${this.runtimeCost().toFixed(4)}.`,
        evidence: runtime.state.evidence,
        cost: this.runtimeCost(),
        error: "Budget limit reached",
      });
    }

    this.primary = this.codingSession.createLoop({
      agentName: codingAgentNameForMode(runtime.state.mode),
      color: codingAgentColorForMode(runtime.state.mode),
      model: runtime.state.command?.custom?.model ?? ctx.model,
      systemPrompt: runtime.buildSystemPrompt(),
      disallowedTools: primaryDisallowedTools(runtime),
      runTaskHelper: async (request) => {
        await this.runHelper(
          ctx,
          runtime,
          request.type,
          `Task ${request.id}: ${request.description}`,
          request.prompt,
          request.id,
        );
        return runtime.buildHelperReturnMessage([request]);
      },
    });

    let message = [
      runtime.buildInitialMessage(),
      runtime.buildHelperContextMessage(),
    ].filter(Boolean).join("\n\n");
    let lastVerification: VerificationAttempt | undefined;
    const maxAttempts = Math.max(1, ctx.maxConsecutiveFailures);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      runtime.setPhase(
        attempt === 0
          ? initialPhaseForMode(runtime.state.mode)
          : "repairing",
        attempt === 0 ? "Running coding agent" : `Repair attempt ${attempt + 1}`,
      );

      const turn = this.codingSession.beginTurn(message, { attempt, mode: runtime.state.mode });
      const response = await this.primary.send(message);
      turn.finish(response);
      runtime.absorbAgentResponse(response);
      if (this.isRuntimeBudgetExceeded(ctx)) {
        return await this.finalizeRuntime(runtime, startTime, {
          success: false,
          summary: `Coding budget limit reached. Budget: $${ctx.maxBudgetUsd?.toFixed(4)}, cost: $${this.runtimeCost().toFixed(4)}.`,
          evidence: runtime.state.evidence,
          cost: this.runtimeCost(),
          error: "Budget limit reached",
        });
      }

      const helperRequests = runtime.takePendingHelperRequests();
      if (helperRequests.length > 0) {
        await this.runRequestedHelpers(ctx, runtime, helperRequests);
        message = runtime.buildHelperReturnMessage(helperRequests);
        continue;
      }

      const finalization = getFinalization(response);
      if (
        !finalization &&
        ["error_rate_limit", "error_stream_protocol", "error_max_turns"].includes(response.subtype)
      ) {
        if (attempt >= maxAttempts - 1) {
          const summary = `Coding agent stopped before completion evidence was available (${response.subtype}).`;
          return await this.finalizeRuntime(runtime, startTime, {
            success: false,
            summary,
            evidence: runtime.state.evidence,
            cost: this.runtimeCost(),
            error: response.text,
          });
        }
        message = runtime.buildTransientRecoveryMessage(response);
        continue;
      }

      if (finalization?.kind === "need_input") {
        runtime.setPhase("waiting_input", finalization.question ?? "Needs user input");
        const question = finalization.question ?? finalization.summary ?? "I need one more detail to continue.";
        return {
          success: false,
          needsInput: true,
          summary: question,
          question,
          questions: finalization.questions ?? [question],
          questionContext: finalization.summary,
          ...(finalization.choices?.length ? {
            clarification: {
              mode: "blocking_facts",
              message: question,
              context: finalization.summary ?? question,
              questions: finalization.questions ?? [question],
              choices: finalization.choices,
              sameSession: true,
            },
          } : {}),
          cost: this.runtimeCost(),
          error: "Needs user input",
        };
      }

      const checkpoint = await runtime.createCheckpoint(response);
      await this.runReviewHelperIfNeeded(ctx, runtime, checkpoint.changedFiles);

      if (runtime.shouldVerifyAfterResponse(response)) {
        lastVerification = await runtime.verify("project");
      }
      await this.runVerificationHelperIfNeeded(
        ctx,
        runtime,
        checkpoint.changedFiles,
        lastVerification,
      );

      const decision = runtime.validateCompletion(response, lastVerification);
      if (decision.accepted) {
        const checkpoint = runtime.state.checkpoints.at(-1);
        const artifacts = [...new Set([...(finalization?.artifacts ?? []), ...runtime.state.artifacts])];
        const summary = [
          finalizationToSummary(response),
          "",
          runtime.state.mode === "build"
            ? `Changed files: ${changedFilesLabel(checkpoint?.changedFiles ?? [])}`
            : `Mode: read-only ${runtime.state.mode}`,
          lastVerification ? `Verification: ${lastVerification.status} (${lastVerification.command})` : undefined,
        ].filter(Boolean).join("\n");
        return await this.finalizeRuntime(runtime, startTime, {
          success: true,
          summary,
          artifacts,
          evidence: runtime.state.evidence,
          cost: this.runtimeCost(),
        });
      }

      if (attempt >= maxAttempts - 1) {
        const summary = [
          "Coding agent did not provide enough verified evidence to complete the task.",
          "",
          "Missing criteria:",
          ...decision.missing.map((item) => `- ${item}`),
          lastVerification?.status === "failed" ? "" : undefined,
          lastVerification?.status === "failed" ? `Last verification failed: ${lastVerification.command}` : undefined,
        ].filter(Boolean).join("\n");
        return await this.finalizeRuntime(runtime, startTime, {
          success: false,
          summary,
          evidence: runtime.state.evidence,
          cost: this.runtimeCost(),
          error: "Completion validator rejected coding result",
        });
      }

      message = lastVerification?.status === "failed"
        ? runtime.buildRepairMessage(lastVerification, decision)
        : runtime.buildValidationRepairMessage(decision, lastVerification);
    }

    const summary = "Coding agent stopped without satisfying runtime completion criteria.";
    return await this.finalizeRuntime(runtime, startTime, {
      success: false,
      summary,
      evidence: runtime.state.evidence,
      cost: this.runtimeCost(),
      error: "Runtime repair limit exceeded",
    });
  }

  close(): void {
    this.primary?.close();
    this.codingSession?.close();
    for (const helper of this.helpers) helper.close();
    this.legacy?.close();
  }

  private runtimeCost(): number {
    return (this.primary?.cost ?? 0) + this.helperCost;
  }

  private isRuntimeBudgetExceeded(ctx: EngineContext): boolean {
    return ctx.maxBudgetUsd !== undefined && this.runtimeCost() >= ctx.maxBudgetUsd;
  }

  private printRuntimeSummary(runtime: CodingRuntime, startTime: number): void {
    const elapsed = Date.now() - startTime;
    log.phase("CODING RUNTIME SUMMARY");
    log.info(`Mode              : ${runtime.state.mode}`);
    log.info(`Duration          : ${formatDuration(elapsed)}`);
    log.info(`Checkpoints       : ${runtime.state.checkpoints.length}`);
    log.info(`Verifications     : ${runtime.state.verificationAttempts.length}`);
    log.info(`Evidence items    : ${runtime.state.evidence.length}`);
    log.info(`Cost              : $${this.runtimeCost().toFixed(4)}`);
  }

  private async finalizeRuntime(
    runtime: CodingRuntime,
    startTime: number,
    result: EngineResult,
  ): Promise<EngineResult> {
    const stopResults = await runtime.runStopHooks(result.summary, !result.success);
    const blocking = stopResults.filter((hook) => hook.blocked);
    const finalResult = blocking.length > 0
      ? {
          ...result,
          success: false,
          summary: [
            result.summary,
            "",
            "Servus Stop hook blocked finalization.",
            ...blocking.map((hook) => [
              `- ${hook.source} ${hook.hook.type} hook${hook.hook.command ? ` (${hook.hook.command})` : ""}`,
              hook.output ? `  Output: ${hook.output}` : undefined,
            ].filter(Boolean).join("\n")),
          ].join("\n"),
          error: result.error ?? "Stop hook blocked finalization",
        }
      : result;

    if (finalResult.success) {
      runtime.complete(finalResult.summary, finalResult.artifacts ?? []);
      const memory = updateProjectMemoryFromCodingRun({
        cwd: runtime.state.targetCwd,
        sessionId: runtime.state.sessionId,
        task: runtime.state.task,
        summary: finalResult.summary,
        success: true,
        repo: runtime.state.repo,
        checkpoints: runtime.state.checkpoints,
        verificationAttempts: runtime.state.verificationAttempts,
      });
      if (memory.updated) {
        bus.push({
          type: "coding:memory",
          agent: "CodingRuntime",
          message: memory.added.length
            ? `Updated project memory with ${memory.added.length} durable item(s).`
            : `Observed ${memory.observed.length} project memory candidate(s).`,
          metadata: {
            memoryPath: memory.memoryPath,
            indexPath: memory.indexPath,
            added: memory.added,
            observed: memory.observed,
          },
        });
      }
    } else {
      runtime.fail(finalResult.summary);
    }
    bus.push({
      type: "coding:final_summary",
      agent: "CodingRuntime",
      message: finalResult.summary,
      metadata: {
        success: finalResult.success,
        artifacts: finalResult.artifacts ?? [],
        evidenceCount: finalResult.evidence?.length ?? 0,
      },
    });
    this.printRuntimeSummary(runtime, startTime);
    return finalResult;
  }

  private async tryRunImmediateCommand(runtime: CodingRuntime, startTime: number): Promise<EngineResult | null> {
    const command = runtime.state.command;
    if (!command?.immediate) return null;

    if (command.name === "verify") {
      const attempt = await runtime.verify("project", command.args);
      const summary = [
        attempt.status === "passed"
          ? "Verification passed."
          : attempt.status === "skipped"
            ? "Verification skipped."
            : "Verification failed.",
        `Command: ${attempt.command}`,
        `Duration: ${formatDuration(attempt.durationMs)}`,
        attempt.failureCategory ? `Failure category: ${attempt.failureCategory}` : undefined,
        attempt.stderr ? `\nSTDERR:\n${truncate(attempt.stderr, 4000)}` : undefined,
        attempt.stdout ? `\nSTDOUT:\n${truncate(attempt.stdout, 4000)}` : undefined,
      ].filter(Boolean).join("\n");
      return await this.finalizeRuntime(runtime, startTime, {
        success: attempt.status === "passed",
        summary,
        evidence: runtime.state.evidence,
        artifacts: runtime.state.artifacts,
        cost: 0,
        ...(attempt.status === "failed" ? { error: "Verification failed" } : {}),
        ...(attempt.status === "skipped" ? { error: "Verification skipped" } : {}),
      });
    }

    if (command.name === "status") {
      const summary = await runtime.buildStatusSummary();
      return await this.finalizeRuntime(runtime, startTime, {
        success: true,
        summary,
        evidence: runtime.state.evidence,
        artifacts: runtime.state.artifacts,
        cost: 0,
      });
    }

    if (command.name === "transcript") {
      const summary = runtime.buildTranscriptSummary(command.args);
      return await this.finalizeRuntime(runtime, startTime, {
        success: true,
        summary,
        evidence: runtime.state.evidence,
        artifacts: runtime.state.artifacts,
        cost: 0,
      });
    }

    if (command.name === "help") {
      const summary = runtime.buildHelpSummary();
      return await this.finalizeRuntime(runtime, startTime, {
        success: true,
        summary,
        evidence: runtime.state.evidence,
        artifacts: runtime.state.artifacts,
        cost: 0,
      });
    }

    if (command.name === "tools") {
      const summary = runtime.buildToolsSummary();
      return await this.finalizeRuntime(runtime, startTime, {
        success: true,
        summary,
        evidence: runtime.state.evidence,
        artifacts: runtime.state.artifacts,
        cost: 0,
      });
    }

    if (command.name === "sessions" || command.name === "search") {
      const summary = runtime.buildSessionsSummary(command.args);
      return await this.finalizeRuntime(runtime, startTime, {
        success: true,
        summary,
        evidence: runtime.state.evidence,
        artifacts: runtime.state.artifacts,
        cost: 0,
      });
    }

    if (command.name === "diff") {
      const result = await runtime.buildDiffSummary(command.args || "latest");
      return await this.finalizeRuntime(runtime, startTime, {
        success: true,
        summary: result.summary,
        evidence: runtime.state.evidence,
        artifacts: result.artifacts,
        cost: 0,
      });
    }

    if (command.name === "revert") {
      const result = await runtime.revertCheckpoint(command.args || "latest");
      return await this.finalizeRuntime(runtime, startTime, {
        success: result.ok,
        summary: result.summary,
        evidence: runtime.state.evidence,
        artifacts: result.artifacts,
        cost: 0,
        ...(result.ok ? {} : { error: "Checkpoint revert failed" }),
      });
    }

    if (command.name === "compact") {
      bus.push({
        type: "context:compact",
        agent: "CodingRuntime",
        message: "Manual coding compaction boundary requested",
        metadata: { sessionId: runtime.state.sessionId, mode: runtime.state.mode },
      });
      const summary = [
        "Manual compaction requested.",
        "Servus uses model-aware automatic compaction for agent history. This command records a compaction boundary for the coding session; active model history will compact before the next send when it crosses the configured threshold.",
        "",
        await runtime.buildStatusSummary(),
      ].join("\n");
      return await this.finalizeRuntime(runtime, startTime, {
        success: true,
        summary,
        evidence: runtime.state.evidence,
        artifacts: runtime.state.artifacts,
        cost: 0,
      });
    }

    if (command.name === "context") {
      const summary = runtime.buildContextSummary();
      return await this.finalizeRuntime(runtime, startTime, {
        success: true,
        summary,
        evidence: runtime.state.evidence,
        artifacts: runtime.state.artifacts,
        cost: 0,
      });
    }

    if (command.name === "remember") {
      const result = runtime.rememberInstruction(command.args);
      return await this.finalizeRuntime(runtime, startTime, {
        success: result.ok,
        summary: result.summary,
        evidence: runtime.state.evidence,
        artifacts: result.artifacts,
        cost: 0,
        ...(result.ok ? {} : { error: "Memory update failed" }),
      });
    }

    if (command.name === "memory") {
      const summary = runtime.buildMemorySummary();
      return await this.finalizeRuntime(runtime, startTime, {
        success: true,
        summary,
        evidence: runtime.state.evidence,
        artifacts: runtime.state.artifacts,
        cost: 0,
      });
    }

    if (command.name === "files") {
      const summary = await runtime.buildFilesSummary();
      return await this.finalizeRuntime(runtime, startTime, {
        success: true,
        summary,
        evidence: runtime.state.evidence,
        artifacts: runtime.state.artifacts,
        cost: 0,
      });
    }

    if (command.name === "agents") {
      const summary = runtime.buildAgentsSummary();
      return await this.finalizeRuntime(runtime, startTime, {
        success: true,
        summary,
        evidence: runtime.state.evidence,
        artifacts: runtime.state.artifacts,
        cost: 0,
      });
    }

    if (command.name === "commands") {
      const summary = runtime.buildCommandsSummary();
      return await this.finalizeRuntime(runtime, startTime, {
        success: true,
        summary,
        evidence: runtime.state.evidence,
        artifacts: runtime.state.artifacts,
        cost: 0,
      });
    }

    if (command.name === "model" || command.name === "models") {
      const summary = runtime.buildModelsSummary();
      return await this.finalizeRuntime(runtime, startTime, {
        success: true,
        summary,
        evidence: runtime.state.evidence,
        artifacts: runtime.state.artifacts,
        cost: 0,
      });
    }

    if (command.name === "permissions") {
      const summary = runtime.buildPermissionsSummary();
      return await this.finalizeRuntime(runtime, startTime, {
        success: true,
        summary,
        evidence: runtime.state.evidence,
        artifacts: runtime.state.artifacts,
        cost: 0,
      });
    }

    if (command.name === "hooks") {
      const summary = runtime.buildHooksSummary();
      return await this.finalizeRuntime(runtime, startTime, {
        success: true,
        summary,
        evidence: runtime.state.evidence,
        artifacts: runtime.state.artifacts,
        cost: 0,
      });
    }

    if (command.name === "settings") {
      const summary = runtime.buildSettingsSummary();
      return await this.finalizeRuntime(runtime, startTime, {
        success: true,
        summary,
        evidence: runtime.state.evidence,
        artifacts: runtime.state.artifacts,
        cost: 0,
      });
    }

    if (command.name === "skills") {
      const summary = runtime.buildSkillsSummary();
      return await this.finalizeRuntime(runtime, startTime, {
        success: true,
        summary,
        evidence: runtime.state.evidence,
        artifacts: runtime.state.artifacts,
        cost: 0,
      });
    }

    if (command.name === "output-style") {
      const result = runtime.buildOutputStylesSummary(command.args);
      return await this.finalizeRuntime(runtime, startTime, {
        success: result.ok,
        summary: result.summary,
        evidence: runtime.state.evidence,
        artifacts: result.artifacts,
        cost: 0,
        ...(result.ok ? {} : { error: "Output style not found" }),
      });
    }

    if (command.name === "doctor") {
      const summary = await runtime.buildDoctorSummary();
      return await this.finalizeRuntime(runtime, startTime, {
        success: true,
        summary,
        evidence: runtime.state.evidence,
        artifacts: runtime.state.artifacts,
        cost: 0,
      });
    }

    if (command.name === "init") {
      const result = runtime.initializeProjectFiles();
      return await this.finalizeRuntime(runtime, startTime, {
        success: result.ok,
        summary: result.summary,
        evidence: runtime.state.evidence,
        artifacts: result.artifacts,
        cost: 0,
        ...(result.ok ? {} : { error: "Servus project initialization failed" }),
      });
    }

    return null;
  }

  private async runPreflightHelpers(ctx: EngineContext, runtime: CodingRuntime): Promise<void> {
    if (!runtime.shouldRunPlanHelper()) return;
    const responseText = await this.runHelper(ctx, runtime, "plan", "Read-only preflight implementation planning");
    if (responseText && runtime.state.planApproval.required && runtime.state.planApproval.status === "pending") {
      runtime.markPlanReady(responseText, ["plan helper"]);
    }
  }

  private async runReviewHelperIfNeeded(ctx: EngineContext, runtime: CodingRuntime, changedFiles: string[]): Promise<void> {
    if (!runtime.shouldRunReviewHelper(changedFiles)) return;
    await this.runHelper(ctx, runtime, "review", `Read-only review of ${changedFiles.length} changed file(s)`);
  }

  private async runVerificationHelperIfNeeded(
    ctx: EngineContext,
    runtime: CodingRuntime,
    changedFiles: string[],
    verification: VerificationAttempt | undefined,
  ): Promise<void> {
    if (!runtime.shouldRunVerificationHelper(changedFiles, verification)) return;
    await this.runHelper(ctx, runtime, "verification", `Independent verification of ${changedFiles.length} changed file(s)`);
  }

  private async runRequestedHelpers(
    ctx: EngineContext,
    runtime: CodingRuntime,
    requests: CodingHelperRequest[],
  ): Promise<void> {
    const serial: CodingHelperRequest[] = [];
    const parallel: CodingHelperRequest[] = [];
    for (const request of requests) {
      const custom = runtime.getCodingAgent(request.type);
      if (request.type === "worker" || custom?.readOnly === false) serial.push(request);
      else parallel.push(request);
    }

    await Promise.all(parallel.map((request) =>
      this.runHelper(
        ctx,
        runtime,
        request.type,
        `Task ${request.id}: ${request.description}`,
        request.prompt,
        request.id,
      )
    ));

    for (const request of serial) {
      await this.runHelper(
        ctx,
        runtime,
        request.type,
        `Task ${request.id}: ${request.description}`,
        request.prompt,
        request.id,
      );
    }
  }

  private async runHelper(
    ctx: EngineContext,
    runtime: CodingRuntime,
    type: CodingHelperType,
    summary: string,
    requestedPrompt?: string,
    requestId?: string,
  ): Promise<string | undefined> {
    const helperRun = runtime.startHelperRun(type, summary, requestId);
    const customAgent = runtime.getCodingAgent(type);
    const helper = new CodingConversationLoop(ctx, runtime, {
      agentName: runtime.helperAgentName(type, helperRun),
      color: type === "review" ? ANSI.yellow : ANSI.blue,
      model: customAgent?.model && customAgent.model !== "inherit"
        ? customAgent.model
        : helperModelFor(ctx.model, type),
      systemPrompt: runtime.buildHelperSystemPrompt(type),
      disallowedTools: helperDisallowedTools(type, customAgent),
      includeTask: false,
      maxTurns: customAgent?.maxTurns ?? (type === "worker" ? 24 : type === "verification" ? 14 : 10),
    });
    this.helpers.push(helper);
    try {
      const response = await helper.send(runtime.buildHelperMessage(type, requestedPrompt));
      this.helperCost += response.cost;
      if (response.subtype !== "success") {
        runtime.finishHelperRun(
          helperRun,
          "failed",
          response.text || `${type} helper failed with status ${response.subtype}.`,
        );
        return undefined;
      }
      runtime.finishHelperRun(helperRun, "completed", response.text || `${type} helper completed without text.`);
      return response.text;
    } catch (err) {
      runtime.finishHelperRun(
        helperRun,
        "failed",
        err instanceof Error ? err.message : String(err),
      );
      return undefined;
    } finally {
      helper.close();
    }
  }
}

function helperModelFor(model: string, type: CodingHelperType): string {
  if (type === "worker") return model;
  const normalized = model.includes(":") ? model.split(":").at(-1)! : model;
  if (/^gpt-/i.test(normalized) || /^o[134]-/i.test(normalized) || /^chatgpt-/i.test(normalized)) {
    return "gpt-5-mini";
  }
  if (/^gemini-|^models\/gemini-/i.test(normalized)) {
    return "gemini-2.5-flash-lite-preview-09-2025";
  }
  if (/^claude-/i.test(normalized)) {
    return "claude-haiku-4-5-20251001";
  }
  return model;
}

function primaryDisallowedTools(runtime: CodingRuntime): string[] {
  const disallowed = new Set<string>();
  if (runtime.state.mode !== "build" && runtime.state.mode !== "coordinate") {
    for (const name of ["write", "edit", "patch", "bash"]) disallowed.add(name);
  }

  for (const name of runtime.state.command?.custom?.disallowedTools ?? []) {
    disallowed.add(name);
  }

  const allowedTools = runtime.state.command?.custom?.allowedTools;
  if (allowedTools?.length) {
    const allowed = new Set(allowedTools.map((toolName) => toolName.toLowerCase()));
    for (const family of KNOWN_TOOL_FAMILIES) {
      if (!family.aliases.some((alias) => allowed.has(alias.toLowerCase()))) {
        for (const alias of family.aliases) disallowed.add(alias);
      }
    }
  }

  return [...disallowed];
}

function initialPhaseForMode(mode: "build" | "plan" | "review" | "explore" | "coordinate"): "editing" | "reviewing" | "discovering" | "planning" {
  if (mode === "coordinate") return "planning";
  if (mode === "build") return "editing";
  if (mode === "review") return "reviewing";
  if (mode === "explore") return "discovering";
  return "planning";
}

function helperDisallowedTools(
  type: CodingHelperType,
  customAgent?: { tools?: string[]; disallowedTools?: string[]; readOnly?: boolean },
): string[] {
  if (!customAgent) {
    if (type === "worker") return [];
    return type === "verification"
      ? ["write", "edit", "patch"]
      : ["write", "edit", "patch", "bash"];
  }

  const disallowed = new Set<string>(customAgent.disallowedTools ?? []);
  if (customAgent.readOnly !== false) {
    for (const name of ["write", "edit", "patch", "bash"]) disallowed.add(name);
  }

  if (customAgent.tools?.length) {
    const allowed = new Set(customAgent.tools.map((toolName) => toolName.toLowerCase()));
    for (const family of KNOWN_TOOL_FAMILIES) {
      if (!family.aliases.some((alias) => allowed.has(alias.toLowerCase()))) {
        for (const alias of family.aliases) disallowed.add(alias);
      }
    }
  }

  return [...disallowed];
}

const KNOWN_TOOL_FAMILIES = [
  { aliases: ["bash", "Bash", "BashOutput", "KillBash"] },
  { aliases: ["read", "Read"] },
  { aliases: ["write", "Write"] },
  { aliases: ["edit", "Edit", "MultiEdit"] },
  { aliases: ["patch"] },
  { aliases: ["grep", "Grep"] },
  { aliases: ["glob", "Glob"] },
  { aliases: ["ls", "LS"] },
  { aliases: ["workspace_status"] },
  { aliases: ["git_diff"] },
  { aliases: ["coding_state", "ReadToolResult"] },
  { aliases: ["webfetch", "WebFetch"] },
  { aliases: ["LSP", "lsp_status"] },
  { aliases: ["todowrite", "TodoWrite", "coding_todo"] },
  { aliases: ["coding_intent"] },
  { aliases: ["coding_plan_ready", "ExitPlanMode"] },
  { aliases: ["ToolSearch", "ReadToolResult"] },
  { aliases: ["Task", "SendMessage", "TaskStop"] },
  { aliases: ["ScratchpadList", "ScratchpadRead", "ScratchpadWrite"] },
  { aliases: ["mcp_list_servers", "McpListTools", "McpCallTool", "ListMcpResourcesTool", "ReadMcpResourceTool"] },
  { aliases: ["servus_done"] },
  { aliases: ["servus_need_input", "AskUserQuestion"] },
];
