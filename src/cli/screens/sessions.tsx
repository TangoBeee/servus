import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { COLORS, ICONS } from "../theme.js";
import { listSessions, deleteSession, type SessionRecord } from "../../session-store.js";
import { formatDuration } from "../../log.js";

interface Props {
  onBack: () => void;
  onFollowUp?: (session: SessionRecord, followUpText: string) => void;
  onInputLockedChange?: (locked: boolean) => void;
  inputBlocked?: boolean;
}

export function SessionsScreen({ onBack, onFollowUp, onInputLockedChange, inputBlocked = false }: Props) {
  const [sessions, setSessions] = useState(listSessions);
  const [selected, setSelected] = useState(0);
  const [viewing, setViewing] = useState<SessionRecord | null>(null);
  const [logScroll, setLogScroll] = useState(0);
  const [showFollowUp, setShowFollowUp] = useState(false);
  const [followUpValue, setFollowUpValue] = useState("");

  useEffect(() => {
    onInputLockedChange?.(showFollowUp);
    return () => onInputLockedChange?.(false);
  }, [showFollowUp, onInputLockedChange]);

  useInput((input, key) => {
    if (showFollowUp) {
      // Only Escape cancels; letters like q or b are typed into the prompt
      if (key.escape) {
        setShowFollowUp(false);
        setFollowUpValue("");
      }
      return;
    }

    if (viewing) {
      if (key.escape || input === "q") setViewing(null);
      if (key.upArrow || input.includes("k")) setLogScroll((s) => Math.max(0, s - countChar(input, "k")));
      if (key.downArrow || input.includes("j")) setLogScroll((s) => s + countChar(input, "j"));
      if (input === "f" && onFollowUp && viewing) {
        setShowFollowUp(true);
      }
      return;
    }

    if (key.escape || input === "q") onBack();
    else if (key.upArrow || input.includes("k")) setSelected((s) => Math.max(0, s - countChar(input, "k")));
    else if (key.downArrow || input.includes("j")) setSelected((s) => Math.min(sessions.length - 1, s + countChar(input, "j")));
    else if (key.return) {
      if (sessions[selected]) setViewing(sessions[selected]);
    } else if (input === "d") {
      if (sessions[selected]) {
        deleteSession(sessions[selected].id);
        setSessions(listSessions());
        setSelected(Math.min(selected, sessions.length - 2));
      }
    }
  }, { isActive: !inputBlocked });

  if (showFollowUp && viewing) {
    return (
      <Box flexDirection="column">
        <Text color={COLORS.primary} bold>Follow-up for {viewing.id}</Text>
        <Box paddingX={1} flexDirection="column" marginTop={1}>
          <Text color="white" bold>
            {viewing.task}
          </Text>
          <Text color="gray">
            {new Date(viewing.startTime).toLocaleString()} | {viewing.model} |{" "}
            {viewing.status}
          </Text>
        </Box>
        <Box paddingX={2} marginTop={1}>
          <Text color="gray">
            Add feedback or new work to continue from this session:
          </Text>
        </Box>
        <Box paddingX={2} marginTop={1} gap={1}>
          <Text color={COLORS.primary}>{">>"}</Text>
          <TextInput
            value={followUpValue}
            onChange={setFollowUpValue}
            onSubmit={(val) => {
              const text = val.trim();
              if (text && onFollowUp) {
                onFollowUp(viewing, text);
              }
              setShowFollowUp(false);
              setFollowUpValue("");
            }}
            placeholder="e.g. refine implementation, add dark mode, update tests..."
          />
        </Box>
        <Text color="gray">Enter run follow-up · Esc cancel · letters type into prompt</Text>
      </Box>
    );
  }

  if (viewing) {
    const timeline = sessionTimeline(viewing);
    const visible = timeline.slice(logScroll, logScroll + 20);
    return (
      <Box flexDirection="column">
        <Text color={COLORS.primary} bold>Session {viewing.id}</Text>
        <Box paddingX={1} flexDirection="column">
          <Text color="white" bold>
            {viewing.task}
          </Text>
          <Text color="gray">
            {new Date(viewing.startTime).toLocaleString()} | {viewing.domain ?? "auto"} | {viewing.model} |{" "}
            {viewing.status}{viewing.runtimeStatus ? `/${viewing.runtimeStatus}` : ""}
          </Text>
          <Text color="gray" wrap="truncate">
            Target: {viewing.targetCwd ?? viewing.cwd}
          </Text>
          {viewing.finalSummary && (
            <Box flexDirection="column" marginTop={1}>
              <Text color={COLORS.secondary} bold>Final Summary</Text>
              <Text color="white" wrap="wrap">{viewing.finalSummary}</Text>
            </Box>
          )}
          <Box marginTop={1} gap={2}>
            <Text color="gray">Events: {viewing.events?.length ?? 0}</Text>
            <Text color="gray">Evidence: {viewing.evidence?.length ?? 0}</Text>
            <Text color="gray">Artifacts: {viewing.artifacts?.length ?? 0}</Text>
            <Text color="gray">Cost: ${viewing.cost.toFixed(4)}</Text>
          </Box>
        </Box>
        <Box
          flexDirection="column"
          borderStyle="single"
          borderColor="gray"
          paddingX={1}
          flexGrow={1}
        >
          {visible.map((line, i) => (
            <Text key={logScroll + i} color="white">
              {line.slice(0, 120)}
            </Text>
          ))}
          {visible.length === 0 && (
            <Text color="gray" italic>
              No timeline entries recorded for this session.
            </Text>
          )}
        </Box>
        {onFollowUp && (
          <Box paddingX={1} marginTop={1}>
            <Text color="gray">
              Press <Text color="green" bold>[f]</Text> to continue this run in the same session.
            </Text>
          </Box>
        )}
        <Text color="gray">{onFollowUp ? "f follow-up · " : ""}j/k scroll · Esc back</Text>
      </Box>
    );
  }

  const sessionOffset = sessionOffsetFor(selected, sessions.length);

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text color={COLORS.primary} bold>Sessions</Text>
        <Text color="gray">{sessions.length} total</Text>
      </Box>
      <Text> </Text>

      {sessions.length === 0 ? (
        <Box paddingX={2}>
          <Text color="gray" italic>
            No sessions yet. Run a task to create one.
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" paddingX={1}>
          {/* Table header */}
          <Box gap={1}>
            <Text color="gray" bold>
              {"  "}
              {"ID".padEnd(10)}
              {"Task / Summary".padEnd(35)}
              {"Domain".padEnd(10)}
              {"Status".padEnd(12)}
              {"Duration".padEnd(10)}
              {"Cost".padEnd(10)}
            </Text>
          </Box>
          {sessions.slice(sessionOffset, sessionOffset + sessionPageSize).map((s, localIndex) => {
            const i = sessionOffset + localIndex;
            const dur = s.endTime
              ? formatDuration(s.endTime - s.startTime)
              : s.status === "waiting_input"
                ? "paused"
                : "running";
            return (
              <Box key={s.id} gap={1}>
                <Text color={i === selected ? COLORS.primary : COLORS.muted}>
                  {i === selected ? ICONS.arrow : " "}
                </Text>
                <Text
                  color={i === selected ? "white" : "gray"}
                  bold={i === selected}
                >
                  {s.id.padEnd(10)}
                  {sessionLabel(s).slice(0, 33).padEnd(35)}
                  {(s.domain ?? "auto").slice(0, 9).padEnd(10)}
                  {(s.status === "completed"
                    ? `${ICONS.check} done`
                    : s.status === "failed"
                      ? `${ICONS.cross} fail`
                      : s.status === "waiting_input"
                        ? "? input"
                        : "running"
                  ).padEnd(12)}
                  {dur.padEnd(10)}
                  {`$${s.cost.toFixed(3)}`}
                </Text>
              </Box>
            );
          })}
        </Box>
      )}

      <Text> </Text>
      <Text color="gray">Enter view · f follow-up after opening · d delete · j/k navigate · Esc back</Text>
    </Box>
  );
}

