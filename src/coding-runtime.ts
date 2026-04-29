import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { AgentResponse, AgentToolEvent } from "./agent.js";
import type { EngineContext } from "./engine.js";
import { bus, type ServusEventType } from "./events.js";
import { truncate } from "./log.js";
import { getApiKeyStatus, loadConfig, SERVUS_DIR } from "./config.js";
import { getDefaultModelForAvailableProvider, listModelOptions } from "./provider.js";
import { findServusProjectRoot } from "./coding-project.js";
import { appendEvent, appendEvidence, findSessionIndex, getProjectMemoryDir, listProjectSessions, updateSession } from "./session-store.js";
import type { EvidenceItem } from "./runtime.js";
import type { VerificationResult } from "./verify.js";
import { runVerification } from "./verify.js";
import { getFinalization } from "./completion-validator.js";
import {
  formatCodingInstructions,
  loadCodingInstructions,
  type CodingInstructionSource,
} from "./coding-instructions.js";
import {
  formatCodingAgents,
  loadCodingAgents,
  type CodingAgentDefinition,
} from "./coding-agents.js";
import {
  codingCommandHelp,
  formatCustomCodingCommands,
  loadCustomCodingCommands,
  parseCodingCommand,
  stripCodingCommand,
  type CodingCommand,
  type CustomCodingCommand,
} from "./coding-commands.js";
import {
  decideCodingPermission,
  findMatchingHooks,
  loadCodingSettings,
  runCodingHooks,
  type CodingHookEvent,
  type CodingHookInput,
  type CodingHookRunResult,
  type CodingPermissionBehavior,
  type CodingPermissionRule as ServusCodingPermissionRule,
  type CodingSettings,
} from "./coding-settings.js";
import {
  createCodingWorkspacePolicy,
  filterWorkspacePaths,
  gitPathspecExcludeArgs,
  stripExcludedGitStatus,
  type CodingWorkspacePolicy,
} from "./coding-workspace-policy.js";
import {
  buildSkillsPrompt,
  loadSkills,
  selectSkillsForTask,
} from "./skills.js";
import type { SkillManifest } from "./runtime.js";
import {
  findCodingOutputStyle,
  formatCodingOutputStyles,
  loadCodingOutputStyles,
  setProjectOutputStyle,
  type CodingOutputStyle,
} from "./coding-output-styles.js";
import {
  formatCodingAttachments,
  mentionDisplayName,
  resolveCodingMentions,
  type CodingContextAttachment,
} from "./coding-attachments.js";
import { listCodingReadStateFiles } from "./tools.js";
import {
  contextBudgetForModel,
  estimateMessageTokens,
  loadAgentHistory,
} from "./context-manager.js";
import { generateCodingContextSuggestions } from "./coding-context-suggestions.js";
import { rememberProjectMemoryFact } from "./project-memory.js";

const execFileAsync = promisify(execFile);
const MAX_STDIO_CHARS = 12_000;

export type CodingMode = "build" | "plan" | "review" | "explore" | "coordinate";
export type CodingPhase =
  | "orienting"
  | "discovering"
  | "planning"
  | "editing"
  | "verifying"
  | "repairing"
  | "reviewing"
  | "waiting_input"
  | "completed"
  | "failed";

export interface CodingTask {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  targetFiles: string[];
  verification?: string;
  evidence: string[];
}

export interface CodingPlan {
  goal: string;
  constraints: string[];
  tasks: CodingTask[];
  dependencies: string[];
  targetFiles: string[];
  verificationStrategy: string;
  status: "draft" | "active" | "completed" | "failed";
}

export interface CodingCheckpoint {
  id: string;
  createdAt: number;
  changedFiles: string[];
  diffSummary: string;
  diffArtifact?: string;
  snapshotArtifact?: string;
  snapshotRef?: string;
  revertable: boolean;
  revertedAt?: number;
}

export interface VerificationAttempt {
  id: string;
  command: string;
  scope: "targeted" | "project";
  status: "passed" | "failed" | "skipped";
  stdout: string;
  stderr: string;
  durationMs: number;
  failureCategory?: "syntax" | "typecheck" | "lint" | "test" | "runtime" | "unknown";
}

export interface RepoContextIndex {
  root: string;
  packageManager?: string;
  projectType: string[];
  scripts: Record<string, string>;
  gitBranch?: string;
  gitStatus: string[];
  importantFiles: string[];
  dependencyFiles: string[];
  entrypoints: string[];
  configFiles: string[];
  workspaceMap: string[];
}

export type CodingTaskKind = "change" | "analysis" | "verification";
export type CodingAmbiguity = "none" | "low" | "material";
export type CodingRisk = "low" | "medium" | "high";

export interface CodingIntentContract {
  id: string;
  kind: CodingTaskKind;
  goal: string;
  interpretation: string;
  alternatives: string[];
  ambiguity: CodingAmbiguity;
  confidence: "low" | "medium" | "high";
  evidence: string[];
  assumptions: string[];
  acceptanceCriteria: string[];
  constraints: string[];
  targetScope: string[];
  risk: CodingRisk;
  editsAllowed: boolean;
  requiresQuestion: boolean;
  askReason?: string;
  question?: string;
}

export interface CodingTodo {
  id: string;
  content: string;
  activeForm: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  evidence: string[];
  criteria: string[];
}

export interface CodingPlanApproval {
  required: boolean;
  status: "not_required" | "pending" | "ready" | "approved";
  reason: string;
  planSummary?: string;
  approvedAt?: number;
}

export type BuiltInCodingHelperType = "explore" | "plan" | "review" | "verification" | "worker";
export type CodingHelperType = BuiltInCodingHelperType | (string & {});

export interface CodingHelperRun {
  id: string;
  type: CodingHelperType;
  requestId?: string;
  continuedFrom?: string;
  checkpointId?: string;
  status: "requested" | "running" | "completed" | "failed";
  summary: string;
  verdict?: "pass" | "fail" | "partial";
  startedAt: number;
  completedAt?: number;
}

export interface CodingHelperRequest {
  id: string;
  type: CodingHelperType;
  description: string;
  prompt: string;
  continueFrom?: string;
  createdAt: number;
}

export interface CodingRunState {
  sessionId: string;
  command?: CodingCommand;
  mode: CodingMode;
  cwd: string;
  launchCwd: string;
  targetCwd: string;
  task: string;
  phase: CodingPhase;
  plan: CodingPlan;
  activeTask?: string;
  checkpoints: CodingCheckpoint[];
  verificationAttempts: VerificationAttempt[];
  evidence: EvidenceItem[];
  artifacts: string[];
  repo?: RepoContextIndex;
  preloadedSessions: Array<{
    id: string;
    task: string;
    status: string;
    domain?: string;
    startTime: number;
    proofDir?: string;
  }>;
  workspacePolicy: CodingWorkspacePolicy;
  instructions: CodingInstructionSource[];
  agents: CodingAgentDefinition[];
  commands: CustomCodingCommand[];
  settings: CodingSettings;
  skills: SkillManifest[];
  selectedSkills: SkillManifest[];
  outputStyles: CodingOutputStyle[];
  activeOutputStyle?: CodingOutputStyle;
  attachments: CodingContextAttachment[];
  intentContract?: CodingIntentContract;
  todos: CodingTodo[];
  planApproval: CodingPlanApproval;
  helperRuns: CodingHelperRun[];
  pendingHelperRequests: CodingHelperRequest[];
  scratchpadDir?: string;
  baselineChangedFiles: string[];
  cost: number;
  createdAt: number;
  updatedAt: number;
}

export interface CodingCompletionDecision {
  accepted: boolean;
  missing: string[];
  repairPrompt?: string;
}

export class CodingRuntime {
  readonly state: CodingRunState;
  private readonly sessionDir?: string;

  constructor(private readonly ctx: EngineContext) {
    const sessionDir = ctx.sessionId
      ? join(SERVUS_DIR, "sessions", ctx.sessionId, "coding")
      : undefined;
    const previous = loadPersistedCodingState(sessionDir, ctx.cwd);
    const command = parseCodingCommand(ctx.task, ctx.cwd);
    const task = command?.immediate && previous?.task
      ? previous.task
      : stripCodingCommand(ctx.task, command);
    const mode = command?.immediate && previous?.mode
      ? previous.mode
      : command?.mode ?? inferCodingMode(task);
    const sessionId = ctx.sessionId ?? `adhoc-${randomUUID().slice(0, 8)}`;
    const launchCwd = ctx.launchCwd ?? ctx.cwd;
    const targetCwd = ctx.targetCwd ?? ctx.cwd;
    this.state = {
      sessionId,
      ...(command ? { command } : {}),
      mode,
      cwd: ctx.cwd,
      launchCwd: previous?.launchCwd ?? launchCwd,
      targetCwd: previous?.targetCwd ?? targetCwd,
      task,
      phase: "orienting",
      plan: createInitialPlan(task, mode),
      checkpoints: previous?.checkpoints ?? [],
      verificationAttempts: previous?.verificationAttempts ?? [],
      evidence: previous?.evidence ?? [],
      artifacts: previous?.artifacts ?? [],
      workspacePolicy: previous?.workspacePolicy ?? createCodingWorkspacePolicy(ctx.cwd),
      instructions: previous?.instructions ?? [],
      agents: previous?.agents ?? [],
      commands: previous?.commands ?? [],
      settings: previous?.settings ?? loadCodingSettings(ctx.cwd),
      skills: previous?.skills ?? [],
      selectedSkills: previous?.selectedSkills ?? [],
      outputStyles: previous?.outputStyles ?? [],
      ...(previous?.activeOutputStyle ? { activeOutputStyle: previous.activeOutputStyle } : {}),
      attachments: previous?.attachments ?? [],
      ...(previous?.intentContract ? { intentContract: previous.intentContract } : {}),
      todos: previous?.todos ?? [],
      planApproval: previous?.planApproval ?? createPlanApproval(task, mode),
      helperRuns: previous?.helperRuns ?? [],
      pendingHelperRequests: previous?.pendingHelperRequests ?? [],
      scratchpadDir: previous?.scratchpadDir ?? (sessionDir ? join(sessionDir, "scratchpad") : undefined),
      baselineChangedFiles: previous?.baselineChangedFiles ?? [],
      cost: 0,
      createdAt: previous?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      ...(previous?.repo ? { repo: previous.repo } : {}),
      preloadedSessions: previous?.preloadedSessions ?? [],
    };
    this.sessionDir = sessionDir;
  }

  async initialize(): Promise<void> {
    this.setPhase("discovering", "Indexing repository context");
    this.state.workspacePolicy = createCodingWorkspacePolicy(this.ctx.cwd);
    this.recordEvent("coding:workspace_policy", "Coding workspace policy loaded", {
      internalPaths: this.state.workspacePolicy.internalPaths,
      generatedPaths: this.state.workspacePolicy.generatedPaths,
      dependencyPaths: this.state.workspacePolicy.dependencyPaths,
    });
    this.state.repo = await buildRepoContext(this.ctx.cwd, this.state.workspacePolicy);
    this.state.preloadedSessions = preloadProjectSessions(this.ctx.cwd, this.state.task, this.state.sessionId);
    this.state.instructions = loadCodingInstructions(this.ctx.cwd);
    this.state.agents = loadCodingAgents(this.ctx.cwd);
    this.state.commands = loadCustomCodingCommands(this.ctx.cwd);
    this.state.settings = loadCodingSettings(this.ctx.cwd);
    this.state.skills = loadSkills({ cwd: this.ctx.cwd });
    this.state.outputStyles = loadCodingOutputStyles(this.ctx.cwd);
    const activeStyle = findCodingOutputStyle(this.state.outputStyles, this.state.settings.outputStyle);
    if (activeStyle) this.state.activeOutputStyle = activeStyle;
    this.state.attachments = resolveCodingMentions(this.state.task, this.ctx.cwd);
    this.state.selectedSkills = selectSkillsForTask(this.state.task, this.state.skills, {
      limit: 6,
      paths: [
        ...this.state.attachments.map((attachment) => attachment.path),
        ...(this.state.intentContract?.targetScope ?? []),
      ],
    });
    if (this.state.baselineChangedFiles.length === 0) {
      this.state.baselineChangedFiles = await gitChangedFiles(this.ctx.cwd);
    }
    this.state.plan.verificationStrategy =
      detectCodingVerificationCommand(this.ctx.cwd, this.ctx.verifyCommand) ?? "No verification command detected yet";
    this.state.plan.dependencies = dependenciesFromRepo(this.state.repo);
    this.state.plan.targetFiles = this.state.repo.importantFiles.slice(0, 12);
    const previousIntent = this.state.intentContract;
    this.state.intentContract = createIntentContract(
      this.state.task,
      this.state.mode,
      this.state.repo,
      this.state.instructions,
      previousIntent,
    );
    this.state.planApproval = createPlanApproval(this.state.task, this.state.mode, this.state.intentContract);
    if (this.state.todos.length === 0 || !isSameIntent(previousIntent, this.state.intentContract)) {
      this.state.todos = createInitialTodos(this.state.intentContract, this.state.plan.verificationStrategy);
    }
    this.state.plan.tasks = this.state.todos.map(todoToPlanTask);
    this.recordEvent("coding:plan_update", "Coding plan initialized", {
      mode: this.state.mode,
      command: this.state.command?.name,
      verification: this.state.plan.verificationStrategy,
      projectType: this.state.repo.projectType,
      instructionFiles: this.state.instructions.map((source) => source.label),
      customCommands: this.state.commands.map((command) => `/${command.id}`),
      settingsSources: this.state.settings.sources,
      skills: this.state.skills.length,
      selectedSkills: this.state.selectedSkills.map((skill) => skill.name),
      outputStyle: this.state.activeOutputStyle?.id,
      preloadedSessions: this.state.preloadedSessions.map((session) => session.id),
      attachments: this.state.attachments.map((attachment) => ({
        requested: attachment.requested,
        path: attachment.path,
        kind: attachment.kind,
      })),
    });
    this.recordEvent("coding:settings", "Coding settings loaded", {
      sources: this.state.settings.sources,
      permissions: {
        allow: this.state.settings.permissions.allow.length,
        ask: this.state.settings.permissions.ask.length,
        deny: this.state.settings.permissions.deny.length,
      },
      hooks: Object.fromEntries(
        Object.entries(this.state.settings.hooks).map(([event, matchers]) => [event, matchers.length]),
      ),
    });
    this.recordEvent("coding:intent", "Coding intent contract initialized", {
      intent: this.state.intentContract,
      planApproval: this.state.planApproval,
    });
    if (this.state.intentContract.requiresQuestion) {
      this.recordEvent("coding:question", this.state.intentContract.question ?? "Intent clarification required", {
        askReason: this.state.intentContract.askReason,
      });
    } else {
      this.recordEvent("coding:question_skipped", "Proceeding without user question; intent confidence is adequate", {
        confidence: this.state.intentContract.confidence,
        assumptions: this.state.intentContract.assumptions,
      });
      for (const assumption of this.state.intentContract.assumptions) {
        this.recordEvent("coding:assumption", assumption, { intentId: this.state.intentContract.id });
      }
    }
    this.addEvidence({
      type: "coding_intent",
      source: this.state.intentContract.id,
      summary: this.state.intentContract.interpretation,
      data: this.state.intentContract,
      confidence: this.state.intentContract.ambiguity === "material" ? "medium" : "high",
    });
    if (this.state.instructions.length > 0) {
      this.addEvidence({
        type: "coding_instructions",
        source: "instruction_loader",
        summary: `Loaded ${this.state.instructions.length} coding instruction file(s).`,
        data: this.state.instructions.map((source) => ({
          label: source.label,
          scope: source.scope,
          truncated: source.truncated,
        })),
        confidence: "high",
      });
    }
    if (this.state.agents.length > 0) {
      this.recordEvent("coding:helper_start", `${this.state.agents.length} coding subagent definition(s) loaded`, {
        agents: this.state.agents.map((agent) => ({
          id: agent.id,
          source: agent.source,
          path: agent.path,
          readOnly: agent.readOnly,
        })),
      });
      this.addEvidence({
        type: "coding_agents",
        source: "agent_loader",
        summary: `Loaded ${this.state.agents.length} coding subagent definition(s).`,
        data: this.state.agents.map((agent) => ({
          id: agent.id,
          source: agent.source,
          path: agent.path,
          readOnly: agent.readOnly,
        })),
        confidence: "medium",
      });
    }
    if (this.state.selectedSkills.length > 0) {
      this.recordEvent("skill:load", `${this.state.selectedSkills.length} coding skill(s) selected`, {
        skills: this.state.selectedSkills.map((skill) => ({
          name: skill.name,
          source: skill.source,
          path: skill.path,
        })),
      });
      this.addEvidence({
        type: "coding_skills",
        source: "skill_selector",
        summary: `Selected ${this.state.selectedSkills.length} coding skill(s).`,
        data: this.state.selectedSkills.map((skill) => ({
          name: skill.name,
          source: skill.source,
          path: skill.path,
        })),
        confidence: "medium",
      });
    }
    if (this.state.attachments.length > 0) {
      this.recordEvent("coding:attachment", `${this.state.attachments.length} user-mentioned context attachment(s) resolved`, {
        attachments: this.state.attachments.map((attachment) => ({
          requested: attachment.requested,
          path: attachment.path,
          kind: attachment.kind,
          lineStart: attachment.lineStart,
          lineEnd: attachment.lineEnd,
          truncated: attachment.truncated,
          reason: attachment.reason,
        })),
      });
      this.addEvidence({
        type: "coding_attachments",
        source: "mention_resolver",
        summary: `Resolved user-mentioned context: ${this.state.attachments.map((item) => `${item.requested} -> ${item.path}`).join(", ")}`,
        data: this.state.attachments.map((attachment) => ({
          requested: attachment.requested,
          path: attachment.path,
          kind: attachment.kind,
          lineStart: attachment.lineStart,
          lineEnd: attachment.lineEnd,
          truncated: attachment.truncated,
          reason: attachment.reason,
        })),
        confidence: "high",
      });
    }
    this.persist();
    await this.runHooks("SessionStart", {
      event: "SessionStart",
      sessionId: this.ctx.sessionId,
      cwd: this.ctx.cwd,
      agentName: "CodingRuntime",
    });
  }

