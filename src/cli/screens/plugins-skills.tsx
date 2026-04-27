import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { COLORS } from "../theme.js";
import { loadConfig } from "../../config.js";
import { loadSkills } from "../../skills.js";
import { loadPlugins } from "../../plugins.js";

type View = "skills" | "plugins";

interface Props {
  cwd?: string;
  inputBlocked?: boolean;
}

export function PluginsSkillsScreen({ cwd = process.cwd(), inputBlocked = false }: Props) {
  const cfg = loadConfig();
  const [view, setView] = useState<View>("skills");
  const [selected, setSelected] = useState(0);

  const data = useMemo(() => ({
    skills: loadSkills({ cwd, extraDirs: cfg.skills?.dirs }),
    plugins: loadPlugins({ cwd, extraDirs: cfg.plugins?.dirs, disabled: cfg.plugins?.disabled }),
  }), [cwd]);

  const rows = view === "skills" ? data.skills : data.plugins;

  useInput((input, key) => {
    if (input === "\t" || key.tab || key.leftArrow || key.rightArrow) {
      setView((value) => value === "skills" ? "plugins" : "skills");
      setSelected(0);
    }
    if (key.upArrow || input === "k") setSelected((value) => Math.max(0, value - 1));
    if (key.downArrow || input === "j") setSelected((value) => Math.min(rows.length - 1, value + 1));
  }, { isActive: !inputBlocked });

  const active = rows[selected];

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box gap={2}>
        <Text color={view === "skills" ? COLORS.primary : COLORS.muted} bold={view === "skills"}>[skills {data.skills.length}]</Text>
        <Text color={view === "plugins" ? COLORS.primary : COLORS.muted} bold={view === "plugins"}>[plugins {data.plugins.length}]</Text>
      </Box>
      <Text color="gray">Left/right switches view. j/k selects. Local-first manifests and SKILL.md files are shown here.</Text>
      <Text> </Text>

      <Box flexGrow={1} gap={1}>
        <Box flexDirection="column" flexGrow={1}>
          {rows.length === 0 && <Text color="gray">No {view} found for {cwd}.</Text>}
          {rows.slice(0, 24).map((item, index) => (
            <Box key={`${view}:${item.path}`} gap={1}>
              <Text color={index === selected ? COLORS.primary : COLORS.muted}>{index === selected ? ">" : " "}</Text>
              <Text color={index === selected ? "white" : "gray"} bold={index === selected}>
                {"name" in item ? item.name : item.id}
              </Text>
              <Text color={COLORS.muted}>
                {"source" in item ? item.source : item.version}
              </Text>
            </Box>
          ))}
        </Box>
        <Box width={44} flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
          <Text color={COLORS.secondary} bold>Details</Text>
          {!active && <Text color="gray">Select an item to inspect it.</Text>}
          {active && view === "skills" && "source" in active && (
            <>
              <Text color="white">Name: {active.name}</Text>
              <Text color="white">Source: {active.source}</Text>
              <Text color="gray" wrap="wrap">{active.description}</Text>
              {active.whenToUse && <Text color="gray" wrap="wrap">When: {active.whenToUse}</Text>}
              {active.allowedTools?.length && <Text color="gray">Tools: {active.allowedTools.join(", ")}</Text>}
              <Text color={COLORS.muted} wrap="wrap">{active.path}</Text>
            </>
          )}
          {active && view === "plugins" && "id" in active && (
            <>
              <Text color="white">ID: {active.id}</Text>
              <Text color="white">Version: {active.version}</Text>
              {active.description && <Text color="gray" wrap="wrap">{active.description}</Text>}
              <Text color="gray">Tools: {active.tools?.length ?? 0}</Text>
              <Text color="gray">Skills: {active.skills?.length ?? 0}</Text>
              <Text color="gray">MCP: {Object.keys(active.mcpServers ?? {}).length}</Text>
              <Text color={COLORS.muted} wrap="wrap">{active.path}</Text>
            </>
          )}
        </Box>
      </Box>
    </Box>
  );
}
