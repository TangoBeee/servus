#!/usr/bin/env node

import { resolve } from "node:path";
import { Orchestrator, type OrchestratorConfig } from "./orchestrator.js";
import { normalizeAgentBackend, type AgentBackend } from "./agent.js";
import { log, ANSI } from "./log.js";
import { loadConfig } from "./config.js";
import { getDefaultModelForAvailableProvider } from "./provider.js";
import { parseCodingCommand } from "./coding-commands.js";
import type { Screen } from "./cli/screens/main-menu.js";
import { bus, type ServusEvent } from "./events.js";
import { appendEvent, createSession, getSession, updateSession } from "./session-store.js";
import {
  addMcpServer,
  beginMcpAuth,
  clearMcpAuth,
  closeAllMcpClients,
  getMcpInstructions,
  getMcpServer,
  listMcpPrompts,
  listMcpResources,
  listMcpTools,
  mcpAuthStatus,
  mcpStatusSummary,
  removeMcpServer,
  summarizeMcpServers,
  testMcpServer,
} from "./mcp-client.js";

// ─── Mode Detection ─────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const firstArg = argv[0] ?? "";

const SUBCOMMANDS = new Set(["config", "sessions", "jobs", "dashboard"]);
const stdinIsTTY = process.stdin.isTTY ?? false;
const isInteractive =
  (argv.length === 0 || SUBCOMMANDS.has(firstArg)) && stdinIsTTY;
const isHelp = firstArg === "-h" || firstArg === "--help";
const isMcpCommand = firstArg === "mcp";
const isSubcommandWithoutTTY = SUBCOMMANDS.has(firstArg) && !stdinIsTTY;
const isDirectRun =
  !isMcpCommand && !isInteractive && !isHelp && !isSubcommandWithoutTTY &&
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
} else if (isMcpCommand) {
  try {
    await handleMcpCommand(argv.slice(1));
  } finally {
    await closeAllMcpClients();
  }
} else if (isDirectRun) {
  directRun();
} else {
  printUsage();
}