  buildSystemPrompt(): string {
    return [
      "You are Servus Coding Agent.",
      "",
      "Operate as a careful coding agent using this loop: understand -> discover -> plan -> edit -> verify -> finalize.",
      "Do not optimize for speed over correctness. Do not claim completion until evidence proves the user's request is satisfied.",
      "Do not create or rely on repo-root servus-plan.json or init.sh. Servus stores plan state in the session.",
      "Use repository-native conventions, read existing code before editing, and keep unrelated user changes intact.",
      "Assume the worktree may already be dirty. Treat pre-existing changes as user-owned unless the current task explicitly requires touching them.",
      `Servus-owned/generated paths are hidden from normal coding context: ${this.state.workspacePolicy.defaultExcludeGlobs.slice(0, 18).join(", ")}. Do not read or edit them unless the user explicitly asks.`,
      "Before editing, identify exact target files with Glob/Grep/Read (lowercase aliases also exist). For string edits, read the surrounding code and use unique oldString context.",
      "Use LSP for symbol context, references, definitions, and hover-like local evidence when it would reduce uncertainty.",
      "Use MCP tools/resources when configured and relevant: mcp_list_servers, McpListTools, ListMcpResourcesTool, ReadMcpResourceTool, and McpCallTool. Never call mutating external MCP tools without approval.",
      "Use workspace_status and git_diff to inspect current repo changes before finalizing instead of broad shell commands. Use Bash only for necessary project commands and verification. For long-running commands use Bash(run_in_background=true), then poll with BashOutput or stop with KillBash.",
      "Project/user settings may allow, ask, deny, or hook tool use. Respect settings blocks and do not route around them.",
      "Before making edits, confirm the intent contract. If discovery changes the interpretation or scope, call coding_intent with the corrected contract.",
      "Do not ask shallow questions. Inspect first, proceed with a documented assumption when confidence is adequate, and ask only when the wrong interpretation would materially change the implementation.",
      "For project summary, explain, or architecture-analysis tasks, use ProjectOverview/project_overview first, then inspect any important files it identifies. Do not run build/typecheck/test unless the user explicitly asks for verification.",
      "Servus coding tools are available: coding_state refreshes session state, ProjectOverview summarizes repository docs/manifests/layout/entrypoints, ToolSearch discovers tool choices, MemoryRead reads durable project memory, MemoryWrite stores one high-signal stable project fact, ReadToolResult retrieves session-stored large tool outputs, BashOutput/KillBash manage background shell commands, AskUserQuestion pauses for one concrete user decision, TodoWrite updates the session todo list, ExitPlanMode records the read-only plan checkpoint, and Task requests a helper agent.",
      "Use Task for focused exploration, planning, review, or independent verification when it materially reduces uncertainty. Do not use Task as a substitute for your own synthesis, and do not call servus_done until helper findings are returned.",
      this.state.mode === "coordinate" ? this.buildCoordinatorPrompt() : "",
      "For multi-step work, maintain coding_todo or TodoWrite. Keep exactly one todo in_progress and do not mark a todo completed without evidence. Skip todo noise for truly trivial one-step edits.",
      "If plan approval is required, finish read-only planning and call coding_plan_ready or ExitPlanMode before editing.",
      "After editing, run the most relevant verification command when possible. If verification fails, fix the failure before finishing.",
      "",
      modeInstruction(this.state.mode),
      "",
      codingCommandHelp(this.ctx.cwd),
      "",
      formatCodingInstructions(this.state.instructions),
      "",
      formatCodingAgents(this.state.agents),
      "",
      this.buildSelectedSkillsPrompt(),
      "",
      this.buildOutputStylePrompt(),
      "",
      formatCodingAttachments(this.state.attachments),
      "",
      "Completion protocol:",
      "- Use servus_need_input for one clear question when you are blocked or the request is ambiguous.",
      "- Use servus_done only after evidence is collected.",
      "- For code changes, evidence must include changed files, what was changed, and verification results.",
      "- If runtime supplies verification/checkpoint evidence in a repair message, cite that evidence in servus_done instead of rerunning the same step blindly.",
      "- If servus_done tools are unavailable, output equivalent JSON in <servus_done_json>...</servus_done_json>.",
    ].join("\n");
  }

  buildInitialMessage(): string {
    const repo = this.state.repo;
    return [
      "## User Task",
      this.state.task,
      "",
      "## Workspace",
      `Launch cwd: ${this.state.launchCwd}`,
      `Target cwd: ${this.state.targetCwd}`,
      this.state.launchCwd !== this.state.targetCwd
        ? "Use the target cwd for repository inspection, edits, verification, session memory, and evidence."
        : "Launch cwd and target cwd are the same.",
      this.state.command ? ["", "## Slash Command", `${this.state.command.raw}`].join("\n") : "",
      "",
      "## Runtime Plan",
      JSON.stringify(this.state.plan, null, 2),
      "",
      "## Intent Contract",
      JSON.stringify(this.state.intentContract, null, 2),
      "",
      "## Coding Todos",
      JSON.stringify(this.state.todos, null, 2),
      "",
      "## Custom Servus Commands",
      this.state.commands.length
        ? this.state.commands.map((command) => `/${command.id}: ${command.description}`).join("\n")
        : "(none loaded)",
      "",
      "## Selected Servus Skills",
      this.state.selectedSkills.length
        ? this.state.selectedSkills.map((skill) => `${skill.name} (${skill.source}): ${skill.description}`).join("\n")
        : "(none selected)",
      "",
      "## Active Output Style",
      this.state.activeOutputStyle
        ? `${this.state.activeOutputStyle.name}: ${this.state.activeOutputStyle.description}`
        : "(default)",
      "",
      "## Relevant Previous Servus Sessions",
      this.buildPreloadedSessionsPrompt(),
      "",
      "## Servus Startup Context",
      this.buildStartupContextPrompt(),
      "",
      "## Mentioned Context",
      this.state.attachments.length
        ? this.state.attachments.map((attachment) => `${attachment.requested} -> ${attachment.path} (${attachment.kind})`).join("\n")
        : "(none)",
      "",
      "## Plan Approval",
      JSON.stringify(this.state.planApproval, null, 2),
      "",
      this.state.mode === "coordinate" ? [
        "## Coordinator Scratchpad",
        this.state.scratchpadDir
          ? `Session scratchpad: ${this.state.scratchpadDir}`
          : "No persistent scratchpad directory is available for this direct run.",
        "Use ScratchpadWrite/ScratchpadRead/ScratchpadList for cross-worker notes, decisions, and implementation specs.",
        "",
      ].join("\n") : "",
      "## Repository Context",
      repo ? formatRepoContext(repo) : "(not indexed)",
      "",
      "## Instructions",
      this.state.mode !== "build" && this.state.mode !== "coordinate"
        ? "Explore/review the codebase and answer with evidence. Do not modify files. For summaries, inspect docs, manifests, source layout, build/deploy config, and key entrypoints before answering."
        : this.state.mode === "coordinate"
          ? "Coordinate the request end-to-end. Use workers where helpful, keep scratchpad notes, synthesize results yourself, inspect diff, then verify. If files change, finish with servus_done that cites intent, workers used, changed files, checkpoint/diff, and verification."
          : "Implement the request end-to-end. Confirm intent first, update todos as work progresses, read before editing, make minimal focused changes, inspect diff, then verify. If you edit files, finish with servus_done that cites intent, changed files, checkpoint/diff, and verification.",
      "",
      "When finished, call servus_done with evidence. If more user input is needed, call servus_need_input.",
    ].join("\n");
  }

  intentQuestion(): { question: string; summary: string } | undefined {
    const intent = this.state.intentContract;
    if (!intent?.requiresQuestion || !intent.question) return undefined;
    this.recordEvent("coding:question", intent.question, { intent });
    return {
      question: intent.question,
      summary: [
        intent.question,
        "",
        "I need to lock the intended scope before editing so I do not overbuild or underbuild.",
        intent.alternatives.length
          ? `Possible meanings: ${intent.alternatives.join(" | ")}`
          : undefined,
      ].filter(Boolean).join("\n"),
    };
  }

  updateIntentContract(input: CodingIntentContract): CodingIntentContract {
    const normalized: CodingIntentContract = {
      ...input,
      id: input.id || this.state.intentContract?.id || `intent-${Date.now().toString(36)}`,
      goal: input.goal.trim(),
      interpretation: input.interpretation.trim(),
      alternatives: input.alternatives.filter((item) => item.trim()).slice(0, 6),
      evidence: input.evidence.filter((item) => item.trim()).slice(0, 12),
      assumptions: input.assumptions.filter((item) => item.trim()).slice(0, 8),
      acceptanceCriteria: input.acceptanceCriteria.filter((item) => item.trim()).slice(0, 12),
      constraints: input.constraints.filter((item) => item.trim()).slice(0, 12),
      targetScope: input.targetScope.filter((item) => item.trim()).slice(0, 12),
      requiresQuestion: input.ambiguity === "material" || input.requiresQuestion,
    };
    this.state.intentContract = normalized;
    this.state.planApproval = createPlanApproval(this.state.task, this.state.mode, normalized);
    this.recordEvent("coding:intent", "Coding intent contract updated", { intent: normalized });
    this.addEvidence({
      type: "coding_intent",
      source: normalized.id,
      summary: normalized.interpretation,
      data: normalized,
      confidence: normalized.ambiguity === "material" ? "medium" : "high",
    });
    this.persist();
    return normalized;
  }

  updateTodos(todos: CodingTodo[]): CodingTodo[] {
    const normalized = normalizeTodos(todos);
    this.state.todos = normalized;
    this.state.plan.tasks = normalized.map(todoToPlanTask);
    this.recordEvent("coding:todo_update", `Updated ${normalized.length} coding todo(s)`, {
      todos: normalized,
    });
    this.persist();
    return normalized;
  }

  markPlanReady(planSummary: string, evidence: string[] = []): CodingPlanApproval {
    this.state.planApproval = {
      ...this.state.planApproval,
      status: this.state.planApproval.required ? "ready" : "not_required",
      planSummary: planSummary.trim(),
      ...(this.state.planApproval.required ? {} : { approvedAt: Date.now() }),
    };
    this.recordEvent("coding:plan_ready", "Coding plan marked ready", {
      planApproval: this.state.planApproval,
      evidence,
    });
    this.addEvidence({
      type: "coding_plan",
      source: "coding_plan_ready",
      summary: planSummary.trim() || "Plan ready.",
      data: { planApproval: this.state.planApproval, evidence },
      confidence: "high",
    });
    this.persist();
    return this.state.planApproval;
  }

  shouldRunPlanHelper(): boolean {
    return (this.state.mode === "build" || this.state.mode === "coordinate") &&
      !this.state.intentContract?.requiresQuestion &&
      this.state.planApproval.required &&
      !this.state.helperRuns.some((run) => run.type === "plan" && run.status === "completed");
  }

  shouldRunReviewHelper(changedFiles: string[]): boolean {
    const checkpointId = this.state.checkpoints.at(-1)?.id;
    return (this.state.mode === "build" || this.state.mode === "coordinate") &&
      changedFiles.length > 0 &&
      (this.state.planApproval.required || changedFiles.length > 1 || this.state.intentContract?.risk !== "low") &&
      !this.state.helperRuns.some((run) =>
        run.type === "review" &&
        (run.status === "completed" || run.status === "running") &&
        (!checkpointId || run.checkpointId === checkpointId)
      );
  }

  shouldRunVerificationHelper(changedFiles: string[], verification?: VerificationAttempt): boolean {
    const checkpointId = this.state.checkpoints.at(-1)?.id;
    return (this.state.mode === "build" || this.state.mode === "coordinate") &&
      changedFiles.length > 0 &&
      verification?.status === "passed" &&
      (this.state.planApproval.required || changedFiles.length > 1 || this.state.intentContract?.risk !== "low") &&
      !this.state.helperRuns.some((run) =>
        run.type === "verification" &&
        (run.status === "completed" || run.status === "running") &&
        (!checkpointId || run.checkpointId === checkpointId)
      );
  }

  requestHelper(type: CodingHelperType, description: string, prompt: string): CodingHelperRequest {
    const request: CodingHelperRequest = {
      id: `helper-request-${type}-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`,
      type,
      description: description.trim() || `${type} helper request`,
      prompt: prompt.trim(),
      createdAt: Date.now(),
    };
    this.state.pendingHelperRequests.push(request);
    this.recordEvent("coding:helper_start", `Requested ${type} helper`, { helperRequest: request });
    this.addEvidence({
      type: "coding_helper_request",
      source: request.id,
      summary: request.description,
      data: request,
      confidence: "medium",
    });
    this.persist();
    return request;
  }

  requestHelperContinuation(to: string, message: string): CodingHelperRequest {
    const target = this.findHelperRun(to);
    const type = target?.type ?? "worker";
    const request: CodingHelperRequest = {
      id: `helper-continue-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`,
      type,
      description: `Continue ${target?.id ?? to}`,
      prompt: message.trim(),
      ...(target ? { continueFrom: target.id } : {}),
      createdAt: Date.now(),
    };
    this.state.pendingHelperRequests.push(request);
    this.recordEvent("coding:helper_start", `Requested continuation for ${target?.id ?? to}`, { helperRequest: request });
    this.persist();
    return request;
  }

  stopHelperRun(id: string, reason?: string): { ok: boolean; summary: string } {
    const run = this.findHelperRun(id);
    if (!run) return { ok: false, summary: `No helper run found for ${id}.` };
    if (run.status === "completed" || run.status === "failed") {
      return { ok: false, summary: `Helper ${run.id} is already ${run.status}.` };
    }
    run.status = "failed";
    run.completedAt = Date.now();
    run.summary = reason?.trim() || "Stopped by coordinator.";
    this.recordEvent("coding:helper_finish", `Stopped helper ${run.id}`, { helper: run, reason });
    void this.runHooks("SubagentStop", {
      event: "SubagentStop",
      sessionId: this.ctx.sessionId,
      cwd: this.ctx.cwd,
      agentName: "CodingRuntime",
      toolName: "TaskStop",
      toolInput: { id, reason },
      toolOutput: run.summary,
      isError: true,
    });
    this.persist();
    return { ok: true, summary: `Stopped helper ${run.id}.` };
  }

  getCodingAgent(type: string): CodingAgentDefinition | undefined {
    return this.state.agents.find((agent) => agent.id === type);
  }

  takePendingHelperRequests(): CodingHelperRequest[] {
    const requests = [...this.state.pendingHelperRequests];
    if (requests.length === 0) return [];
    this.state.pendingHelperRequests = [];
    this.persist();
    return requests;
  }

  clearPendingHelperRequest(id: string): void {
    const next = this.state.pendingHelperRequests.filter((request) => request.id !== id);
    if (next.length === this.state.pendingHelperRequests.length) return;
    this.state.pendingHelperRequests = next;
    this.persist();
  }

  startHelperRun(type: CodingHelperType, summary: string, requestId?: string): CodingHelperRun {
    const request = requestId
      ? this.state.pendingHelperRequests.find((item) => item.id === requestId)
      : undefined;
    const checkpointId = (type === "review" || type === "verification")
      ? this.state.checkpoints.at(-1)?.id
      : undefined;
    const run: CodingHelperRun = {
      id: `helper-${type}-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`,
      type,
      ...(requestId ? { requestId } : {}),
      ...(request?.continueFrom ? { continuedFrom: request.continueFrom } : {}),
      ...(checkpointId ? { checkpointId } : {}),
      status: "running",
      summary,
      startedAt: Date.now(),
    };
    this.state.helperRuns.push(run);
    this.recordEvent("coding:helper_start", `Started ${type} helper`, { helper: run });
    void this.runHooks("TaskCreated", {
      event: "TaskCreated",
      sessionId: this.ctx.sessionId,
      cwd: this.ctx.cwd,
      agentName: "CodingRuntime",
      toolName: "Task",
      toolInput: run,
    });
    this.persist();
    return run;
  }

  helperAgentName(type: CodingHelperType, run: CodingHelperRun): string {
    const stableId = run.continuedFrom ?? run.id;
    const label = `${type.charAt(0).toUpperCase()}${type.slice(1)}`;
    return `${label}-${stableId}`;
  }

  finishHelperRun(run: CodingHelperRun, status: "completed" | "failed", summary: string): CodingHelperRun {
    run.status = status;
    run.summary = summary;
    if (run.type === "verification") {
      run.verdict = parseVerificationHelperVerdict(summary);
      this.recordEvent("coding:verification_verdict", `Verification helper verdict: ${run.verdict ?? "missing"}`, {
        helperId: run.id,
        verdict: run.verdict ?? "missing",
        summary: truncate(summary, 1200),
      });
    }
    run.completedAt = Date.now();
    this.recordEvent("coding:helper_finish", `${run.type} helper ${status}`, { helper: run });
    this.addEvidence({
      type: `coding_${run.type}_helper`,
      source: run.id,
      summary: truncate(summary, 500),
      data: run,
      confidence: status === "completed" && run.verdict !== "fail" ? "medium" : "low",
    });
    void this.runHooks("TaskCompleted", {
      event: "TaskCompleted",
      sessionId: this.ctx.sessionId,
      cwd: this.ctx.cwd,
      agentName: "CodingRuntime",
      toolName: "Task",
      toolInput: run,
      toolOutput: summary,
      isError: status === "failed",
    });
    this.persist();
    return run;
  }

  buildHelperSystemPrompt(type: CodingHelperType): string {
    const customAgent = this.getCodingAgent(type);
    if (customAgent) {
      return [
        `You are the Servus custom coding subagent "${customAgent.id}".`,
        customAgent.description,
        "",
        "You are invoked by the primary coding agent through the Task tool.",
        customAgent.readOnly
          ? "This subagent is read-only. Do not edit files, run mutating shell commands, install dependencies, stage commits, or delete data."
          : "You may follow the tools allowed for this subagent, but Servus safety rules and permission gates still apply.",
        "Return concise, evidence-backed findings for the primary coding agent. Do not claim the overall task is complete.",
        "",
        "# Subagent Instructions",
        customAgent.prompt,
      ].join("\n");
    }
    if (type === "plan") {
      return [
        "You are a read-only Servus planning helper.",
        "Explore the repository and produce an implementation strategy. Do not edit files.",
        "Focus on ambiguous scope, likely target files, existing patterns, risks, and verification.",
        "Use read, grep, glob, ls, LSP, workspace_status, and git_diff. Do not use write, edit, patch, or mutating shell commands.",
        "Return concise findings for the primary coding agent. Do not claim implementation is complete.",
      ].join("\n");
    }
    if (type === "review") {
      return [
        "You are a read-only Servus review helper.",
        "Review the current diff and repository evidence for bugs, regressions, missing tests, and scope drift.",
        "Return findings only. Do not edit files.",
      ].join("\n");
    }
    if (type === "verification") {
      return [
        "You are a read-only Servus verification helper.",
        "Try to verify and break the implementation with concrete commands when safe.",
        "You may use read/search tools and read-only shell commands such as build, test, typecheck, lint, curl, git diff, and git status.",
        "Do not edit files, install dependencies, stage commits, delete files, or mutate project state.",
        "Report exact commands and relevant output. End with exactly one line: VERDICT: PASS, VERDICT: FAIL, or VERDICT: PARTIAL.",
      ].join("\n");
    }
    if (type === "worker") {
      return [
        "You are a Servus coding worker.",
        "You receive self-contained tasks from the Servus coordinator. Follow the requested scope exactly.",
        "You may inspect, edit, and verify code when the coordinator explicitly asks for implementation. Keep changes focused and evidence-backed.",
        "Use the session scratchpad tools for durable notes when coordinating across workers. Do not write project files just to communicate.",
        "Do not claim the user's overall task is complete; report concrete findings, changed files, verification, blockers, and next recommended action back to the coordinator.",
      ].join("\n");
    }
    return [
      "You are a read-only Servus exploration helper.",
      "Find relevant files, code paths, and conventions quickly. Do not edit files.",
      "Return concrete paths and concise evidence.",
    ].join("\n");
  }

  buildHelperMessage(type: CodingHelperType, requestedPrompt?: string): string {
    const customAgent = this.getCodingAgent(type);
    return [
      `## Helper Task: ${type}`,
      "",
      "User task:",
      this.state.task,
      "",
      "Intent contract:",
      JSON.stringify(this.state.intentContract, null, 2),
      "",
      type === "review"
        ? [
            "Current diff summary:",
            this.state.checkpoints.at(-1)?.diffSummary ?? "No checkpoint diff summary available.",
            "",
          ].join("\n")
        : type === "verification"
          ? [
              "Changed files:",
              changedFilesLabel(this.state.checkpoints.at(-1)?.changedFiles ?? []),
              "",
              "Current diff summary:",
              this.state.checkpoints.at(-1)?.diffSummary ?? "No checkpoint diff summary available.",
              "",
              "Verification attempts:",
              JSON.stringify(this.state.verificationAttempts.slice(-3), null, 2),
              "",
            ].join("\n")
        : "",
      "Repository context:",
      this.state.repo ? formatRepoContext(this.state.repo) : "(not indexed)",
      "",
      this.state.mode === "coordinate" ? [
        "Coordinator scratchpad:",
        this.state.scratchpadDir ?? "(unavailable)",
        "",
      ].join("\n") : "",
      customAgent
        ? [
            "## Subagent Definition",
            `Id: ${customAgent.id}`,
            `Description: ${customAgent.description}`,
            `Source: ${customAgent.source}`,
            `Path: ${customAgent.path}`,
            "",
          ].join("\n")
        : "",
      requestedPrompt
        ? [
            "## Primary Agent Requested Prompt",
            requestedPrompt,
            "",
          ].join("\n")
        : "",
      customAgent
        ? "Follow the custom subagent instructions and answer the primary agent's requested prompt. Keep it under 900 words unless the request demands structured detail."
        : type === "plan"
        ? "Produce a read-only implementation plan with critical files, sequencing, risks, and verification strategy. Keep it under 800 words."
        : type === "review"
          ? "Review the current changes for correctness, scope drift, missing verification, and likely regressions. Keep it under 600 words."
          : type === "verification"
            ? "Run or inspect enough to independently validate this implementation. Keep the report concise and end with VERDICT."
        : "Produce concise read-only findings with file paths and evidence.",
    ].join("\n");
  }

