import React, { useEffect, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";
import { COLORS } from "../theme.js";
import type { TuiOverlay } from "../tui-types.js";
import { listModelOptions, getDefaultModelForAvailableProvider } from "../../provider.js";
import { loadConfig, saveConfig } from "../../config.js";
import {
  listMcpPrompts,
  listMcpResources,
  listMcpServerStatuses,
  listMcpTools,
  mcpAuthStatus,
  type McpPromptInfo,
  type McpResource,
  type McpServerStatus,
  type McpToolInfo,
} from "../../mcp-client.js";
import { codingCommandHelp } from "../../coding-commands.js";

interface Props {
  overlay: TuiOverlay;
  cwd: string;
  onClose: () => void;
}

export function TuiOverlayPanel({ overlay, cwd, onClose }: Props) {
  useInput((input, key) => {
    if (key.escape) onClose();
  });
  const { stdout } = useStdout();
  const width = Math.min(92, Math.max(56, Math.floor((stdout?.columns ?? 120) * 0.68)));

  return (
    <Box flexGrow={1} justifyContent="center" alignItems="center">
      <Box width={width} flexDirection="column" borderStyle="single" borderColor={COLORS.blue} paddingX={1} backgroundColor="black">
        <Box justifyContent="space-between">
          <Text color={COLORS.blue} bold>{overlayTitle(overlay)}</Text>
          <Text color="gray">Esc close</Text>
        </Box>
        <Text> </Text>
        {overlay === "help" && <HelpOverlay cwd={cwd} />}
        {overlay === "models" && <ModelsOverlay onClose={onClose} />}
        {overlay === "mcp" && <McpOverlay cwd={cwd} />}
        {overlay === "agents" && <StaticOverlay title="Agents" lines={[
          "Built-in coding helpers: explore, plan, review, verification.",
          "Custom helpers load from .servus/agents and ~/.servus/agents.",
          "Helpers are read-only by default and cannot finalize the main task alone.",
        ]} />}
        {overlay === "tools" && <StaticOverlay title="Tools" lines={[
          "Coding: Read, Write, Edit, MultiEdit, Glob, Grep, LS, Bash, TodoWrite, Task, AskUserQuestion, ExitPlanMode.",
          "Automation: browser, desktop, media, data/docs, security, extension, and MCP tools are available by domain.",
          "Mutating tools are serialized and routed through approvals when risk requires it.",
        ]} />}
        {overlay === "settings" && <StaticOverlay title="Settings" lines={[
          "Global config: ~/.servus/config.json",
          "Project config: .servus/settings.json, .servus/instructions.md, SERVUS.md",
          "MCP config: ~/.servus/mcp.json and project .servus/mcp.json",
        ]} />}
        {overlay === "capabilities" && <StaticOverlay title="Capabilities" lines={[
          "Use /capabilities from the home screen for the detailed readiness view.",
          "Domains: coding, browser, desktop, media, data, security, extension, general.",
          "MCP readiness is based on live server health and tool/resource counts.",
        ]} />}
        {overlay === "sessions" && <StaticOverlay title="Sessions" lines={[
          "Use /sessions from home or the command palette to open the session browser.",
          "Sessions store transcript, events, evidence, artifacts, checkpoints, and final summaries.",
        ]} />}
        {overlay === "diff" && <StaticOverlay title="Diff" lines={[
          "During a coding run, use /diff latest in the composer.",
          "Diffs and checkpoints live inside the Servus session folder.",
        ]} />}
      </Box>
    </Box>
  );
}

function HelpOverlay({ cwd }: { cwd: string }) {
  const lines = [
    "Type a task directly, or use commands in the bottom composer.",
    "",
    "Composer modes",
    "/ commands with autocomplete and Tab completion",
    "@ file mentions from the current folder",
    "! local shell command through Servus permissions",
    "",
    "Slash commands",
    ...codingCommandHelp(cwd).split(/\r?\n/),
  ];
  return (
    <ScrollableLines lines={lines} title="Help" />
  );
}

function ModelsOverlay({ onClose }: { onClose: () => void }) {
  const config = loadConfig();
  const options = listModelOptions();
  const current = getDefaultModelForAvailableProvider(config.defaultModel);
  const [selected, setSelected] = useState(Math.max(0, options.findIndex((option) => option.value === current)));
  const [custom, setCustom] = useState(false);
  const [customValue, setCustomValue] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const listOffset = Math.max(0, Math.min(selected - 10, Math.max(0, options.length - 12)));

  useInput((input, key) => {
    if (custom) {
      if (input.includes("\r") || input.includes("\n")) {
        saveCustom(`${customValue}${input}`.replace(/[\r\n]/g, ""));
      }
      return;
    }
    if (key.upArrow || input.includes("k")) setSelected((value) => Math.max(0, value - countChar(input, "k")));
    if (key.downArrow || input.includes("j")) setSelected((value) => Math.min(Math.max(0, options.length - 1), value + countChar(input, "j")));
    if (input === "c" || input.startsWith("c")) {
      setCustom(true);
      if (input.length > 1) {
        const tail = input.slice(1).replace(/[\r\n]/g, "");
        setCustomValue(tail);
        if (input.includes("\r") || input.includes("\n")) saveCustom(tail);
      }
      return;
    }
    if (key.return && options[selected]) {
      const next = { ...loadConfig(), defaultModel: options[selected].value };
      saveConfig(next);
      setSaved(`Saved ${options[selected].value} as default model.`);
      setTimeout(onClose, 500);
    }
  });

  function saveCustom(value: string) {
    const trimmed = value.trim();
    if (!trimmed) {
      setCustom(false);
      return;
    }
    saveConfig({ ...loadConfig(), defaultModel: trimmed });
    setSaved(`Saved ${trimmed} as default model.`);
    setTimeout(onClose, 500);
  }

  return (
    <Box flexDirection="column">
      <Text color="white">Current: {current}</Text>
      <Text color="gray">Only providers with accessible API keys are listed. Press c for a custom provider:model-id.</Text>
      <Text> </Text>
      <Box height={12} flexDirection="column" overflow="hidden">
        {options.length === 0 && <Text color={COLORS.error}>No API-backed models detected. Press c for custom.</Text>}
        {options.slice(listOffset, listOffset + 12).map((option, index) => {
          const absoluteIndex = listOffset + index;
          const row = [
            option.label.padEnd(24).slice(0, 24),
            option.providerName.padEnd(10).slice(0, 10),
            option.value.padEnd(30).slice(0, 30),
            `$${option.inputPerM}/${option.outputPerM}/MTok`,
            option.recommended ? "recommended" : "",
          ].join("  ");
          return (
          <Text
            key={option.value}
            color={absoluteIndex === selected ? "black" : "gray"}
            backgroundColor={absoluteIndex === selected ? COLORS.accent : undefined}
            wrap="truncate"
          >
            {absoluteIndex === selected ? ">" : " "} {row}
          </Text>
          );
        })}
      </Box>
      {custom && (
        <Box gap={1}>
          <Text color={COLORS.blue}>custom</Text>
          <TextInput
            value={customValue}
            onChange={(next) => setCustomValue(next.replace(/[\r\n]/g, ""))}
            onSubmit={saveCustom}
            placeholder="provider:model-id"
          />
        </Box>
      )}
      {saved && <Text color={COLORS.primary}>{saved}</Text>}
      <Text color="gray">Enter save · j/k select · c custom · Esc close</Text>
    </Box>
  );
}

function McpOverlay({ cwd }: { cwd: string }) {
  const [statuses, setStatuses] = useState<McpServerStatus[]>([]);
  const [tools, setTools] = useState<McpToolInfo[]>([]);
  const [resources, setResources] = useState<McpResource[]>([]);
  const [prompts, setPrompts] = useState<McpPromptInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    Promise.all([
      listMcpServerStatuses(cwd),
      listMcpTools(cwd).catch(() => []),
      listMcpResources(cwd).catch(() => []),
      listMcpPrompts(cwd).catch(() => []),
    ])
      .then(([nextStatuses, nextTools, nextResources, nextPrompts]) => {
        if (!mounted) return;
        setStatuses(nextStatuses);
        setTools(nextTools);
        setResources(nextResources);
        setPrompts(nextPrompts);
      })
      .catch((err: unknown) => {
        if (mounted) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      mounted = false;
    };
  }, [cwd]);

  if (error) return <Text color={COLORS.error}>{error}</Text>;
  return (
    <Box flexDirection="column">
      <Text color="white">MCP config sources: ~/.servus/mcp.json, .servus/mcp.json, Servus config, plugins.</Text>
      <Text color="gray">Commands: /mcp test · /mcp add · /mcp auth status · /mcp tools · /mcp resources · /mcp prompts · /mcp instructions</Text>
      <Text> </Text>
      <Text color={COLORS.secondary} bold>Servers</Text>
      {statuses.length === 0 ? <Text color="gray">No MCP servers configured.</Text> : statuses.map((status) => (
        <Text key={status.name} color={status.status === "ready" ? COLORS.primary : status.status === "error" ? COLORS.error : "gray"} wrap="wrap">
          {status.status === "ready" ? "●" : status.status === "error" ? "×" : status.status === "auth_required" ? "!" : "○"} {status.name} [{status.activeTransport ?? status.transport}/{status.source}] auth {status.authState ?? "none"} tools {status.tools} resources {status.resources} prompts {status.prompts ?? 0}{status.lastProgress ? ` · ${status.lastProgress}` : ""}{status.lastError ? ` - ${status.lastError}` : ""}
        </Text>
      ))}
      <Text color="gray" wrap="wrap">{mcpAuthStatus(cwd).split(/\r?\n/).slice(0, 4).join(" · ")}</Text>
      <Text> </Text>
      <Text color={COLORS.secondary} bold>Tools</Text>
      {tools.slice(0, 12).map((tool) => (
        <Text key={`${tool.server}:${tool.name}`} color="gray" wrap="truncate">- {tool.server}/{tool.name}: {tool.description ?? "no description"}</Text>
      ))}
      {tools.length > 12 && <Text color="gray">... {tools.length - 12} more tools</Text>}
      <Text> </Text>
      <Text color={COLORS.secondary} bold>Resources</Text>
      {resources.slice(0, 8).map((resource) => (
        <Text key={`${resource.server}:${resource.uri}`} color="gray" wrap="truncate">- {resource.server}: {resource.uri}</Text>
      ))}
      {resources.length > 8 && <Text color="gray">... {resources.length - 8} more resources</Text>}
      <Text> </Text>
      <Text color={COLORS.secondary} bold>Prompts</Text>
      {prompts.slice(0, 8).map((prompt) => (
        <Text key={`${prompt.server}:${prompt.name}`} color="gray" wrap="truncate">- {prompt.server}/{prompt.name}: {prompt.description ?? "no description"}</Text>
      ))}
      {prompts.length > 8 && <Text color="gray">... {prompts.length - 8} more prompts</Text>}
    </Box>
  );
}