async function handleMcpCommand(args: string[]): Promise<void> {
  const cwd = process.cwd();
  const command = args[0] ?? "list";
  if (command === "list") {
    console.log(summarizeMcpServers(cwd));
    return;
  }
  if (command === "status" || command === "debug") {
    console.log(await mcpStatusSummary(cwd));
    return;
  }
  if (command === "auth" || command === "auth-status") {
    const sub = command === "auth-status" ? "status" : (args[1] ?? "status");
    const server = command === "auth-status" ? args[1] : args[2];
    if (sub === "status") {
      console.log(mcpAuthStatus(cwd, server));
      return;
    }
    if (sub === "login" && server) {
      console.log(beginMcpAuth(cwd, server));
      return;
    }
    if (sub === "logout" && server) {
      console.log(clearMcpAuth(cwd, server));
      return;
    }
    console.log("Usage: servus mcp auth status [server] | servus mcp auth login <server> | servus mcp auth logout <server>");
    process.exit(1);
  }
  if (command === "test") {
    const name = args[1];
    if (!name) {
      log.error("Usage: servus mcp test <name>");
      process.exit(1);
    }
    const result = await testMcpServer(cwd, name);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (command === "tools") {
    const tools = await listMcpTools(cwd, args[1]);
    console.log(tools.length ? JSON.stringify(tools, null, 2) : "No MCP tools found.");
    return;
  }
  if (command === "resources") {
    const resources = await listMcpResources(cwd, args[1]);
    console.log(resources.length ? JSON.stringify(resources, null, 2) : "No MCP resources found.");
    return;
  }
  if (command === "prompts") {
    const prompts = await listMcpPrompts(cwd, args[1]);
    console.log(prompts.length ? JSON.stringify(prompts, null, 2) : "No MCP prompts found.");
    return;
  }
  if (command === "instructions") {
    const name = args[1];
    if (!name) {
      log.error("Usage: servus mcp instructions <name>");
      process.exit(1);
    }
    console.log(await getMcpInstructions(cwd, name));
    return;
  }
  if (command === "get") {
    const name = args[1];
    if (!name) {
      log.error("Usage: servus mcp get <name>");
      process.exit(1);
    }
    const server = getMcpServer(cwd, name);
    if (!server) {
      log.error(`No MCP server named ${name}.`);
      process.exit(1);
    }
    console.log(JSON.stringify(server, null, 2));
    return;
  }
  if (command === "remove") {
    const name = args[1];
    if (!name) {
      log.error("Usage: servus mcp remove <name> [--scope user|project]");
      process.exit(1);
    }
    const scope = parseScope(args);
    const result = removeMcpServer(cwd, name, scope);
    console.log(result.removed ? `Removed ${name} from ${result.path}` : `No ${name} entry found in ${result.path}`);
    return;
  }
  if (command === "add") {
    const parsed = parseMcpAddArgs(args.slice(1));
    if (!parsed.name || (!parsed.config.url && !parsed.config.command)) {
      log.error("Usage: servus mcp add <name> --url <url> [--transport auto|streamable-http|sse] [--scope user|project] OR servus mcp add <name> -- <command> [args...]");
      process.exit(1);
    }
    const result = addMcpServer(cwd, parsed.name, parsed.config, parsed.scope);
    console.log(`Added MCP server ${result.server.name} to ${result.path}`);
    console.log(summarizeMcpServers(cwd));
    return;
  }

  log.error(`Unknown mcp command: ${command}`);
  console.log("Usage: servus mcp list|status|add|get|remove|tools|resources|prompts|instructions|test|debug|auth");
  process.exit(1);
}

function parseScope(args: string[]): "user" | "project" {
  const index = args.indexOf("--scope");
  const value = index >= 0 ? args[index + 1] : undefined;
  return value === "project" ? "project" : "user";
}

function parseMcpAddArgs(args: string[]): {
  name: string;
  scope: "user" | "project";
  config: {
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
    headers?: Record<string, string>;
    timeoutMs?: number;
    resourceFilter?: string[];
    toolFilter?: string[];
    transport?: "auto" | "stdio" | "streamable-http" | "sse" | "http";
    auth?: {
      type?: "none" | "bearer" | "header" | "oauth" | "client_credentials";
      tokenEnv?: string;
      headerName?: string;
      clientIdEnv?: string;
      clientSecretEnv?: string;
      scopes?: string[];
      redirectUrl?: string;
    };
  };
} {
  const name = args[0] ?? "";
  const scope = parseScope(args);
  const config: {
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
    headers?: Record<string, string>;
    timeoutMs?: number;
    resourceFilter?: string[];
    toolFilter?: string[];
    transport?: "auto" | "stdio" | "streamable-http" | "sse" | "http";
    auth?: {
      type?: "none" | "bearer" | "header" | "oauth" | "client_credentials";
      tokenEnv?: string;
      headerName?: string;
      clientIdEnv?: string;
      clientSecretEnv?: string;
      scopes?: string[];
      redirectUrl?: string;
    };
  } = {};
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--scope") {
      i++;
      continue;
    }
    if (arg === "--url") {
      config.url = args[++i];
      continue;
    }
    if (arg === "--timeout") {
      config.timeoutMs = Number(args[++i]);
      continue;
    }
    if (arg === "--transport") {
      config.transport = args[++i] as typeof config.transport;
      continue;
    }
    if (arg === "--tool-filter") {
      config.toolFilter = (args[++i] ?? "").split(",").map((item) => item.trim()).filter(Boolean);
      continue;
    }
    if (arg === "--resource-filter") {
      config.resourceFilter = (args[++i] ?? "").split(",").map((item) => item.trim()).filter(Boolean);
      continue;
    }
    if (arg === "--auth") {
      config.auth = { ...(config.auth ?? {}), type: args[++i] as NonNullable<typeof config.auth>["type"] };
      continue;
    }
    if (arg === "--token-env") {
      config.auth = { ...(config.auth ?? {}), tokenEnv: args[++i] };
      continue;
    }
    if (arg === "--header-name") {
      config.auth = { ...(config.auth ?? {}), headerName: args[++i] };
      continue;
    }
    if (arg === "--client-id-env") {
      config.auth = { ...(config.auth ?? {}), clientIdEnv: args[++i] };
      continue;
    }
    if (arg === "--client-secret-env") {
      config.auth = { ...(config.auth ?? {}), clientSecretEnv: args[++i] };
      continue;
    }
    if (arg === "--auth-scope") {
      const scopes = [...(config.auth?.scopes ?? []), args[++i] ?? ""].filter(Boolean);
      config.auth = { ...(config.auth ?? {}), scopes };
      continue;
    }
    if (arg === "--auth-scopes") {
      config.auth = { ...(config.auth ?? {}), scopes: (args[++i] ?? "").split(",").map((item) => item.trim()).filter(Boolean) };
      continue;
    }
    if (arg === "--redirect-url") {
      config.auth = { ...(config.auth ?? {}), redirectUrl: args[++i] };
      continue;
    }
    if (arg === "--env") {
      const [key, ...rest] = (args[++i] ?? "").split("=");
      if (key && rest.length) env[key] = rest.join("=");
      continue;
    }
    if (arg === "--header") {
      const [key, ...rest] = (args[++i] ?? "").split("=");
      if (key && rest.length) headers[key] = rest.join("=");
      continue;
    }
    if (arg === "--") {
      const command = args[++i];
      if (command) {
        config.command = command;
        config.args = args.slice(i + 1);
      }
      break;
    }
    if (!arg.startsWith("--") && !config.command && !config.url) {
      config.command = arg;
      config.args = args.slice(i + 1).filter((item) => item !== "--scope" && item !== "user" && item !== "project");
      break;
    }
  }
  if (Object.keys(env).length) config.env = env;
  if (Object.keys(headers).length) config.headers = headers;
  return { name, scope, config };
}

