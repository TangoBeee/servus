import React from "react";
import { Box, Text, useInput } from "ink";
import { COLORS } from "../theme.js";
import type { ApprovalRequestPayload } from "../../events.js";

interface PendingApproval {
  request: ApprovalRequestPayload;
  resolve: (approved: boolean) => void;
}

interface Props {
  pending: PendingApproval | null;
  onResolve: (approved: boolean) => void;
}

export function ApprovalModal({ pending, onResolve }: Props) {
  useInput((input) => {
    if (!pending) return;
    if (input.toLowerCase() === "y") onResolve(true);
    if (input.toLowerCase() === "n") onResolve(false);
  });

  if (!pending) return null;

  const { request } = pending;
  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={request.risk === "critical" ? COLORS.error : COLORS.accent}
      paddingX={1}
      marginBottom={1}
    >
      <Text color={request.risk === "critical" ? COLORS.error : COLORS.accent} bold>
        Approval Required [{request.risk.toUpperCase()}]
      </Text>
      <Text color="white">Engine: {request.engine}</Text>
      <Text color="white">Action: {request.action}</Text>
      <Text color="gray" wrap="wrap">{request.detail}</Text>
      <Text color={COLORS.muted}>Press y to approve, n to deny.</Text>
    </Box>
  );
}
