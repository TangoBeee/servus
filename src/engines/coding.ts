/**
 * Coding Engine — wraps the existing plan→develop→test→feedback loop.
 *
 * This is a direct extraction of the original Orchestrator's coding logic
 * into the Engine interface, preserving all existing behavior.
 */

import {
  createAgent,
  type IAgent,
} from "../agent.js";
import { PLANNER_PROMPT } from "../prompts/planner.js";
import { DEVELOPER_PROMPT } from "../prompts/developer.js";
import { REVIEWER_PROMPT } from "../prompts/reviewer.js";
import { MANAGER_PROMPT } from "../prompts/manager.js";
import {
  runVerification,
  readPlan,
  writePlan,
  findNextPendingTask,
  countTasks,
  type Plan,
  type PlanTask,
  type VerificationResult,
} from "../verify.js";
import { log, ANSI, truncate, formatDuration } from "../log.js";
import { bus } from "../events.js";
import type { Engine, EngineContext, EngineResult } from "../engine.js";

// ─── Coding Engine ──────────────────────────────────────────────────────────

export class CodingEngine implements Engine {
  readonly name = "coding";
  readonly description =
    "Handles software development tasks: writing, editing, debugging, building, and testing code. " +
    "Uses a team of agents (Planner, Developer, Tester, Manager) in a plan→execute→test→feedback loop.";

  private planner!: IAgent;
  private developer!: IAgent;
  private tester!: IAgent;
  private manager!: IAgent;

  private metrics = {
    tasksCompleted: 0,
    tasksFailed: 0,
    totalVerifications: 0,
    planRevisions: 0,
  };