  buildHelperContextMessage(): string {
    const completed = this.state.helperRuns.filter((run) => run.status === "completed");
    if (completed.length === 0) return "";
    return [
      "## Read-only Helper Findings",
      ...completed.map((run) => [
        `### ${run.type} helper (${run.id})`,
        truncate(run.summary, 3000),
      ].join("\n")),
    ].join("\n\n");
  }

  buildCoordinatorPrompt(): string {
    return [
      "# Servus Coordinator Mode",
      "You are coordinating a coding task across focused workers while staying responsible for the final answer.",
      "Use Task with subagent_type=\"worker\" for substantial independent research, implementation, or verification that benefits from separated context.",
      "Use SendMessage to continue an existing worker when its loaded context is useful for a correction or follow-up. Use TaskStop when a worker is going in the wrong direction.",
      "Do not delegate trivial reads or decisions. Synthesize worker findings yourself before writing follow-up instructions.",
      "Worker prompts must be self-contained: include goal, files, constraints, done criteria, and verification expectations.",
      "Run read-only research workers in parallel when independent. Serialize implementation workers that touch overlapping files.",
      "Use the scratchpad for durable coordinator notes: decisions, worker specs, file ownership, unresolved risks, and verification plan.",
      "For final completion, synthesize worker outputs with your own evidence. Workers do not finalize the user task.",
    ].join("\n");
  }

  buildHelperReturnMessage(requests: CodingHelperRequest[]): string {
    const requestIds = new Set(requests.map((request) => request.id));
    const relevant = this.state.helperRuns.filter((run) =>
      !!run.requestId && requestIds.has(run.requestId)
    );
    const latest = relevant.length > 0
      ? relevant
      : this.state.helperRuns.slice(-requests.length);
    return [
      "## Task Helper Results",
      "Continue the same coding session. Use these read-only helper findings as evidence, then decide the next step yourself.",
      "",
      ...latest.map((run) => [
        `### ${run.type} helper (${run.id}) - ${run.status}`,
        truncate(run.summary, 4000),
      ].join("\n")),
      "",
      "Do not restart. If the helper resolved the uncertainty, proceed with the next todo. If the helper found a blocker, ask one clear user question or fail honestly.",
    ].join("\n\n");
  }

  absorbAgentResponse(response: AgentResponse): void {
    this.state.cost = response.cost;
    const toolEvents = response.toolEvents ?? [];
    const changed = changedFilesFromToolEvents(toolEvents, this.ctx.cwd);
    if (changed.length > 0) {
      this.addEvidence({
        type: "coding_change",
        source: "tool_events",
        summary: `Agent edited ${changed.length} file(s): ${changed.join(", ")}`,
        data: { files: changed },
        confidence: "medium",
      });
    }
    const readEvidence = toolEvents
      .filter((event) => event.type === "call" && ["read", "grep", "glob", "ls", "LSP", "workspace_status", "git_diff"].includes(event.toolName))
      .slice(0, 12)
      .map((event) => event.toolName);
    if (readEvidence.length > 0) {
      this.addEvidence({
        type: "repo_evidence",
        source: "tool_events",
        summary: `Agent inspected repository context with: ${[...new Set(readEvidence)].join(", ")}`,
        confidence: "medium",
      });
    }
    this.persist();
  }

  async createCheckpoint(response: AgentResponse): Promise<CodingCheckpoint> {
    const gitFiles = (await gitChangedFiles(this.ctx.cwd))
      .filter((file) => !this.state.baselineChangedFiles.includes(file));
    const toolFiles = changedFilesFromToolEvents(response.toolEvents ?? [], this.ctx.cwd);
    const changedFiles = [...new Set([...gitFiles, ...toolFiles])].sort();
    const diffFiles = changedFiles.filter((file) => file !== "patch");
    const diffSummary = await gitDiffSummary(this.ctx.cwd, diffFiles);
    const diffArtifact = await this.writeCheckpointDiff(diffFiles);
    const snapshotArtifact = this.writeCheckpointSnapshot(diffFiles);
    const gitRepo = await isGitRepo(this.ctx.cwd);
    const checkpoint: CodingCheckpoint = {
      id: `ckpt-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`,
      createdAt: Date.now(),
      changedFiles,
      diffSummary: diffSummary || (changedFiles.length ? changedFiles.join("\n") : "No file changes detected."),
      ...(diffArtifact ? { diffArtifact } : {}),
      ...(snapshotArtifact ? { snapshotArtifact } : {}),
      snapshotRef: await gitHead(this.ctx.cwd),
      revertable: gitRepo || !!snapshotArtifact,
    };
    this.state.checkpoints.push(checkpoint);
    this.recordEvent("coding:checkpoint", `Checkpoint ${checkpoint.id}`, {
      changedFiles,
      diffArtifact,
      snapshotArtifact,
      revertable: checkpoint.revertable,
    });
    if (changedFiles.length > 0) {
      this.addEvidence({
        type: "coding_checkpoint",
        source: checkpoint.id,
        summary: `Checkpoint captured ${changedFiles.length} changed file(s).`,
        data: checkpoint,
        confidence: "high",
      });
    }
    this.persist();
    return checkpoint;
  }

  async verify(scope: "targeted" | "project" = "project", commandOverride?: string): Promise<VerificationAttempt> {
    this.setPhase("verifying", "Running verification");
    const changedFiles = this.state.checkpoints.at(-1)?.changedFiles ?? await gitChangedFiles(this.ctx.cwd);
    const command = commandOverride?.trim() || detectCodingVerificationCommand(
      this.ctx.cwd,
      this.ctx.verifyCommand,
      changedFiles,
    );
    const start = Date.now();
    if (!command) {
      const attempt: VerificationAttempt = {
        id: `verify-${this.state.verificationAttempts.length + 1}`,
        command: "No verification command detected",
        scope,
        status: "skipped",
        stdout: "",
        stderr: "Servus could not find a safe existing verification command for this workspace/change set.",
        durationMs: Date.now() - start,
      };
      this.state.verificationAttempts.push(attempt);
      this.recordEvent("coding:verify_finish", "Verification skipped", {
        ...attempt,
        reason: "no_existing_command",
        changedFiles,
      });
      this.addEvidence({
        type: "verification_skipped",
        source: "verification_detector",
        summary: "No safe existing verification command was detected.",
        data: { attempt, changedFiles },
        confidence: "medium",
      });
      this.persist();
      return attempt;
    }
    this.recordEvent("coding:verify_start", `Running ${command}`, { command, scope });
    const result = await runVerification(this.ctx.cwd, command);
    const attempt: VerificationAttempt = {
      id: `verify-${this.state.verificationAttempts.length + 1}`,
      command: result.command,
      scope,
      status: result.ok ? "passed" : "failed",
      stdout: clamp(result.stdout),
      stderr: clamp(result.stderr),
      durationMs: Date.now() - start,
      ...(result.ok ? {} : { failureCategory: classifyFailure(result) }),
    };
    this.state.verificationAttempts.push(attempt);
    this.recordEvent("coding:verify_finish", result.ok ? "Verification passed" : "Verification failed", {
      ...attempt,
      stdout: attempt.stdout.slice(0, 1200),
      stderr: attempt.stderr.slice(0, 1200),
    });
    this.addEvidence({
      type: "verification_attempt",
      source: result.command,
      summary: result.ok ? "Verification passed." : `Verification failed (${attempt.failureCategory}).`,
      data: attempt,
      confidence: result.ok ? "high" : "medium",
    });
    this.persist();
    return attempt;
  }

  validateCompletion(response: AgentResponse, verification?: VerificationAttempt): CodingCompletionDecision {
    const missing: string[] = [];
    const finalization = getFinalization(response);
    if (!finalization || finalization.kind !== "done") {
      missing.push("structured servus_done completion");
    } else {
      if (!finalization.summary?.trim()) missing.push("completion summary");
      if (!finalization.evidence?.length) missing.push("agent evidence");
      if (finalization.confidence === "low") missing.push("medium or high confidence");
    }

    const checkpoint = this.state.checkpoints.at(-1);
    const isBuild = this.state.mode === "build" || this.state.mode === "coordinate";
    const requiresFileChange = taskRequiresCodeMutation(this.state.task);
    const intentKind = this.state.intentContract?.kind;
    if (!this.state.intentContract) {
      missing.push("coding intent contract");
    } else {
      if (this.state.intentContract.requiresQuestion) missing.push("resolved intent ambiguity");
      if (!this.state.evidence.some((item) => item.type === "coding_intent")) missing.push("intent evidence");
    }
    missing.push(...validateTodos(this.state.todos, this.state.intentContract));
    if (
      isBuild &&
      this.state.planApproval.required &&
      this.state.planApproval.status !== "ready" &&
      this.state.planApproval.status !== "approved"
    ) {
      missing.push("plan ready checkpoint before implementation");
    }
    if (isBuild && intentKind === "change") {
      if (!checkpoint) missing.push("coding checkpoint");
      if (requiresFileChange && !checkpoint?.changedFiles.length) missing.push("changed files");
      if (requiresFileChange && checkpoint && checkpoint.changedFiles.length > 0 && !checkpoint.diffArtifact && !checkpoint.diffSummary) {
        missing.push("diff or checkpoint evidence");
      }
      if (!verification) missing.push("verification attempt or explicit verification-unavailable evidence");
      if (verification?.status === "failed") missing.push("passing verification");
      if (verification?.status === "skipped" && !hasVerificationSkipEvidence(this.state.evidence)) {
        missing.push("explicit verification-unavailable evidence");
      }
      if (
        checkpoint?.changedFiles.length &&
        (this.state.planApproval.required || checkpoint.changedFiles.length > 1 || this.state.intentContract?.risk !== "low") &&
        !this.hasPassingVerificationHelperVerdict()
      ) {
        missing.push("passing independent verification helper verdict");
      }
    } else if (intentKind === "verification") {
      if (!verification && !this.state.evidence.some((item) => item.type === "verification_attempt")) {
        missing.push("verification attempt");
      }
      if (verification && verification.status !== "passed") missing.push("passing verification");
    } else if (!this.state.evidence.some((item) => item.type === "repo_evidence")) {
      missing.push("repository evidence");
    }

    if (missing.length === 0) return { accepted: true, missing: [] };
    return {
      accepted: false,
      missing: [...new Set(missing)],
      repairPrompt: [
        "## Runtime validation failed",
        "Servus cannot mark the coding task complete yet.",
        "",
        "Missing evidence:",
        ...[...new Set(missing)].map((item) => `- ${item}`),
        "",
        "Continue in the same session. Gather the missing evidence, fix any failures, then call servus_done again.",
      ].join("\n"),
    };
  }

  buildRepairMessage(verification: VerificationAttempt, decision?: CodingCompletionDecision): string {
    this.setPhase("repairing", "Repairing failed validation");
    this.recordEvent("coding:repair", "Repair requested", {
      verificationStatus: verification.status,
      failureCategory: verification.failureCategory,
      missing: decision?.missing ?? [],
    });
    return [
      "## Repair Required",
      decision?.repairPrompt ?? "Verification failed. Fix the implementation and verify again.",
      "",
      "## Verification Command",
      verification.command,
      "",
      "## Failure Category",
      verification.failureCategory ?? "unknown",
      "",
      "## STDERR",
      "```",
      truncate(verification.stderr, 6000),
      "```",
      verification.stdout
        ? ["", "## STDOUT", "```", truncate(verification.stdout, 4000), "```"].join("\n")
        : "",
      "",
      verification.status === "passed"
        ? "Verification has passed. If the implementation satisfies the user request, call servus_done with the changed files/checkpoint and this verification evidence."
        : "Fix the issue without restarting. Then call servus_done with updated evidence.",
    ].filter(Boolean).join("\n");
  }

  buildValidationRepairMessage(decision: CodingCompletionDecision, verification?: VerificationAttempt): string {
    this.setPhase("repairing", "Repairing missing completion evidence");
    const helperContext = this.latestVerificationHelperSummary();
    return [
      decision.repairPrompt ?? "Continue and provide missing completion evidence.",
      verification
        ? [
            "",
      "## Runtime Verification Evidence",
            `Command: ${verification.command}`,
            `Status: ${verification.status}`,
            verification.status === "failed" ? `Failure category: ${verification.failureCategory ?? "unknown"}` : "",
          ].filter(Boolean).join("\n")
        : "",
      helperContext
        ? ["", "## Independent Verification Helper", helperContext].join("\n")
        : "",
      "",
      "Do not restart. Continue in this same session.",
    ].filter(Boolean).join("\n");
  }

  buildTransientRecoveryMessage(response: AgentResponse): string {
    this.setPhase("repairing", "Recovering same-session model/tool stream");
    this.recordEvent("coding:repair", "Transient coding response recovery requested", {
      subtype: response.subtype,
      text: truncate(response.text, 1200),
    });
    return [
      "## Continue Same Coding Session",
      "The previous model/tool stream ended before Servus received valid completion evidence.",
      "",
      "Do not restart the task, do not discard prior work, and do not re-scan the whole repository unless necessary.",
      "Use the current session context, inspect any changed files if needed, then continue from the last concrete step.",
      "",
      "Previous runtime notice:",
      "```",
      truncate(response.text, 2000),
      "```",
      "",
      "If the work is complete, call servus_done with changed-file/checkpoint evidence and verification. If more work is needed, continue and verify before finishing.",
    ].join("\n");
  }

  shouldVerifyAfterResponse(response: AgentResponse): boolean {
    if (this.state.mode !== "build") return false;
    if (getFinalization(response)?.kind === "done") return true;
    const eventFiles = changedFilesFromToolEvents(response.toolEvents ?? [], this.ctx.cwd);
    if (eventFiles.length > 0) return true;
    const latest = this.state.checkpoints.at(-1);
    return !!latest && latest.changedFiles.length > 0;
  }

  setPhase(phase: CodingPhase, message: string = phase): void {
    this.state.phase = phase;
    this.state.updatedAt = Date.now();
    this.recordEvent(`coding:${phase}`, message, { phase });
    if (this.ctx.sessionId) {
      updateSession(this.ctx.sessionId, { phase: toRuntimePhase(phase) });
    }
    this.persist();
  }

  complete(summary: string, artifacts: string[] = []): void {
    this.state.phase = "completed";
    this.state.plan.status = "completed";
    this.state.artifacts = [...new Set([...this.state.artifacts, ...artifacts])];
    this.recordEvent("coding:completed", summary, { artifacts });
    if (this.ctx.sessionId) {
      updateSession(this.ctx.sessionId, {
        finalSummary: summary,
        artifacts: this.state.artifacts,
        cwd: this.state.targetCwd,
        launchCwd: this.state.launchCwd,
        targetCwd: this.state.targetCwd,
      });
    }
    this.persist();
  }

  fail(summary: string): void {
    this.state.phase = "failed";
    this.state.plan.status = "failed";
    this.recordEvent("coding:failed", summary);
    if (this.ctx.sessionId) {
      updateSession(this.ctx.sessionId, {
        finalSummary: summary,
        cwd: this.state.targetCwd,
        launchCwd: this.state.launchCwd,
        targetCwd: this.state.targetCwd,
      });
    }
    this.persist();
  }

  async runStopHooks(summary: string, isError: boolean): Promise<CodingHookRunResult[]> {
    const event = isError ? "StopFailure" : "Stop";
    return await this.runHooks(event, {
      event,
      sessionId: this.ctx.sessionId,
      cwd: this.ctx.cwd,
      agentName: "CodingRuntime",
      toolOutput: summary,
      isError,
    });
  }

  private addEvidence(input: Omit<EvidenceItem, "id" | "timestamp">): EvidenceItem {
    const duplicate = this.state.evidence.some(
      (item) => item.type === input.type && item.source === input.source && item.summary === input.summary,
    );
    if (duplicate) return this.state.evidence[this.state.evidence.length - 1]!;
    const evidence: EvidenceItem = {
      id: `coding-evidence-${this.state.evidence.length + 1}`,
      timestamp: Date.now(),
      ...input,
    };
    this.state.evidence.push(evidence);
    if (this.ctx.sessionId) appendEvidence(this.ctx.sessionId, evidence);
    bus.push({
      type: "evidence:add",
      agent: "CodingRuntime",
      message: evidence.summary,
      metadata: { evidence },
    });
    return evidence;
  }

  private recordEvent(type: string, message: string, metadata?: Record<string, unknown>): void {
    const event = bus.push({ type: type as ServusEventType, agent: "CodingRuntime", message, metadata });
    if (this.ctx.sessionId && !bus.interactive) appendEvent(this.ctx.sessionId, event);
  }

  private persist(): void {
    this.state.updatedAt = Date.now();
    if (!this.sessionDir) return;
    try {
      mkdirSync(this.sessionDir, { recursive: true });
      writeFileSync(join(this.sessionDir, "state.json"), JSON.stringify(this.state, null, 2) + "\n");
    } catch {
      // Session persistence must not break non-interactive coding runs.
    }
  }

