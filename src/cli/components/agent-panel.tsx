import React from "react";
import { Box, Text } from "ink";
import { ICONS } from "../theme.js";

export interface AgentStatus {
  name: string;
  color: string;
  status: "idle" | "working" | "done" | "error";
  cost: number;
  lastAction?: string;
}

interface Props {
  agents: AgentStatus[];
}

const STATUS_ICON: Record<AgentStatus["status"], string> = {
  working: ICONS.working,
  idle: ICONS.idle,
  done: ICONS.check,
  error: ICONS.cross,
};

export function AgentPanel({ agents }: Props) {
  return (
    <Box flexDirection="column" gap={0}>
      <Text bold color="cyan" underline>
        TEAM STATUS
      </Text>
      <Text> </Text>
      {agents.map((a) => (
        <Box key={a.name} gap={1}>
          <Text color={a.color}>
            {STATUS_ICON[a.status]}
          </Text>
          <Text color={a.color} bold>
            {a.name.padEnd(10)}
          </Text>
          <Text color="gray">
            {a.status === "working"
              ? "working..."
              : a.status === "done"
                ? `done $${a.cost.toFixed(3)}`
                : a.status === "error"
                  ? "error"
                  : "idle"}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
