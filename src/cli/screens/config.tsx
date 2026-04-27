import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { COLORS } from "../theme.js";
import { ModelPicker } from "../components/model-picker.js";
import {
  getApiKeyStatus,
  loadConfig,
  saveConfig,
  type ServusConfig,
} from "../../config.js";
import { getDefaultModelForAvailableProvider, listModelOptions } from "../../provider.js";

interface Props {
  onBack: () => void;
  onInputLockedChange?: (locked: boolean) => void;
  inputBlocked?: boolean;
}

type FieldId =
  | "defaultModel"
  | "defaultBackend"
  | "maxFailures"
  | "budget"
  | "verifyCommand"
  | "providerUrl"
  | "browser.headless"
  | "browser.timeoutMs"
  | "skills.enabled"
  | "plugins.enabled"
  | "memory.enabled";

interface Field {
  id: FieldId;
  group: string;
  label: string;
  kind: "text" | "number" | "toggle" | "backend" | "model";
}

const FIELDS: Field[] = [
  { id: "defaultModel", group: "Providers", label: "Default Model", kind: "model" },
  { id: "defaultBackend", group: "Providers", label: "Default Backend", kind: "backend" },
  { id: "providerUrl", group: "Providers", label: "Provider URL", kind: "text" },
  { id: "maxFailures", group: "Runtime", label: "Max Failures", kind: "number" },
  { id: "budget", group: "Runtime", label: "Budget USD", kind: "number" },
  { id: "verifyCommand", group: "Runtime", label: "Verify Command", kind: "text" },
  { id: "browser.headless", group: "Browser", label: "Headless", kind: "toggle" },
  { id: "browser.timeoutMs", group: "Browser", label: "Timeout MS", kind: "number" },
  { id: "skills.enabled", group: "Extensions", label: "Skills Enabled", kind: "toggle" },
  { id: "plugins.enabled", group: "Extensions", label: "Plugins Enabled", kind: "toggle" },
  { id: "memory.enabled", group: "Memory", label: "Memory Enabled", kind: "toggle" },
];

const BACKENDS: ServusConfig["defaultBackend"][] = ["auto", "claude-code", "custom"];