  private async writeCheckpointDiff(changedFiles: string[]): Promise<string | undefined> {
    if (!this.sessionDir || changedFiles.length === 0) return undefined;
    const diff = await gitDiff(this.ctx.cwd, changedFiles);
    if (!diff.trim()) return undefined;
    try {
      const dir = join(this.sessionDir, "diffs");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `checkpoint-${this.state.checkpoints.length + 1}.diff`);
      writeFileSync(path, diff.endsWith("\n") ? diff : `${diff}\n`);
      this.state.artifacts = [...new Set([...this.state.artifacts, path])];
      return path;
    } catch {
      return undefined;
    }
  }

  private writeCheckpointSnapshot(changedFiles: string[]): string | undefined {
    if (!this.sessionDir || changedFiles.length === 0) return undefined;
    const snapshotLog = join(this.sessionDir, "snapshots", "pre-mutation.jsonl");
    if (!existsSync(snapshotLog)) return undefined;
    const since = this.state.checkpoints.at(-1)?.createdAt ?? 0;
    const changed = new Set(changedFiles);
    const selected = new Map<string, PreMutationSnapshot>();
    for (const entry of readPreMutationSnapshots(snapshotLog)) {
      if (entry.timestamp < since) continue;
      if (!changed.has(entry.path)) continue;
      if (!selected.has(entry.path)) selected.set(entry.path, entry);
    }
    if (selected.size === 0) return undefined;
    try {
      const dir = join(this.sessionDir, "snapshots");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `checkpoint-${this.state.checkpoints.length + 1}-snapshot.json`);
      writeFileSync(path, JSON.stringify({
        version: 1,
        cwd: this.ctx.cwd,
        createdAt: Date.now(),
        files: [...selected.values()],
      }, null, 2) + "\n");
      this.state.artifacts = [...new Set([...this.state.artifacts, path])];
      return path;
    } catch {
      return undefined;
    }
  }

  async buildStatusSummary(): Promise<string> {
    const currentFiles = await gitChangedFiles(this.ctx.cwd);
    return [
      "Coding session status:",
      `- Session: ${this.state.sessionId}`,
      `- Mode: ${this.state.mode}`,
      this.state.command ? `- Slash command: /${this.state.command.name}` : undefined,
      `- Task: ${this.state.task}`,
      `- Phase: ${this.state.phase}`,
      this.state.intentContract ? `- Intent: ${this.state.intentContract.interpretation}` : "- Intent: not set",
      this.state.intentContract ? `- Ambiguity: ${this.state.intentContract.ambiguity}` : undefined,
      `- Todos: ${this.state.todos.filter((todo) => todo.status === "completed").length}/${this.state.todos.length}`,
      `- Plan approval: ${this.state.planApproval.status}`,
      `- Verification: ${this.state.plan.verificationStrategy}`,
      `- Checkpoints: ${this.state.checkpoints.length}`,
      `- Verification attempts: ${this.state.verificationAttempts.length}`,
      `- Instruction files: ${this.state.instructions.length ? this.state.instructions.map((item) => item.label).join(", ") : "none"}`,
      `- Coding subagents: ${this.currentCodingAgents().length ? this.currentCodingAgents().map((agent) => agent.id).join(", ") : "built-ins only"}`,
      `- Custom commands: ${this.currentCustomCommands().length ? this.currentCustomCommands().map((command) => `/${command.id}`).join(", ") : "none"}`,
      `- Skills: ${this.state.selectedSkills.length}/${this.state.skills.length} selected`,
      `- Output style: ${this.state.activeOutputStyle?.id ?? "default"}`,
      `- Mentioned files: ${this.state.attachments.length ? this.state.attachments.map((item) => mentionDisplayName(item.path)).join(", ") : "none"}`,
      currentFiles.length ? `- Git changed files: ${currentFiles.join(", ")}` : "- Git changed files: none",
    ].filter(Boolean).join("\n");
  }

  buildHelpSummary(): string {
    return [
      "Servus coding help:",
      "",
      codingCommandHelp(this.ctx.cwd),
      "",
      "Basics:",
      "- Type a normal request to let Servus inspect, plan, edit, verify, and finish with evidence.",
      "- Use @path or @path:line-line to attach exact files to the request.",
      "- Use /plan for read-only implementation planning and /build to force edit mode.",
      "- Use /diff and /revert to inspect or undo Servus checkpointed changes.",
      "- Use /status, /context, /memory, /permissions, /hooks, /skills, and /tools to understand the current coding environment.",
    ].join("\n");
  }

  buildTranscriptSummary(limitArg?: string): string {
    const limit = Math.max(5, Math.min(120, Number.parseInt(limitArg ?? "40", 10) || 40));
    const transcriptPath = join(SERVUS_DIR, "sessions", this.state.sessionId, "coding", "transcript.jsonl");
    if (!existsSync(transcriptPath)) {
      return [
        "No coding transcript has been recorded for this session yet.",
        `Expected: ${transcriptPath}`,
      ].join("\n");
    }
    const events = readJsonlLoose(transcriptPath)
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
      .slice(-limit);
    if (events.length === 0) return "Coding transcript exists, but it has no readable entries.";
    return [
      `Recent coding transcript (${events.length} event${events.length === 1 ? "" : "s"} shown, newest at bottom):`,
      "",
      ...events.map((entry, index) => {
        const type = typeof entry.type === "string" ? entry.type : "message";
        const agent = typeof entry.agent === "string" ? entry.agent : "Servus";
        const timestamp = typeof entry.timestamp === "number"
          ? new Date(entry.timestamp).toISOString()
          : "(unknown time)";
        const content = typeof entry.content === "string"
          ? entry.content
          : entry.metadata
            ? JSON.stringify(entry.metadata)
            : "";
        return [
          `#${index + 1} ${timestamp} ${type} ${agent}`,
          truncate(content.trim() || "(no text content)", 1800),
        ].join("\n");
      }),
    ].join("\n\n");
  }

  buildToolsSummary(): string {
    return [
      "Servus coding tools:",
      "",
      "Repository context:",
      "- Read / LS: inspect files and directories. Existing files must be read before Edit/Write/Patch.",
      "- ProjectOverview / project_overview: summarize docs, manifests, source layout, configs, and likely entrypoints for project-summary/onboarding tasks.",
      "- workspace_map: inspect a bounded tree-style project structure without exposing Servus/generated folders.",
      "- Glob: find files by pattern with workspace ignore policy.",
      "- Grep: search file contents with output modes, context lines, offsets, file type filters, and case-insensitive search.",
      "- LSP / lsp_status: symbol, reference, definition, hover, and call-hierarchy style code intelligence when available.",
      "- workspace_status / git_diff: inspect dirty files and diffs with Servus-generated paths hidden.",
      "",
      "Changes and commands:",
      "- Edit / MultiEdit / Write / patch: serialized file mutations with read-before-edit, stale-read, exact-match, binary, size, and generated-path guards.",
      "- Bash / BashOutput / KillBash: run project commands, background long-running commands, poll output, or stop them.",
      "",
      "Planning and completion:",
      "- coding_intent: update the intent contract after discovery.",
      "- TodoWrite / coding_todo: maintain multi-step todos with exactly one in_progress item.",
      "- ExitPlanMode / coding_plan_ready: checkpoint read-only planning before broad or risky edits.",
      "- AskUserQuestion / servus_need_input: ask one concrete user question when genuinely blocked.",
      "- servus_done: finish only after evidence, diff/checkpoint, verification, and risks are recorded.",
      "",
      "Advanced context:",
      "- Task / SendMessage / TaskStop: run, continue, or stop Servus helper agents.",
      "- MemoryRead / MemoryWrite: read or intentionally update durable project memory; MemoryWrite stores only high-signal stable facts and rejects transient notes or secrets.",
      "- ScratchpadList / ScratchpadRead / ScratchpadWrite: coordinator notes that do not touch project files.",
      "- ToolSearch: discover tools by capability.",
      "- ReadToolResult: read large output artifacts that were truncated from model context.",
      "- MCP tools/resources: list and read configured MCP context; mutating MCP calls require approval.",
    ].join("\n");
  }

  buildSessionsSummary(query?: string): string {
    const sessions = listProjectSessions(this.ctx.cwd);
    const globalMatches = query?.trim() ? findSessionIndex(query, 8) : [];
    const normalized = query?.trim().toLowerCase() ?? "";
    const filtered = normalized
      ? sessions.filter((session) => {
          const haystack = [
            session.id,
            session.task,
            session.status,
            session.runtimeStatus,
            session.domain,
            session.model,
            session.backend,
            session.cwd,
            session.proofDir,
          ].filter(Boolean).join("\n").toLowerCase();
          return haystack.includes(normalized);
        })
      : sessions;
    const rows = filtered.slice(0, 24);
    return [
      normalized
        ? `Servus project sessions matching "${query}": ${filtered.length}/${sessions.length}`
        : `Recent Servus project sessions: ${sessions.length}`,
      "",
      rows.length
        ? rows.map((session) => [
            `- ${session.id} [${session.status}${session.runtimeStatus ? `/${session.runtimeStatus}` : ""}] ${new Date(session.startTime).toISOString()}`,
            `  Title: ${(session.finalSummary || session.task).slice(0, 180)}`,
            `  Domain: ${session.domain ?? "unknown"} | Target: ${session.targetCwd ?? session.cwd}`,
            `  Model: ${session.model} | Cost: $${session.cost.toFixed(4)}`,
            session.proofDir ? `  Proof: ${session.proofDir}` : undefined,
            `  Continue: servus --session ${session.id} --cwd ${session.cwd} "<follow-up>"`,
          ].filter(Boolean).join("\n")).join("\n")
        : "No matching Servus sessions found for this project.",
      filtered.length > rows.length ? `\n... ${filtered.length - rows.length} more omitted` : "",
      globalMatches.length
        ? [
            "",
            "Global session-index matches:",
            ...globalMatches
              .filter((entry) => !rows.some((row) => row.id === entry.id))
              .map((entry) =>
                `- ${entry.id} [${entry.status}${entry.runtimeStatus ? `/${entry.runtimeStatus}` : ""}] ${entry.title} (${entry.targetCwd ?? entry.cwd})`
              ),
          ].join("\n")
        : "",
    ].filter(Boolean).join("\n");
  }

  buildContextSummary(): string {
    const budget = contextBudgetForModel(this.ctx.model);
    const systemPrompt = this.buildSystemPrompt();
    const initialMessage = this.buildInitialMessage();
    const agentNames = new Set<string>([
      primaryAgentNameForMode(this.state.mode),
      ...this.state.helperRuns.map((run) => this.helperAgentName(run.type, run)),
    ]);
    const histories = [...agentNames].map((agent) => {
      const history = loadAgentHistory(this.ctx.sessionId, agent);
      return {
        agent,
        messages: history.length,
        tokens: estimateMessageTokens(history),
      };
    });
    const systemTokens = estimateMessageTokens(systemPrompt);
    const initialTokens = estimateMessageTokens(initialMessage);
    const historyTokens = histories.reduce((total, item) => total + item.tokens, 0);
    const total = systemTokens + initialTokens + historyTokens;
    const percent = budget.contextWindowTokens > 0
      ? Math.round((total / budget.contextWindowTokens) * 1000) / 10
      : 0;
    const compactPercent = budget.compactAtTokens > 0
      ? Math.round((total / budget.compactAtTokens) * 1000) / 10
      : 0;
    const suggestions = generateCodingContextSuggestions({
      estimatedTokens: total,
      contextWindowTokens: budget.contextWindowTokens,
      compactAtTokens: budget.compactAtTokens,
      historyTokens,
      systemTokens,
      readStateFiles: listCodingReadStateFiles(this.state.sessionId, this.ctx.cwd).length,
      toolResultArtifacts: this.state.artifacts.filter((artifact) => artifact.includes("/tool-results/")).length,
      compactions: this.loadCompactionCount(),
    });
    return [
      "Servus coding context:",
      "",
      `Model: ${this.ctx.model}`,
      `Context window: ${budget.contextWindowTokens.toLocaleString()} estimated tokens`,
      `Auto-compact threshold: ${budget.compactAtTokens.toLocaleString()} estimated tokens`,
      `Current estimate: ${total.toLocaleString()} tokens (${percent}% of window, ${compactPercent}% of compact threshold)`,
      "",
      "Breakdown:",
      `- system prompt: ${systemTokens.toLocaleString()}`,
      `- initial run message: ${initialTokens.toLocaleString()}`,
      `- persisted agent history: ${historyTokens.toLocaleString()}`,
      "",
      "Agent histories:",
      ...(histories.length
        ? histories.map((item) => `- ${item.agent}: ${item.messages} message(s), ~${item.tokens.toLocaleString()} token(s)`)
        : ["- none"]),
      "",
      "Context suggestions:",
      ...(suggestions.length
        ? suggestions.map((suggestion) =>
            `- [${suggestion.severity}] ${suggestion.title}: ${suggestion.detail}${suggestion.savingsTokens ? ` (~${suggestion.savingsTokens.toLocaleString()} tokens saved)` : ""}`
          )
        : ["- none"]),
      "",
      total >= budget.compactAtTokens
        ? "Status: compaction will run before the next model turn."
        : "Status: below automatic compaction threshold.",
    ].join("\n");
  }

  private loadCompactionCount(): number {
    if (!this.sessionDir) return 0;
    const path = join(this.sessionDir, "compactions.jsonl");
    if (!existsSync(path)) return 0;
    try {
      return readFileSync(path, "utf-8").split(/\r?\n/).filter(Boolean).length;
    } catch {
      return 0;
    }
  }

  private buildPreloadedSessionsPrompt(): string {
    if (this.state.preloadedSessions.length === 0) return "(none)";
    return this.state.preloadedSessions.map((session) => [
      `- ${session.id} [${session.status}] ${new Date(session.startTime).toISOString()}`,
      `  Task: ${session.task.slice(0, 220)}`,
      session.domain ? `  Domain: ${session.domain}` : undefined,
      session.proofDir ? `  Proof: ${session.proofDir}` : undefined,
    ].filter(Boolean).join("\n")).join("\n");
  }

  private buildStartupContextPrompt(): string {
    const readFiles = listCodingReadStateFiles(this.state.sessionId, this.ctx.cwd);
    const recentSessions = this.state.preloadedSessions.slice(0, 6);
    const workspaceMap = this.state.repo?.workspaceMap?.slice(0, 60) ?? [];
    const latestCheckpoint = this.state.checkpoints.at(-1);
    const latestVerification = this.state.verificationAttempts.at(-1);
    const content = [
      "<servus_startup_context>",
      "This is bounded background context from Servus. It may be incomplete or stale; use it to orient, then verify with tools before making claims or edits.",
      "",
      "## Current Session",
      `Mode: ${this.state.mode}`,
      `Phase: ${this.state.phase}`,
      `Target cwd: ${this.state.targetCwd}`,
      this.state.intentContract ? `Intent: ${this.state.intentContract.interpretation}` : "Intent: not finalized",
      this.state.todos.length
        ? `Todos: ${this.state.todos.map((todo) => `[${todo.status}] ${todo.content}`).join(" | ")}`
        : "Todos: none",
      latestCheckpoint
        ? `Latest checkpoint: ${latestCheckpoint.id} (${changedFilesLabel(latestCheckpoint.changedFiles)})`
        : "Latest checkpoint: none",
      latestVerification
        ? `Latest verification: ${latestVerification.status} (${latestVerification.command})`
        : "Latest verification: none",
      readFiles.length
        ? `Read-state files: ${readFiles.slice(0, 20).map((file) => file.path).join(", ")}${readFiles.length > 20 ? `, ... ${readFiles.length - 20} more` : ""}`
        : "Read-state files: none",
      "",
      "## Recent Servus Work",
      recentSessions.length
        ? recentSessions.map((session) =>
            `- ${session.id} [${session.status}] ${new Date(session.startTime).toISOString()}: ${session.task.slice(0, 180)}`
          ).join("\n")
        : "(none)",
      "",
      "## Workspace Map",
      workspaceMap.length ? workspaceMap.map((line) => `- ${line}`).join("\n") : "(not available)",
      "",
      "## Notes",
      "Do not repeat this block back unless relevant. Use current tool evidence over stale context.",
      "</servus_startup_context>",
    ].filter(Boolean).join("\n");
    return truncate(content, 8_000);
  }

  buildCompactionSnapshot(): string {
    return truncate(JSON.stringify({
      sessionId: this.state.sessionId,
      mode: this.state.mode,
      task: this.state.task,
      phase: this.state.phase,
      intentContract: this.state.intentContract,
      todos: this.state.todos,
      planApproval: this.state.planApproval,
      latestCheckpoints: this.state.checkpoints.slice(-5),
      latestVerificationAttempts: this.state.verificationAttempts.slice(-5),
      selectedSkills: this.state.selectedSkills.map((skill) => ({
        name: skill.name,
        source: skill.source,
        pathPatterns: skill.pathPatterns,
      })),
      attachments: this.state.attachments.map((attachment) => ({
        requested: attachment.requested,
        path: attachment.path,
        kind: attachment.kind,
      })),
      helperRuns: this.state.helperRuns.slice(-8),
      scratchpadDir: this.state.scratchpadDir,
      preloadedSessions: this.state.preloadedSessions,
      recentEvidence: this.state.evidence.slice(-20).map((item) => ({
        id: item.id,
        type: item.type,
        source: item.source,
        summary: item.summary,
        confidence: item.confidence,
      })),
      artifacts: this.state.artifacts.slice(-20),
    }, null, 2), 24_000);
  }

  buildTurnReminder(turn: number): string {
    if (turn === 0 || turn % 4 !== 0) return "";
    const activeTodo = this.state.todos.find((todo) => todo.status === "in_progress");
    const pendingTodos = this.state.todos.filter((todo) => todo.status === "pending");
    const latestCheckpoint = this.state.checkpoints.at(-1);
    const latestVerification = this.state.verificationAttempts.at(-1);
    const lines = [
      "<servus_context type=\"runtime_reminder\">",
      "## Servus Runtime Reminder",
      "Continue the same coding session. Do not restart or discard prior context.",
      activeTodo ? `Active todo: ${activeTodo.id} - ${activeTodo.activeForm || activeTodo.content}` : undefined,
      pendingTodos.length ? `Pending todos: ${pendingTodos.map((todo) => todo.id).join(", ")}` : undefined,
      latestCheckpoint?.changedFiles.length
        ? `Latest changed files: ${latestCheckpoint.changedFiles.join(", ")}`
        : undefined,
      latestVerification
        ? `Latest verification: ${latestVerification.status} (${latestVerification.command})`
        : "Verification: not recorded yet.",
      this.state.planApproval.required ? `Plan approval: ${this.state.planApproval.status}` : undefined,
      "",
      "Before servus_done, make sure intent, changed files or repo evidence, checkpoint/diff, verification, satisfied criteria, and remaining risks are present.",
      "</servus_context>",
    ].filter(Boolean).join("\n");
    this.recordEvent("coding:reminder", "Injected coding runtime reminder", {
      turn,
      activeTodo: activeTodo?.id,
      pendingTodos: pendingTodos.map((todo) => todo.id),
      latestVerification: latestVerification?.status,
    });
    return lines;
  }

  buildAgentsSummary(): string {
    const agents = this.currentCodingAgents();
    return [
      "Coding subagents:",
      "",
      "Built-ins:",
      "- explore: read-only codebase search and evidence gathering.",
      "- plan: read-only implementation strategy and risk analysis.",
      "- review: read-only final diff review.",
      "- verification: read-only independent verification; must end with VERDICT.",
      "- worker: coordinator-mode worker for focused research, implementation, or verification tasks.",
      "",
      agents.length ? "Custom agents:" : "Custom agents: none found in .servus/agents or ~/.servus/agents.",
      ...agents.map((agent) => [
        `- ${agent.id} (${agent.source})`,
        `  ${agent.description}`,
        `  Path: ${agent.path}`,
        `  Read-only: ${agent.readOnly ? "yes" : "no"}`,
        agent.tools?.length ? `  Tools: ${agent.tools.join(", ")}` : undefined,
      ].filter(Boolean).join("\n")),
      "",
      "Use: Task({ subagent_type: \"agent-id\", description, prompt })",
      "Coordinator mode: /coordinate <task>, then use Task/SendMessage/TaskStop and Scratchpad tools.",
    ].join("\n");
  }

  buildCommandsSummary(): string {
    return formatCustomCodingCommands(this.currentCustomCommands());
  }

  buildModelsSummary(): string {
    const available = listModelOptions();
    const all = listModelOptions({ includeUnavailable: true });
    const recommended = getDefaultModelForAvailableProvider(this.ctx.model);
    const keyStatus = getApiKeyStatus();
    return [
      "Servus model options:",
      "",
      `Current model: ${this.ctx.model}`,
      `Recommended default from available provider keys: ${recommended}`,
      "",
      "Provider keys:",
      ...Object.entries(keyStatus).map(([key, present]) => `- ${key}: ${present ? "present" : "missing"}`),
      "",
      available.length ? "Selectable models:" : "Selectable models: none detected from current environment.",
      ...available.map((model) => [
        `- ${model.value}${model.value === recommended ? " [recommended]" : ""}`,
        `  ${model.providerName}: ${model.label}`,
        `  Pricing: $${model.inputPerM}/MTok input, $${model.outputPerM}/MTok output${model.cachedInputPerM !== undefined ? `, $${model.cachedInputPerM}/MTok cached input` : ""}`,
        model.contextWindow ? `  Context: ${model.contextWindow.toLocaleString()} tokens${model.maxOutput ? `, max output ${model.maxOutput.toLocaleString()}` : ""}` : undefined,
        `  ${model.description}`,
      ].filter(Boolean).join("\n")),
      "",
      "Unavailable catalog entries:",
      ...all
        .filter((model) => !model.available)
        .map((model) => `- ${model.value} (${model.providerName}; missing provider key)`),
      "",
      "Use --model <model> for a direct run, or the TUI model picker for interactive runs.",
    ].join("\n");
  }

  buildPermissionsSummary(): string {
    const settings = this.state.settings;
    return [
      "Servus coding permissions:",
      settings.sources.length ? `Sources: ${settings.sources.join(", ")}` : "Sources: none",
      "",
      "Allow rules:",
      ...(settings.permissions.allow.length ? settings.permissions.allow.map((rule) => `- ${rule.rule}${rule.reason ? ` (${rule.reason})` : ""}`) : ["- none"]),
      "",
      "Ask rules:",
      ...(settings.permissions.ask.length ? settings.permissions.ask.map((rule) => `- ${rule.rule}${rule.reason ? ` (${rule.reason})` : ""}`) : ["- none"]),
      "",
      "Deny rules:",
      ...(settings.permissions.deny.length ? settings.permissions.deny.map((rule) => `- ${rule.rule}${rule.reason ? ` (${rule.reason})` : ""}`) : ["- none"]),
      "",
      "Rule examples: Bash(npm install*), Bash(git push*), Edit(src/**), Write(docs/**), McpCallTool(*).",
    ].join("\n");
  }

  buildHooksSummary(): string {
    const settings = this.state.settings;
    const events = [
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "PostToolUseFailure",
      "Notification",
      "PreCompact",
      "PostCompact",
      "Stop",
      "StopFailure",
      "SubagentStop",
      "TaskCreated",
      "TaskCompleted",
    ] as const;
    return [
      "Servus coding hooks:",
      settings.sources.length ? `Sources: ${settings.sources.join(", ")}` : "Sources: none",
      "",
      ...events.map((event) => {
        const matchers = settings.hooks[event] ?? [];
        if (matchers.length === 0) return `- ${event}: none`;
        return [
          `- ${event}:`,
          ...matchers.map((matcher) => [
            `  matcher: ${matcher.matcher ?? "*"}`,
            `  source: ${matcher.source}`,
            `  hooks: ${matcher.hooks.map((hook) =>
              hook.type === "prompt"
                ? `prompt${hook.model ? `:${hook.model}` : ""}`
                : hook.command ?? hook.url ?? hook.type
            ).join(", ")}`,
          ].join("\n")),
        ].join("\n");
      }),
      "",
      "Prompt hooks use PASS:/BLOCK: semantics; command hooks can return exit code 2 to block.",
      "Plugin hooks are loaded from active Servus plugin manifests and run through the same policy pipeline.",
    ].join("\n");
  }

  buildSettingsSummary(): string {
    const settings = this.state.settings;
    return [
      "Servus coding settings:",
      settings.sources.length ? `Sources: ${settings.sources.join(", ")}` : "Sources: none",
      "",
      "Permissions:",
      `- allow: ${settings.permissions.allow.map((rule) => rule.rule).join(", ") || "none"}`,
      `- ask: ${settings.permissions.ask.map((rule) => rule.rule).join(", ") || "none"}`,
      `- deny: ${settings.permissions.deny.map((rule) => rule.rule).join(", ") || "none"}`,
      "",
      "Hooks:",
      ...(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "StopFailure"] as const).map((event) => {
        const matchers = settings.hooks[event] ?? [];
        return `- ${event}: ${matchers.length ? matchers.map((matcher) => `${matcher.matcher ?? "*"} (${matcher.source})`).join(", ") : "none"}`;
      }),
    ].join("\n");
  }

  buildSkillsSummary(): string {
    const selected = new Set(this.state.selectedSkills.map((skill) => `${skill.source}:${skill.name}`));
    if (this.state.skills.length === 0) {
      return "No Servus skills are currently loaded. Add project skills in .servus/skills/<name>/SKILL.md or user skills in ~/.servus/skills/<name>/SKILL.md.";
    }
    return [
      `Loaded ${this.state.skills.length} Servus skill(s).`,
      `Selected for this task: ${this.state.selectedSkills.length ? this.state.selectedSkills.map((skill) => skill.name).join(", ") : "none"}`,
      "",
      ...this.state.skills.map((skill) => [
        `- ${skill.name}${selected.has(`${skill.source}:${skill.name}`) ? " [selected]" : ""}`,
        `  Source: ${skill.source}`,
        `  Path: ${skill.path}`,
        `  Description: ${skill.description}`,
        skill.whenToUse ? `  When: ${skill.whenToUse}` : undefined,
        skill.pathPatterns?.length ? `  Paths: ${skill.pathPatterns.join(", ")}` : undefined,
        skill.allowedTools?.length ? `  Allowed tools: ${skill.allowedTools.join(", ")}` : undefined,
      ].filter(Boolean).join("\n")),
    ].join("\n");
  }

  buildOutputStylesSummary(requested?: string): { ok: boolean; summary: string; artifacts: string[] } {
    if (!requested?.trim()) {
      return {
        ok: true,
        summary: formatCodingOutputStyles(this.state.outputStyles, this.state.activeOutputStyle),
        artifacts: [],
      };
    }
    const style = findCodingOutputStyle(this.state.outputStyles, requested);
    if (!style) {
      return {
        ok: false,
        summary: [
          `No Servus output style found for "${requested}".`,
          "",
          formatCodingOutputStyles(this.state.outputStyles, this.state.activeOutputStyle),
        ].join("\n"),
        artifacts: [],
      };
    }
    const settingsPath = setProjectOutputStyle(this.ctx.cwd, style.id);
    this.state.settings = loadCodingSettings(this.ctx.cwd);
    this.state.activeOutputStyle = style;
    this.recordEvent("coding:settings", `Output style set to ${style.id}`, {
      style,
      settingsPath,
    });
    this.persist();
    return {
      ok: true,
      summary: `Servus output style set to "${style.id}" in ${settingsPath}. Future coding runs will use it.`,
      artifacts: [settingsPath],
    };
  }

  async buildDoctorSummary(): Promise<string> {
    const root = findServusProjectRoot(this.ctx.cwd);
    const keys = getApiKeyStatus();
    const gitRepo = await isGitRepo(this.ctx.cwd);
    const changedFiles = await gitChangedFiles(this.ctx.cwd);
    const verification = detectCodingVerificationCommand(this.ctx.cwd, this.ctx.verifyCommand, changedFiles) ??
      "No verification command detected";
    const checks = [
      ["Project root", root],
      ["Session", this.state.sessionId],
      ["Mode", this.state.mode],
      ["Git repository", gitRepo ? "yes" : "no"],
      ["Changed files", changedFiles.length ? changedFiles.join(", ") : "none"],
      ["Project type", this.state.repo?.projectType.join(", ") ?? "unknown"],
      ["Package manager", this.state.repo?.packageManager ?? "unknown"],
      ["Verification", verification],
      ["Instruction files", this.state.instructions.length ? this.state.instructions.map((item) => item.label).join(", ") : "none"],
      ["Settings sources", this.state.settings.sources.length ? this.state.settings.sources.join(", ") : "none"],
      ["Custom commands", this.state.commands.length ? this.state.commands.map((item) => `/${item.id}`).join(", ") : "none"],
      ["Custom agents", this.state.agents.length ? this.state.agents.map((item) => item.id).join(", ") : "none"],
      ["Skills", `${this.state.selectedSkills.length}/${this.state.skills.length} selected`],
      ["Output style", this.state.activeOutputStyle?.id ?? "default"],
      ["API keys", Object.entries(keys).filter(([, value]) => value).map(([key]) => key).join(", ") || "none"],
    ];
    const issues: string[] = [];
    if (!this.state.instructions.some((item) => item.label.endsWith("SERVUS.md"))) {
      issues.push("No SERVUS.md or .servus/SERVUS.md loaded. Run /init or add project instructions.");
    }
    if (!this.state.settings.sources.length) {
      issues.push("No .servus/settings.json or ~/.servus/settings.json loaded. Run /init to create a project settings file.");
    }
    if (!Object.values(keys).some(Boolean)) {
      issues.push("No provider API key detected in the current environment.");
    }
    if (verification.startsWith("echo ")) {
      issues.push("No project verification command was detected. Add a script or pass --verify.");
    }
    return [
      "Servus coding doctor:",
      "",
      ...checks.map(([label, value]) => `- ${label}: ${value}`),
      "",
      issues.length ? "Issues:" : "Issues: none detected",
      ...issues.map((issue) => `- ${issue}`),
    ].join("\n");
  }

  permissionDecision(
    toolName: string,
    input: unknown,
  ): { behavior: CodingPermissionBehavior; rule?: ServusCodingPermissionRule } {
    const rule = decideCodingPermission(this.state.settings, toolName, input);
    if (rule) return { behavior: rule.behavior, rule };
    return { behavior: "ask" };
  }

  matchingHooks(event: CodingHookEvent, toolName?: string, input?: unknown): number {
    return findMatchingHooks(this.state.settings, event, toolName, input).length;
  }

  async runHooks(event: CodingHookEvent, input: CodingHookInput): Promise<CodingHookRunResult[]> {
    const results = await runCodingHooks(this.state.settings, event, input);
    for (const result of results) {
      this.recordEvent("coding:hook", `${event} hook ${result.ok ? "passed" : "failed"}`, {
        source: result.source,
        type: result.hook.type,
        command: result.hook.command,
        url: result.hook.url,
        ok: result.ok,
        blocked: result.blocked,
        durationMs: result.durationMs,
        output: result.output,
      });
      if (result.output.trim()) {
        this.addEvidence({
          type: `coding_hook_${event}`,
          source: result.hook.command ?? result.hook.url ?? event,
          summary: `${event} hook ${result.ok ? "passed" : "failed"}.`,
          data: result,
          confidence: result.ok ? "medium" : "low",
        });
      }
    }
    if (results.length > 0) this.persist();
    return results;
  }

  initializeProjectFiles(): { ok: boolean; summary: string; artifacts: string[] } {
    const rootServus = join(this.ctx.cwd, "SERVUS.md");
    const servusDir = join(this.ctx.cwd, ".servus");
    const nestedServus = join(servusDir, "SERVUS.md");
    const settingsPath = join(servusDir, "settings.json");
    const commandsDir = join(servusDir, "commands");
    const agentsDir = join(servusDir, "agents");
    const skillsDir = join(servusDir, "skills");
    const outputStylesDir = join(servusDir, "output-styles");
    const artifacts: string[] = [];
    const skipped: string[] = [];

    try {
      mkdirSync(servusDir, { recursive: true });
      mkdirSync(commandsDir, { recursive: true });
      mkdirSync(agentsDir, { recursive: true });
      mkdirSync(skillsDir, { recursive: true });
      mkdirSync(outputStylesDir, { recursive: true });
      artifacts.push(commandsDir, agentsDir, skillsDir, outputStylesDir);

      if (!existsSync(rootServus)) {
        writeFileSync(rootServus, servusProjectTemplate(this.ctx.cwd), "utf-8");
        artifacts.push(rootServus);
      } else {
        skipped.push(rootServus);
      }

      if (!existsSync(nestedServus)) {
        writeFileSync(nestedServus, servusLocalProjectTemplate(), "utf-8");
        artifacts.push(nestedServus);
      } else {
        skipped.push(nestedServus);
      }

      if (!existsSync(settingsPath)) {
        writeFileSync(settingsPath, JSON.stringify(servusSettingsTemplate(), null, 2) + "\n", "utf-8");
        artifacts.push(settingsPath);
      } else {
        skipped.push(settingsPath);
      }

      this.state.instructions = loadCodingInstructions(this.state.targetCwd);
      this.state.commands = loadCustomCodingCommands(this.ctx.cwd);
      this.state.agents = loadCodingAgents(this.ctx.cwd);
      this.state.settings = loadCodingSettings(this.ctx.cwd);
      this.state.skills = loadSkills({ cwd: this.ctx.cwd });
      this.state.selectedSkills = selectSkillsForTask(this.state.task, this.state.skills, 6);
      this.state.outputStyles = loadCodingOutputStyles(this.ctx.cwd);
      const summary = [
        "Initialized Servus coding project files.",
        artifacts.length ? `Created/confirmed: ${artifacts.join(", ")}` : undefined,
        skipped.length ? `Skipped existing files: ${skipped.join(", ")}` : undefined,
        "",
        "Next steps:",
        "- Put durable project rules in SERVUS.md.",
        "- Tune tool permissions and hooks in .servus/settings.json.",
        "- Add reusable prompts in .servus/commands/*.md.",
        "- Add focused read-only helper agents in .servus/agents/*.md.",
        "- Add reusable coding skills in .servus/skills/<name>/SKILL.md.",
        "- Add response style prompts in .servus/output-styles/*.md.",
      ].filter(Boolean).join("\n");
      this.recordEvent("coding:memory", "Servus project files initialized", {
        artifacts,
        skipped,
      });
      this.addEvidence({
        type: "coding_project_init",
        source: "servus_init",
        summary: "Initialized Servus project coding files.",
        data: { artifacts, skipped },
        confidence: "high",
      });
      this.persist();
      return { ok: true, summary, artifacts };
    } catch (err: unknown) {
      return {
        ok: false,
        summary: `Failed to initialize Servus project files: ${err instanceof Error ? err.message : String(err)}`,
        artifacts,
      };
    }
  }

  rememberInstruction(instruction: string): { ok: boolean; summary: string; artifacts: string[] } {
    const text = instruction.trim();
    if (!text) {
      return {
        ok: false,
        summary: "No instruction text provided. Usage: /remember <project instruction>",
        artifacts: [],
      };
    }

    const targetRoot = findServusProjectRoot(this.state.targetCwd);
    const dir = join(targetRoot, ".servus");
    const path = join(dir, "instructions.md");
    const saved: string[] = [];
    const failures: string[] = [];

    try {
      mkdirSync(dir, { recursive: true });
      const prefix = existsSync(path) ? "\n\n" : "# Servus Project Instructions\n\n";
      appendFileSync(path, `${prefix}## ${new Date().toISOString()}\n${text}\n`, "utf-8");
      saved.push(path);
    } catch (err: unknown) {
      failures.push(`repo-local memory: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (loadConfig().memory?.enabled !== false) {
      try {
        const memory = rememberProjectMemoryFact({
          cwd: this.state.targetCwd,
          sessionId: this.state.sessionId,
          text,
          category: "workflow",
          source: "/remember",
          reason: "User explicitly saved this project instruction for future Servus coding runs.",
          confidence: "high",
        });
        if (memory.updated) {
          saved.push(memory.memoryPath);
        } else {
          failures.push("project session memory: instruction was saved locally but not promoted because it looked too vague, transient, secret-like, or memory is disabled");
        }
      } catch (err: unknown) {
        failures.push(`project session memory: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (saved.length > 0) {
      this.recordEvent("coding:memory", "Project coding memory updated", {
        paths: saved,
        failures,
        instruction: text,
      });
      this.addEvidence({
        type: "coding_memory",
        source: saved[0]!,
        summary: "Saved durable project coding instruction.",
        data: { instruction: text, paths: saved, failures },
        confidence: "high",
      });
      this.state.instructions = loadCodingInstructions(this.ctx.cwd);
      this.persist();
      return {
        ok: true,
        summary: [
          `Saved project instruction to ${saved.join(" and ")}.`,
          "Future coding runs will load it automatically.",
          failures.length ? `Non-blocking memory warning: ${failures.join("; ")}` : "",
        ].filter(Boolean).join(" "),
        artifacts: saved,
      };
    }
    return {
      ok: false,
      summary: `Failed to save project instruction: ${failures.join("; ") || "unknown write error"}`,
      artifacts: [],
    };
  }

  buildMemorySummary(): string {
    if (loadConfig().memory?.enabled === false) {
      return [
        "Project memory is disabled in Servus config (memory.enabled=false).",
        "Repo-local instructions such as SERVUS.md and .servus/instructions.md can still be used.",
      ].join("\n");
    }
    const projectMemoryDir = getProjectMemoryDir(this.ctx.cwd);
    if (this.state.instructions.length === 0) {
      return [
        "No coding instruction files are currently loaded.",
        "Use /remember <instruction> to save a project instruction in .servus/instructions.md.",
        `Servus also learns durable project memory after successful coding runs in ${projectMemoryDir}.`,
      ].join("\n");
    }
    return [
      `Loaded ${this.state.instructions.length} coding instruction file(s):`,
      `Project memory dir: ${projectMemoryDir}`,
      "",
      ...this.state.instructions.map((source) => [
        `## ${source.label} (${source.scope})${source.truncated ? " [truncated]" : ""}`,
        truncate(source.content, 1800),
      ].join("\n")),
    ].join("\n\n");
  }

  async buildFilesSummary(): Promise<string> {
    const readFiles = listCodingReadStateFiles(this.ctx.sessionId, this.ctx.cwd);
    const changedFiles = (await gitChangedFiles(this.ctx.cwd))
      .filter((file) => !this.state.baselineChangedFiles.includes(file));
    const attached = this.state.attachments.map((attachment) => ({
      path: mentionDisplayName(attachment.path),
      kind: attachment.kind,
      requested: attachment.requested,
    }));
    return [
      "Servus coding files in context:",
      "",
      "Mentioned/attached:",
      ...(attached.length
        ? attached.map((item) => `- ${item.path} (${item.kind}; requested as ${item.requested})`)
        : ["- none"]),
      "",
      "Read this session:",
      ...(readFiles.length
        ? readFiles.slice(0, 80).map((file) => [
          `- ${file.path}`,
          `  agent: ${file.agent}`,
          file.size !== undefined ? `  size: ${file.size} bytes` : undefined,
          file.partial ? "  partial: yes" : undefined,
          file.timestamp ? `  read: ${new Date(file.timestamp).toISOString()}` : undefined,
        ].filter(Boolean).join("\n"))
        : ["- none"]),
      readFiles.length > 80 ? `... ${readFiles.length - 80} more read files omitted` : undefined,
      "",
      "Changed by this Servus session:",
      ...(changedFiles.length ? changedFiles.map((file) => `- ${file}`) : ["- none"]),
      "",
      "Servus-owned/generated folders remain hidden unless explicitly requested.",
    ].filter(Boolean).join("\n");
  }

  private currentCodingAgents(): CodingAgentDefinition[] {
    if (this.state.agents.length > 0) return this.state.agents;
    return loadCodingAgents(this.ctx.cwd);
  }

  private currentCustomCommands(): CustomCodingCommand[] {
    if (this.state.commands.length > 0) return this.state.commands;
    return loadCustomCodingCommands(this.ctx.cwd);
  }

  private buildSelectedSkillsPrompt(): string {
    if (this.state.selectedSkills.length === 0) return "";
    const prompt = buildSkillsPrompt(this.state.selectedSkills, 24_000);
    if (!prompt) return "";
    return [
      "# Selected Servus Skills",
      "Use these local skills when they directly apply to the current coding task. Respect each skill's allowed tools and constraints.",
      "",
      prompt,
    ].join("\n");
  }

  private buildOutputStylePrompt(): string {
    if (!this.state.activeOutputStyle) return "";
    return [
      "# Active Servus Output Style",
      `Name: ${this.state.activeOutputStyle.name}`,
      `Description: ${this.state.activeOutputStyle.description}`,
      "",
      this.state.activeOutputStyle.prompt,
    ].join("\n");
  }

  async buildDiffSummary(target = "latest"): Promise<{ summary: string; artifacts: string[] }> {
    const normalized = target.trim() || "latest";
    if (normalized === "current" || normalized === "working-tree") {
      const files = (await gitChangedFiles(this.ctx.cwd))
        .filter((file) => !this.state.baselineChangedFiles.includes(file));
      const diff = await gitDiff(this.ctx.cwd, files);
      return {
        summary: diff.trim()
          ? [`Current Servus working-tree diff (${files.length} file${files.length === 1 ? "" : "s"}):`, "", clamp(diff)].join("\n")
          : "No current Servus-owned working-tree diff was found.",
        artifacts: [],
      };
    }

    const checkpoint = this.findCheckpoint(normalized);
    if (!checkpoint) {
      return {
        summary: `No checkpoint found for "${normalized}". Available checkpoints: ${checkpointLabels(this.state.checkpoints)}`,
        artifacts: [],
      };
    }
    const diffText = checkpoint.diffArtifact && existsSync(checkpoint.diffArtifact)
      ? readFileSync(checkpoint.diffArtifact, "utf-8")
      : "";
    const summary = [
      `Checkpoint ${checkpoint.id}`,
      `Created: ${new Date(checkpoint.createdAt).toISOString()}`,
      `Files: ${checkpoint.changedFiles.length ? checkpoint.changedFiles.join(", ") : "none"}`,
      checkpoint.revertedAt ? `Reverted: ${new Date(checkpoint.revertedAt).toISOString()}` : undefined,
      checkpoint.snapshotArtifact ? `Snapshot: ${checkpoint.snapshotArtifact}` : undefined,
      checkpoint.diffSummary ? `\nSummary:\n${checkpoint.diffSummary}` : undefined,
      diffText ? `\nDiff:\n${clamp(diffText)}` : "\nNo diff artifact is available for this checkpoint.",
    ].filter(Boolean).join("\n");
    return {
      summary,
      artifacts: [checkpoint.diffArtifact, checkpoint.snapshotArtifact].filter(Boolean) as string[],
    };
  }

  async revertCheckpoint(target = "latest"): Promise<{ ok: boolean; summary: string; artifacts: string[] }> {
    const checkpoint = this.findCheckpoint(target.trim() || "latest");
    if (!checkpoint) {
      return {
        ok: false,
        summary: `No checkpoint found for "${target || "latest"}". Available checkpoints: ${checkpointLabels(this.state.checkpoints)}`,
        artifacts: [],
      };
    }
    if (checkpoint.revertedAt) {
      return {
        ok: false,
        summary: `Checkpoint ${checkpoint.id} was already reverted at ${new Date(checkpoint.revertedAt).toISOString()}.`,
        artifacts: checkpoint.diffArtifact ? [checkpoint.diffArtifact] : [],
      };
    }
    if (!checkpoint.diffArtifact || !existsSync(checkpoint.diffArtifact)) {
      return this.restoreCheckpointSnapshot(checkpoint, "No tracked-file diff artifact is available.");
    }

    const check = await runGit(this.ctx.cwd, ["apply", "--reverse", "--check", checkpoint.diffArtifact]);
    if (!check.ok) {
      if (checkpoint.snapshotArtifact) {
        return this.restoreCheckpointSnapshot(
          checkpoint,
          [
            "Git reverse-apply check failed; using Servus pre-mutation snapshot instead.",
            truncate(check.stderr || check.stdout || "git apply --reverse --check failed", 1200),
          ].join("\n"),
        );
      }
      return {
        ok: false,
        summary: [
          `Checkpoint ${checkpoint.id} cannot be reverted cleanly.`,
          "The files may have changed since the checkpoint, or the checkpoint contains unsupported changes.",
          "",
          truncate(check.stderr || check.stdout || "git apply --reverse --check failed", 4000),
        ].join("\n"),
        artifacts: [checkpoint.diffArtifact],
      };
    }

    const applied = await runGit(this.ctx.cwd, ["apply", "--reverse", checkpoint.diffArtifact]);
    if (!applied.ok) {
      return {
        ok: false,
        summary: `Failed to revert checkpoint ${checkpoint.id}:\n${truncate(applied.stderr || applied.stdout, 4000)}`,
        artifacts: [checkpoint.diffArtifact],
      };
    }

    checkpoint.revertedAt = Date.now();
    checkpoint.revertable = false;
    this.recordEvent("coding:revert", `Reverted checkpoint ${checkpoint.id}`, {
      checkpointId: checkpoint.id,
      changedFiles: checkpoint.changedFiles,
      diffArtifact: checkpoint.diffArtifact,
    });
    this.addEvidence({
      type: "coding_revert",
      source: checkpoint.id,
      summary: `Reverted checkpoint ${checkpoint.id}.`,
      data: checkpoint,
      confidence: "high",
    });
    this.persist();
    return {
      ok: true,
      summary: [
        `Reverted checkpoint ${checkpoint.id}.`,
        checkpoint.changedFiles.length ? `Files: ${checkpoint.changedFiles.join(", ")}` : "Files: none",
      ].join("\n"),
      artifacts: [checkpoint.diffArtifact],
    };
  }

  private restoreCheckpointSnapshot(
    checkpoint: CodingCheckpoint,
    reason: string,
  ): { ok: boolean; summary: string; artifacts: string[] } {
    if (!checkpoint.snapshotArtifact || !existsSync(checkpoint.snapshotArtifact)) {
      return {
        ok: false,
        summary: [
          `Checkpoint ${checkpoint.id} cannot be reverted.`,
          reason,
          "No Servus pre-mutation snapshot artifact is available.",
        ].join("\n"),
        artifacts: checkpoint.diffArtifact ? [checkpoint.diffArtifact] : [],
      };
    }
    const snapshot = readCheckpointSnapshot(checkpoint.snapshotArtifact);
    if (!snapshot || snapshot.files.length === 0) {
      return {
        ok: false,
        summary: `Checkpoint ${checkpoint.id} has an unreadable or empty snapshot artifact.`,
        artifacts: [checkpoint.snapshotArtifact],
      };
    }
    try {
      for (const file of snapshot.files) {
        const abs = resolve(this.ctx.cwd, file.path);
        const rel = relative(this.ctx.cwd, abs);
        if (!rel || rel.startsWith("..") || rel.split(/[\\/]/).includes("..")) {
          return {
            ok: false,
            summary: `Snapshot restore refused path outside workspace: ${file.path}`,
            artifacts: [checkpoint.snapshotArtifact],
          };
        }
        if (file.existed) {
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, file.content ?? "", "utf-8");
        } else if (existsSync(abs)) {
          rmSync(abs, { force: true });
        }
      }
    } catch (err: unknown) {
      return {
        ok: false,
        summary: `Failed to restore checkpoint ${checkpoint.id} from snapshot: ${err instanceof Error ? err.message : String(err)}`,
        artifacts: [checkpoint.snapshotArtifact],
      };
    }

    checkpoint.revertedAt = Date.now();
    checkpoint.revertable = false;
    this.recordEvent("coding:revert", `Restored checkpoint ${checkpoint.id} from snapshot`, {
      checkpointId: checkpoint.id,
      changedFiles: checkpoint.changedFiles,
      snapshotArtifact: checkpoint.snapshotArtifact,
      reason,
    });
    this.addEvidence({
      type: "coding_revert",
      source: checkpoint.id,
      summary: `Restored checkpoint ${checkpoint.id} from Servus snapshot.`,
      data: checkpoint,
      confidence: "high",
    });
    this.persist();
    return {
      ok: true,
      summary: [
        `Restored checkpoint ${checkpoint.id} from Servus snapshot.`,
        reason,
        checkpoint.changedFiles.length ? `Files: ${checkpoint.changedFiles.join(", ")}` : "Files: none",
      ].join("\n"),
      artifacts: [checkpoint.snapshotArtifact],
    };
  }

  private findCheckpoint(target: string): CodingCheckpoint | undefined {
    const active = this.state.checkpoints.filter((checkpoint) => checkpoint.changedFiles.length > 0);
    if (active.length === 0) return undefined;
    if (target === "latest" || target === "last") {
      return [...active].reverse().find((checkpoint) => !checkpoint.revertedAt) ?? active.at(-1);
    }
    return active.find((checkpoint) => checkpoint.id === target || checkpoint.id.endsWith(target));
  }

  private hasPassingVerificationHelperVerdict(): boolean {
    return this.state.helperRuns.some(
      (run) => run.type === "verification" && run.status === "completed" && run.verdict === "pass",
    );
  }

  private latestVerificationHelperSummary(): string {
    const run = [...this.state.helperRuns]
      .reverse()
      .find((item) => item.type === "verification" && item.status === "completed");
    if (!run) return "";
    return [
      `Helper: ${run.id}`,
      `Verdict: ${run.verdict ?? "missing"}`,
      "",
      truncate(run.summary, 3000),
    ].join("\n");
  }

  private findHelperRun(id: string): CodingHelperRun | undefined {
    return [...this.state.helperRuns]
      .reverse()
      .find((run) => run.id === id || run.id.endsWith(id) || run.requestId === id || run.requestId?.endsWith(id));
  }
}

