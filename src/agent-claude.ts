/**
 * Claude Code SDK agent backend.
 *
 * Wraps a V2 SDK session (`unstable_v2_createSession`) with the IAgent
 * interface.  On the first `send()`, the role prompt is prepended as
 * system instructions; subsequent messages rely on session context.
 */

import {
  unstable_v2_createSession,
  type SDKMessage,
  type SDKSession,
  type SDKSessionOptions,
} from "@anthropic-ai/claude-agent-sdk";
import type { IAgent, AgentConfig, AgentResponse } from "./agent.js";
import { log, ANSI } from "./log.js";
import { bus } from "./events.js";

// ─── Content block typing ───────────────────────────────────────────────────

interface ContentBlock {
  type: string;
  text?: string;
}

interface MessagePayload {
  content?: ContentBlock[];
}

function extractText(msg: SDKMessage): string {
  if (msg.type !== "assistant") return "";
  const payload = (msg as SDKMessage & { message?: MessagePayload }).message;
  if (!payload?.content) return "";
  return payload.content
    .filter(
      (b: ContentBlock): b is ContentBlock & { text: string } =>
        b.type === "text" && typeof b.text === "string",
    )
    .map((b: ContentBlock & { text: string }) => b.text)
    .join("");
}

// ─── Claude Code Agent ──────────────────────────────────────────────────────

export class ClaudeCodeAgent implements IAgent {
  readonly name: string;
  readonly role: string;
  readonly color: string;

  private session: SDKSession;
  private prompt: string;
  private initialized = false;
  private totalCost = 0;

  constructor(config: AgentConfig) {
    this.name = config.name;
    this.role = config.role;
    this.color = config.color;
    this.prompt = config.prompt;

    const options: SDKSessionOptions = {
      model: config.model,
      permissionMode: "bypassPermissions",
      disallowedTools: [
        "AskUserQuestion",
        "ExitPlanMode",
        ...(config.disallowedTools ?? []).flatMap(toClaudeToolNames),
      ],
    };

    this.session = unstable_v2_createSession(options);
  }

  async send(message: string): Promise<AgentResponse> {
    const fullMessage = this.initialized
      ? message
      : `# SYSTEM INSTRUCTIONS\n\n${this.prompt}\n\n---\n\n${message}`;
    this.initialized = true;

    log.agent(this.name, this.color, "working...");

    await this.session.send(fullMessage);

    let text = "";
    let cost = 0;
    let turns = 0;
    let subtype = "";

    for await (const msg of this.session.stream()) {
      switch (msg.type) {
        case "assistant": {
          const chunk = extractText(msg);
          if (chunk) {
            text += chunk;
            log.agentText(this.name, this.color, chunk);
          }
          break;
        }
        case "result": {
          const m = msg as unknown as Record<string, unknown>;
          subtype = (m.subtype as string) ?? "unknown";
          cost = (m.total_cost_usd as number) ?? 0;
          this.totalCost = cost;
          if (bus.interactive) {
            bus.push({
              type: "cost",
              agent: this.name,
              message: "cost update",
              metadata: { cost: this.totalCost },
            });
          }
          break;
        }
        default:
          break;
      }
    }

    if (text && !bus.interactive) process.stdout.write("\n");

    log.agent(
      this.name,
      this.color,
      `${ANSI.dim}done (turns: ${turns}, cost: $${cost.toFixed(4)}, status: ${subtype})${ANSI.reset}`,
    );

    return { text, cost, turns, subtype };
  }

  get cost(): number {
    return this.totalCost;
  }

  close(): void {
    try {
      this.session.close();
    } catch {
      // Session may already be closed
    }
  }
}

function toClaudeToolNames(name: string): string[] {
  const normalized = name.toLowerCase();
  const map: Record<string, string[]> = {
    bash: ["Bash"],
    write: ["Write"],
    edit: ["Edit", "MultiEdit"],
    patch: ["Edit", "MultiEdit"],
    webfetch: ["WebFetch"],
    read: ["Read"],
    grep: ["Grep"],
    glob: ["Glob"],
    ls: ["LS"],
  };
  return map[normalized] ?? [name];
}
