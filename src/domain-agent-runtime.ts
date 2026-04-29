import type { IAgent } from "./agent.js";
import type { EngineContext, EngineResult, TaskDomain } from "./engine.js";
import { bus } from "./events.js";
import { createRunContract } from "./completion-validator.js";
import { runValidatedAgentTask } from "./agentic-loop.js";
import type { RunContract } from "./runtime.js";

export interface DomainAgentRuntimeOptions {
  domain: TaskDomain;
  agent: IAgent;
  ctx: EngineContext;
  initialMessage: string;
  contract?: RunContract;
  progressRequired?: boolean;
  maxRepairAttempts?: number;
}

export async function runDomainAgentRuntime(options: DomainAgentRuntimeOptions): Promise<EngineResult> {
  const contract = options.contract ?? createRunContract(options.ctx, options.domain);
  bus.push({
    type: "runtime:state",
    agent: options.agent.name,
    message: `${options.domain} runtime started`,
    metadata: {
      domain: options.domain,
      phase: "orienting",
      contract,
    },
  });

  const prompt = [
    options.initialMessage,
    "",
    options.progressRequired !== false
      ? [
          "## Public Progress Notes",
          "Use servus_progress or ReportProgress before your first domain tool call.",
          "Then use it whenever the user would otherwise be staring at a silent run: after important evidence, before a risky/meaningful action, before asking input, and before finalization.",
          "These notes are public working updates, not hidden chain-of-thought.",
        ].join("\n")
      : "",
  ].filter(Boolean).join("\n");

  const result = await runValidatedAgentTask({
    agent: options.agent,
    ctx: options.ctx,
    domain: options.domain,
    initialMessage: prompt,
    maxRepairAttempts: options.maxRepairAttempts,
    progressRequired: options.progressRequired !== false,
  });

  bus.push({
    type: "runtime:state",
    agent: options.agent.name,
    message: `${options.domain} runtime ${result.needsInput ? "waiting for input" : result.success ? "completed" : "failed"}`,
    metadata: {
      domain: options.domain,
      status: result.needsInput ? "waiting_input" : result.success ? "completed" : "failed",
      phase: result.needsInput ? "waiting_input" : result.success ? "completed" : "failed",
    },
  });

  return result;
}
