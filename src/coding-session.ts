import type { AgentResponse } from "./agent.js";
import type { EngineContext } from "./engine.js";
import { bus } from "./events.js";
import { appendEvent } from "./session-store.js";
import { ANSI } from "./log.js";
import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { SERVUS_DIR } from "./config.js";
import { listCodingReadStateFiles } from "./tools.js";
import { queuedCodingUserMessageCount } from "./coding-message-queue.js";
import {
  CodingRuntime,
  type CodingMode,
} from "./coding-runtime.js";
import {
  CodingConversationLoop,
  type CodingConversationLoopOptions,
} from "./coding-conversation-loop.js";

export class ServusCodingSession {
  readonly runtime: CodingRuntime;
  readonly startedAt = Date.now();
  private turnCounter = 0;
  private loops: CodingConversationLoop[] = [];

  private constructor(readonly ctx: EngineContext) {
    this.runtime = new CodingRuntime(ctx);
  }

  static async start(ctx: EngineContext): Promise<ServusCodingSession> {
    const session = new ServusCodingSession(ctx);
    await session.runtime.initialize();
    const replay = loadCodingSessionReplay(ctx.sessionId, ctx.cwd);
    bus.push({
      type: "session:hydrated",
      agent: "ServusCodingSession",
      message: "Coding session runtime initialized",
      metadata: {
        sessionId: ctx.sessionId,
        cwd: ctx.cwd,
        launchCwd: ctx.launchCwd,
        targetCwd: ctx.targetCwd,
        mode: session.runtime.state.mode,
        replay,
      },
    });
    bus.push({
      type: "runtime:state",
      agent: "ServusCodingSession",
      message: "Coding session runtime initialized",
      metadata: {
        sessionId: ctx.sessionId,
        cwd: ctx.cwd,
        launchCwd: ctx.launchCwd,
        targetCwd: ctx.targetCwd,
        mode: session.runtime.state.mode,
      },
    });
    return session;
  }

  createLoop(options: CodingConversationLoopOptions): CodingConversationLoop {
    const loop = new CodingConversationLoop(this.ctx, this.runtime, options);
    this.loops.push(loop);
    return loop;
  }

  beginTurn(input: string, metadata: Record<string, unknown> = {}): ServusCodingTurn {
    const turn = new ServusCodingTurn(
      this,
      `turn-${++this.turnCounter}`,
      input,
      metadata,
    );
    turn.start();
    return turn;
  }

  close(): void {
    for (const loop of this.loops) loop.close();
  }
}

export class ServusCodingTurn {
  readonly startedAt = Date.now();

  constructor(
    private readonly session: ServusCodingSession,
    readonly id: string,
    readonly input: string,
    readonly metadata: Record<string, unknown> = {},
  ) {}

  start(): void {
    const event = bus.push({
      type: "coding:turn_start",
      agent: "ServusCodingSession",
      message: `Coding turn ${this.id} started`,
      metadata: {
        turnId: this.id,
        sessionId: this.session.ctx.sessionId,
        phase: this.session.runtime.state.phase,
        inputPreview: this.input.slice(0, 500),
        ...this.metadata,
      },
    });
    if (this.session.ctx.sessionId && !bus.interactive) appendEvent(this.session.ctx.sessionId, event);
  }

  finish(response: AgentResponse): void {
    const durationMs = Date.now() - this.startedAt;
    const event = bus.push({
      type: "coding:turn_finish",
      agent: "ServusCodingSession",
      message: `Coding turn ${this.id} finished (${response.subtype})`,
      metadata: {
        turnId: this.id,
        sessionId: this.session.ctx.sessionId,
        subtype: response.subtype,
        durationMs,
        cost: response.cost,
        turns: response.turns,
      },
    });
    if (this.session.ctx.sessionId && !bus.interactive) appendEvent(this.session.ctx.sessionId, event);
  }
}

export function codingAgentNameForMode(mode: CodingMode): string {
  if (mode === "plan") return "PlanAgent";
  if (mode === "review") return "ReviewAgent";
  if (mode === "explore") return "ExploreAgent";
  if (mode === "coordinate") return "CoordinatorAgent";
  return "CodingAgent";
}

export function codingAgentColorForMode(mode: CodingMode): string {
  return mode === "build" || mode === "coordinate" ? ANSI.green : ANSI.blue;
}

export interface CodingSessionReplay {
  sessionId?: string;
  transcriptEvents: number;
  toolCalls: number;
  toolResults: number;
  lastAssistantMessage?: string;
  toolResultArtifacts: number;
  readStateFiles: number;
  checkpoints: number;
  queuedUserMessages: number;
  compactions: number;
}

export function loadCodingSessionReplay(sessionId: string | undefined, cwd: string): CodingSessionReplay {
  if (!sessionId) {
    return {
      transcriptEvents: 0,
      toolCalls: 0,
      toolResults: 0,
      toolResultArtifacts: 0,
      readStateFiles: 0,
      checkpoints: 0,
      queuedUserMessages: 0,
      compactions: 0,
    };
  }
  const codingDir = join(SERVUS_DIR, "sessions", sanitizeSessionPart(sessionId), "coding");
  const transcript = readJsonl(join(codingDir, "transcript.jsonl"));
  const lastAssistant = [...transcript].reverse().find((entry) =>
    entry && typeof entry === "object" &&
    (entry as { type?: unknown }).type === "assistant" &&
    typeof (entry as { content?: unknown }).content === "string"
  ) as { content?: string } | undefined;
  return {
    sessionId,
    transcriptEvents: transcript.length,
    toolCalls: transcript.filter((entry) => (entry as { type?: unknown })?.type === "tool_call").length,
    toolResults: transcript.filter((entry) => (entry as { type?: unknown })?.type === "tool_result").length,
    ...(lastAssistant?.content ? { lastAssistantMessage: lastAssistant.content.slice(0, 1200) } : {}),
    toolResultArtifacts: countFiles(join(codingDir, "tool-results")),
    readStateFiles: listCodingReadStateFiles(sessionId, cwd).length,
    checkpoints: countFiles(join(codingDir, "diffs")) + countFiles(join(codingDir, "snapshots")),
    queuedUserMessages: queuedCodingUserMessageCount(sessionId),
    compactions: countCompactionFiles(codingDir),
  };
}

function readJsonl(path: string): unknown[] {
  if (!existsSync(path)) return [];
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

function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile()).length;
  } catch {
    return 0;
  }
}

function countCompactionFiles(codingDir: string): number {
  const rootCount = readJsonl(join(codingDir, "compactions.jsonl")).length;
  const agentsDir = join(codingDir, "agents");
  if (!existsSync(agentsDir)) return rootCount;
  try {
    return rootCount + readdirSync(agentsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .reduce((count, entry) => count + readJsonl(join(agentsDir, entry.name, "compactions.jsonl")).length, 0);
  } catch {
    return rootCount;
  }
}

function sanitizeSessionPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}
