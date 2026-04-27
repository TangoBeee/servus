import React from "react";
import { Box, Text } from "ink";
import { COLORS } from "../theme.js";

interface Metric {
  label: string;
  value: string;
  tone?: "normal" | "good" | "warn" | "bad";
}

interface Props {
  metrics: Metric[];
}

const TONE_COLOR = {
  normal: "white",
  good: COLORS.primary,
  warn: COLORS.accent,
  bad: COLORS.error,
} as const;

export function MetricStrip({ metrics }: Props) {
  return (
    <Box gap={1} flexWrap="wrap">
      {metrics.map((metric) => (
        <Box key={metric.label} borderStyle="single" borderColor="gray" paddingX={1}>
          <Text color={COLORS.muted}>{metric.label}: </Text>
          <Text color={TONE_COLOR[metric.tone ?? "normal"]} bold>{metric.value}</Text>
        </Box>
      ))}
    </Box>
  );
}
