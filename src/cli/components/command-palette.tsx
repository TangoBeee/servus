import React, { useEffect, useState } from "react";
import { Box, Text, useInput, useStdout } from "ink";
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
  const { stdout } = useStdout();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const normalizedQuery = query.trim().replace(/^\//, "").toLowerCase();
  const filtered = items.filter((item) =>
    !normalizedQuery ||
    `${item.id} ${item.label} ${item.hint ?? ""} ${item.group ?? ""}`.toLowerCase().includes(normalizedQuery),
  );
  const safeSelected = Math.min(selected, Math.max(0, filtered.length - 1));
  const visibleCount = 9;
  const offset = Math.max(0, Math.min(safeSelected - visibleCount + 1, Math.max(0, filtered.length - visibleCount)));

  useEffect(() => {
    setSelected((value) => {
      if (filtered.length <= 0) return 0;
      return Math.max(0, Math.min(value, filtered.length - 1));
    });
  }, [filtered.length]);

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

  const width = Math.min(78, Math.max(48, Math.floor((stdout?.columns ?? 100) * 0.5)));

  return (
    <Box justifyContent="center" marginTop={1}>
      <Box
        width={width}
        flexDirection="column"
        borderStyle="single"
        borderColor={COLORS.blue}
        paddingX={1}
        backgroundColor="black"
      >
        <Box gap={1} justifyContent="space-between">
          <Box gap={1}>
            <Text color={COLORS.blue} bold>commands</Text>
            <Text color={COLORS.muted}>/</Text>
            <TextInput value={query} onChange={(value) => { setQuery(value); setSelected(0); }} />
          </Box>
          <Text color={COLORS.muted}>Esc close</Text>
        </Box>
        <Text color={COLORS.muted}> </Text>
        <Box height={10} flexDirection="column" overflow="hidden">
          {filtered.slice(offset, offset + visibleCount).map((item, localIndex) => {
            const index = offset + localIndex;
            return (
            <Text
              key={item.id}
              color={index === safeSelected ? "black" : "gray"}
              backgroundColor={index === safeSelected ? COLORS.accent : undefined}
              wrap="truncate"
            >
              {formatCommandRow(item, index === safeSelected)}
            </Text>
            );
          })}
          {filtered.length === 0 && <Text color="gray">No matching commands</Text>}
        </Box>
        <Text color={COLORS.muted}>Enter run · arrows select · Tab next</Text>
      </Box>
    </Box>
  );
}

function formatCommandRow(item: CommandItem, selected: boolean): string {
  const pointer = selected ? ">" : " ";
  const group = (item.group ?? "").padEnd(10).slice(0, 10);
  const label = item.label.padEnd(18).slice(0, 18);
  const hint = item.hint ?? "";
  return `${pointer} ${group} ${label} ${hint}`;
}
