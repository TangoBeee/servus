import React from "react";
import { Box, Text, useStdout } from "ink";

export interface LogEntry {
  id: number;
  agent?: string;
  color?: string;
  message: string;
  type: string;
}

interface Streaming {
  agent: string;
  color?: string;
  text: string;
}

interface Props {
  logs: LogEntry[];
  title?: string;
  /** Live stream from current agent — shown in real time like a timer */
  streaming?: Streaming | null;
}

const STREAMING_MAX = 500; // show last N chars of live stream
const MIN_HEIGHT = 10;

export function LogViewer({ logs, title, streaming }: Props) {
  const { stdout } = useStdout();
  const termRows = stdout?.rows ?? 24;
  const viewportHeight = Math.max(MIN_HEIGHT, termRows - 12);

  // Always show the latest logs (tail behavior)
  const visible = logs.slice(-viewportHeight);

  const streamPreview =
    streaming?.text != null && streaming.text.length > STREAMING_MAX
      ? "…" + streaming.text.slice(-STREAMING_MAX)
      : streaming?.text ?? "";

  return (
    <Box flexDirection="column" flexGrow={1}>
      {title && (
        <Text bold color="cyan" underline>
          {title}
        </Text>
      )}
      <Box flexDirection="column" flexGrow={1}>
        {visible.map((entry) => (
          <Box key={entry.id} flexShrink={0}>
            {entry.agent ? (
              <>
                <Text color={entry.color ?? "white"} bold>
                  [{entry.agent}]
                </Text>
                <Text> </Text>
                <Text
                  color={
                    entry.type === "agent:tool_call"
                      ? "gray"
                      : entry.type === "error" || entry.type === "agent:error"
                        ? "red"
                        : "white"
                  }
                  dimColor={
                    entry.type === "agent:tool_call" ||
                    entry.type === "agent:tool_result"
                  }
                  wrap="wrap"
                >
                  {entry.message}
                </Text>
              </>
            ) : (
              <Text
                color={
                  entry.type === "phase"
                    ? "magenta"
                    : entry.type === "success"
                      ? "green"
                      : entry.type === "error"
                        ? "red"
                        : entry.type === "warn"
                          ? "yellow"
                          : "cyan"
                }
                bold={entry.type === "phase"}
                wrap="wrap"
              >
                {entry.type === "phase"
                  ? `═══ ${entry.message} ${"═".repeat(Math.max(0, 40 - entry.message.length))}`
                  : `[servus] ${entry.message}`}
              </Text>
            )}
          </Box>
        ))}
        {visible.length === 0 && !streaming && (
          <Text color="gray" italic>
            Waiting for agent activity...
          </Text>
        )}
        {streaming && streamPreview && (
          <Box flexShrink={0}>
            <Text color={streaming.color ?? "white"} bold>
              [{streaming.agent}]
            </Text>
            <Text> </Text>
            <Text color="gray" dimColor wrap="wrap">
              {streamPreview}
            </Text>
            <Text color="green"> █</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