export function ConfigScreen({ onBack, onInputLockedChange, inputBlocked = false }: Props) {
  const [config, setConfig] = useState(loadConfig);
  const [selected, setSelected] = useState(0);
  const [editing, setEditing] = useState<FieldId | null>(null);
  const [editValue, setEditValue] = useState("");
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelSelected, setModelSelected] = useState(0);
  const [saved, setSaved] = useState(false);
  const keys = getApiKeyStatus();
  const models = listModelOptions();
  const effectiveDefault = getDefaultModelForAvailableProvider(config.defaultModel);

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
        setModelSelected((value) => Math.min(models.length, value + 1));
      }
      if (input === "c") {
        setModelPickerOpen(false);
        setEditing("defaultModel");
        setEditValue(String(config.defaultModel ?? effectiveDefault));
        return;
      }
      if (key.return) {
        const option = models[modelSelected];
        if (option) updateField("defaultModel", option.value);
        else {
          setEditing("defaultModel");
          setEditValue(String(config.defaultModel ?? effectiveDefault));
        }
        setModelPickerOpen(false);
        return;
      }
      return;
    }

    if (editing) {
      if (key.escape) {
        setEditing(null);
        setEditValue("");
      }
      return;
    }
    if (key.escape || input === "b" || input === "q") onBack();
    if (key.upArrow || input === "k") setSelected((value) => Math.max(0, value - 1));
    if (key.downArrow || input === "j" || input === "\t" || key.tab) setSelected((value) => Math.min(FIELDS.length - 1, value + 1));
    if (key.return || input === "e") activate(FIELDS[selected]);
  }, { isActive: !inputBlocked });

  function activate(field: Field) {
    if (field.kind === "toggle") {
      updateField(field.id, !Boolean(getValue(config, field.id)));
      return;
    }
    if (field.kind === "backend") {
      const current = config.defaultBackend;
      const choices = availableDefaultBackends();
      const index = choices.indexOf(current);
      updateField(field.id, choices[(index + 1) % choices.length] ?? "auto");
      return;
    }
    if (field.kind === "model") {
      const current = String(getValue(config, field.id) ?? effectiveDefault);
      const index = models.findIndex((model) => model.value === current);
      setModelSelected(index === -1 ? 0 : index);
      setModelPickerOpen(true);
      return;
    }
    setEditing(field.id);
    setEditValue(String(getValue(config, field.id) ?? ""));
  }

  function saveEdit(value: string) {
    if (!editing) return;
    const field = FIELDS.find((item) => item.id === editing);
    const nextValue = field?.kind === "number"
      ? value.trim() ? Number(value) : undefined
      : value.trim() || undefined;
    updateField(editing, nextValue);
    setEditing(null);
  }

  function updateField(field: FieldId, value: unknown) {
    const next = setValue(config, field, value);
    setConfig(next);
    saveConfig(next);
    setSaved(true);
    setTimeout(() => setSaved(false), 1600);
  }

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text color={COLORS.primary} bold>Settings</Text>
      <Text color="gray">Provider-aware defaults and safe runtime switches. Enter/e edits, toggles cycle immediately, Esc cancels.</Text>
      <Text> </Text>

      <Box gap={1}>
        <Box flexDirection="column" flexGrow={1}>
          {modelPickerOpen && (
            <ModelPicker
              title="Default Model"
              options={models}
              selected={modelSelected}
              currentModel={String(config.defaultModel ?? effectiveDefault)}
            />
          )}
          {FIELDS.map((field, index) => {
            const previous = FIELDS[index - 1];
            const showGroup = !previous || previous.group !== field.group;
            return (
              <React.Fragment key={field.id}>
                {showGroup && <Text color={COLORS.secondary} bold>{field.group}</Text>}
                <Box gap={1}>
                  <Text color={index === selected ? COLORS.primary : COLORS.muted}>{index === selected ? ">" : " "}</Text>
                  <Text color={index === selected ? "white" : "gray"} bold={index === selected}>
                    {field.label.padEnd(18)}
                  </Text>
                  {editing === field.id ? (
                    <TextInput value={editValue} onChange={setEditValue} onSubmit={saveEdit} />
                  ) : (
                    <Text color={field.id === "defaultModel" ? COLORS.secondary : "gray"}>
                      {formatValue(getValue(config, field.id))}
                    </Text>
                  )}
                </Box>
              </React.Fragment>
            );
          })}
        </Box>

        <Box width={38} flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
          <Text color={COLORS.secondary} bold>Provider Keys</Text>
          {Object.entries(keys).map(([key, ok]) => (
            <Text key={key} color={ok ? COLORS.primary : COLORS.error}>{ok ? "ok" : "--"} {key}</Text>
          ))}
          <Text> </Text>
          <Text color={COLORS.secondary} bold>Model Defaults</Text>
          <Text color="gray">Configured: {config.defaultModel}</Text>
          <Text color={COLORS.primary}>Effective: {effectiveDefault}</Text>
          <Text color="gray">Available choices: {models.length}</Text>
          <Text> </Text>
          <Text color={COLORS.secondary} bold>Config File</Text>
          <Text color="gray">~/.servus/config.json</Text>
          <Text> </Text>
          {saved && <Text color={COLORS.primary}>Saved.</Text>}
        </Box>
      </Box>
    </Box>
  );
}

function getValue(config: ServusConfig, field: FieldId): unknown {
  if (field === "browser.headless") return config.browser?.headless ?? false;
  if (field === "browser.timeoutMs") return config.browser?.timeoutMs ?? 30_000;
  if (field === "skills.enabled") return config.skills?.enabled ?? true;
  if (field === "plugins.enabled") return config.plugins?.enabled ?? true;
  if (field === "memory.enabled") return config.memory?.enabled ?? false;
  return config[field];
}

function setValue(config: ServusConfig, field: FieldId, value: unknown): ServusConfig {
  const next: ServusConfig = { ...config };
  if (field === "browser.headless") next.browser = { ...next.browser, headless: Boolean(value) };
  else if (field === "browser.timeoutMs") next.browser = { ...next.browser, timeoutMs: Number(value) || 30_000 };
  else if (field === "skills.enabled") next.skills = { ...next.skills, enabled: Boolean(value) };
  else if (field === "plugins.enabled") next.plugins = { ...next.plugins, enabled: Boolean(value) };
  else if (field === "memory.enabled") next.memory = { ...next.memory, enabled: Boolean(value) };
  else (next as unknown as Record<string, unknown>)[field] = value;
  return next;
}

function formatValue(value: unknown): string {
  if (value === undefined || value === "") return "(not set)";
  if (typeof value === "boolean") return value ? "enabled" : "disabled";
  return String(value);
}

function availableDefaultBackends(): ServusConfig["defaultBackend"][] {
  return process.env.ANTHROPIC_API_KEY ? BACKENDS : ["auto", "custom"];
}
