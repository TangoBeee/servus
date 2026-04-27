import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { COLORS } from "../theme.js";
import { ModelPicker } from "../components/model-picker.js";
import { getApiKeyStatus, loadConfig } from "../../config.js";
import { loadSkills } from "../../skills.js";
import { loadPlugins } from "../../plugins.js";
import {
  getDefaultModelForAvailableProvider,
  hasProviderAccess,
  inferProviderForModel,
  listModelOptions,
} from "../../provider.js";
import type { AgentBackend } from "../../agent.js";
import type { TaskDomain } from "../../engine.js";

type DomainChoice = "auto" | TaskDomain;
type BackendChoice = "auto" | AgentBackend;
type Field =
  | "task"
  | "domain"
  | "model"
  | "backend"
  | "cwd"
  | "budget"
  | "verify"
  | "browser"
  | "runMode";

export interface TaskConfig {
  task: string;
  backend: AgentBackend;
  domainMode: DomainChoice;
  model: string;
  cwd: string;
  maxFailures: number;
  budget?: number;
  verifyCommand?: string;
  browserHeadless: boolean;
  runInBackground: boolean;
}

interface Props {
  onSubmit: (config: TaskConfig) => void;
  onBack: () => void;
  onInputLockedChange?: (locked: boolean) => void;
  inputBlocked?: boolean;
}

const FIELDS: Array<{ id: Field; label: string; help: string; group: string }> = [
  { id: "task", label: "Task", help: "What should Servus do?", group: "Start" },
  { id: "domain", label: "Mode", help: "auto/coding/browser/desktop/media/data/extension/security/general", group: "Start" },
  { id: "model", label: "Model", help: "Choose from available provider models", group: "Provider" },
  { id: "backend", label: "Backend", help: "auto/custom/claude-code when available", group: "Provider" },
  { id: "cwd", label: "Folder", help: "Working directory", group: "Context" },
  { id: "budget", label: "Budget", help: "Optional USD cap", group: "Context" },
  { id: "verify", label: "Verify", help: "Optional verification command", group: "Context" },
  { id: "browser", label: "Browser", help: "Visible browser or headless", group: "Run" },
  { id: "runMode", label: "Run", help: "Foreground dashboard or background job", group: "Run" },
];

const DOMAIN_CHOICES: DomainChoice[] = [
  "auto",
  "coding",
  "browser",
  "desktop",
  "media",
  "data",
  "extension",
  "security",
  "general",
];