function toRuntimePhase(phase: CodingPhase): "orienting" | "discovering" | "planning" | "acting" | "verifying" | "waiting_input" | "completed" | "failed" {
  if (phase === "editing" || phase === "repairing" || phase === "reviewing") return "acting";
  return phase;
}

function loadPersistedCodingState(sessionDir: string | undefined, cwd: string): CodingRunState | undefined {
  if (!sessionDir) return undefined;
  const path = join(sessionDir, "state.json");
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<CodingRunState>;
    if (parsed.cwd !== cwd) return undefined;
    return {
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : "unknown",
      mode: isCodingMode(parsed.mode) ? parsed.mode : "build",
      cwd,
      launchCwd: typeof parsed.launchCwd === "string" ? parsed.launchCwd : cwd,
      targetCwd: typeof parsed.targetCwd === "string" ? parsed.targetCwd : cwd,
      task: typeof parsed.task === "string" ? parsed.task : "",
      phase: isCodingPhase(parsed.phase) ? parsed.phase : "orienting",
      plan: isCodingPlan(parsed.plan) ? parsed.plan : createInitialPlan("", "build"),
      checkpoints: Array.isArray(parsed.checkpoints) ? parsed.checkpoints.filter(isCodingCheckpoint) : [],
      verificationAttempts: Array.isArray(parsed.verificationAttempts) ? parsed.verificationAttempts.filter(isVerificationAttempt) : [],
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence as EvidenceItem[] : [],
      artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts.filter((item): item is string => typeof item === "string") : [],
      workspacePolicy: createCodingWorkspacePolicy(cwd),
      instructions: Array.isArray(parsed.instructions) ? parsed.instructions.filter(isInstructionSource) : [],
      agents: Array.isArray(parsed.agents) ? parsed.agents.filter(isCodingAgentDefinition) : [],
      commands: Array.isArray(parsed.commands) ? parsed.commands.filter(isCustomCodingCommand) : [],
      settings: loadCodingSettings(cwd),
      skills: Array.isArray(parsed.skills) ? parsed.skills as SkillManifest[] : [],
      selectedSkills: Array.isArray(parsed.selectedSkills) ? parsed.selectedSkills as SkillManifest[] : [],
      outputStyles: Array.isArray(parsed.outputStyles) ? parsed.outputStyles as CodingOutputStyle[] : [],
      ...(parsed.activeOutputStyle ? { activeOutputStyle: parsed.activeOutputStyle as CodingOutputStyle } : {}),
      attachments: Array.isArray(parsed.attachments) ? parsed.attachments as CodingContextAttachment[] : [],
      ...(isCodingIntentContract(parsed.intentContract) ? { intentContract: parsed.intentContract } : {}),
      todos: Array.isArray(parsed.todos) ? parsed.todos.filter(isCodingTodo) : [],
      planApproval: isCodingPlanApproval(parsed.planApproval) ? parsed.planApproval : createPlanApproval(typeof parsed.task === "string" ? parsed.task : "", "build"),
      helperRuns: Array.isArray(parsed.helperRuns) ? parsed.helperRuns.filter(isCodingHelperRun) : [],
      pendingHelperRequests: Array.isArray(parsed.pendingHelperRequests) ? parsed.pendingHelperRequests.filter(isCodingHelperRequest) : [],
      ...(typeof parsed.scratchpadDir === "string" ? { scratchpadDir: parsed.scratchpadDir } : {}),
      baselineChangedFiles: Array.isArray(parsed.baselineChangedFiles) ? parsed.baselineChangedFiles.filter((item): item is string => typeof item === "string") : [],
      cost: typeof parsed.cost === "number" ? parsed.cost : 0,
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now(),
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
      ...(normalizeRepoContext(parsed.repo) ? { repo: normalizeRepoContext(parsed.repo) } : {}),
      preloadedSessions: Array.isArray(parsed.preloadedSessions)
        ? parsed.preloadedSessions.filter(isPreloadedSession)
        : [],
    };
  } catch {
    return undefined;
  }
}

