import React, { type ReactNode, useEffect, useState } from "react";
import { Box, Text, useStdout } from "ink";
import { COLORS, SCREEN_ACCENTS } from "../theme.js";
import { NavRail } from "../components/nav-rail.js";
import { KeyHints } from "../components/key-hints.js";
import { Mascot } from "../components/mascot.js";
import type { Screen } from "../screens/main-menu.js";

interface Props {
  screen: Screen;
  title: string;
  right?: string;
  children: ReactNode;
  onNavigate: (screen: Screen) => void;
  footerHints?: Array<{ key: string; label: string }>;
  activeRun?: boolean;
  celebrate?: boolean;
}

export function Shell({
  screen,
  title,
  right,
  children,
  onNavigate,
  footerHints = [],
  activeRun = false,
  celebrate = false,
}: Props) {
  const { stdout } = useStdout();
  const isTTY = stdout?.isTTY ?? false;
  const width = stdout?.columns ?? 100;
  const [tick, setTick] = useState(0);
  const accent = SCREEN_ACCENTS[normalize(screen)] ?? COLORS.primary;

  useEffect(() => {
    if (!isTTY) return;
    const timer = setInterval(() => setTick((value) => value + 1), 420);
    return () => clearInterval(timer);
  }, [isTTY]);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box borderStyle="round" borderColor={accent} paddingX={1} justifyContent="space-between">
        <Box gap={1}>
          <Text color={accent} bold>SERVUS</Text>
          <Text color={COLORS.muted}>|</Text>
          <Text color={COLORS.secondary} bold={activeRun}>{title}</Text>
          <Text color={COLORS.muted}>|</Text>
          <Text color={activeRun ? COLORS.primary : COLORS.muted}>
            {activeRun ? `${pulse(tick)} active run` : isTTY ? "operator console" : "plain mode"}
          </Text>
          {celebrate && width >= 86 && (
            <>
              <Text color={COLORS.muted}>|</Text>
              <Text color={COLORS.accent}>hidden console unlocked</Text>
            </>
          )}
        </Box>
        <Box gap={2}>
          {width >= 72 && <Mascot tick={tick} active={isTTY} celebrate={celebrate} />}
          {right && <Text color={COLORS.muted}>{right}</Text>}
        </Box>
      </Box>

      {isTTY && width >= 72 && (
        <Box paddingX={1} justifyContent="space-between">
          <Text color={COLORS.muted}>{scanline(tick, Math.min(38, Math.max(18, Math.floor(width / 4))))}</Text>
          <Text color={accent}>{modeHint(screen)}</Text>
        </Box>
      )}

      <Box flexGrow={1}>
        {width >= 68 && <NavRail active={screen} onNavigate={onNavigate} tick={tick} accent={accent} activeRun={activeRun} />}
        <Box flexDirection="column" flexGrow={1} paddingX={1}>
          {children}
        </Box>
      </Box>

      <Box borderStyle="single" borderColor={celebrate ? COLORS.accent : "gray"} paddingX={1}>
        <KeyHints
          hints={[
            { key: "1-7", label: "switch views" },
            { key: "Ctrl+K", label: "command palette" },
            ...footerHints,
          ]}
        />
      </Box>
    </Box>
  );
}

function normalize(screen: Screen): Screen {
  if (screen === "menu" || screen === "new-task") return "launchpad";
  if (screen === "dashboard") return "live-run";
  if (screen === "config") return "settings";
  return screen;
}

function pulse(tick: number): string {
  return tick % 2 === 0 ? "*" : ".";
}

function scanline(tick: number, width: number): string {
  const pos = tick % Math.max(1, width);
  return Array.from({ length: width }, (_, i) => (i === pos ? ">" : i < pos ? "-" : ".")).join("");
}

function modeHint(screen: Screen): string {
  const normalized = normalize(screen);
  if (normalized === "launchpad") return "start here";
  if (normalized === "live-run") return "watch + approve";
  if (normalized === "sessions") return "resume work";
  if (normalized === "capabilities") return "what Servus can do";
  if (normalized === "plugins") return "skills + plugins";
  if (normalized === "settings") return "providers + safety";
  if (normalized === "background") return "scheduled/background";
  return "ready";
}