export function NewTask({ onSubmit, onBack, onInputLockedChange, inputBlocked = false }: Props) {
  const cfg = loadConfig();
  const initialModel = getDefaultModelForAvailableProvider(cfg.defaultModel);
  const [selected, setSelected] = useState(0);
  const [editing, setEditing] = useState<Field | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelSelected, setModelSelected] = useState(0);
  const [task, setTask] = useState("");
  const [domainMode, setDomainMode] = useState<DomainChoice>("auto");
  const [backend, setBackend] = useState<BackendChoice>(normalizeBackendChoice(cfg.defaultBackend, initialModel));
  const [model, setModel] = useState(initialModel);
  const [cwd, setCwd] = useState(process.cwd());
  const [budget, setBudget] = useState(cfg.budget === undefined ? "" : String(cfg.budget));
  const [verifyCommand, setVerifyCommand] = useState(cfg.verifyCommand ?? "");
  const [browserHeadless, setBrowserHeadless] = useState(cfg.browser?.headless ?? false);
  const [runInBackground, setRunInBackground] = useState(false);

  const readiness = useMemo(() => {
    const keys = getApiKeyStatus();
    const skills = loadSkills({ cwd, extraDirs: cfg.skills?.dirs });
    const plugins = loadPlugins({ cwd, extraDirs: cfg.plugins?.dirs, disabled: cfg.plugins?.disabled });
    const mcpCount = Object.keys(cfg.mcpServers ?? {}).length;
    const availableKeys = Object.values(keys).filter(Boolean).length;
    return { keys, skills: skills.length, plugins: plugins.length, mcpCount, availableKeys };
  }, [cwd]);
  const modelOptions = useMemo(() => listModelOptions(), []);
  const backendChoices = useMemo(() => availableBackendChoices(model), [model]);

  useEffect(() => {
    if (!backendChoices.includes(backend)) setBackend(backendChoices[0] ?? "auto");
  }, [backend, backendChoices]);

  useEffect(() => {
    onInputLockedChange?.(!!editing || modelPickerOpen);
    return () => onInputLockedChange?.(false);
  }, [editing, modelPickerOpen, onInputLockedChange]);

  useInput((input, key) => {
    if (modelPickerOpen) {
      if (key.escape) {
        setModelPickerOpen(false);
        return;
      }
      if (key.upArrow || input === "k") setModelSelected((value) => Math.max(0, value - 1));
      if (key.downArrow || input === "j" || input === "\t" || key.tab) {
        setModelSelected((value) => Math.min(modelOptions.length, value + 1));
      }
      if (input === "c") {
        setModelPickerOpen(false);
        beginEdit("model");
        return;
      }
      if (key.return) {
        const option = modelOptions[modelSelected];
        if (option) {
          setModel(option.value);
          setBackend((value) => normalizeBackendChoice(value, option.value));
        } else {
          beginEdit("model");
        }
        setModelPickerOpen(false);
        return;
      }
      return;
    }

    if (editing) {
      if (key.escape) {
        setEditing(null);
        setEditDraft("");
      }
      return;
    }

    if (key.escape || input === "b") onBack();
    if (key.upArrow || input === "k") setSelected((value) => Math.max(0, value - 1));
    if (key.downArrow || input === "j" || input === "\t" || key.tab) {
      setSelected((value) => Math.min(FIELDS.length - 1, value + 1));
    }
    if (input === "r") submit();
    if (key.return) activate(FIELDS[selected].id);
  }, { isActive: !inputBlocked });

  const currentField = FIELDS[selected];

  function activate(field: Field) {
    if (field === "domain") {
      setDomainMode((value) => nextChoice(DOMAIN_CHOICES, value));
    } else if (field === "backend") {
      setBackend((value) => nextChoice(backendChoices, value));
    } else if (field === "browser") {
      setBrowserHeadless((value) => !value);
    } else if (field === "runMode") {
      setRunInBackground((value) => !value);
    } else if (field === "model") {
      const index = modelOptions.findIndex((option) => option.value === model);
      setModelSelected(index === -1 ? 0 : index);
      setModelPickerOpen(true);
    } else {
      beginEdit(field);
    }
  }

  function submit() {
    if (!task.trim()) {
      setSelected(0);
      beginEdit("task");
      return;
    }

    const resolvedBackend = resolveBackend(backend, model);
    const parsedBudget = budget.trim() ? Number(budget) : undefined;
    onSubmit({
      task: task.trim(),
      backend: resolvedBackend,
      domainMode,
      model: model.trim(),
      cwd: cwd.trim() || process.cwd(),
      maxFailures: cfg.maxFailures,
      budget: Number.isFinite(parsedBudget) ? parsedBudget : undefined,
      verifyCommand: verifyCommand.trim() || undefined,
      browserHeadless,
      runInBackground,
    });
  }

  function commitText(value: string) {
    if (editing === "task") setTask(value);
    if (editing === "model") {
      setModel(value);
      setBackend((current) => normalizeBackendChoice(current, value));
    }
    if (editing === "cwd") setCwd(value);
    if (editing === "budget") setBudget(value);
    if (editing === "verify") setVerifyCommand(value);
    setEditing(null);
    setEditDraft("");
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box marginBottom={1} flexDirection="column">
        <Text color={COLORS.primary} bold>Launchpad</Text>
        <Text color="gray">Start with plain language. Servus filters models by available API keys and keeps risky options explicit.</Text>
      </Box>

      <Box gap={1} marginBottom={1}>
        <StatusPill label="Task" value={task.trim() ? "ready" : "needed"} ok={!!task.trim()} />
        <StatusPill label="Provider" value={providerLabel(model)} ok={modelOptions.length > 0 || model.includes(":")} />
        <StatusPill label="Mode" value={domainMode} ok />
        <StatusPill label="Run" value={runInBackground ? "background" : "foreground"} ok />
      </Box>

      <Box gap={1} flexGrow={1}>
        <Box flexDirection="column" flexGrow={1}>
          {modelPickerOpen && (
            <ModelPicker
              options={modelOptions}
              selected={modelSelected}
              currentModel={model}
              title="Select Available Model"
            />
          )}

          {FIELDS.map((field, index) => {
            const previous = FIELDS[index - 1];
            const showGroup = !previous || previous.group !== field.group;
            return (
              <React.Fragment key={field.id}>
                {showGroup && <Text color={COLORS.secondary} bold>{field.group}</Text>}
                <Box gap={1}>
                  <Text color={index === selected ? COLORS.primary : COLORS.muted}>
                    {index === selected ? ">" : " "}
                  </Text>
                  <Text color={index === selected ? "white" : "gray"} bold={index === selected}>
                    {field.label.padEnd(10)}
                  </Text>
                  {editing === field.id ? (
                    <Box flexGrow={1}>
                      <Text color={COLORS.secondary}> </Text>
                      <TextInput
                        value={editDraft}
                        onChange={setEditDraft}
                        onSubmit={commitText}
                        placeholder={field.help}
                      />
                    </Box>
                  ) : (
                    <Text color={field.id === "model" ? COLORS.secondary : "white"} wrap="truncate">
                      {displayValue(field.id)}
                    </Text>
                  )}
                </Box>
              </React.Fragment>
            );
          })}
        </Box>

        <Box width={42} flexDirection="column" borderStyle="round" borderColor={readiness.availableKeys > 0 ? COLORS.primary : COLORS.error} paddingX={1}>
          <Text color={COLORS.secondary} bold>Ready Check</Text>
          <Text color={readiness.availableKeys > 0 ? COLORS.primary : COLORS.error}>
            API keys: {readiness.availableKeys}/{Object.keys(readiness.keys).length}
          </Text>
          {Object.entries(readiness.keys).map(([key, ok]) => (
            <Text key={key} color={ok ? "green" : "gray"}>{ok ? "ok" : "--"} {shortKeyName(key)}</Text>
          ))}
          <Text color="white">Skills: {readiness.skills}</Text>
          <Text color="white">Plugins: {readiness.plugins}</Text>
          <Text color="white">MCP servers: {readiness.mcpCount}</Text>
          <Text color="white">Models shown: {modelOptions.length || "none"}</Text>
          <Text color="gray">Unavailable providers stay hidden from the picker.</Text>
          <Text> </Text>
          <Text color={COLORS.secondary} bold>Current Control</Text>
          <Text color="gray">{currentField.label}: {currentField.help}</Text>
          {currentField.id === "model" && <Text color="gray">Enter opens a real picker; c enters a custom id.</Text>}
          {editing && <Text color={COLORS.accent}>Esc cancels edit</Text>}
          {modelPickerOpen && <Text color={COLORS.accent}>Enter selects, c custom, Esc closes</Text>}
          <Text> </Text>
          <Text color={COLORS.primary}>Press r to run</Text>
        </Box>
      </Box>
    </Box>
  );

  function beginEdit(field: Field): void {
    setEditing(field);
    setEditDraft(fieldValue(field));
  }

  function fieldValue(field: Field): string {
    if (field === "task") return task;
    if (field === "model") return model;
    if (field === "cwd") return cwd;
    if (field === "budget") return budget;
    if (field === "verify") return verifyCommand;
    return "";
  }

  function displayValue(field: Field): string {
    if (field === "task") return task || "(enter task prompt)";
    if (field === "domain") return domainMode;
    if (field === "backend") return `${backend} -> ${resolveBackend(backend, model)}`;
    if (field === "model") return model;
    if (field === "cwd") return cwd;
    if (field === "budget") return budget || "(none)";
    if (field === "verify") return verifyCommand || "(auto)";
    if (field === "browser") return browserHeadless ? "headless" : "visible browser";
    if (field === "runMode") return runInBackground ? "background" : "foreground dashboard";
    return "";
  }
}

