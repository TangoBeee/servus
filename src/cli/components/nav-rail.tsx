import React from "react";
import { Box, Text } from "ink";
import { COLORS } from "../theme.js";
import type { Screen } from "../screens/main-menu.js";

const ITEMS: Array<{ screen: Screen; label: string; hotkey: string; desc: string }> = [
  { screen: "launchpad", label: "Launchpad", hotkey: "1", desc: "start" },
  { screen: "live-run", label: "Live Run", hotkey: "2", desc: "watch" },
  { screen: "sessions", label: "Sessions", hotkey: "3", desc: "history" },
  { screen: "capabilities", label: "Caps", hotkey: "4", desc: "ready" },
  { screen: "plugins", label: "Plugins", hotkey: "5", desc: "extend" },
  { screen: "settings", label: "Settings", hotkey: "6", desc: "setup" },
  { screen: "background", label: "Jobs", hotkey: "7", desc: "later" },
];

interface Props {
  active: Screen;
  onNavigate: (screen: Screen) => void;
  tick?: number;
  accent?: string;
  activeRun?: boolean;
}

export function NavRail({ active, tick = 0, accent = COLORS.primary, activeRun = false }: Props) {
  return (
    <Box
      width={24}
      flexDirection="column"
      borderStyle="single"
      borderColor={activeRun ? COLORS.secondary : "gray"}
      paddingX={1}
    >
      <Text color={accent} bold>Views</Text>
      <Text color={COLORS.muted}>Press number keys</Text>
      <Text color={COLORS.muted}> </Text>
      {ITEMS.map((item) => {
        const selected = normalize(active) === normalize(item.screen);
        return (
          <Box key={item.screen} flexDirection="column">
            <Box gap={1}>
              <Text color={selected ? accent : COLORS.muted}>
                {selected ? (tick % 2 === 0 ? ">" : "*") : " "}
              </Text>
              <Text color={selected ? accent : COLORS.muted}>{item.hotkey}</Text>
              <Text color={selected ? accent : "white"} bold={selected}>
                {item.label}
              </Text>
            </Box>
            <Box paddingLeft={4}>
              <Text color={selected ? COLORS.secondary : COLORS.muted}>{item.desc}</Text>
            </Box>
          </Box>
        );
      })}
      <Text> </Text>
      <Text color={COLORS.muted}>Quick Help</Text>
      <Text color="gray">Enter edits fields</Text>
      <Text color="gray">Esc cancels edit</Text>
      <Text color="gray">Ctrl+K commands</Text>
      {activeRun && (
        <>
          <Text> </Text>
          <Box gap={1}>
            <Text color={COLORS.primary}>{tick % 2 === 0 ? "*" : "."}</Text>
            <Text color={COLORS.secondary}>run stays attached</Text>
          </Box>
        </>
      )}
    </Box>
  );
}

function normalize(screen: Screen): Screen {
  if (screen === "menu" || screen === "new-task") return "launchpad";
  if (screen === "dashboard") return "live-run";
  if (screen === "config") return "settings";
  return screen;
}
