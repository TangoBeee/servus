import React from "react";
import { Box, Text } from "ink";
import { formatDuration } from "../../log.js";

interface Props {
  task: string;
  phase: string;
  elapsed: number;
  cost: number;
  completed: number;
  total: number;
}

export function StatusLine({ task, phase, elapsed, cost, completed, total }: Props) {
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Box gap={1}>
        <Text color="green" bold>
          Task:
        </Text>
        <Text color="white">
          {task.length > 40 ? task.slice(0, 40) + "..." : task}
        </Text>
      </Box>
      <Box gap={2}>
        <Text color="cyan">
          {phase}
        </Text>
        <Text color="yellow">
          {completed}/{total} tasks
        </Text>
        <Text color="gray">
          {formatDuration(elapsed)}
        </Text>
        <Text color="green">
          ${cost.toFixed(4)}
        </Text>
      </Box>
    </Box>
  );
}
