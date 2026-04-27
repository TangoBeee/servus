import React, { useState, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { BANNER, TAGLINE, COLORS, ICONS } from "../theme.js";
import { getApiKeyStatus, loadConfig } from "../../config.js";

export type Screen =
  | "menu"
  | "launchpad"
  | "new-task"
  | "dashboard"
  | "live-run"
  | "sessions"
  | "background"
  | "capabilities"
  | "plugins"
  | "config"
  | "settings";

interface Props {
  onNavigate: (screen: Screen) => void;
}

const MENU_ITEMS: Array<{ id: Screen; label: string; desc: string }> = [
  { id: "new-task", label: "New Task", desc: "Start a new engineering task" },
  { id: "dashboard", label: "Dashboard", desc: "View live agent activity" },
  { id: "sessions", label: "Sessions", desc: "Browse past runs" },
  { id: "background", label: "Background Jobs", desc: "Manage PM2 background tasks" },
  { id: "config", label: "Settings", desc: "Configure model, keys, preferences" },
];

export function MainMenu({ onNavigate }: Props) {
  const { exit } = useApp();
  const [selected, setSelected] = useState(0);
  const [tick, setTick] = useState(0);
  const keys = getApiKeyStatus();
  const cfg = loadConfig();

  useEffect(() => {
    const t = setInterval(() => setTick((v) => v + 1), 800);
    return () => clearInterval(t);
  }, []);

  useInput((input, key) => {
    if (key.upArrow || input === "k") {
      setSelected((s) => (s - 1 + MENU_ITEMS.length) % MENU_ITEMS.length);
    } else if (key.downArrow || input === "j") {
      setSelected((s) => (s + 1) % MENU_ITEMS.length);
    } else if (key.return) {
      onNavigate(MENU_ITEMS[selected].id);
    } else if (input === "q") {
      exit();
    } else {
      const num = parseInt(input, 10);
      if (num >= 1 && num <= MENU_ITEMS.length) {
        onNavigate(MENU_ITEMS[num - 1].id);
      }
    }
  });

  const cursor = tick % 2 === 0 ? ICONS.arrow : " ";

  return (
    <Box flexDirection="column">
      {/* Banner */}
      <Box
        borderStyle="double"
        borderColor={COLORS.primary}
        paddingX={2}
        flexDirection="column"
        alignItems="center"
      >
        <Text color={COLORS.primary} bold>
          {BANNER}
        </Text>
        <Text> </Text>
        <Text color={COLORS.secondary}>{TAGLINE}</Text>
      </Box>

      <Text> </Text>

      {/* Menu items */}
      <Box flexDirection="column" paddingX={2}>
        {MENU_ITEMS.map((item, i) => (
          <Box key={item.id} gap={1}>
            <Text color={i === selected ? COLORS.primary : COLORS.muted}>
              {i === selected ? cursor : " "}
            </Text>
            <Text
              color={i === selected ? COLORS.primary : "white"}
              bold={i === selected}
            >
              {`${i + 1}. ${item.label.padEnd(20)}`}
            </Text>
            <Text color={COLORS.muted}>{item.desc}</Text>
          </Box>
        ))}
        <Box gap={1} marginTop={1}>
          <Text color={COLORS.muted}> </Text>
          <Text color="gray">
            q. Quit
          </Text>
        </Box>
      </Box>

      <Text> </Text>

      {/* System status */}
      <Box
        borderStyle="single"
        borderColor="gray"
        paddingX={1}
        gap={2}
      >
        <Text color="gray">System:</Text>
        {Object.entries(keys).map(([envKey, ok]) => {
          const shortName = envKey.split("_").slice(0, -1).join("_");
          return (
            <Text key={envKey} color={ok ? COLORS.primary : COLORS.error}>
              {ok ? ICONS.check : ICONS.cross} {shortName}
            </Text>
          );
        })}
        <Text color={COLORS.muted}>{ICONS.separator}</Text>
        <Text color={COLORS.secondary}>
          Model: {cfg.defaultModel}
        </Text>
      </Box>

      <Text> </Text>

      {/* Tips for new users */}
      <Box
        borderStyle="single"
        borderColor={COLORS.primary}
        paddingX={1}
        flexDirection="column"
      >
        <Text color={COLORS.primary} bold>
          Tips
        </Text>
        <Text color="gray">
          When a run finishes in Dashboard: press <Text color="green" bold>[f]</Text> to add follow-up feedback or new features.
        </Text>
        <Text color="gray">
          In Sessions: open a past run, then press <Text color="green" bold>[f]</Text> to continue from it.
        </Text>
      </Box>
    </Box>
  );
}
