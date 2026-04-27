import React from "react";
import { Box, Text } from "ink";
import { COLORS, ICONS } from "../theme.js";

interface HeaderProps {
  title?: string;
  right?: string;
}

export function Header({ title, right }: HeaderProps) {
  return (
    <Box
      borderStyle="single"
      borderColor={COLORS.primary}
      paddingX={1}
      justifyContent="space-between"
    >
      <Box gap={1}>
        <Text color={COLORS.primary} bold>
          SERVUS
        </Text>
        <Text color={COLORS.muted}>{ICONS.separator}</Text>
        <Text color={COLORS.secondary}>{title ?? "Dashboard"}</Text>
      </Box>
      {right && <Text color={COLORS.muted}>{right}</Text>}
    </Box>
  );
}
