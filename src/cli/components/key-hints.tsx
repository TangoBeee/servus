import React from "react";
import { Box, Text } from "ink";

interface Hint {
  key: string;
  label: string;
}

interface Props {
  hints: Hint[];
}

export function KeyHints({ hints }: Props) {
  return (
    <Box
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      gap={2}
    >
      {hints.map((h) => (
        <Box key={h.key} gap={0}>
          <Text color="green" bold>
            [{h.key}]
          </Text>
          <Text color="gray"> {h.label}</Text>
        </Box>
      ))}
    </Box>
  );
}
