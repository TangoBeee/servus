import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { COLORS } from "../theme.js";

export interface CommandItem {
  id: string;
  label: string;
  hint?: string;
  group?: string;
  run: () => void;
}

interface Props {
  items: CommandItem[];
  onClose: () => void;
}

export function CommandPalette({ items, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const filtered = items.filter((item) =>
    `${item.label} ${item.hint ?? ""} ${item.group ?? ""}`.toLowerCase().includes(query.toLowerCase()),
  );
  const safeSelected = Math.min(selected, Math.max(0, filtered.length - 1));

  useInput((input, key) => {
    if (key.escape) onClose();
    if (key.upArrow) setSelected((value) => Math.max(0, value - 1));
    if (key.downArrow) setSelected((value) => Math.min(Math.max(0, filtered.length - 1), value + 1));
    if (key.return && filtered[safeSelected]) {
      filtered[safeSelected].run();
      onClose();
    }
    if (input === "\t" || key.tab) setSelected((value) => (value + 1) % Math.max(1, filtered.length));
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={COLORS.secondary}
      paddingX={1}
      paddingY={0}
    >
      <Box gap={1} justifyContent="space-between">
        <Box gap={1}>
          <Text color={COLORS.secondary} bold>Command</Text>
          <Text color={COLORS.muted}>/</Text>
          <TextInput value={query} onChange={(value) => { setQuery(value); setSelected(0); }} />
        </Box>
        <Text color={COLORS.muted}>type to filter</Text>
      </Box>
      <Text color={COLORS.muted}> </Text>
      {filtered.slice(0, 9).map((item, index) => (
        <Box key={item.id} gap={1}>
          <Text color={index === safeSelected ? COLORS.primary : COLORS.muted}>
            {index === safeSelected ? ">" : " "}
          </Text>
          {item.group && <Text color={index === safeSelected ? COLORS.secondary : COLORS.muted}>{item.group.padEnd(8)}</Text>}
          <Text color={index === safeSelected ? "white" : "gray"} bold={index === safeSelected}>
            {item.label}
          </Text>
          {item.hint && <Text color={COLORS.muted}>{item.hint}</Text>}
        </Box>
      ))}
      {filtered.length === 0 && <Text color="gray">No matching commands</Text>}
      <Text color={COLORS.muted}>Enter run | Esc close | arrows select</Text>
    </Box>
  );
}
