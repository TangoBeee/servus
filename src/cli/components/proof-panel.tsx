import React from "react";
import { Box, Text } from "ink";
import { COLORS } from "../theme.js";

interface Props {
  proofDir?: string;
  artifacts: string[];
}

export function ProofPanel({ proofDir, artifacts }: Props) {
  return (
    <Box flexDirection="column">
      <Text color={COLORS.secondary} bold>Artifacts</Text>
      {proofDir && <Text color="white">Proof: {proofDir}</Text>}
      {artifacts.slice(-8).map((artifact) => (
        <Text key={artifact} color="gray">{artifact}</Text>
      ))}
      {!proofDir && artifacts.length === 0 && <Text color="gray">No artifacts yet.</Text>}
    </Box>
  );
}
