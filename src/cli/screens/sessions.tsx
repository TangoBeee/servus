import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { KeyHints } from "../components/key-hints.js";
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
      if (key.upArrow || input === "k") setLogScroll((s) => Math.max(0, s - 1));
      if (key.downArrow || input === "j") setLogScroll((s) => s + 1);
      if (input === "f" && onFollowUp && viewing) {
        setShowFollowUp(true);
      }
      return;
    }

    if (key.escape || input === "q") onBack();
    else if (key.upArrow || input === "k") setSelected((s) => Math.max(0, s - 1));
    else if (key.downArrow || input === "j") setSelected((s) => Math.min(sessions.length - 1, s + 1));
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
        <KeyHints
          hints={[
            { key: "Enter", label: "run follow-up" },
            { key: "Esc", label: "cancel (letters type into prompt)" },
          ]}
        />
      </Box>
    );
  }

  if (viewing) {
    const visible = viewing.logs.slice(logScroll, logScroll + 20);
    return (
      <Box flexDirection="column">
        <Text color={COLORS.primary} bold>Session {viewing.id}</Text>
        <Box paddingX={1} flexDirection="column">
          <Text color="white" bold>
            {viewing.task}
          </Text>
          <Text color="gray">
            {new Date(viewing.startTime).toLocaleString()} | {viewing.model} |{" "}
            {viewing.status}
          </Text>
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
              No logs recorded for this session.
            </Text>
          )}
        </Box>
        {onFollowUp && (
          <Box paddingX={1} marginTop={1}>
            <Text color="gray">
              Press <Text color="green" bold>[f]</Text> to continue this run with follow-up feedback or new features.
            </Text>
          </Box>
        )}
        <KeyHints
          hints={[
            ...(onFollowUp ? [{ key: "f", label: "follow-up (continue from this run)" }] : []),
            { key: "j/k", label: "scroll" },
            { key: "Esc", label: "back" },
          ]}
        />
      </Box>
    );
  }

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
              {"Task".padEnd(35)}
              {"Status".padEnd(12)}
              {"Duration".padEnd(10)}
              {"Cost".padEnd(10)}
            </Text>
          </Box>
          {sessions.slice(0, 20).map((s, i) => {
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
                  {s.task.slice(0, 33).padEnd(35)}
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
      <KeyHints
        hints={[
          { key: "Enter", label: "view logs (then [f] for follow-up)" },
          { key: "d", label: "delete" },
          { key: "j/k", label: "navigate" },
          { key: "Esc", label: "back" },
        ]}
      />
    </Box>
  );
}