function preloadProjectSessions(cwd: string, task: string, currentSessionId: string): CodingRunState["preloadedSessions"] {
  const terms = task.toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((term) => term.length >= 4)
    .slice(0, 24);
  return listProjectSessions(cwd)
    .filter((session) => session.id !== currentSessionId)
    .map((session) => {
      const haystack = [
        session.task,
        session.domain,
        session.status,
        session.runtimeStatus,
        session.model,
        session.backend,
      ].filter(Boolean).join("\n").toLowerCase();
      const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
      return { session, score };
    })
    .sort((a, b) => b.score - a.score || b.session.startTime - a.session.startTime)
    .slice(0, 6)
    .map(({ session }) => ({
      id: session.id,
      task: session.task,
      status: session.status,
      ...(session.domain ? { domain: String(session.domain) } : {}),
      startTime: session.startTime,
      ...(session.proofDir ? { proofDir: session.proofDir } : {}),
    }));
}

function isPreloadedSession(value: unknown): value is CodingRunState["preloadedSessions"][number] {
  return typeof value === "object" && value !== null &&
    typeof (value as CodingRunState["preloadedSessions"][number]).id === "string" &&
    typeof (value as CodingRunState["preloadedSessions"][number]).task === "string" &&
    typeof (value as CodingRunState["preloadedSessions"][number]).status === "string" &&
    typeof (value as CodingRunState["preloadedSessions"][number]).startTime === "number";
}

function primaryAgentNameForMode(mode: CodingMode): string {
  if (mode === "build") return "Build";
  if (mode === "coordinate") return "Coordinator";
  if (mode === "review") return "Review";
  if (mode === "explore") return "Explore";
  return "Plan";
}

function isCodingMode(value: unknown): value is CodingMode {
  return value === "build" || value === "plan" || value === "review" || value === "explore" || value === "coordinate";
}

function isCodingPhase(value: unknown): value is CodingPhase {
  return value === "orienting" ||
    value === "discovering" ||
    value === "planning" ||
    value === "editing" ||
    value === "verifying" ||
    value === "repairing" ||
    value === "reviewing" ||
    value === "waiting_input" ||
    value === "completed" ||
    value === "failed";
}

function isCodingPlan(value: unknown): value is CodingPlan {
  return typeof value === "object" && value !== null &&
    typeof (value as CodingPlan).goal === "string" &&
    Array.isArray((value as CodingPlan).tasks);
}

function isCodingCheckpoint(value: unknown): value is CodingCheckpoint {
  return typeof value === "object" && value !== null &&
    typeof (value as CodingCheckpoint).id === "string" &&
    Array.isArray((value as CodingCheckpoint).changedFiles);
}

function isVerificationAttempt(value: unknown): value is VerificationAttempt {
  return typeof value === "object" && value !== null &&
    typeof (value as VerificationAttempt).id === "string" &&
    typeof (value as VerificationAttempt).command === "string";
}

function isInstructionSource(value: unknown): value is CodingInstructionSource {
  return typeof value === "object" && value !== null &&
    typeof (value as CodingInstructionSource).label === "string" &&
    typeof (value as CodingInstructionSource).content === "string";
}

function isCodingAgentDefinition(value: unknown): value is CodingAgentDefinition {
  return typeof value === "object" && value !== null &&
    typeof (value as CodingAgentDefinition).id === "string" &&
    typeof (value as CodingAgentDefinition).description === "string" &&
    typeof (value as CodingAgentDefinition).prompt === "string";
}

function isCustomCodingCommand(value: unknown): value is CustomCodingCommand {
  return typeof value === "object" && value !== null &&
    typeof (value as CustomCodingCommand).id === "string" &&
    typeof (value as CustomCodingCommand).description === "string" &&
    typeof (value as CustomCodingCommand).prompt === "string";
}

function isCodingIntentContract(value: unknown): value is CodingIntentContract {
  return typeof value === "object" && value !== null &&
    typeof (value as CodingIntentContract).id === "string" &&
    typeof (value as CodingIntentContract).goal === "string" &&
    typeof (value as CodingIntentContract).interpretation === "string" &&
    Array.isArray((value as CodingIntentContract).evidence) &&
    Array.isArray((value as CodingIntentContract).assumptions) &&
    Array.isArray((value as CodingIntentContract).acceptanceCriteria);
}

function isCodingTodo(value: unknown): value is CodingTodo {
  return typeof value === "object" && value !== null &&
    typeof (value as CodingTodo).id === "string" &&
    typeof (value as CodingTodo).content === "string" &&
    typeof (value as CodingTodo).activeForm === "string" &&
    Array.isArray((value as CodingTodo).evidence);
}

function isCodingPlanApproval(value: unknown): value is CodingPlanApproval {
  return typeof value === "object" && value !== null &&
    typeof (value as CodingPlanApproval).required === "boolean" &&
    typeof (value as CodingPlanApproval).status === "string" &&
    typeof (value as CodingPlanApproval).reason === "string";
}

function isCodingHelperRun(value: unknown): value is CodingHelperRun {
  return typeof value === "object" && value !== null &&
    typeof (value as CodingHelperRun).id === "string" &&
    typeof (value as CodingHelperRun).type === "string" &&
    typeof (value as CodingHelperRun).status === "string";
}

function isCodingHelperRequest(value: unknown): value is CodingHelperRequest {
  return typeof value === "object" && value !== null &&
    typeof (value as CodingHelperRequest).id === "string" &&
    typeof (value as CodingHelperRequest).type === "string" &&
    typeof (value as CodingHelperRequest).description === "string" &&
    typeof (value as CodingHelperRequest).prompt === "string";
}

function parseVerificationHelperVerdict(summary: string): CodingHelperRun["verdict"] {
  const match = summary.match(/VERDICT:\s*(PASS|FAIL|PARTIAL)\b/i);
  if (!match?.[1]) return undefined;
  const value = match[1].toLowerCase();
  if (value === "pass" || value === "fail" || value === "partial") return value;
  return undefined;
}

function checkpointLabels(checkpoints: CodingCheckpoint[]): string {
  const labels = checkpoints
    .filter((checkpoint) => checkpoint.changedFiles.length > 0)
    .map((checkpoint) => checkpoint.id)
    .slice(-8);
  return labels.length ? labels.join(", ") : "none";
}

interface PreMutationSnapshot {
  id: string;
  timestamp: number;
  operation: string;
  path: string;
  existed: boolean;
  content?: string;
}

interface CheckpointSnapshot {
  version: number;
  cwd: string;
  createdAt: number;
  files: PreMutationSnapshot[];
}

function readPreMutationSnapshots(path: string): PreMutationSnapshot[] {
  try {
    return readFileSync(path, "utf-8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Partial<PreMutationSnapshot>)
      .filter(isPreMutationSnapshot);
  } catch {
    return [];
  }
}

function readCheckpointSnapshot(path: string): CheckpointSnapshot | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<CheckpointSnapshot>;
    if (!Array.isArray(parsed.files)) return undefined;
    return {
      version: typeof parsed.version === "number" ? parsed.version : 1,
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : "",
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : 0,
      files: parsed.files.filter(isPreMutationSnapshot),
    };
  } catch {
    return undefined;
  }
}

function isPreMutationSnapshot(value: Partial<PreMutationSnapshot>): value is PreMutationSnapshot {
  return typeof value.id === "string" &&
    typeof value.timestamp === "number" &&
    typeof value.operation === "string" &&
    typeof value.path === "string" &&
    typeof value.existed === "boolean" &&
    (value.content === undefined || typeof value.content === "string");
}

function servusProjectTemplate(cwd: string): string {
  return [
    "# SERVUS.md",
    "",
    "Project instructions for Servus Coding Agent.",
    "",
    "## Project Overview",
    `- Root: ${cwd}`,
    "- Describe what this project does and the boundaries Servus should respect.",
    "",
    "## Coding Rules",
    "- Preserve existing architecture and conventions.",
    "- Keep changes focused on the user's request.",
    "- Do not overwrite unrelated user work.",
    "- Verify meaningful code changes before marking work complete.",
    "",
    "## Verification",
    "- Add the preferred test, lint, typecheck, or build commands here.",
    "",
  ].join("\n");
}

function servusLocalProjectTemplate(): string {
  return [
    "# .servus/SERVUS.md",
    "",
    "Local Servus project notes. This file is loaded with SERVUS.md and can contain machine-local guidance.",
    "",
    "## Local Notes",
    "- Add project-specific paths, commands, or constraints here.",
    "",
  ].join("\n");
}

function servusSettingsTemplate(): Record<string, unknown> {
  return {
    outputStyle: "default",
    permissions: {
      allow: [
        "Read(*)",
        "Grep(*)",
        "Glob(*)",
        "LS(*)",
        "workspace_status(*)",
        "git_diff(*)",
      ],
      ask: [
        "Bash(npm install*)",
        "Bash(pnpm add*)",
        "Bash(yarn add*)",
        "Write(*)",
        "Edit(*)",
        "MultiEdit(*)",
      ],
      deny: [
        "Bash(rm -rf*)",
        "Bash(git reset --hard*)",
      ],
    },
    hooks: {
      PreToolUse: [],
      PostToolUse: [],
      Stop: [],
    },
  };
}

