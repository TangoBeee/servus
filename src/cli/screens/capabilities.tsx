import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { COLORS } from "../theme.js";
import {
  BROWSER_TOOLS,
  CORE_TOOLS,
  DATA_TOOLS,
  DESKTOP_TOOLS,
  EXTENSION_TOOLS,
  MEDIA_TOOLS,
  SECURITY_TOOLS,
  getCapabilityDescriptors,
  getCapabilityDescriptorsWithLiveMcp,
  type CapabilityDescriptor,
  type CapabilityStatus,
} from "../../capabilities.js";

interface Props {
  cwd?: string;
}

export function CapabilitiesScreen({ cwd = process.cwd() }: Props) {
  const [capabilities, setCapabilities] = useState<CapabilityDescriptor[]>(() => getCapabilityDescriptors(cwd));

  useEffect(() => {
    let mounted = true;
    setCapabilities(getCapabilityDescriptors(cwd));
    getCapabilityDescriptorsWithLiveMcp(cwd)
      .then((next) => {
        if (mounted) setCapabilities(next);
      })
      .catch(() => {
        // Keep static descriptors when live MCP health checks fail.
      });
    return () => {
      mounted = false;
    };
  }, [cwd]);
  const primary = capabilities.slice(0, 7);
  const secondary = capabilities.slice(7);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text color={COLORS.primary} bold>Capabilities</Text>
      <Text color="gray">Current local readiness for coding, browser, desktop, media, data/docs, extension building, security, plugins, skills, and MCP.</Text>
      <Text> </Text>

      <Box gap={1} flexWrap="wrap">
        {primary.map((capability) => (
          <CapabilityCard
            key={capability.id}
            title={capability.title}
            status={capability.status}
            lines={[
              `${capability.tools.length} tool${capability.tools.length === 1 ? "" : "s"}`,
              ...capability.notes,
              ...(capability.missing.length ? [`Missing: ${capability.missing.join(", ")}`] : []),
            ]}
          />
        ))}
      </Box>

      <Text> </Text>
      <Box gap={1} flexWrap="wrap">
        {secondary.map((capability) => (
          <CapabilityCard
            key={capability.id}
            title={capability.title}
            status={capability.status}
            lines={capability.notes}
          />
        ))}
      </Box>

      <Text> </Text>
      <Text color={COLORS.secondary} bold>Tool Inventory</Text>
      <Text color="gray">Core: {CORE_TOOLS.join(", ")}</Text>
      <Text color="gray">Browser: {BROWSER_TOOLS.join(", ")}</Text>
      <Text color="gray">Desktop: {DESKTOP_TOOLS.join(", ")}</Text>
      <Text color="gray">Media: {MEDIA_TOOLS.join(", ")}</Text>
      <Text color="gray">Data & Docs: {DATA_TOOLS.join(", ")}</Text>
      <Text color="gray">Extension Builder: {EXTENSION_TOOLS.join(", ")}</Text>
      <Text color="gray">Cyber Security: {SECURITY_TOOLS.join(", ")}</Text>
    </Box>
  );
}

function CapabilityCard({ title, status, lines }: { title: string; status: CapabilityStatus; lines: string[] }) {
  const color = status === "ready" || status === "configured"
    ? COLORS.primary
    : status === "blocked"
      ? COLORS.error
      : COLORS.accent;
  return (
    <Box width={34} flexDirection="column" borderStyle="single" borderColor={color} paddingX={1}>
      <Box justifyContent="space-between">
        <Text color={color} bold>{title}</Text>
        <Text color={color}>{status}</Text>
      </Box>
      {lines.map((line) => <Text key={line} color="gray">{line}</Text>)}
    </Box>
  );
}
