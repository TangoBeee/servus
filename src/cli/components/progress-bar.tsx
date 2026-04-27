import React from "react";
import { Box, Text } from "ink";

interface Props {
  completed: number;
  total: number;
  width?: number;
  label?: string;
}

export function ProgressBar({ completed, total, width = 24, label }: Props) {
  const ratio = total > 0 ? Math.min(completed / total, 1) : 0;
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(empty);

  return (
    <Box gap={1}>
      {label && <Text color="gray">{label}</Text>}
      <Text color="green">{bar}</Text>
      <Text color="white">
        {completed}/{total}
      </Text>
    </Box>
  );
}