function createIntentContract(
  task: string,
  mode: CodingMode,
  repo: RepoContextIndex,
  instructions: CodingInstructionSource[],
  previous?: CodingIntentContract,
): CodingIntentContract {
  if (isContinuation(task) && previous) {
    return {
      ...previous,
      id: previous.id,
      goal: task,
      constraints: [...new Set([...previous.constraints, "Continue in the same session and preserve previous decisions."])],
      requiresQuestion: false,
      ambiguity: previous.ambiguity === "material" ? "low" : previous.ambiguity,
      confidence: previous.confidence === "low" ? "medium" : previous.confidence,
      evidence: [...new Set([...previous.evidence, "User provided a same-session continuation answer."])],
      assumptions: [...new Set([...previous.assumptions, "Use the latest user message as clarification for the existing coding intent."])],
      editsAllowed: previous.kind === "change",
      interpretation: previous.requiresQuestion
        ? "Continue using the user's clarification answer in this same session."
        : previous.interpretation,
    };
  }

  const kind: CodingTaskKind = mode === "build" || mode === "coordinate"
    ? taskRequiresCodeMutation(task)
      ? "change"
      : taskIsVerificationRequest(task)
        ? "verification"
        : "analysis"
    : mode === "review" && taskIsVerificationRequest(task)
      ? "verification"
      : "analysis";
  const broad = isBroadTask(task);
  const alternatives = inferAlternatives(task, kind);
  const targetScope = inferTargetScope(task, repo);
  const evidence = intentEvidence(task, repo, targetScope);
  const assumptions = inferAssumptions(task, kind, targetScope, broad);
  const ambiguityAssessment = assessIntentAmbiguity(task, kind, targetScope, alternatives);
  const materialAmbiguity = ambiguityAssessment.requiresQuestion;
  const acceptanceCriteria = acceptanceCriteriaFor(task, kind, repo, materialAmbiguity);
  const risk = inferRisk(task, kind, targetScope);
  const constraints = [
    "Preserve unrelated user changes.",
    "Follow project instructions and existing patterns.",
    "Do not create repo-root servus-plan.json or init.sh.",
    kind === "analysis" ? "Do not modify files." : "Keep edits focused to the accepted scope.",
    instructions.length ? `Honor ${instructions.length} loaded instruction file(s).` : "",
  ].filter(Boolean);
  const question = materialAmbiguity
    ? buildAmbiguityQuestion(task, alternatives, kind, ambiguityAssessment.askReason)
    : undefined;

  return {
    id: `intent-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`,
    kind,
    goal: task.trim(),
    interpretation: materialAmbiguity
      ? "Intent is not locked yet; user clarification is required before edits."
      : inferInterpretation(task, kind, targetScope),
    alternatives,
    ambiguity: materialAmbiguity ? "material" : broad || alternatives.length > 1 ? "low" : "none",
    confidence: materialAmbiguity ? "low" : broad ? "medium" : "high",
    evidence,
    assumptions,
    acceptanceCriteria,
    constraints,
    targetScope,
    risk,
    editsAllowed: kind === "change" && !materialAmbiguity,
    requiresQuestion: materialAmbiguity,
    ...(ambiguityAssessment.askReason ? { askReason: ambiguityAssessment.askReason } : {}),
    ...(question ? { question } : {}),
  };
}

function createInitialTodos(intent: CodingIntentContract, verificationCommand: string): CodingTodo[] {
  if (!shouldRequireTodos(intent)) return [];
  if (intent.requiresQuestion) {
    return [
      {
        id: "todo-clarify-intent",
        content: "Clarify the intended coding scope before editing",
        activeForm: "Clarifying the intended coding scope",
        status: "in_progress",
        evidence: [],
        criteria: ["User answer resolves material ambiguity"],
      },
    ];
  }
  if (intent.kind === "analysis") {
    return [
      {
        id: "todo-inspect",
        content: "Inspect repository evidence relevant to the question",
        activeForm: "Inspecting repository evidence",
        status: "in_progress",
        evidence: [],
        criteria: intent.acceptanceCriteria,
      },
    ];
  }
  if (intent.kind === "verification") {
    return [
      {
        id: "todo-verify",
        content: `Run verification: ${verificationCommand}`,
        activeForm: "Running verification",
        status: "in_progress",
        evidence: [],
        criteria: intent.acceptanceCriteria,
      },
    ];
  }
  const todos: CodingTodo[] = [
    {
      id: "todo-discover",
      content: "Inspect relevant code and project conventions",
      activeForm: "Inspecting relevant code and conventions",
      status: "in_progress",
      evidence: [],
      criteria: ["Relevant files and patterns identified"],
    },
    {
      id: "todo-plan",
      content: "Lock implementation plan and scope",
      activeForm: "Locking implementation plan and scope",
      status: "pending",
      evidence: [],
      criteria: ["Intent contract and acceptance criteria are reflected in the plan"],
    },
    {
      id: "todo-edit",
      content: "Apply focused code changes",
      activeForm: "Applying focused code changes",
      status: "pending",
      evidence: [],
      criteria: intent.acceptanceCriteria,
    },
    {
      id: "todo-verify",
      content: `Run verification: ${verificationCommand}`,
      activeForm: "Running verification",
      status: "pending",
      evidence: [],
      criteria: ["Verification result recorded"],
    },
  ];
  return todos;
}

function createPlanApproval(task: string, mode: CodingMode, intent?: CodingIntentContract): CodingPlanApproval {
  const required = (mode === "build" || mode === "coordinate") && (
    intent?.risk === "high" ||
    isBroadTask(task) ||
    (intent?.targetScope.length ?? 0) > 3
  );
  return {
    required,
    status: required ? "pending" : "not_required",
    reason: required
      ? "Task is broad, risky, or multi-step enough to require an explicit plan checkpoint."
      : "Task is narrow enough to proceed after intent contract validation.",
  };
}

function todoToPlanTask(todo: CodingTodo): CodingTask {
  return {
    id: todo.id,
    title: todo.content,
    status: todo.status === "cancelled" ? "failed" : todo.status,
    targetFiles: [],
    evidence: todo.evidence,
  };
}

function normalizeTodos(todos: CodingTodo[]): CodingTodo[] {
  const cleaned = todos
    .filter((todo) => todo.content.trim())
    .slice(0, 20)
    .map((todo, index) => ({
      ...todo,
      id: todo.id.trim() || `todo-${index + 1}`,
      content: todo.content.trim(),
      activeForm: todo.activeForm.trim() || activeFormFor(todo.content),
      evidence: todo.evidence.filter((item) => item.trim()).slice(0, 12),
      criteria: todo.criteria.filter((item) => item.trim()).slice(0, 12),
    }));
  const inProgress = cleaned.filter((todo) => todo.status === "in_progress");
  if (cleaned.length > 0 && inProgress.length === 0 && cleaned.some((todo) => todo.status === "pending")) {
    const firstPending = cleaned.find((todo) => todo.status === "pending");
    if (firstPending) firstPending.status = "in_progress";
  }
  if (inProgress.length > 1) {
    let kept = false;
    for (const todo of cleaned) {
      if (todo.status !== "in_progress") continue;
      if (!kept) {
        kept = true;
      } else {
        todo.status = "pending";
      }
    }
  }
  return cleaned;
}

function validateTodos(todos: CodingTodo[], intent?: CodingIntentContract): string[] {
  const missing: string[] = [];
  if (!shouldRequireTodos(intent)) return [];
  if (!todos.length) return ["coding todo list"];
  const active = todos.filter((todo) => todo.status === "in_progress");
  const open = todos.filter((todo) => todo.status === "pending" || todo.status === "in_progress");
  if (open.length > 0) missing.push("all coding todos completed or cancelled");
  if (active.length > 1) missing.push("only one coding todo in progress");
  const completedWithoutEvidence = todos.filter((todo) => todo.status === "completed" && todo.evidence.length === 0);
  if (completedWithoutEvidence.length > 0) missing.push("completed todos include evidence");
  if (intent?.kind === "change" && todos.length < 3 && !intent.requiresQuestion) {
    missing.push("multi-step coding todos for implementation");
  }
  return missing;
}

function shouldRequireTodos(intent: CodingIntentContract | undefined): boolean {
  if (!intent) return true;
  if (intent.requiresQuestion) return true;
  if (intent.kind !== "change") return false;
  return intent.risk !== "low" ||
    intent.ambiguity !== "none" ||
    intent.targetScope.length > 1 ||
    intent.goal.split(/\s+/).length > 28 ||
    isBroadTask(intent.goal);
}

function isSameIntent(a: CodingIntentContract | undefined, b: CodingIntentContract | undefined): boolean {
  if (!a || !b) return false;
  return a.goal === b.goal && a.kind === b.kind && a.interpretation === b.interpretation;
}

function isContinuation(task: string): boolean {
  return /^same servus session continuation\b/i.test(task.trim()) ||
    /\banswers to servus clarification\b/i.test(task);
}

function assessIntentAmbiguity(
  task: string,
  kind: CodingTaskKind,
  targetScope: string[],
  alternatives: string[],
): { requiresQuestion: boolean; askReason?: string } {
  const text = task.toLowerCase().trim();
  if (isBarePronounTask(text)) {
    return {
      requiresQuestion: true,
      askReason: "The request uses an unresolved reference like 'it' or 'this' without enough coding context.",
    };
  }
  if (/\b(or|either)\b.+\b(or)\b/.test(text) && alternatives.length > 1) {
    return {
      requiresQuestion: true,
      askReason: "The request presents incompatible implementation choices.",
    };
  }
  if (kind === "change" && /\b(delete|remove|replace|rewrite)\b/.test(text) && targetScope.includes("to be discovered")) {
    return {
      requiresQuestion: true,
      askReason: "The requested destructive or broad rewrite target is not identified.",
    };
  }
  return { requiresQuestion: false };
}

function isBarePronounTask(text: string): boolean {
  return /^(fix|update|change|improve|polish|clean up|do)\s+(it|this|that|the thing)$/i.test(text) ||
    /^(fix it|update it)$/i.test(text);
}

function isVagueTask(task: string): boolean {
  const text = task.toLowerCase().trim();
  return isBarePronounTask(text) ||
    /\b(do the needful)\b/.test(text);
}

function isBroadTask(task: string): boolean {
  const text = task.toLowerCase();
  return /\b(rebuild|rewrite|redesign|overhaul|make.*like|make.*better|just like|clone|full|complete|all kinds|everything|production ready|best|perfect)\b/.test(text) ||
    task.split(/\s+/).length > 80;
}

function inferAlternatives(task: string, kind: CodingTaskKind): string[] {
  const text = task.toLowerCase();
  const alternatives: string[] = [];
  if (/\bui|ux|frontend|screen|page|component|style|theme\b/.test(text)) alternatives.push("UI-only change");
  if (/\bbackend|runtime|engine|agent|tool|session|orchestrator\b/.test(text)) alternatives.push("backend/runtime behavior change");
  if (/\bfix|bug|error|crash|fail\b/.test(text)) alternatives.push("bug fix with minimal scope");
  if (/\bfeature|add|implement|support\b/.test(text)) alternatives.push("new feature implementation");
  if (/\brefactor|cleanup|architecture\b/.test(text)) alternatives.push("internal refactor without behavior change");
  if (kind === "analysis") alternatives.push("read-only analysis");
  return [...new Set(alternatives)].slice(0, 5);
}

function inferTargetScope(task: string, repo: RepoContextIndex): string[] {
  const scopes = new Set<string>();
  const quoted = task.match(/(?:src|frontend|test|tests|lib|app|packages|server|client)\/[\w./-]+/g) ?? [];
  for (const item of quoted) scopes.add(item);
  const fileNames = task.match(/\b[\w.-]+\.(?:tsx?|jsx?|css|scss|json|md|mjs|cjs)\b/g) ?? [];
  for (const fileName of fileNames) scopes.add(fileName);
  const cliLike = /\btui\b|\bcli\b|terminal UI|command palette|launchpad|live run/i.test(task);
  if (cliLike) scopes.add("src/cli");
  if (!cliLike && /\bfrontend|ui|ux|component|page|screen|style|css\b/i.test(task)) {
    if (repo.importantFiles.includes("frontend")) scopes.add("frontend");
    else scopes.add("UI/frontend files");
  }
  if (/\bbackend|runtime|agent|engine|tool|orchestrator|session\b/i.test(task)) scopes.add("src");
  if (/\breadme|docs|documentation\b/i.test(task)) scopes.add("README/docs");
  if (scopes.size === 0) scopes.add("to be discovered");
  return [...scopes].slice(0, 8);
}

function inferRisk(task: string, kind: CodingTaskKind, targetScope: string[]): CodingRisk {
  const text = task.toLowerCase();
  if (kind === "analysis") return "low";
  if (/\b(auth|payment|security|database|migration|delete|destructive|credentials|secret)\b/.test(text)) return "high";
  if (isBroadTask(task) || targetScope.length > 3) return "medium";
  return "low";
}

function acceptanceCriteriaFor(task: string, kind: CodingTaskKind, repo: RepoContextIndex, ambiguous: boolean): string[] {
  if (ambiguous) return ["User clarification resolves the intended scope before edits"];
  if (kind === "analysis") {
    if (isProjectSummaryTask(task)) {
      return [
        "Root documentation or README is inspected when present.",
        "Dependency manifests and scripts are inspected when present.",
        "Source layout and key entrypoints are inspected.",
        "Build/deploy/config files are considered when present.",
        "No files are modified.",
        "Uncertainty or missing evidence is called out.",
      ];
    }
    return [
      "Answer cites repository evidence.",
      "No files are modified.",
      "Uncertainty or missing evidence is called out.",
    ];
  }
  if (kind === "verification") {
    return ["Requested verification command is run.", "Exact pass/fail result and relevant output are reported."];
  }
  const criteria = [
    "Relevant existing code is inspected before editing.",
    "Implementation matches the locked intent and scope.",
    "Diff/checkpoint is reviewed before completion.",
    "Verification is run and passes, or failure is reported honestly.",
  ];
  if (Object.keys(repo.scripts).includes("typecheck")) criteria.push("Typecheck remains passing.");
  if (Object.keys(repo.scripts).includes("test")) criteria.push("Relevant tests remain passing.");
  return criteria;
}

function inferInterpretation(task: string, kind: CodingTaskKind, targetScope: string[]): string {
  if (kind === "analysis") return `Answer the coding question using repository evidence in ${targetScope.join(", ")}.`;
  if (kind === "verification") return "Run the requested verification and report exact results without unrelated edits.";
  return `Implement a focused code change for the requested behavior within ${targetScope.join(", ")}.`;
}

function isProjectSummaryTask(task: string): boolean {
  return /\b(project|repo|repository|codebase|app|application)\b.*\b(summari[sz]e|summary|overview|explain|architecture)\b/i.test(task) ||
    /\b(summari[sz]e|summary|overview|explain)\b.*\b(project|repo|repository|codebase|app|application)\b/i.test(task);
}

function intentEvidence(task: string, repo: RepoContextIndex, targetScope: string[]): string[] {
  return [
    `Task kind inferred from request: ${taskRequiresCodeMutation(task) ? "change" : "analysis/verification"}`,
    `Project type: ${repo.projectType.join(", ")}`,
    targetScope.length ? `Likely target scope: ${targetScope.join(", ")}` : "",
    repo.gitStatus.length ? `Workspace has ${repo.gitStatus.length} visible changed file(s).` : "Workspace has no visible non-generated changes.",
  ].filter(Boolean);
}

function inferAssumptions(
  task: string,
  kind: CodingTaskKind,
  targetScope: string[],
  broad: boolean,
): string[] {
  const assumptions: string[] = [];
  if (kind === "change") {
    assumptions.push("Implement the smallest complete change that satisfies the requested behavior.");
    assumptions.push("Preserve existing architecture and user-owned work unless the task explicitly requires changing it.");
  }
  if (broad) {
    assumptions.push("Handle broad requests incrementally: inspect, plan, implement the highest-impact stable slice, then verify.");
  }
  if (targetScope.includes("to be discovered")) {
    assumptions.push("Discover exact files with search/read tools before editing.");
  }
  if (/servus coding agent|coding agent|agent/i.test(task)) {
    assumptions.push("Prefer coding-runtime/tooling improvements over cosmetic changes unless evidence points elsewhere.");
  }
  return [...new Set(assumptions)];
}

function buildAmbiguityQuestion(task: string, alternatives: string[], kind: CodingTaskKind, askReason?: string): string {
  if (askReason?.includes("unresolved reference")) {
    return "What exact code behavior or file should Servus change?";
  }
  if (askReason?.includes("destructive")) {
    return "Which exact file, feature, or subsystem should Servus remove or rewrite?";
  }
  if (alternatives.length > 1) {
    return `Which interpretation should Servus implement: ${alternatives.join(", ")}?`;
  }
  if (kind === "change") {
    return "What exact behavior should Servus build or fix, and what should count as done?";
  }
  return "What should Servus focus on in this coding task?";
}

function activeFormFor(content: string): string {
  const cleaned = content.replace(/[.!?]+$/g, "");
  if (/ing\b/i.test(cleaned)) return cleaned;
  return `${cleaned.charAt(0).toUpperCase()}${cleaned.slice(1)}`;
}

function modeInstruction(mode: CodingMode): string {
  if (mode === "coordinate") {
    return "Current mode: coordinate. You may orchestrate focused workers with Task/SendMessage/TaskStop, use the scratchpad, synthesize results yourself, and edit only through evidence-backed worker or primary actions.";
  }
  if (mode === "plan") {
    return "Current mode: plan. This is read-only implementation planning. Do not edit files.";
  }
  if (mode === "review") {
    return "Current mode: review. This is read-only code review. Prioritize defects, regressions, security risks, and missing tests. Do not edit files.";
  }
  if (mode === "explore") {
    return "Current mode: explore. This is read-only codebase exploration. Return concrete paths, line references, and evidence. Do not edit files.";
  }
  return "Current mode: build. You may edit files, but every change must be verified.";
}

export function inferCodingMode(task: string): CodingMode {
  const command = parseCodingCommand(task);
  if (command?.mode) return command.mode;
  const text = task.toLowerCase();
  if (/\b(coordinate|coordinator|workers?|parallel agents?|delegate)\b/.test(text)) return "coordinate";
  const mutating = taskRequiresCodeMutation(task);
  const verificationOnly = taskIsVerificationRequest(task);
  const readOnly =
    /\b(analy[sz]e|check|explain|find|inspect|investigate|list|locate|review|show|summari[sz]e|what|where|why|how)\b/.test(text);
  if (verificationOnly) return "build";
  return mutating || !readOnly ? "build" : "plan";
}

function taskIsVerificationRequest(task: string): boolean {
  const text = task.toLowerCase();
  return /\b(run|check|verify)\b.*\b(build|ci|lint|test|tests|typecheck)\b/.test(text) ||
    /\b(test|typecheck|lint|build)\b.*\b(only|without changing|no changes)\b/.test(text);
}

export function taskRequiresCodeMutation(task: string): boolean {
  const text = task.toLowerCase();
  if (taskIsVerificationRequest(task)) return false;
  return /\b(add|build|change|create|debug|edit|enhance|fix|implement|improve|install|migrate|modify|patch|polish|refactor|remove|rename|repair|replace|update|upgrade|write)\b/.test(text) ||
    /\bmake\b.+\bbetter\b/.test(text);
}

export function detectCodingVerificationCommand(
  cwd: string,
  customCommand?: string,
  changedFiles: string[] = [],
): string | undefined {
  if (customCommand?.trim()) return customCommand;
  const nested = detectNestedPackageVerificationCommand(cwd, changedFiles);
  if (nested) return nested;
  const pkgPath = resolve(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { scripts?: Record<string, string> };
      const scripts = pkg.scripts ?? {};
      const packageManager = inferPackageManager(cwd) ?? "npm";
      const parts: string[] = [];
      if (scripts.typecheck) parts.push(packageRunCommand(packageManager, "typecheck"));
      if (scripts.lint) parts.push(packageRunCommand(packageManager, "lint"));
      if (scripts.test) parts.push(packageRunCommand(packageManager, "test"));
      if (scripts.build) parts.push(packageRunCommand(packageManager, "build"));
      if (parts.length > 0) return parts.join(" && ");
    } catch {
      // Fall through to other project detectors.
    }
  }
  if (existsSync(resolve(cwd, "Cargo.toml"))) return "cargo test";
  if (existsSync(resolve(cwd, "go.mod"))) return "go test ./...";
  if (existsSync(resolve(cwd, "pyproject.toml"))) return "python -m pytest";
  if (makefileHasTarget(cwd, "test")) return "make test";
  return undefined;
}

