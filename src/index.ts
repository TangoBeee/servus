#!/usr/bin/env node

import { resolve } from "node:path";
import { Orchestrator, type OrchestratorConfig } from "./orchestrator.js";
import type { AgentBackend } from "./agent.js";
import { log, ANSI } from "./log.js";
import { loadConfig } from "./config.js";
import { getDefaultModelForAvailableProvider } from "./provider.js";
import type { Screen } from "./cli/screens/main-menu.js";

// ─── Mode Detection ─────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const firstArg = argv[0] ?? "";

const SUBCOMMANDS = new Set(["config", "sessions", "jobs", "dashboard"]);
const stdinIsTTY = process.stdin.isTTY ?? false;
const isInteractive =
  (argv.length === 0 || SUBCOMMANDS.has(firstArg)) && stdinIsTTY;
const isHelp = firstArg === "-h" || firstArg === "--help";
const isSubcommandWithoutTTY = SUBCOMMANDS.has(firstArg) && !stdinIsTTY;
const isDirectRun =
  !isInteractive && !isHelp && !isSubcommandWithoutTTY &&
  (!firstArg.startsWith("--") || argv.length > 1);

// ─── Interactive mode: launch Ink TUI ───────────────────────────────────────

if (isInteractive) {
  const screenMap: Record<string, Screen> = {
    config: "settings",
    sessions: "sessions",
    jobs: "background",
    dashboard: "live-run",
  };
  const initialScreen = screenMap[firstArg] ?? "launchpad";

  launchTUI(initialScreen as Screen);
} else if (isDirectRun) {
  directRun();
} else {
  printUsage();
}

// ─── TUI Launch ─────────────────────────────────────────────────────────────

async function launchTUI(screen: Screen) {
  const { render } = await import("ink");
  const React = await import("react");
  const { App } = await import("./cli/app.js");

  render(React.createElement(App, { initialScreen: screen }));
}

// ─── Direct (flags-based) execution ─────────────────────────────────────────

function detectBackend(model: string): AgentBackend {
  const colonIdx = model.indexOf(":");
  if (colonIdx > 0) {
    const provider = model.slice(0, colonIdx);
    if (["openai", "google", "openai-compatible", "anthropic"].includes(provider)) {
      return "custom";
    }
  }
  if (
    model.startsWith("gpt-") || model.startsWith("o1-") ||
    model.startsWith("o3-") || model.startsWith("o4-") ||
    model.startsWith("gemini-") || model.startsWith("models/gemini-")
  ) {
    return "custom";
  }
  if (process.env.ANTHROPIC_API_KEY) return "claude-code";
  return "custom";
}

function parseDirectArgs(): OrchestratorConfig {
  const cfg = loadConfig();
  let cwd = process.cwd();
  let model = "";
  let backend: AgentBackend | "" = "";
  let maxConsecutiveFailures = cfg.maxFailures;
  let verifyCommand: string | undefined = cfg.verifyCommand;
  let maxBudgetUsd: number | undefined = cfg.budget;
  let preferredDomain: OrchestratorConfig["preferredDomain"] = "auto";
  const taskParts: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--cwd": cwd = resolve(argv[++i] ?? "."); break;
      case "--model": model = argv[++i] ?? ""; break;
      case "--mode": backend = argv[++i] as AgentBackend; break;
      case "--max-failures": maxConsecutiveFailures = parseInt(argv[++i] ?? "5", 10); break;
      case "--verify": verifyCommand = argv[++i]; break;
      case "--budget": maxBudgetUsd = parseFloat(argv[++i] ?? ""); break;
      case "--domain": preferredDomain = argv[++i] as OrchestratorConfig["preferredDomain"]; break;
      case "--provider-url": process.env.OPENAI_BASE_URL = argv[++i]; break;
      default:
        if (!arg.startsWith("--")) taskParts.push(arg);
        else log.warn(`Unknown option: ${arg}`);
    }
  }

  const task = taskParts.join(" ").trim();
  if (!task) {
    log.error("No task provided.");
    process.exit(1);
  }

  if (!model) {
    model = getDefaultModelForAvailableProvider(cfg.defaultModel);
    if (
      !process.env.ANTHROPIC_API_KEY &&
      !process.env.OPENAI_API_KEY &&
      !process.env.GOOGLE_GENERATIVE_AI_API_KEY &&
      !process.env.OPENAI_BASE_URL &&
      !process.env.OPENAI_API_BASE
    ) {
      log.error("No API key found.");
      process.exit(1);
    }
  }

  if (!backend) backend = detectBackend(model);

  if (backend === "claude-code" && !process.env.ANTHROPIC_API_KEY) {
    log.error("claude-code mode requires ANTHROPIC_API_KEY.");
    process.exit(1);
  }

  return { task, cwd, model, backend, maxConsecutiveFailures, verifyCommand, maxBudgetUsd, preferredDomain };
}

async function directRun() {
  const args = parseDirectArgs();

  log.banner();
  log.phase("CONFIGURATION");
  log.info(`Task           : ${ANSI.bold}${args.task}${ANSI.reset}`);
  log.info(`Working dir    : ${args.cwd}`);
  log.info(`Backend        : ${args.backend === "claude-code" ? "Claude Code SDK" : "Custom AI SDK"}`);
  log.info(`Model          : ${args.model}`);
  log.info(`Max failures   : ${args.maxConsecutiveFailures}`);
  if (args.verifyCommand) log.info(`Verify command : ${args.verifyCommand}`);
  if (args.maxBudgetUsd) log.info(`Budget limit   : $${args.maxBudgetUsd}`);

  process.chdir(args.cwd);

  const orchestrator = new Orchestrator(args);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.warn(`Received ${signal}. Closing all agent sessions...`);
    orchestrator.closeAll();
    process.exit(130);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  try {
    const outcome = await orchestrator.run();
    if (outcome.status === "waiting_input") {
      log.warn("Servus needs more input before it can continue:");
      log.info(outcome.question ?? outcome.result?.summary ?? "More information is needed.");
      process.exitCode = 2;
    } else if (outcome.status === "failed") {
      process.exitCode = 1;
    }
  } catch (err: unknown) {
    log.error(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

// ─── Help ───────────────────────────────────────────────────────────────────

function printUsage(): void {
  console.log(`
${ANSI.bold}Servus${ANSI.reset} — Autonomous Multi-Agent Engineer v2.0

${ANSI.bold}Interactive Mode:${ANSI.reset}
  servus                     Launch interactive TUI
  servus config              Open settings
  servus sessions            Browse past runs
  servus jobs                Manage background jobs
  servus dashboard           Open live dashboard

${ANSI.bold}Direct Mode:${ANSI.reset}
  servus <task> [options]    Run a task directly (CI-friendly)

${ANSI.bold}Options:${ANSI.reset}
  --mode <mode>              claude-code | custom (default: auto)
  --model <model>            Model name or provider:model
  --cwd <path>               Working directory
  --max-failures <n>         Max test failures before skipping task (default: 5)
  --verify <command>         Custom verification command
  --budget <usd>             Max spend in USD
  --domain <domain>          auto | coding | browser | desktop | media | data | extension | security | general
  --provider-url <url>       Base URL for openai-compatible provider
  -h, --help                 Show this help

${ANSI.bold}Examples:${ANSI.reset}
  ${ANSI.dim}# Interactive${ANSI.reset}
  servus

  ${ANSI.dim}# Direct${ANSI.reset}
  servus "Add rate limiting middleware" --model gpt-4o
  servus "Fix CI tests" --mode claude-code --cwd ./backend
`);
  process.exit(0);
}
