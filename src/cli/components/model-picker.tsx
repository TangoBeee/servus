import React from "react";
import { Box, Text } from "ink";
import { COLORS } from "../theme.js";
import type { ModelOption } from "../../provider.js";

interface Props {
  options: ModelOption[];
  selected: number;
  currentModel: string;
  title?: string;
  allowCustom?: boolean;
}

export function ModelPicker({
  options,
  selected,
  currentModel,
  title = "Choose Model",
  allowCustom = true,
}: Props) {
  const groups = groupOptions(options);
  let cursor = 0;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={COLORS.secondary} paddingX={1} marginBottom={1}>
      <Box justifyContent="space-between">
        <Text color={COLORS.secondary} bold>{title}</Text>
        <Text color={COLORS.muted}>provider-aware</Text>
      </Box>
      {options.length === 0 && (
        <Text color={COLORS.error}>No API-backed models detected. Add a provider key or choose Custom.</Text>
      )}

      {groups.map((group) => (
        <Box key={group.provider} flexDirection="column">
          <Text color={providerColor(group.provider)} bold>{group.providerName}</Text>
          {group.options.map((option) => {
            const index = cursor++;
            return (
              <Box key={option.value} gap={1}>
                <Text color={index === selected ? COLORS.primary : COLORS.muted}>
                  {index === selected ? ">" : " "}
                </Text>
                <Text color={index === selected ? "white" : "gray"} bold={index === selected}>
                  {option.label}
                </Text>
                <Text color={COLORS.muted}>{option.id}</Text>
                <Text color={COLORS.muted}>{formatPricing(option)}</Text>
                {option.value === currentModel && <Text color={COLORS.primary}>current</Text>}
                {option.recommended && <Text color={COLORS.accent}>recommended</Text>}
              </Box>
            );
          })}
        </Box>
      ))}

      {allowCustom && (
        <Box gap={1}>
          <Text color={selected === options.length ? COLORS.primary : COLORS.muted}>
            {selected === options.length ? ">" : " "}
          </Text>
          <Text color={selected === options.length ? "white" : "gray"} bold={selected === options.length}>
            Custom model...
          </Text>
          <Text color={COLORS.muted}>provider:model-id</Text>
        </Box>
      )}

      <Text color={COLORS.muted}>j/k select | Enter choose | c custom | Esc cancel</Text>
    </Box>
  );
}

function formatPricing(option: ModelOption): string {
  return `$${option.inputPerM}/$${option.outputPerM}/MTok`;
}

function groupOptions(options: ModelOption[]): Array<{
  provider: string;
  providerName: string;
  options: ModelOption[];
}> {
  const groups = new Map<string, { provider: string; providerName: string; options: ModelOption[] }>();
  for (const option of options) {
    const group = groups.get(option.provider) ?? {
      provider: option.provider,
      providerName: option.providerName,
      options: [],
    };
    group.options.push(option);
    groups.set(option.provider, group);
  }
  return [...groups.values()];
}

function providerColor(provider: string): string {
  if (provider === "openai") return COLORS.primary;
  if (provider === "anthropic") return COLORS.violet;
  if (provider === "google") return COLORS.secondary;
  return COLORS.accent;
}