function detectNestedPackageVerificationCommand(cwd: string, changedFiles: string[]): string | undefined {
  const packageDirs = [...new Set(
    changedFiles
      .map((file) => nearestPackageDirForFile(cwd, file))
      .filter((dir): dir is string => !!dir),
  )];
  if (packageDirs.length !== 1) return undefined;
  const packageDir = packageDirs[0]!;
  const pkgPath = resolve(packageDir, "package.json");
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      scripts?: Record<string, string>;
      packageManager?: string;
    };
    const scripts = pkg.scripts ?? {};
    const packageManager = pkg.packageManager?.split("@")[0] ?? inferPackageManager(packageDir) ?? "npm";
    const parts: string[] = [];
    if (scripts.typecheck) parts.push(packageRunCommand(packageManager, "typecheck"));
    if (scripts.lint) parts.push(packageRunCommand(packageManager, "lint"));
    if (scripts.test) parts.push(packageRunCommand(packageManager, "test"));
    if (scripts.build) parts.push(packageRunCommand(packageManager, "build"));
    if (!parts.length) return undefined;
    const rel = relative(cwd, packageDir) || ".";
    return rel === "."
      ? parts.join(" && ")
      : `cd ${shellQuote(rel)} && ${parts.join(" && ")}`;
  } catch {
    return undefined;
  }
}

function nearestPackageDirForFile(cwd: string, file: string): string | undefined {
  let current = resolve(cwd, file);
  try {
    if (existsSync(current) && !statSync(current).isDirectory()) current = dirname(current);
  } catch {
    current = dirname(current);
  }
  const root = resolve(cwd);
  while (current.startsWith(root)) {
    if (existsSync(resolve(current, "package.json"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function makefileHasTarget(cwd: string, target: string): boolean {
  const makefile = ["Makefile", "makefile", "GNUmakefile"]
    .map((name) => resolve(cwd, name))
    .find((path) => existsSync(path));
  if (!makefile) return false;
  try {
    const text = readFileSync(makefile, "utf-8");
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^${escaped}\\s*:`, "m").test(text);
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function createInitialPlan(task: string, mode: CodingMode): CodingPlan {
  return {
    goal: task,
    constraints: [
      "Preserve unrelated user changes.",
      "Do not create repo-root servus-plan.json or init.sh.",
      "Finish only with evidence-backed completion.",
    ],
    tasks: [
      {
        id: "task-1",
        title: mode === "coordinate"
          ? "Coordinate focused workers and synthesize verified outcome"
          : mode === "plan"
          ? "Explore and answer with repository evidence"
          : taskRequiresCodeMutation(task)
            ? "Implement requested code change"
            : "Run requested coding verification",
        status: "pending",
        targetFiles: [],
        evidence: [],
      },
    ],
    dependencies: [],
    targetFiles: [],
    verificationStrategy: "detect project verification command",
    status: "active",
  };
}

async function buildRepoContext(cwd: string, policy = createCodingWorkspacePolicy(cwd)): Promise<RepoContextIndex> {
  const scripts: Record<string, string> = {};
  const importantFiles: string[] = [];
  const dependencyFiles: string[] = [];
  const entrypoints: string[] = [];
  const configFiles: string[] = [];
  const projectType: string[] = [];

  const candidates = [
    "package.json",
    "tsconfig.json",
    "vite.config.js",
    "vite.config.ts",
    "src",
    "frontend",
    "README.md",
    "Cargo.toml",
    "go.mod",
    "pyproject.toml",
    "Makefile",
  ];
  for (const candidate of candidates) {
    if (existsSync(resolve(cwd, candidate))) importantFiles.push(candidate);
  }

  const deps = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "Cargo.lock", "go.sum", "requirements.txt"];
  for (const candidate of deps) {
    if (existsSync(resolve(cwd, candidate))) dependencyFiles.push(candidate);
  }

  const entryCandidates = [
    "src/index.ts",
    "src/index.tsx",
    "src/index.js",
    "src/main.ts",
    "src/main.tsx",
    "src/main.js",
    "src/app.ts",
    "src/app.tsx",
    "src/app.js",
    "app",
    "pages",
    "routes",
    "server",
    "backend",
    "frontend/src/App.jsx",
    "frontend/src/App.tsx",
  ];
  for (const candidate of entryCandidates) {
    if (existsSync(resolve(cwd, candidate))) entrypoints.push(candidate);
  }

  const configCandidates = [
    "Dockerfile",
    "docker-compose.yml",
    "docker-compose.yaml",
    ".github/workflows",
    "vercel.json",
    "netlify.toml",
    "eslint.config.js",
    ".eslintrc",
    "biome.json",
    "vitest.config.ts",
    "jest.config.js",
    "next.config.js",
    "next.config.ts",
    "vite.config.js",
    "vite.config.ts",
    "tailwind.config.js",
    "tailwind.config.ts",
  ];
  for (const candidate of configCandidates) {
    if (existsSync(resolve(cwd, candidate))) configFiles.push(candidate);
  }

  const pkgPath = resolve(cwd, "package.json");
  let packageManager: string | undefined;
  if (existsSync(pkgPath)) {
    projectType.push("node");
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { scripts?: Record<string, string>; packageManager?: string };
      Object.assign(scripts, pkg.scripts ?? {});
      packageManager = pkg.packageManager?.split("@")[0] ?? inferPackageManager(cwd);
    } catch {
      packageManager = inferPackageManager(cwd);
    }
  }
  if (existsSync(resolve(cwd, "tsconfig.json"))) projectType.push("typescript");
  if (existsSync(resolve(cwd, "Cargo.toml"))) projectType.push("rust");
  if (existsSync(resolve(cwd, "go.mod"))) projectType.push("go");
  if (existsSync(resolve(cwd, "pyproject.toml"))) projectType.push("python");

  return {
    root: cwd,
    ...(packageManager ? { packageManager } : {}),
    projectType: projectType.length ? [...new Set(projectType)] : ["unknown"],
    scripts,
    gitBranch: await gitBranch(cwd),
    gitStatus: await gitStatus(cwd, policy),
    importantFiles,
    dependencyFiles,
    entrypoints,
    configFiles,
    workspaceMap: buildWorkspaceMap(cwd, policy),
  };
}

function inferPackageManager(cwd: string): string | undefined {
  if (existsSync(resolve(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(resolve(cwd, "yarn.lock"))) return "yarn";
  if (existsSync(resolve(cwd, "bun.lockb"))) return "bun";
  if (existsSync(resolve(cwd, "package-lock.json"))) return "npm";
  return undefined;
}

function packageRunCommand(packageManager: string, script: string): string {
  if (packageManager === "yarn") return `yarn ${script}`;
  if (packageManager === "pnpm") return `pnpm run ${script}`;
  if (packageManager === "bun") return `bun run ${script}`;
  return `npm run ${script}`;
}

function dependenciesFromRepo(repo: RepoContextIndex): string[] {
  const deps = [...repo.dependencyFiles];
  if (repo.packageManager) deps.push(`package manager: ${repo.packageManager}`);
  return deps;
}

function formatRepoContext(repo: RepoContextIndex): string {
  const entrypoints = repo.entrypoints ?? [];
  const configFiles = repo.configFiles ?? [];
  const workspaceMap = repo.workspaceMap ?? [];
  return [
    `Root: ${repo.root}`,
    `Project type: ${repo.projectType.join(", ")}`,
    repo.packageManager ? `Package manager: ${repo.packageManager}` : undefined,
    repo.gitBranch ? `Git branch: ${repo.gitBranch}` : undefined,
    repo.gitStatus.length ? `Git status:\n${repo.gitStatus.map((line) => `- ${line}`).join("\n")}` : "Git status: clean or unavailable",
    repo.importantFiles.length ? `Important files: ${repo.importantFiles.join(", ")}` : undefined,
    entrypoints.length ? `Likely entrypoints: ${entrypoints.join(", ")}` : undefined,
    configFiles.length ? `Config/deploy files: ${configFiles.join(", ")}` : undefined,
    workspaceMap.length ? `Workspace map:\n${workspaceMap.map((line) => `- ${line}`).join("\n")}` : undefined,
    Object.keys(repo.scripts).length ? `Scripts: ${Object.keys(repo.scripts).join(", ")}` : undefined,
  ].filter(Boolean).join("\n");
}

function normalizeRepoContext(value: unknown): RepoContextIndex | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<RepoContextIndex>;
  if (typeof record.root !== "string") return undefined;
  return {
    root: record.root,
    ...(typeof record.packageManager === "string" ? { packageManager: record.packageManager } : {}),
    projectType: Array.isArray(record.projectType) ? record.projectType.filter((item): item is string => typeof item === "string") : ["unknown"],
    scripts: record.scripts && typeof record.scripts === "object" ? record.scripts as Record<string, string> : {},
    ...(typeof record.gitBranch === "string" ? { gitBranch: record.gitBranch } : {}),
    gitStatus: Array.isArray(record.gitStatus) ? record.gitStatus.filter((item): item is string => typeof item === "string") : [],
    importantFiles: Array.isArray(record.importantFiles) ? record.importantFiles.filter((item): item is string => typeof item === "string") : [],
    dependencyFiles: Array.isArray(record.dependencyFiles) ? record.dependencyFiles.filter((item): item is string => typeof item === "string") : [],
    entrypoints: Array.isArray(record.entrypoints) ? record.entrypoints.filter((item): item is string => typeof item === "string") : [],
    configFiles: Array.isArray(record.configFiles) ? record.configFiles.filter((item): item is string => typeof item === "string") : [],
    workspaceMap: Array.isArray(record.workspaceMap) ? record.workspaceMap.filter((item): item is string => typeof item === "string") : [],
  };
}

function buildWorkspaceMap(cwd: string, policy: CodingWorkspacePolicy): string[] {
  const lines: string[] = [];
  const maxDepth = 2;
  const maxEntries = 80;

  function walk(dir: string, depth: number): void {
    if (lines.length >= maxEntries || depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => !isWorkspaceExcludedForMap(cwd, resolve(dir, entry.name), policy))
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    } catch {
      return;
    }

    for (const entry of entries.slice(0, 24)) {
      if (lines.length >= maxEntries) return;
      const full = resolve(dir, entry.name);
      const rel = toRelativePath(cwd, full);
      lines.push(`${rel}${entry.isDirectory() ? "/" : ""}`);
      if (entry.isDirectory()) walk(full, depth + 1);
    }
    if (entries.length > 24 && lines.length < maxEntries) {
      lines.push(`${toRelativePath(cwd, dir) || "."}/… ${entries.length - 24} more`);
    }
  }

  walk(cwd, 0);
  if (lines.length >= maxEntries) lines.push("… workspace map truncated");
  return lines;
}

function isWorkspaceExcludedForMap(cwd: string, path: string, policy: CodingWorkspacePolicy): boolean {
  const rel = toRelativePath(cwd, path);
  if (!rel || rel === ".") return false;
  return policy.defaultExcludeGlobs.some((pattern) => {
    const base = pattern.replace(/\/\*\*$/g, "");
    return rel === base || rel.startsWith(`${base}/`);
  });
}

function changedFilesFromToolEvents(events: AgentToolEvent[], cwd: string): string[] {
  const result = new Set<string>();
  for (const event of events) {
    if (event.type !== "call") continue;
    if (!["write", "Write", "edit", "Edit", "MultiEdit", "patch"].includes(event.toolName)) continue;
    const input = event.input;
    if (!input || typeof input !== "object") continue;
    const filePath = (input as { filePath?: unknown; file_path?: unknown }).filePath ??
      (input as { file_path?: unknown }).file_path;
    if (typeof filePath === "string" && filePath.trim()) {
      result.add(toRelativePath(cwd, filePath));
    } else if (event.toolName === "patch") {
      const patchText = (input as { patchText?: unknown }).patchText;
      if (typeof patchText === "string") {
        for (const patchFile of changedFilesFromPatchText(cwd, patchText)) {
          result.add(patchFile);
        }
      } else {
        result.add("patch");
      }
    }
  }
  return [...result].sort();
}

function changedFilesFromPatchText(cwd: string, patchText: string): string[] {
  const result = new Set<string>();
  let oldPath: string | undefined;
  for (const line of patchText.split(/\r?\n/)) {
    if (line.startsWith("--- ")) {
      oldPath = normalizePatchDiffPath(line.slice(4).trim());
      continue;
    }
    if (!line.startsWith("+++ ")) continue;
    const newPath = normalizePatchDiffPath(line.slice(4).trim());
    const target = newPath && newPath !== "/dev/null" ? newPath : oldPath;
    if (!target || target === "/dev/null") continue;
    result.add(toRelativePath(cwd, target));
  }
  return [...result].sort();
}

function normalizePatchDiffPath(raw: string): string | undefined {
  const clean = raw.split(/\t| /)[0]?.trim();
  if (!clean) return undefined;
  if (clean === "/dev/null") return clean;
  return clean.replace(/^a\//, "").replace(/^b\//, "");
}

function toRelativePath(cwd: string, filePath: string): string {
  const abs = resolve(cwd, filePath);
  const rel = relative(cwd, abs);
  return rel && !rel.startsWith("..") ? rel : abs;
}

function classifyFailure(result: VerificationResult): VerificationAttempt["failureCategory"] {
  const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (/syntaxerror|parse error|unexpected token|unterminated/.test(text)) return "syntax";
  if (/type error|ts\d{4}|typescript|typecheck/.test(text)) return "typecheck";
  if (/eslint|lint|prettier|stylelint/.test(text)) return "lint";
  if (/test failed|failed tests?|expect\(|assert|jest|vitest|pytest|cargo test/.test(text)) return "test";
  if (/exception|runtime|crash|segmentation fault|panic/.test(text)) return "runtime";
  return "unknown";
}

function hasVerificationSkipEvidence(evidence: EvidenceItem[]): boolean {
  return evidence.some((item) => item.type === "verification_skipped");
}

async function isGitRepo(cwd: string): Promise<boolean> {
  const result = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return result.ok && result.stdout.trim() === "true";
}

async function gitBranch(cwd: string): Promise<string | undefined> {
  const result = await runGit(cwd, ["branch", "--show-current"]);
  return result.ok ? result.stdout.trim() || undefined : undefined;
}

async function gitHead(cwd: string): Promise<string | undefined> {
  const result = await runGit(cwd, ["rev-parse", "--short", "HEAD"]);
  return result.ok ? result.stdout.trim() || undefined : undefined;
}

async function gitStatus(cwd: string, policy = createCodingWorkspacePolicy(cwd)): Promise<string[]> {
  const result = await runGit(cwd, ["status", "--short"]);
  if (!result.ok) return [];
  return stripExcludedGitStatus(cwd, result.stdout)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => {
      const rawPath = line.slice(3).trim();
      const filePath = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1)! : rawPath;
      return filterWorkspacePaths(cwd, [filePath]).length > 0 || policy.internalPaths.length === 0;
    })
    .slice(0, 80);
}

async function gitChangedFiles(cwd: string): Promise<string[]> {
  const result = await runGit(cwd, ["status", "--short"]);
  if (!result.ok) return [];
  return stripExcludedGitStatus(cwd, result.stdout)
    .split(/\r?\n/)
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .map((line) => line.includes(" -> ") ? line.split(" -> ").at(-1)! : line)
    .sort();
}

async function gitDiffSummary(cwd: string, files: string[] = []): Promise<string> {
  const policy = createCodingWorkspacePolicy(cwd);
  const visibleFiles = filterWorkspacePaths(cwd, files);
  if (visibleFiles.length === 0) return "";
  const untracked = await gitUntrackedFiles(cwd);
  const result = await runGit(cwd, ["diff", "--stat", "--", ...visibleFiles, ...gitPathspecExcludeArgs(policy)]);
  const untrackedStats = await gitUntrackedDiffs(cwd, visibleFiles, untracked, true);
  if (!result.ok || !result.stdout.trim()) {
    const staged = await runGit(cwd, ["diff", "--cached", "--stat", "--", ...visibleFiles, ...gitPathspecExcludeArgs(policy)]);
    return [staged.ok ? staged.stdout.trim() : "", untrackedStats].filter(Boolean).join("\n");
  }
  return [result.stdout.trim(), untrackedStats].filter(Boolean).join("\n");
}

async function gitDiff(cwd: string, files: string[] = []): Promise<string> {
  const policy = createCodingWorkspacePolicy(cwd);
  const visibleFiles = filterWorkspacePaths(cwd, files);
  if (visibleFiles.length === 0) return "";
  const untracked = await gitUntrackedFiles(cwd);
  const untrackedDiff = await gitUntrackedDiffs(cwd, visibleFiles, untracked, false);
  const result = await runGit(cwd, ["diff", "--", ...visibleFiles, ...gitPathspecExcludeArgs(policy)]);
  if (!result.ok || !result.stdout.trim()) {
    const staged = await runGit(cwd, ["diff", "--cached", "--", ...visibleFiles, ...gitPathspecExcludeArgs(policy)]);
    return [staged.ok ? staged.stdout : "", untrackedDiff].filter(Boolean).join("\n");
  }
  return [result.stdout, untrackedDiff].filter(Boolean).join("\n");
}

async function gitUntrackedFiles(cwd: string): Promise<Set<string>> {
  const result = await runGit(cwd, ["status", "--short"]);
  if (!result.ok) return new Set();
  return new Set(
    stripExcludedGitStatus(cwd, result.stdout)
      .split(/\r?\n/)
      .filter((line) => line.startsWith("??"))
      .map((line) => line.slice(3).trim())
      .filter(Boolean),
  );
}

async function gitUntrackedDiffs(
  cwd: string,
  files: string[],
  untracked: Set<string>,
  stat: boolean,
): Promise<string> {
  const chunks: string[] = [];
  for (const file of files) {
    if (!untracked.has(file) && !await isGitUntrackedFile(cwd, file)) continue;
    if (!existsSync(resolve(cwd, file))) continue;
    const diff = await runGitAllowDiffExit(cwd, [
      "diff",
      "--no-index",
      ...(stat ? ["--stat"] : []),
      "--",
      "/dev/null",
      file,
    ]);
    if (diff.stdout.trim()) chunks.push(diff.stdout.trimEnd());
  }
  return chunks.join("\n");
}

async function isGitUntrackedFile(cwd: string, file: string): Promise<boolean> {
  const result = await runGit(cwd, ["ls-files", "--others", "--exclude-standard", "--", file]);
  return result.ok && result.stdout.split(/\r?\n/).includes(file);
}

async function runGitAllowDiffExit(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { stdout: String(stdout), stderr: String(stderr) };
  } catch (err: unknown) {
    const maybe = err as { stdout?: unknown; stderr?: unknown };
    return {
      stdout: typeof maybe.stdout === "string" ? maybe.stdout : "",
      stderr: typeof maybe.stderr === "string" ? maybe.stderr : err instanceof Error ? err.message : String(err),
    };
  }
}

async function runGit(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      timeout: 30_000,
      maxBuffer: 512_000,
    });
    return { ok: true, stdout: String(stdout), stderr: String(stderr) };
  } catch (err: unknown) {
    const maybe = err as { stdout?: unknown; stderr?: unknown };
    return {
      ok: false,
      stdout: typeof maybe.stdout === "string" ? maybe.stdout : "",
      stderr: typeof maybe.stderr === "string" ? maybe.stderr : err instanceof Error ? err.message : String(err),
    };
  }
}

function clamp(text: string): string {
  if (text.length <= MAX_STDIO_CHARS) return text;
  const keep = Math.floor((MAX_STDIO_CHARS - 80) / 2);
  return `${text.slice(0, keep)}\n\n[... truncated ${text.length - MAX_STDIO_CHARS} characters ...]\n\n${text.slice(-keep)}`;
}

function readJsonlLoose(path: string): unknown[] {
  try {
    return readFileSync(path, "utf-8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return undefined;
        }
      })
      .filter((entry) => entry !== undefined);
  } catch {
    return [];
  }
}

export function changedFilesLabel(files: string[]): string {
  if (files.length === 0) return "no files";
  if (files.length <= 4) return files.join(", ");
  return `${files.slice(0, 4).join(", ")} and ${files.length - 4} more`;
}

export function workspaceDisplayName(cwd: string): string {
  return basename(cwd) || cwd;
}