function StatusPill({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <Box borderStyle="single" borderColor={ok ? COLORS.primary : COLORS.error} paddingX={1}>
      <Text color={COLORS.muted}>{label}: </Text>
      <Text color={ok ? COLORS.primary : COLORS.error} bold>{value}</Text>
    </Box>
  );
}

function shortKeyName(key: string): string {
  return key
    .replace("ANTHROPIC_API_KEY", "Anthropic")
    .replace("OPENAI_API_KEY", "OpenAI")
    .replace("GOOGLE_GENERATIVE_AI_API_KEY", "Google GenAI")
    .replace("GOOGLE_API_KEY", "Google API");
}

function nextChoice<T>(choices: T[], current: T): T {
  const index = choices.indexOf(current);
  return choices[(index + 1) % choices.length] ?? choices[0];
}

function availableBackendChoices(model: string): BackendChoice[] {
  const provider = inferProviderForModel(model);
  const choices: BackendChoice[] = ["auto", "custom"];
  if ((provider === "anthropic" || !provider) && hasProviderAccess("anthropic")) {
    choices.push("claude-code");
  }
  return choices;
}

function normalizeBackendChoice(backend: BackendChoice, model: string): BackendChoice {
  if (backend === "claude-code" && !availableBackendChoices(model).includes("claude-code")) {
    return "auto";
  }
  return backend;
}

function resolveBackend(backend: BackendChoice, model: string): AgentBackend {
  if (backend !== "auto") return backend;
  const provider = inferProviderForModel(model);
  if (provider === "anthropic" && hasProviderAccess("anthropic") && !model.includes(":")) {
    return "claude-code";
  }
  return "custom";
}

function providerLabel(model: string): string {
  const provider = inferProviderForModel(model);
  if (provider === "openai") return "OpenAI";
  if (provider === "anthropic") return "Anthropic";
  if (provider === "google") return "Google";
  if (provider === "openai-compatible") return "Compatible";
  return "Custom";
}
