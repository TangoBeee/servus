import React, { type ReactNode } from "react";
import { Box, useStdout } from "ink";
import type { Screen } from "../screens/main-menu.js";

interface Props {
  screen?: Screen;
  title?: string;
  right?: string;
  children: ReactNode;
  onNavigate?: (screen: Screen) => void;
  footerHints?: Array<{ key: string; label: string }>;
  activeRun?: boolean;
  celebrate?: boolean;
}

export function Shell({
  children,
}: Props) {
  const { stdout } = useStdout();
  const width = Math.max(80, stdout?.columns ?? 120);
  const height = Math.max(24, stdout?.rows ?? 36);

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      paddingX={1}
      backgroundColor="black"
      overflow="hidden"
    >
      {children}
    </Box>
  );
}