  async execute(ctx: EngineContext): Promise<EngineResult> {
    const startTime = Date.now();
    await this.createAgents(ctx);

    try {
      await this.planPhase(ctx);
      await this.executionPhase(ctx);
      await this.finalVerification(ctx);

      const cost = this.totalCost();
      return {
        success: true,
        summary: `Completed ${this.metrics.tasksCompleted} tasks (${this.metrics.tasksFailed} failed, ${this.metrics.totalVerifications} verifications)`,
        cost,
      };
    } catch (err) {
      const cost = this.totalCost();
      return {
        success: false,
        summary: `Coding engine failed: ${err instanceof Error ? err.message : String(err)}`,
        cost,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      this.printSummary(startTime);
    }
  }

  close(): void {
    this.planner?.close();
    this.developer?.close();
    this.tester?.close();
    this.manager?.close();
  }

  // ── Agent Creation ──────────────────────────────────────────────────────

  private async createAgents(ctx: EngineContext): Promise<void> {
    const { model, backend, cwd } = ctx;
    const opts = { cwd };

    log.info(`Backend: ${backend === "claude-code" ? "Claude Code SDK" : "Custom AI SDK (multi-provider)"}`);

    [this.planner, this.developer, this.tester, this.manager] =
      await Promise.all([
        createAgent(backend, {
          name: "Planner",
          role: "architect",
          color: ANSI.blue,
          model,
          prompt: PLANNER_PROMPT,
          sessionId: ctx.sessionId,
        }, opts),
        createAgent(backend, {
          name: "Developer",
          role: "builder",
          color: ANSI.green,
          model,
          prompt: DEVELOPER_PROMPT,
          sessionId: ctx.sessionId,
        }, opts),
        createAgent(backend, {
          name: "Tester",
          role: "qa",
          color: ANSI.yellow,
          model,
          prompt: REVIEWER_PROMPT,
          sessionId: ctx.sessionId,
        }, opts),
        createAgent(backend, {
          name: "Manager",
          role: "lead",
          color: ANSI.magenta,
          model,
          prompt: MANAGER_PROMPT,
          sessionId: ctx.sessionId,
        }, opts),
      ]);

    log.success("All agents initialized");
  }

  // ── Phase 1: Planning ──────────────────────────────────────────────────

  private async planPhase(ctx: EngineContext): Promise<void> {
    log.phase("PHASE 1 — ARCHITECT ANALYSES THE CODEBASE");

    const planRequest = [
      `## Task`,
      ctx.task,
      ``,
      `## Working Directory`,
      `\`${ctx.cwd}\``,
      ``,
      `## Instructions`,
      `Analyse this project thoroughly. Then write \`servus-plan.json\` and \`init.sh\`.`,
      `Signal <plan_status>READY</plan_status> when both files are written.`,
    ].join("\n");

    this.emitAgentStatus("Planner", "working");
    let response = await this.planner.send(planRequest);
    this.emitAgentStatus("Planner", "done");

    // Retry if plan wasn't created
    let plan = readPlan(ctx.cwd);
    let retries = 0;

    while (!plan && retries < 3) {
      retries++;
      log.warn(`Plan file not found. Asking Planner to retry (${retries}/3)...`);
      this.emitAgentStatus("Planner", "working");
      response = await this.planner.send(
        `servus-plan.json was not created or is invalid JSON. ` +
          `Please create it now following the schema, then signal <plan_status>READY</plan_status>.`,
      );
      this.emitAgentStatus("Planner", "done");
      plan = readPlan(ctx.cwd);
    }

    if (!plan) {
      log.error("Planner failed to create a valid plan after 3 retries.");
      throw new Error("Planning failed");
    }

    const counts = countTasks(plan);
    log.success(
      `Plan created: ${counts.total} tasks across ${plan.phases.length} phases`,
    );

    // Manager reviews the plan
    log.phase("MANAGER REVIEWS THE PLAN");

    const planSummary = summarisePlan(plan);
    this.emitAgentStatus("Manager", "working");
    const reviewResponse = await this.manager.send(
      [
        `## Plan Review Request`,
        ``,
        `The Architect has produced the following plan for: "${ctx.task}"`,
        ``,
        planSummary,
        ``,
        `Review this plan. If acceptable, output <decision>APPROVE</decision>.`,
        `If changes are needed, output <decision>REVISE</decision> with specifics.`,
      ].join("\n"),
    );
    this.emitAgentStatus("Manager", "done");

    if (reviewResponse.text.includes("<decision>REPLAN</decision>")) {
      this.metrics.planRevisions++;
      log.warn("Manager requested a replan. Sending feedback to Planner...");

      this.emitAgentStatus("Planner", "working");
      await this.planner.send(
        `The Manager has reviewed your plan and requested revisions:\n\n` +
          `${reviewResponse.text}\n\n` +
          `Update servus-plan.json accordingly and signal <plan_status>READY</plan_status>.`,
      );
      this.emitAgentStatus("Planner", "done");

      // Re-read plan
      plan = readPlan(ctx.cwd);
      if (!plan) throw new Error("Replanning failed — no valid plan file");
    }

    log.success("Plan approved. Moving to execution.");
  }

  // ── Phase 2: Execution ─────────────────────────────────────────────────

  private async executionPhase(ctx: EngineContext): Promise<void> {
    log.phase("PHASE 2 — EXECUTING THE PLAN");

    while (true) {
      // Budget check
      if (this.isBudgetExhausted(ctx)) {
        log.error("Budget exhausted. Stopping execution.");
        throw new Error("Budget limit reached");
      }

      const plan = readPlan(ctx.cwd);
      if (!plan) {
        log.error("Plan file missing during execution.");
        throw new Error("servus-plan.json not found");
      }

      const counts = countTasks(plan);
      bus.push({
        type: "info",
        message: `Tasks ${counts.completed}/${counts.total}`,
        metadata: { total: counts.total, completed: counts.completed },
      });

      const next = findNextPendingTask(plan);
      if (!next) {
        log.success(
          `All tasks processed: ${counts.completed} completed, ${counts.failed} failed`,
        );
        break;
      }

      const { task } = next;
      await this.executeTask(ctx, plan, task);
    }
  }

  // ── Single Task Lifecycle ──────────────────────────────────────────────

  private async executeTask(ctx: EngineContext, plan: Plan, task: PlanTask): Promise<void> {
    const counts = countTasks(plan);
    log.phase(
      `TASK ${task.id} — ${task.description} [${counts.completed + 1}/${counts.total}]`,
    );

    // Mark in_progress
    task.status = "in_progress";
    writePlan(ctx.cwd, plan);

    let consecutiveFailures = 0;
    const maxAttempts = ctx.maxConsecutiveFailures;
    const maxContinueWithoutDone = 3;
    let continueWithoutDone = 0;

    let testerRateLimitRetries = 0;

    while (consecutiveFailures < maxAttempts) {
      // ── Step A: Developer implements ──────────────────────────────

      const devMessage =
        consecutiveFailures === 0 && continueWithoutDone === 0
          ? this.buildTaskAssignment(task, plan)
          : `Continue working on task ${task.id}. You have not signaled completion yet. Use your tools to implement, then run verification, then output <task_status>DONE</task_status>.`;

      this.emitAgentStatus("Developer", "working");
      const devResponse = await this.developer.send(devMessage);
      this.emitAgentStatus("Developer", "done");

      if (!devResponse.text.includes("<task_status>DONE</task_status>")) {
        if (devResponse.subtype === "error_max_turns") {
          log.warn("Developer hit turn limit. Sending continuation...");
          continueWithoutDone++;
          if (continueWithoutDone >= maxContinueWithoutDone) {
            log.error(
              `Developer did not signal completion after ${maxContinueWithoutDone} attempts. Marking task as failed.`,
            );
            task.status = "failed";
            task.failure_reason = "Developer did not signal DONE after multiple attempts";
            writePlan(ctx.cwd, plan);
            this.metrics.tasksFailed++;
            return;
          }
          continue;
        }
        continueWithoutDone++;
        if (continueWithoutDone >= maxContinueWithoutDone) {
          log.error(
            `Developer did not signal completion after ${maxContinueWithoutDone} attempts. Marking task as failed.`,
          );
          task.status = "failed";
          task.failure_reason = "Developer did not signal DONE after multiple attempts";
          writePlan(ctx.cwd, plan);
          this.metrics.tasksFailed++;
          return;
        }
        continue;
      }

      continueWithoutDone = 0;

      // ── Step B: Tester verifies ──────────────────────────────────

      log.info("Developer signals done. Sending to Tester...");

      const testRequest = [
        `## Test Task ${task.id}: ${task.description}`,
        ``,
        `**Original user task**: "${truncate(ctx.task, 2000)}"`,
        ``,
        `The Developer says this task is complete. You must verify both (1) technical checks and (2) that the work actually satisfies the task.`,
        ``,
        `1. **Technical verification**`,
        `   - Run \`bash init.sh\` (or the project's test/build commands).`,
        `   - Use \`Read\` and \`Grep\` to review the modified files.`,
        `   - Check for anti-patterns (no test weakening, no type/lint bypass).`,
        ``,
        `2. **End-to-end / behavioral verification**`,
        `   - Confirm that the implementation matches the task and the user's goal.`,
        `   - Read the relevant code (e.g. components, handlers) and verify the described behavior is present.`,
        `   - If the task or user goal is not satisfied, output <test_result>FAIL</test_result> with a clear explanation.`,
        ``,
        `Output <test_result>PASS</test_result> only if both technical checks and behavioral verification pass. Otherwise output <test_result>FAIL</test_result>.`,
      ].join("\n");

      this.emitAgentStatus("Tester", "working");
      const testResponse = await this.tester.send(testRequest);
      this.emitAgentStatus("Tester", "done");
      this.metrics.totalVerifications++;

      if (testResponse.subtype === "error_rate_limit") {
        log.warn(
          "Tester hit a rate limit / token cap. Retrying verification...",
        );
        testerRateLimitRetries++;
        this.tester.close();
        const delayMs = Math.min(30_000, 3_000 * 2 ** (testerRateLimitRetries - 1));
        await new Promise((r) => setTimeout(r, delayMs));
        if (testerRateLimitRetries >= 3) {
          log.error("Tester was rate limited repeatedly. Marking task as failed.");
          task.status = "failed";
          task.failure_reason = "Tester repeatedly hit model rate limits.";
          writePlan(ctx.cwd, plan);
          this.metrics.tasksFailed++;
          return;
        }
        continue;
      }

      if (testResponse.text.includes("<test_result>PASS</test_result>")) {
        // ── SUCCESS ─────────────────────────────────────────────────

        log.success(`Task ${task.id} PASSED`);

        task.status = "completed";
        writePlan(ctx.cwd, plan);
        this.metrics.tasksCompleted++;
        const countsAfter = countTasks(plan);
        bus.push({
          type: "task:complete",
          message: `Task ${task.id} completed`,
          metadata: { total: countsAfter.total, completed: countsAfter.completed },
        });

        return;
      }

      // ── FAILURE — escalate to Manager ─────────────────────────────

      consecutiveFailures++;
      log.error(
        `Task ${task.id} FAILED test (${consecutiveFailures}/${maxAttempts})`,
      );

      const isRetry = consecutiveFailures >= 1;
      const managerRequest = [
        `## Test Failure Report — Task ${task.id}`,
        ``,
        `**Task**: ${task.description}`,
        `**Attempt**: ${consecutiveFailures}/${maxAttempts}`,
        isRetry
          ? `**IMPORTANT**: The Developer has already tried and failed. Give CONCRETE steps.`
          : "",
        ``,
        `### Tester's Report`,
        truncate(testResponse.text, 3000),
        ``,
        `Analyse the failure. Provide SPECIFIC, ACTIONABLE feedback for the Developer.`,
        ``,
        consecutiveFailures >= maxAttempts - 1
          ? `This is the LAST attempt. Consider suggesting a fundamentally different approach.`
          : `Output <decision>REVISE</decision> with your feedback.`,
      ]
        .filter(Boolean)
        .join("\n");

      this.emitAgentStatus("Manager", "working");
      const managerResponse = await this.manager.send(managerRequest);
      this.emitAgentStatus("Manager", "done");

      if (managerResponse.text.includes("<decision>REPLAN</decision>")) {
        log.warn("Manager requested a replan for this task.");
        task.status = "failed";
        task.failure_reason = "Manager requested replan";
        writePlan(ctx.cwd, plan);
        this.metrics.tasksFailed++;
        await this.triggerReplan(ctx, plan);
        return;
      }

      // Forward Manager's feedback to Developer
      const retryPreamble =
        consecutiveFailures >= 1
          ? [
              `**RETRY**: Your previous attempt failed verification. Do NOT repeat the same steps.`,
              `Follow the Manager's feedback exactly.`,
              ``,
            ].join("\n")
          : "";
      this.emitAgentStatus("Developer", "working");
      await this.developer.send(
        [
          `## Manager Feedback — Task ${task.id} (attempt ${consecutiveFailures}/${maxAttempts})`,
          ``,
          retryPreamble,
          `The Tester found issues. The Manager has analysed them:`,
          ``,
          truncate(managerResponse.text, 3000),
          ``,
          `Fix the issues, re-validate, and signal <task_status>DONE</task_status> when ready.`,
        ].join("\n"),
      );
      this.emitAgentStatus("Developer", "done");
    }

    // Exhausted all attempts — mark failed.
    log.error(`Task ${task.id} failed after ${maxAttempts} attempts.`);

    task.status = "failed";
    task.failure_reason = `Failed after ${maxAttempts} consecutive attempts`;
    writePlan(ctx.cwd, plan);
    this.metrics.tasksFailed++;

    log.warn("Max attempts reached. Manual intervention is recommended.");
  }

  // ── Final Verification ─────────────────────────────────────────────────

  private async finalVerification(ctx: EngineContext): Promise<void> {
    log.phase("FINAL VERIFICATION");

    const verification = await runVerification(ctx.cwd, ctx.verifyCommand);
    this.metrics.totalVerifications++;

    if (verification.ok) {
      log.success("Final verification PASSED");
      return;
    }

    log.warn("Final verification failed. Running emergency fix cycle...");
    await this.emergencyFixCycle(ctx, verification);
  }

  private async emergencyFixCycle(ctx: EngineContext, initial: VerificationResult): Promise<void> {
    let lastResult = initial;

    for (let attempt = 0; attempt < ctx.maxConsecutiveFailures; attempt++) {
      const devMessage = [
        `## Emergency Fix — Final Verification Failed`,
        ``,
        `The project's final verification (\`${lastResult.command}\`) is failing.`,
        ``,
        `### Errors`,
        `\`\`\``,
        truncate(lastResult.stderr, 3000),
        `\`\`\``,
        lastResult.stdout
          ? `### Stdout\n\`\`\`\n${truncate(lastResult.stdout, 1500)}\n\`\`\``
          : "",
        ``,
        `Fix ALL errors. Signal <task_status>DONE</task_status> when ready.`,
      ].join("\n");

      const devResponse = await this.developer.send(devMessage);

      if (devResponse.text.includes("<task_status>DONE</task_status>")) {
        const verification = await runVerification(ctx.cwd, ctx.verifyCommand);
        this.metrics.totalVerifications++;

        if (verification.ok) {
          log.success("Emergency fix resolved all issues!");
          return;
        }

        lastResult = verification;
        log.error(
          `Emergency fix attempt ${attempt + 1} still failing. ` +
            `(${ctx.maxConsecutiveFailures - attempt - 1} attempts left)`,
        );
      }
    }

    log.error(
      "Emergency fix cycle exhausted. The project may need manual intervention.",
    );
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private buildTaskAssignment(task: PlanTask, plan: Plan): string {
    const counts = countTasks(plan);
    return [
      `## Assigned Task: ${task.id}`,
      ``,
      `**Description**: ${task.description}`,
      task.target_files?.length
        ? `**Target Files**: ${task.target_files.join(", ")}`
        : "",
      task.verification
        ? `**Verification Command**: \`${task.verification}\``
        : "",
      ``,
      `**Progress**: ${counts.completed}/${counts.total} tasks completed`,
      ``,
      `Implement this task fully. Follow the Generate → Validate → Fix cycle.`,
      `When implementation is done AND validation passes, output:`,
      `  <task_status>DONE</task_status>`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  private async triggerReplan(ctx: EngineContext, plan: Plan): Promise<void> {
    this.metrics.planRevisions++;
    log.phase("REPLANNING");

    const counts = countTasks(plan);
    this.emitAgentStatus("Planner", "working");
    await this.planner.send(
      [
        `## Replan Request`,
        ``,
        `Progress so far: ${counts.completed} completed, ${counts.failed} failed, ${counts.pending} pending.`,
        `The Manager determined the current plan needs restructuring.`,
        ``,
        `Re-analyse the codebase, considering what has already been done,`,
        `and update servus-plan.json with a revised approach.`,
        `Reset failed tasks to "pending" with a new strategy.`,
        `Signal <plan_status>READY</plan_status> when done.`,
      ].join("\n"),
    );
    this.emitAgentStatus("Planner", "done");

    // Notify dashboard of the new plan so counters reset
    const newPlan = readPlan(ctx.cwd);
    if (newPlan) {
      const newCounts = countTasks(newPlan);
      bus.push({
        type: "info",
        message: `Plan revised: ${newCounts.total} tasks (${newCounts.completed} done, ${newCounts.pending} pending)`,
        metadata: { total: newCounts.total, completed: newCounts.completed },
      });
    }
  }

  private emitAgentStatus(agent: string, status: "working" | "done" | "idle" | "error"): void {
    bus.push({
      type: "agent:status",
      agent,
      message: status,
    });
  }

  private totalCost(): number {
    return (
      (this.planner?.cost ?? 0) +
      (this.developer?.cost ?? 0) +
      (this.tester?.cost ?? 0) +
      (this.manager?.cost ?? 0)
    );
  }

  private isBudgetExhausted(ctx: EngineContext): boolean {
    if (ctx.maxBudgetUsd === undefined) return false;
    return this.totalCost() >= ctx.maxBudgetUsd;
  }

  private printSummary(startTime: number): void {
    const elapsed = Date.now() - startTime;
    const totalCost = this.totalCost();

    log.phase("SESSION SUMMARY");
    log.info(`Duration           : ${formatDuration(elapsed)}`);
    log.info(`Tasks completed    : ${this.metrics.tasksCompleted}`);
    log.info(`Tasks failed       : ${this.metrics.tasksFailed}`);
    log.info(`Verifications run  : ${this.metrics.totalVerifications}`);
    log.info(`Plan revisions     : ${this.metrics.planRevisions}`);
    log.info(`Total cost         : $${totalCost.toFixed(4)}`);
    log.detail(`  Planner  : $${(this.planner?.cost ?? 0).toFixed(4)}`);
    log.detail(`  Developer: $${(this.developer?.cost ?? 0).toFixed(4)}`);
    log.detail(`  Tester   : $${(this.tester?.cost ?? 0).toFixed(4)}`);
    log.detail(`  Manager  : $${(this.manager?.cost ?? 0).toFixed(4)}`);
  }
}

// ─── Plan Summary Helper ────────────────────────────────────────────────────

function summarisePlan(plan: Plan): string {
  const lines: string[] = [`**Task**: ${plan.task}`, ""];

  for (const phase of plan.phases) {
    lines.push(`### Phase ${phase.id}: ${phase.name}`);
    for (const task of phase.tasks) {
      const files = task.target_files?.join(", ") ?? "—";
      lines.push(`- [${task.status}] **${task.id}**: ${task.description} (${files})`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