function StaticOverlay({ title, lines }: { title: string; lines: string[] }) {
  const allLines = [title, "", ...lines.map((line) => `- ${line}`)];
  if (allLines.length > 10) return <ScrollableLines title={title} lines={allLines} />;
  return (
    <Box flexDirection="column">
      <Text color={COLORS.secondary} bold>{title}</Text>
      {lines.map((line) => <Text key={line} color="gray" wrap="wrap">- {line}</Text>)}
    </Box>
  );
}

function ScrollableLines({ title, lines }: { title: string; lines: string[] }) {
  const { stdout } = useStdout();
  const [offset, setOffset] = useState(0);
  const height = Math.max(8, Math.min(22, (stdout?.rows ?? 32) - 10));
  const maxOffset = Math.max(0, lines.length - height);
  const safeOffset = Math.min(offset, maxOffset);

  useInput((input, key) => {
    if (key.downArrow || input.includes("j")) setOffset((value) => Math.min(maxOffset, value + countChar(input, "j")));
    if (key.upArrow || input.includes("k")) setOffset((value) => Math.max(0, value - countChar(input, "k")));
    if (key.pageDown) setOffset((value) => Math.min(maxOffset, value + height));
    if (key.pageUp) setOffset((value) => Math.max(0, value - height));
  });

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text color={COLORS.secondary} bold>{title}</Text>
        <Text color="gray">{safeOffset + 1}-{Math.min(lines.length, safeOffset + height)}/{lines.length} j/k scroll</Text>
      </Box>
      <Box height={height} flexDirection="column" overflow="hidden">
        {lines.slice(safeOffset, safeOffset + height).map((line, index) => (
          <Text key={`${safeOffset}:${index}:${line}`} color={line.endsWith(":") || /^[A-Z][A-Za-z ]+$/.test(line) ? COLORS.secondary : "gray"} wrap="truncate">
            {line || " "}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function countChar(value: string, char: string): number {
  const count = [...value].filter((item) => item === char).length;
  return Math.max(1, count);
}

function overlayTitle(overlay: TuiOverlay): string {
  return overlay
    .split("-")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}
