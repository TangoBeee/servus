import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { COLORS } from "../theme.js";
import {
  applyComposerTextInput,
  normalizeComposerCursor,
  SelectionHint,
  StableComposerInput,
} from "../components/stable-composer.js";
import type { TuiOverlay } from "../tui-types.js";
import { getApiKeyStatus, loadConfig, saveConfig, type ServusConfig } from "../../config.js";
import {
  getDefaultModelForAvailableProvider,
  listModelOptions,
} from "../../provider.js";
import { resolveMcpServers } from "../../mcp-client.js";
import { loadCustomCodingCommands } from "../../coding-commands.js";
import type { AgentBackend } from "../../agent.js";
import type { TaskDomain } from "../../engine.js";
import type { TaskConfig } from "./new-task.js";
import { runTuiMcpCommand } from "../mcp-command.js";

interface Props {
  onSubmit: (config: TaskConfig) => void;
  onOpenOverlay: (overlay: TuiOverlay) => void;
  onInputLockedChange?: (locked: boolean) => void;
  inputBlocked?: boolean;
}

type DomainChoice = "coding" | "auto" | TaskDomain;

const WORDMARK = "/ S /";
const LOGO_FRAMES = ["     ", ".    ", " .   ", "  .  ", "   . ", "    .", "     "];
const AMBIENT_GLYPHS = ["·", "∙", "•"];

type HomeCommand = { id: string; label: string; description: string };

const COMMANDS: HomeCommand[] = [
  { id: "/help", label: "Help", description: "Show help" },
  { id: "/new", label: "New", description: "Clear prompt" },
  { id: "/models", label: "Models", description: "Switch model" },
  { id: "/model", label: "Model", description: "Switch model" },
  { id: "/agents", label: "Agents", description: "Switch agent" },
  { id: "/sessions", label: "Sessions", description: "Switch session" },
  { id: "/resume", label: "Resume", description: "Resume a session" },
  { id: "/fork", label: "Fork", description: "Fork current session" },
  { id: "/plan", label: "Plan", description: "Plan first" },
  { id: "/build", label: "Build", description: "Build mode" },
  { id: "/coordinate", label: "Coordinate", description: "Coordinate helpers" },
  { id: "/explore", label: "Explore", description: "Read-only exploration" },
  { id: "/review", label: "Review", description: "Review changes" },
  { id: "/verify", label: "Verify", description: "Run verification" },
  { id: "/diff", label: "Diff", description: "Show latest diff" },
  { id: "/revert", label: "Revert", description: "Revert checkpoint" },
  { id: "/status", label: "Status", description: "Session and repo status" },
  { id: "/transcript", label: "Transcript", description: "Show recent transcript" },
  { id: "/mcp", label: "MCP", description: "Manage MCP servers" },
  { id: "/mcp test", label: "MCP Test", description: "Test a server" },
  { id: "/mcp tools", label: "MCP Tools", description: "List MCP tools" },
  { id: "/mcp resources", label: "MCP Resources", description: "List MCP resources" },
  { id: "/mcp prompts", label: "MCP Prompts", description: "List MCP prompts" },
  { id: "/mcp auth status", label: "MCP Auth", description: "Show auth status" },
  { id: "/tools", label: "Tools", description: "List tools" },
  { id: "/files", label: "Files", description: "Show read/changed files" },
  { id: "/commands", label: "Commands", description: "Show custom commands" },
  { id: "/capabilities", label: "Capabilities", description: "Show capabilities" },
  { id: "/permissions", label: "Permissions", description: "Show permissions" },
  { id: "/settings", label: "Settings", description: "Edit config" },
  { id: "/context", label: "Context", description: "Context usage" },
  { id: "/compact", label: "Compact", description: "Compact current session" },
  { id: "/memory", label: "Memory", description: "Show project memory" },
  { id: "/remember", label: "Remember", description: "Save project memory" },
  { id: "/hooks", label: "Hooks", description: "Show hooks" },
  { id: "/skills", label: "Skills", description: "Show skills" },
  { id: "/output-style", label: "Output Style", description: "Select response style" },
  { id: "/doctor", label: "Doctor", description: "Run diagnostics" },
  { id: "/init", label: "Init", description: "Create SERVUS.md files" },
];

