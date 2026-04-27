import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { KeyHints } from "../components/key-hints.js";
import { COLORS, ICONS } from "../theme.js";
import {
  listJobs,
  stopJob,
  deleteJob,
  getJobLogs,
  getJobMeta,
  startBackground,
  type PM2Job,
} from "../../background.js";
import { createSession } from "../../session-store.js";
import { bus } from "../../events.js";
import { formatDuration } from "../../log.js";

interface Props {
  onBack: () => void;
  onInputLockedChange?: (locked: boolean) => void;
  inputBlocked?: boolean;
}

export function BackgroundScreen({ onBack, onInputLockedChange, inputBlocked = false }: Props) {
  const [jobs, setJobs] = useState<PM2Job[]>([]);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(true);
  const [viewingLogs, setViewingLogs] = useState<string | null>(null);
  const [logContent, setLogContent] = useState("");
  const [message, setMessage] = useState("");
  const [showFollowUp, setShowFollowUp] = useState(false);
  const [followUpPrompt, setFollowUpPrompt] = useState("");
  const [followUpJobName, setFollowUpJobName] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    const j = await listJobs();
    setJobs(j);
    setLoading(false);
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    onInputLockedChange?.(showFollowUp);
    return () => onInputLockedChange?.(false);
  }, [showFollowUp, onInputLockedChange]);

  useInput((input, key) => {
    if (showFollowUp) {
      if (key.escape) {
        setShowFollowUp(false);
        setFollowUpPrompt("");
        setFollowUpJobName(null);
        setMessage("");
      }
      return;
    }

    if (viewingLogs) {
      if (key.escape || input === "q") setViewingLogs(null);
      return;
    }

    if (key.escape || input === "q") onBack();
    else if (key.upArrow || input === "k") setSelected((s) => Math.max(0, s - 1));
    else if (key.downArrow || input === "j") setSelected((s) => Math.min(jobs.length - 1, s + 1));
    else if (input === "s" && jobs[selected]) {
      stopJob(jobs[selected].name).then(() => {
        setMessage(`Stopped ${jobs[selected].name}`);
        refresh();
        setTimeout(() => setMessage(""), 3000);
      });
    } else if (input === "d" && jobs[selected]) {
      deleteJob(jobs[selected].name).then(() => {
        setMessage(`Deleted ${jobs[selected].name}`);
        refresh();
        setTimeout(() => setMessage(""), 3000);
      });
    } else if (input === "l" && jobs[selected]) {
      setViewingLogs(jobs[selected].name);
      getJobLogs(jobs[selected].name, 30).then(setLogContent);
    } else if (input === "f" && jobs[selected]) {
      const meta = getJobMeta(jobs[selected].name);
      if (!meta?.cwd) {
        setMessage("No context for this job (older jobs lack follow-up data)");
        setTimeout(() => setMessage(""), 4000);
      } else {
        setFollowUpJobName(jobs[selected].name);
        setShowFollowUp(true);
        setFollowUpPrompt("");
      }
    } else if (input === "r") {
      refresh();
    }
  }, { isActive: !inputBlocked });

  const handleFollowUpSubmit = (value: string) => {
    const text = value.trim();
    if (!text || !followUpJobName) return;
    const meta = getJobMeta(followUpJobName);
    if (!meta?.cwd) {
      setMessage("No context for this job");
      setTimeout(() => setMessage(""), 3000);
      return;
    }
    const followUpTask = `Follow-up from user:\n\n${text}\n\n---\n(Original task: ${meta.task})`;
    startBackground(followUpTask, {
      cwd: meta.cwd,
      model: meta.model,
      mode: meta.mode,
      maxFailures: meta.maxFailures,
      budget: meta.budget,
    })
      .then((name) => {
        createSession(followUpTask, meta.model ?? "gpt-4o-mini", meta.mode ?? "custom", meta.cwd);
        bus.push({ type: "success", message: `Follow-up job started: ${name}` });
        setMessage(`Follow-up started: ${name}`);
        setShowFollowUp(false);
        setFollowUpPrompt("");
        setFollowUpJobName(null);
        refresh();
        setTimeout(() => setMessage(""), 3000);
      })
      .catch((err) => {
        setMessage(`Failed: ${err instanceof Error ? err.message : String(err)}`);
        setTimeout(() => setMessage(""), 4000);
      });
  };

  if (showFollowUp && followUpJobName) {
    return (
      <Box flexDirection="column">
        <Text color={COLORS.primary} bold>Follow-up Prompt</Text>
        <Box paddingX={2} marginTop={1}>
          <Text color="gray">
            Add a follow-up task or feedback (continuing from {followUpJobName}):
          </Text>
        </Box>
        <Box paddingX={2} marginTop={1} gap={1}>
          <Text color={COLORS.primary}>{">>"}</Text>
          <TextInput
            value={followUpPrompt}
            onChange={setFollowUpPrompt}
            onSubmit={handleFollowUpSubmit}
            placeholder="e.g. add dark mode, fix the styling..."
          />
        </Box>
        <KeyHints hints={[{ key: "Enter", label: "run" }, { key: "Esc", label: "cancel" }]} />
      </Box>
    );
  }

  if (viewingLogs) {
    return (
      <Box flexDirection="column">
        <Text color={COLORS.primary} bold>Logs: {viewingLogs}</Text>
        <Box
          flexDirection="column"
          borderStyle="single"
          borderColor="gray"
          paddingX={1}
          flexGrow={1}
        >
          {logContent.split("\n").slice(-20).map((line, i) => (
            <Text key={i} color="white">
              {line.slice(0, 120)}
            </Text>
          ))}
        </Box>
        <KeyHints hints={[{ key: "Esc", label: "back" }]} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text color={COLORS.primary} bold>Background Jobs</Text>
        <Text color="gray">{loading ? "refreshing..." : `${jobs.length} jobs`}</Text>
      </Box>
      <Text> </Text>

      {jobs.length === 0 ? (
        <Box paddingX={2}>
          <Text color="gray" italic>
            {loading
              ? "Loading..."
              : "No background jobs. Start one from New Task."}
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" paddingX={1}>
          <Box gap={1}>
            <Text color="gray" bold>
              {"  "}
              {"Name".padEnd(22)}
              {"Status".padEnd(12)}
              {"PID".padEnd(8)}
              {"CPU".padEnd(6)}
              {"Mem (MB)".padEnd(10)}
              {"Uptime"}
            </Text>
          </Box>
          {jobs.map((j, i) => (
            <Box key={j.name} gap={1}>
              <Text color={i === selected ? COLORS.primary : COLORS.muted}>
                {i === selected ? ICONS.arrow : " "}
              </Text>
              <Text
                color={i === selected ? "white" : "gray"}
                bold={i === selected}
              >
                {j.name.padEnd(22)}
                {(j.status === "online"
                  ? `${ICONS.working} online`
                  : j.status === "stopped"
                    ? `${ICONS.idle} stopped`
                    : j.status
                ).padEnd(12)}
                {String(j.pid).padEnd(8)}
                {`${j.cpu}%`.padEnd(6)}
                {`${(j.memory / 1024 / 1024).toFixed(1)}`.padEnd(10)}
                {formatDuration(j.uptime)}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {message && (
        <Box paddingX={2} marginTop={1}>
          <Text color={COLORS.primary}>{ICONS.check} {message}</Text>
        </Box>
      )}

      <Text> </Text>
      <KeyHints
        hints={[
          { key: "f", label: "follow-up" },
          { key: "s", label: "stop" },
          { key: "d", label: "delete" },
          { key: "l", label: "logs" },
          { key: "r", label: "refresh" },
          { key: "Esc", label: "back" },
        ]}
      />
    </Box>
  );
}
