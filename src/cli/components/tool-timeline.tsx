import React from "react";
import { Box, Text } from "ink";
import { COLORS } from "../theme.js";
import type { ToolActivity } from "../state/run-store.js";

interface Props {
  tools: ToolActivity[];
}

export function ToolTimeline({ tools }: Props) {
  const visible = tools.slice(-12);
  return (
    <Box flexDirection="column">
      <Text color={COLORS.secondary} bold>Tool Timeline</Text>
      {visible.length === 0 && <Text color="gray">No tool activity yet.</Text>}
      {visible.map((item) => (
        <Box key={item.id} gap={1}>
          <Text color={item.status === "running" ? COLORS.accent : item.status === "failed" ? COLORS.error : COLORS.primary}>
            {item.status === "running" ? "*" : item.status === "failed" ? "x" : "o"}
          </Text>
          <Text color="white">{item.tool}</Text>
          <Text color={COLORS.muted}>{item.agent ?? "runtime"}</Text>
          <Text color={COLORS.muted}>{item.preview}</Text>
        </Box>
      ))}
    </Box>
  );
}