const OVERLAY_COMMANDS: Record<string, TuiOverlay> = {
  "/help": "help",
  "/models": "models",
  "/model": "models",
  "/sessions": "sessions",
  "/agents": "agents",
  "/tools": "tools",
  "/mcp": "mcp",
  "/settings": "settings",
  "/capabilities": "capabilities",
};

const MODES: Array<{ label: string; value: DomainChoice; prefix?: string }> = [
  { label: "Auto", value: "auto" },
  { label: "Plan", value: "coding", prefix: "/plan " },
  { label: "Build", value: "coding" },
  { label: "Browse", value: "browser" },
  { label: "Desktop", value: "desktop" },
  { label: "Data", value: "data" },
  { label: "Security", value: "security" },
];

export function HomeScreen({ onSubmit, onOpenOverlay, onInputLockedChange, inputBlocked = false }: Props) {
  const { stdout } = useStdout();
  const [config, setConfig] = useState<ServusConfig>(() => loadConfig());
  const [value, setValue] = useState("");
  const [cursor, setCursor] = useState(0);
  const [modeIndex, setModeIndex] = useState(0);
  const [commandIndex, setCommandIndex] = useState(0);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [trustPrompt, setTrustPrompt] = useState<TaskConfig | null>(null);
  const [logoTick, setLogoTick] = useState(0);

  const cwd = process.cwd();
  const width = stdout?.columns ?? 120;
  const height = stdout?.rows ?? 36;
  const model = getDefaultModelForAvailableProvider(config.defaultModel);
  const backend = resolveBackend(config.defaultBackend, model);
  const modelOptions = useMemo(() => listModelOptions(), []);
  const apiKeys = useMemo(() => getApiKeyStatus(), []);
  const mcpServers = useMemo(() => resolveMcpServers(cwd), [cwd]);
  const allCommands = useMemo(() => [
    ...COMMANDS,
    ...loadCustomCodingCommands(cwd).map((command) => ({
      id: `/${command.id}`,
      label: command.id,
      description: command.description,
    })),
  ], [cwd]);
  const commandSuggestions = useMemo(() => filterCommands(value, allCommands), [value, allCommands]);
  const mentionSuggestions = useMemo(() => listMentionSuggestions(cwd, value), [cwd, value]);
  const activeMode = MODES[modeIndex] ?? MODES[0];

  useEffect(() => {
    onInputLockedChange?.(!!trustPrompt);
    return () => onInputLockedChange?.(false);
  }, [trustPrompt, onInputLockedChange]);

  useEffect(() => {
    if (!process.stdout.isTTY) return;
    const timer = setInterval(() => setLogoTick((tick) => tick + 1), 420);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    setCommandIndex(0);
    setMentionIndex(0);
    setCursor((current) => normalizeComposerCursor(value, current));
  }, [value]);

  useEffect(() => {
    setCommandIndex((index) => clampIndex(index, commandSuggestions.length));
  }, [commandSuggestions.length]);

  useEffect(() => {
    setMentionIndex((index) => clampIndex(index, mentionSuggestions.length));
  }, [mentionSuggestions.length]);

  function setComposerText(next: string) {
    setValue(next);
    setCursor(next.length);
  }

  useInput((input, key) => {
    if (inputBlocked) return;
    if (trustPrompt) {
      if (input === "1") submitTrusted(trustPrompt, false);
      if (input === "2") submitTrusted(trustPrompt, true);
      if (input === "3" || key.escape) {
        setTrustPrompt(null);
        setComposerText("");
        setNotice("Cancelled.");
      }
      return;
    }
    if (input.includes("\r") || input.includes("\n")) {
      void submit(value);
      return;
    }

    if (key.shift && key.tab) {
      setModeIndex((index) => (index + 1) % MODES.length);
      return;
    }
    if (key.tab && value.startsWith("/")) {
      const suggestion = commandSuggestions[commandIndex];
      if (suggestion) setComposerText(`${suggestion.id} `);
      return;
    }
    if (key.tab && value.startsWith("@")) {
      const suggestion = mentionSuggestions[mentionIndex];
      if (suggestion) setComposerText(`@${suggestion.path} `);
      return;
    }
    if (value.startsWith("/") && (key.downArrow || input === "\t")) {
      if (commandSuggestions.length > 0) {
        setCommandIndex((index) => Math.min(commandSuggestions.length - 1, index + 1));
      }
      return;
    }
    if (value.startsWith("/") && key.upArrow) {
      setCommandIndex((index) => Math.max(0, index - 1));
      return;
    }
    if (value.startsWith("@") && key.downArrow) {
      if (mentionSuggestions.length > 0) {
        setMentionIndex((index) => Math.min(mentionSuggestions.length - 1, index + 1));
      }
      return;
    }
    if (value.startsWith("@") && key.upArrow) {
      setMentionIndex((index) => Math.max(0, index - 1));
      return;
    }
    if (key.ctrl && input === "p") {
      setComposerText(value.startsWith("/") ? value : "/");
      return;
    }
    if (key.escape) {
      setComposerText("");
      setNotice(null);
      return;
    }

    const edited = applyComposerTextInput(value, cursor, input, key);
    if (edited.handled) {
      setValue(edited.value);
      setCursor(edited.cursor);
    }
  }, { isActive: !inputBlocked });

  async function submit(raw: string) {
    const text = raw.trim();
    if (!text) return;
    setNotice(null);

    if (text.startsWith("/")) {
      const handled = await handleSlashCommand(text);
      if (handled) {
        setComposerText("");
        return;
      }
    }

    const taskText = text.startsWith("!")
      ? [
          "Run this local shell command through Servus with normal permission checks.",
          "Capture stdout/stderr and explain the result.",
          "",
          `Command: ${text.slice(1).trim()}`,
        ].join("\n")
      : `${activeMode.prefix ?? ""}${text}`;

    const taskConfig: TaskConfig = {
      task: taskText,
      backend,
      domainMode: text.startsWith("!") ? "coding" : activeMode.value,
      model,
      cwd,
      maxFailures: config.maxFailures,
      budget: config.budget,
      verifyCommand: config.verifyCommand,
      browserHeadless: config.browser?.headless ?? false,
      runInBackground: false,
    };

    if (!isTrusted(config, cwd)) {
      setTrustPrompt(taskConfig);
      return;
    }

    onSubmit(taskConfig);
    setComposerText("");
  }

  async function handleSlashCommand(text: string): Promise<boolean> {
    const first = text.split(/\s+/)[0]?.toLowerCase() ?? "";
    if (first === "/new") {
      setComposerText("");
      setNotice("New prompt ready.");
      return true;
    }
    if (first === "/mcp" && text.trim() !== "/mcp") {
      try {
        setNotice(await runTuiMcpCommand(text, cwd));
      } catch (err) {
        setNotice(`MCP command failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return true;
    }
    const overlay = OVERLAY_COMMANDS[first];
    if (overlay) {
      onOpenOverlay(overlay);
      return true;
    }
    return false;
  }

  function submitTrusted(taskConfig: TaskConfig, remember: boolean) {
    if (remember) {
      const nextConfig = {
        ...config,
        trustedFolders: [...new Set([...(config.trustedFolders ?? []), resolve(cwd)])],
      };
      saveConfig(nextConfig);
      setConfig(nextConfig);
    }
    setTrustPrompt(null);
    onSubmit(taskConfig);
    setComposerText("");
  }

  const compact = height < 30 || width < 92;
  const composerWidth = compact
    ? Math.min(Math.max(48, width - 8), 76)
    : Math.min(Math.max(60, Math.floor(width * 0.42)), 86);
  const centerBlockHeight = compact ? 16 : 23;
  const topSpacer = Math.max(0, Math.floor((height - centerBlockHeight) / 2));

  return (
    <Box flexDirection="column" flexGrow={1} backgroundColor="black">
      <Box flexGrow={1} flexDirection="column">
        <Box height={topSpacer} />
        {!compact && <AmbientLine width={width} tick={logoTick} phase={0} />}
        <ServusLogo compact={compact} tick={logoTick} />
        {!compact && <AmbientLine width={width} tick={logoTick} phase={2} />}
        <Text> </Text>
        <Box justifyContent="center">
          <Box width={composerWidth} flexDirection="column">
            <ComposerFrame
              value={value}
              cursor={cursor}
              width={composerWidth}
              modeLabel={activeMode.label}
              model={model}
              commandSuggestions={value.startsWith("/") ? commandSuggestions : []}
              commandIndex={commandIndex}
              mentionSuggestions={value.startsWith("@") ? mentionSuggestions : []}
              mentionIndex={mentionIndex}
              compact={compact}
              focus={!trustPrompt}
            />
            <Box justifyContent="flex-end" marginTop={1}>
              <Text color="gray">shift+tab mode   ctrl+p commands</Text>
            </Box>
          </Box>
        </Box>
        <Text> </Text>
        <Box justifyContent="center">
          <Text color={COLORS.accent}>● Tip </Text>
          <Text color="gray">Run </Text>
          <Text color="white">/models</Text>
          <Text color="gray"> to switch provider, </Text>
          <Text color="white">/mcp</Text>
          <Text color="gray"> to add tools</Text>
        </Box>
        {!compact && (
          <Box marginTop={1}>
            <AmbientLine width={width} tick={logoTick} phase={4} />
          </Box>
        )}
        {notice && (
          <Box justifyContent="center" marginTop={1}>
            <Box width={composerWidth} flexDirection="column">
              <Text color={COLORS.secondary} wrap="wrap">{notice}</Text>
            </Box>
          </Box>
        )}
      </Box>

      {trustPrompt && <TrustPrompt cwd={cwd} />}

      <Box justifyContent="space-between">
        <Text color="gray">{shortPath(cwd)}</Text>
        <Text color="gray">
          {availableProviders(apiKeys)} · {modelOptions.length} models · {mcpServers.length} mcp · {formatBackend(config.defaultBackend)}
        </Text>
      </Box>
    </Box>
  );
}

function ComposerFrame({
  value,
  cursor,
  width,
  modeLabel,
  model,
  commandSuggestions,
  commandIndex,
  mentionSuggestions,
  mentionIndex,
  compact,
  focus,
}: {
  value: string;
  cursor: number;
  width: number;
  modeLabel: string;
  model: string;
  commandSuggestions: HomeCommand[];
  commandIndex: number;
  mentionSuggestions: Array<{ path: string; kind: string }>;
  mentionIndex: number;
  compact: boolean;
  focus: boolean;
}) {
  const showCommands = commandSuggestions.length > 0;
  const showMentions = mentionSuggestions.length > 0;
  const wellHeight = compact ? 5 : 8;
  const inputWidth = Math.max(20, width - 6);
  const commandOffset = Math.max(0, Math.min(commandIndex - wellHeight + 1, Math.max(0, commandSuggestions.length - wellHeight)));
  const mentionOffset = Math.max(0, Math.min(mentionIndex - wellHeight + 1, Math.max(0, mentionSuggestions.length - wellHeight)));
  const visibleCommands = commandSuggestions.slice(commandOffset, commandOffset + wellHeight);
  const visibleMentions = mentionSuggestions.slice(mentionOffset, mentionOffset + wellHeight);
  const commandTopPadding = showCommands ? Math.max(0, wellHeight - visibleCommands.length) : 0;
  const mentionTopPadding = showMentions && !showCommands ? Math.max(0, wellHeight - visibleMentions.length) : 0;

  return (
    <Box flexDirection="column">
      <Box height={wellHeight} flexDirection="column" overflow="hidden" paddingX={2}>
          {showCommands && (
            <>
              {Array.from({ length: commandTopPadding }).map((_, index) => (
                <Text key={`command-pad-${index}`}> </Text>
              ))}
              {visibleCommands.map((command, localIndex) => {
                const index = commandOffset + localIndex;
                return (
                <Box key={command.id}>
                  <SelectionHint selected={index === commandIndex}>{command.id.padEnd(18)}</SelectionHint>
                  <Text color={index === commandIndex ? "white" : "gray"} wrap="truncate"> {command.description}</Text>
                </Box>
                );
              })}
            </>
          )}
          {showMentions && !showCommands && (
            <>
              {Array.from({ length: mentionTopPadding }).map((_, index) => (
                <Text key={`mention-pad-${index}`}> </Text>
              ))}
              {visibleMentions.map((item, localIndex) => {
                const index = mentionOffset + localIndex;
                return (
                <Box key={item.path}>
                  <SelectionHint selected={index === mentionIndex}>@{item.path}</SelectionHint>
                  <Text color="gray" wrap="truncate"> {item.kind}</Text>
                </Box>
                );
              })}
            </>
          )}
          {!showCommands && !showMentions && (
            <Box flexDirection="column" width={Math.max(20, width - 4)}>
              <Box justifyContent="center">
                <Text color="gray">Ask naturally, or start with / for commands.</Text>
              </Box>
              {!compact && (
                <Box justifyContent="center">
                  <Text color="gray">Use @ to mention files and ! to run a local command.</Text>
                </Box>
              )}
            </Box>
          )}
      </Box>
      <Box borderStyle="single" borderColor={COLORS.blue} paddingX={1} flexDirection="column" backgroundColor="black">
        <Box gap={1} height={3}>
          <Text color={COLORS.blue}>▌</Text>
          <StableComposerInput
            value={value}
            cursor={cursor}
            width={inputWidth}
            maxLines={3}
            active={focus}
            placeholder={'Ask anything... "What is the tech stack of this project?"'}
          />
        </Box>
        <Box marginTop={1}>
          <Text color={COLORS.blue}>{modeLabel}</Text>
          <Text color="gray"> · </Text>
          <Text color="white">{shortModel(model)}</Text>
          <Text color="gray"> Servus Zen</Text>
        </Box>
      </Box>
    </Box>
  );
}

function ServusLogo({ compact, tick }: { compact: boolean; tick: number }) {
  const frame = LOGO_FRAMES[tick % LOGO_FRAMES.length] ?? LOGO_FRAMES[0];
  const reverse = frame.split("").reverse().join("");
  if (compact) {
    return (
      <Box justifyContent="center">
        <Text color={COLORS.muted}>{frame}</Text>
        <Text color={COLORS.secondary} bold>{WORDMARK}</Text>
        <Text color={COLORS.muted}>{reverse}</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Box justifyContent="center">
        <Text color={COLORS.muted}>   {frame}   </Text>
      </Box>
      <Box justifyContent="center">
        <Text color={COLORS.secondary} bold>  / S /  </Text>
        <Text color={COLORS.muted}>  </Text>
        <Text color={COLORS.secondary} bold>servus</Text>
        <Text color={COLORS.muted}>  </Text>
        <Text color={COLORS.secondary} bold>  / S /  </Text>
      </Box>
      <Box justifyContent="center">
        <Text color={COLORS.muted}>--- local agents · tools · proof ---</Text>
      </Box>
    </Box>
  );
}

function AmbientLine({ width, tick, phase }: { width: number; tick: number; phase: number }) {
  const lineWidth = Math.max(24, Math.min(96, width - 8));
  const cells = Array.from({ length: lineWidth }, () => " ");
  const points = Math.max(3, Math.floor(lineWidth / 22));
  for (let index = 0; index < points; index++) {
    const position = (tick * (index + 1) + phase * 7 + index * 19) % lineWidth;
    cells[position] = AMBIENT_GLYPHS[(tick + index + phase) % AMBIENT_GLYPHS.length] ?? "·";
  }
  return (
    <Box justifyContent="center">
      <Text color={COLORS.muted}>{cells.join("")}</Text>
    </Box>
  );
}

function TrustPrompt({ cwd }: { cwd: string }) {
  return (
    <Box borderStyle="single" borderColor="gray" paddingX={1} marginBottom={1} flexDirection="column">
      <Text color="white" bold>Confirm folder trust</Text>
      <Text color="white">{cwd}</Text>
      <Text color="gray" wrap="wrap">Servus may read files here and ask before mutating tools.</Text>
      <Text color={COLORS.secondary}>1. Yes   2. Yes, remember   3. No</Text>
    </Box>
  );
}

function filterCommands(input: string, commands: HomeCommand[] = COMMANDS): HomeCommand[] {
  const query = input.toLowerCase().trim();
  if (!query || query === "/") return commands;
  const needle = query.slice(1);
  return commands.filter((command) =>
    command.id.startsWith(query) ||
    command.label.toLowerCase().includes(needle) ||
    command.description.toLowerCase().includes(needle)
  ).sort((a, b) => scoreCommand(a, query, needle) - scoreCommand(b, query, needle));
}

function scoreCommand(command: HomeCommand, query: string, needle: string): number {
  if (command.id.startsWith(query)) return 0;
  if (command.label.toLowerCase().startsWith(needle)) return 1;
  if (command.label.toLowerCase().includes(needle)) return 2;
  return 3;
}

function listMentionSuggestions(cwd: string, input: string): Array<{ path: string; kind: string }> {
  const query = input.startsWith("@") ? input.slice(1).toLowerCase().trim() : "";
  try {
    return readdirSync(cwd)
      .filter((name) => !name.startsWith(".servus") && name !== "node_modules" && name !== "dist")
      .map((name) => {
        const path = join(cwd, name);
        const stat = statSync(path);
        return { path: name, kind: stat.isDirectory() ? "dir" : "file" };
      })
      .filter((item) => !query || item.path.toLowerCase().includes(query))
      .slice(0, 16);
  } catch {
    return [];
  }
}

function resolveBackend(configured: "custom" | "auto", model: string): AgentBackend {
  if (configured !== "auto") return configured;
  return "custom";
}

function isTrusted(config: ServusConfig, cwd: string): boolean {
  const resolved = resolve(cwd);
  if (!existsSync(cwd)) return false;
  return (config.trustedFolders ?? []).some((folder) => resolve(folder) === resolved);
}

function availableProviders(keys: Record<string, boolean>): string {
  const providers = [
    keys.ANTHROPIC_API_KEY ? "anthropic" : "",
    keys.OPENAI_API_KEY ? "openai" : "",
    keys.GOOGLE_GENERATIVE_AI_API_KEY || keys.GOOGLE_API_KEY ? "google" : "",
  ].filter(Boolean);
  return providers.length ? providers.join("/") : "no provider";
}

function shortModel(model: string): string {
  return model
    .replace(/^claude-/, "Provider ")
    .replace(/^gpt-/, "GPT ")
    .replace(/^gemini-/, "Gemini ")
    .slice(0, 24);
}

function formatBackend(backend: ServusConfig["defaultBackend"]): string {
  return backend === "custom" ? "runtime" : backend;
}

function shortPath(path: string): string {
  const home = process.env.HOME;
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}
