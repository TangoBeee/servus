import React from "react";
import { Box, Text } from "ink";
import { COLORS } from "../theme.js";

const FRAMES = ["SERV-O [._.]", "SERV-O [o_o]", "SERV-O [^_^]", "SERV-O [>_>]"];
const CELEBRATE_FRAMES = ["SERV-O <*_*>" , "SERV-O <^_^>", "SERV-O <#_#>", "SERV-O <^_^>"];

interface Props {
  tick: number;
  active?: boolean;
  celebrate?: boolean;
}

export function Mascot({ tick, active = true, celebrate = false }: Props) {
  const frames = celebrate ? CELEBRATE_FRAMES : FRAMES;
  const frame = active ? frames[tick % frames.length] : "SERV-O";
  return (
    <Box gap={1}>
      <Text color={celebrate ? COLORS.accent : active ? COLORS.primary : COLORS.muted} bold>{frame}</Text>
      <Text color={COLORS.muted}>{celebrate ? "easter mode" : "operator buddy"}</Text>
    </Box>
  );
}