const sessionPageSize = 18;

function sessionOffsetFor(selected: number, total: number): number {
  return Math.max(0, Math.min(selected - sessionPageSize + 1, Math.max(0, total - sessionPageSize)));
}

function countChar(value: string, char: string): number {
  const count = [...value].filter((item) => item === char).length;
  return Math.max(1, count);
}

function sessionLabel(session: SessionRecord): string {
  const finalLine = session.finalSummary
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return finalLine || session.task;
}

function sessionTimeline(session: SessionRecord): string[] {
  const logs = session.logs ?? [];
  const eventLines = (session.events ?? [])
    .slice(-160)
    .map((event) => `[${event.agent ?? "servus"}] ${event.type}: ${event.message}`)
    .filter(Boolean);
  const evidenceLines = (session.evidence ?? [])
    .slice(-40)
    .map((item) => `[evidence:${item.type}] ${item.summary}`);
  const artifactLines = (session.artifacts ?? [])
    .slice(-20)
    .map((item) => `[artifact] ${item}`);
  return [
    ...(session.finalSummary ? [`[final] ${session.finalSummary}`] : []),
    ...eventLines,
    ...evidenceLines,
    ...artifactLines,
    ...logs,
  ].filter((line, index, all) => line.trim() && all.indexOf(line) === index);
}