// ─── TUI Launch ─────────────────────────────────────────────────────────────

async function launchTUI(screen: Screen) {
  const { render } = await import("ink");
  const React = await import("react");
  const { App } = await import("./cli/app.js");

  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[2J\x1b[H");
  }
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
  return "custom";
}

function parseBackendMode(value: string | undefined): AgentBackend | "" {
  if (!value) return "";
  const normalized = value.trim().toLowerCase();
  const legacyProviderBackend = `${"claude"}-code`;
  const removedProviderSdkBackend = `${"provider"}-sdk`;
  if (
    normalized === "custom" ||
    normalized === removedProviderSdkBackend ||
    normalized === "sdk" ||
    normalized === legacyProviderBackend
  ) {
    return "custom";
  }
  log.warn(`Unknown mode: ${value}`);
  return "";
}

function formatBackendLabel(backend: AgentBackend): string {
  return "Servus Runtime";
}

function parseDirectArgs(): OrchestratorConfig {
  const cfg = loadConfig();
  let cwd = process.cwd();
  let model = "";
  let backend: AgentBackend | "" = "";
  let sessionId: string | undefined;
  let maxConsecutiveFailures = cfg.maxFailures;
  let verifyCommand: string | undefined = cfg.verifyCommand;
  let maxBudgetUsd: number | undefined = cfg.budget;
  let preferredDomain: OrchestratorConfig["preferredDomain"] = "auto";
  let cwdProvided = false;
  let domainProvided = false;
  const taskParts: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--cwd":
        cwd = resolve(argv[++i] ?? ".");
        cwdProvided = true;
        break;
      case "--model": model = argv[++i] ?? ""; break;
      case "--mode": backend = parseBackendMode(argv[++i]); break;
      case "--session":
      case "--resume":
        sessionId = argv[++i];
        break;
      case "--max-failures": maxConsecutiveFailures = parseInt(argv[++i] ?? "5", 10); break;
      case "--verify": verifyCommand = argv[++i]; break;
      case "--budget": maxBudgetUsd = parseFloat(argv[++i] ?? ""); break;
      case "--domain":
        preferredDomain = argv[++i] as OrchestratorConfig["preferredDomain"];
        domainProvided = true;
        break;
      case "--provider-url": process.env.OPENAI_BASE_URL = argv[++i]; break;
      default:
        if (!arg.startsWith("--")) taskParts.push(arg);
        else log.warn(`Unknown option: ${arg}`);
    }
  }

  let task = taskParts.join(" ").trim();
  if (!task) {
    log.error("No task provided.");
    process.exit(1);
  }

  if (sessionId) {
    const prior = getSession(sessionId);
    if (!prior) {
      log.error(`No Servus session found for --session ${sessionId}.`);
      process.exit(1);
    }
    if (!cwdProvided) cwd = prior.cwd;
    if (!model) model = prior.model;
    if (!backend) backend = normalizeAgentBackend(prior.backend);
    if (!domainProvided) preferredDomain = prior.domain ?? "auto";
    task = [
      `Follow-up from user in same Servus session ${sessionId}:`,
      "",
      task,
      "",
      "---",
      `(Previous task: ${prior.task})`,
    ].join("\n");
  }

  const codingCommand = parseCodingCommand(task, cwd);
  const localImmediateCodingCommand =
    !!codingCommand?.immediate && (preferredDomain === "coding" || preferredDomain === "auto");
  if (localImmediateCodingCommand && !domainProvided) preferredDomain = "coding";

  if (!model) {
    model = getDefaultModelForAvailableProvider(cfg.defaultModel);
    if (
      !localImmediateCodingCommand &&
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

  return { task, cwd, model, backend, maxConsecutiveFailures, verifyCommand, maxBudgetUsd, preferredDomain, sessionId };
}

async function directRun() {
  const args = parseDirectArgs();
  const existingSession = args.sessionId ? getSession(args.sessionId) : null;
  const session = existingSession ?? createSession(args.task, args.model, args.backend, args.cwd, {
    domain: args.preferredDomain ?? "auto",
    runtimeStatus: "running",
  });
  args.sessionId = session.id;
  if (existingSession) {
    updateSession(session.id, {
      status: "running",
      runtimeStatus: "running",
      domain: args.preferredDomain ?? existingSession.domain,
      endTime: undefined,
    });
  }

  log.banner();
  log.phase("CONFIGURATION");
  log.info(`Task           : ${ANSI.bold}${args.task}${ANSI.reset}`);
  log.info(`Session        : ${session.id}`);
  if (existingSession) log.info(`Resume         : yes`);
  log.info(`Working dir    : ${args.cwd}`);
  log.info(`Backend        : ${formatBackendLabel(args.backend)}`);
  log.info(`Model          : ${args.model}`);
  log.info(`Max failures   : ${args.maxConsecutiveFailures}`);
  if (args.verifyCommand) log.info(`Verify command : ${args.verifyCommand}`);
  if (args.maxBudgetUsd) log.info(`Budget limit   : $${args.maxBudgetUsd}`);

  process.chdir(args.cwd);

  const orchestrator = new Orchestrator(args);
  const persistEvent = (event: ServusEvent) => appendEvent(session.id, event);
  bus.on("event", persistEvent);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.warn(`Received ${signal}. Closing all agent sessions...`);
    orchestrator.closeAll();
    updateSession(session.id, {
      status: "failed",
      runtimeStatus: "cancelled",
      phase: "failed",
      endTime: Date.now(),
    });
    bus.off("event", persistEvent);
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
      if (outcome.result?.summary) {
        log.phase("RESULT");
        console.log(outcome.result.summary);
      }
      process.exitCode = 1;
    } else if (outcome.result?.summary) {
      log.phase("RESULT");
      console.log(outcome.result.summary);
    }
  } catch (err: unknown) {
    updateSession(session.id, {
      status: "failed",
      runtimeStatus: "failed",
      phase: "failed",
      endTime: Date.now(),
    });
    log.error(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  } finally {
    bus.off("event", persistEvent);
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
  servus mcp <command>       Manage MCP servers, tools, and resources

${ANSI.bold}Direct Mode:${ANSI.reset}
  servus <task> [options]    Run a task directly (CI-friendly)

${ANSI.bold}Options:${ANSI.reset}
  --mode <mode>              custom (default: auto)
  --model <model>            Model name or provider:model
  --cwd <path>               Working directory
  --session <id>             Continue an existing Servus session
  --resume <id>              Alias for --session
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
  servus "Add rate limiting middleware" --model gpt-5.4
  servus "Fix CI tests" --mode custom --cwd ./backend

${ANSI.bold}MCP Commands:${ANSI.reset}
  servus mcp list
  servus mcp status
  servus mcp add <name> --url <url> [--transport auto|streamable-http|sse] [--auth bearer|header|oauth|client_credentials] [--scope user|project]
  servus mcp add <name> -- <command> [args...]
  servus mcp get <name>
  servus mcp remove <name> [--scope user|project]
  servus mcp tools [server]
  servus mcp resources [server]
  servus mcp prompts [server]
  servus mcp instructions <server>
  servus mcp test <server>
  servus mcp auth status [server]
  servus mcp auth login <server>
  servus mcp auth logout <server>
  servus mcp debug

${ANSI.bold}Coding Slash Commands:${ANSI.reset}
  /plan <task>               Read-only repo plan with evidence
  /build <task>              Force edit/build mode
  /coordinate <task>         Coordinate focused workers with scratchpad
  /review <task>             Read-only code review mode
  /explore <task>            Read-only codebase exploration
  /verify [command]          Run detected or explicit verification
  /diff [checkpoint|current] Show session checkpoint or working-tree diff
  /revert [checkpoint]       Safely reverse a Servus checkpoint diff
  /help                      Show coding command help
  /status                    Show coding session/repo status
  /transcript [limit]        Show recent coding session transcript
  /tools                     Show coding tool catalog
  /sessions [query]          List or search project Servus sessions
  /search <query>            Search project Servus sessions
  /compact                   Mark a manual context compaction boundary
  /context                   Show context budget and compaction status
  /remember <instruction>    Save durable project coding memory
  /memory                    Show loaded coding memory/instructions
  /files                     Show files attached, read, or changed in session
  /agents                    Show available coding subagents
  /commands                  Show custom .servus coding commands
  /model, /models            Show selectable models from available providers
  /permissions               Show active coding permission rules
  /hooks                     Show active coding hooks
  /settings                  Show loaded Servus coding settings
  /skills                    Show loaded Servus coding skills
  /output-style [name]       List or select a Servus output style
  /doctor                    Run Servus coding project diagnostics
  /init                      Create Servus project coding files
`);
  process.exit(0);
}
