import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { LogViewer, type LogEntry } from "../components/log-viewer.js";
import { MetricStrip } from "../components/metric-strip.js";
import { ToolTimeline } from "../components/tool-timeline.js";
import { ApprovalModal } from "../components/approval-modal.js";
import { ProofPanel } from "../components/proof-panel.js";
import { KeyHints } from "../components/key-hints.js";
import { COLORS } from "../theme.js";
import {
  initialRuntimeViewState,
  reduceRunEvent,
  type RuntimeViewState,
} from "../state/run-store.js";
import { bus, type ApprovalRequestPayload, type ServusEvent } from "../../events.js";
import { Orchestrator, type OrchestratorConfig, type OrchestratorRunOutcome } from "../../orchestrator.js";
import { formatDuration } from "../../log.js";
import { appendEvent, appendLog, updateSession } from "../../session-store.js";
import { killAllServusChildren } from "../../child-registry.js";
import type { ClarificationRequest } from "../../clarification.js";

type Tab = "stream" | "tools" | "approvals" | "errors" | "artifacts";

interface PendingApproval {
  request: ApprovalRequestPayload;
  resolve: (approved: boolean) => void;
}

interface Props {
  config: OrchestratorConfig;
  visible?: boolean;
  onBack: () => void;
  onFollowUp?: (followUpText: string, options?: { sameSession?: boolean }) => void;
  clearSignal?: number;
  onInputLockedChange?: (locked: boolean) => void;
  inputBlocked?: boolean;
}

const TABS: Tab[] = ["stream", "tools", "approvals", "errors", "artifacts"];
type ComposerMode = "follow-up" | "answer";

export function Dashboard({ config, visible = true, onBack, onFollowUp, clearSignal = 0, onInputLockedChange, inputBlocked = false }: Props) {
  const { exit } = useApp();
  const activeRunRef = useRef<{ sessionId?: string; running: boolean } | null>(null);
  const lastSessionIdRef = useRef<string | undefined>(config.sessionId);
  const [runtime, setRuntime] = useState<RuntimeViewState>({
    ...initialRuntimeViewState,
    model: config.model,
    backend: config.backend,
    budget: config.maxBudgetUsd,
    domain: config.preferredDomain ?? "auto",
  });
  const [running, setRunning] = useState(true);
  const [startTime, setStartTime] = useState(Date.now());
  const [elapsed, setElapsed] = useState(0);
  const [tab, setTab] = useState<Tab>("stream");
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [streaming, setStreaming] = useState<{ agent: string; color?: string; text: string } | null>(null);
  const [composerMode, setComposerMode] = useState<ComposerMode | null>(null);
  const [composerValue, setComposerValue] = useState("");
  const [pendingQuestion, setPendingQuestion] = useState<string | undefined>(undefined);
  const [pendingContext, setPendingContext] = useState<string | undefined>(undefined);
  const [pendingClarification, setPendingClarification] = useState<ClarificationRequest | undefined>(undefined);
  const [answerIndex, setAnswerIndex] = useState(0);
  const [answers, setAnswers] = useState<Array<{ question: string; answer: string }>>([]);

  useEffect(() => {
    onInputLockedChange?.(visible && (!!composerMode || !!pendingApproval));
    return () => onInputLockedChange?.(false);
  }, [visible, composerMode, pendingApproval, onInputLockedChange]);

  const handleEvent = useCallback((event: ServusEvent) => {
    if (event.type === "agent:text") {
      setStreaming((prev) => ({
        agent: event.agent ?? "Agent",
        color: event.color,
        text: prev && prev.agent === event.agent ? prev.text + event.message : event.message,
      }));
      return;
    }

    setStreaming(null);
    setRuntime((prev) => reduceRunEvent(prev, event));
    if (config.sessionId) {
      appendEvent(config.sessionId, event);
      appendLog(
        config.sessionId,
        `[${event.agent ?? "servus"}] ${event.type}: ${(event.message ?? "").slice(0, 500)}`,
      );
    }
  }, [config.sessionId]);

  useEffect(() => {
    if (clearSignal === 0) return;
    setRuntime((prev) => ({ ...prev, logs: [], errors: [] }));
    setStreaming(null);
  }, [clearSignal]);

  useEffect(() => {
    const approvalHandler = (request: ApprovalRequestPayload) =>
      new Promise<boolean>((resolve) => {
        setPendingApproval({ request, resolve });
      });

    bus.interactive = true;
    bus.setApprovalHandler(approvalHandler);
    bus.on("event", handleEvent);
    return () => {
      bus.off("event", handleEvent);
      bus.setApprovalHandler(null);
      bus.interactive = false;
    };
  }, [handleEvent]);

  useEffect(() => {
    const sessionChanged = lastSessionIdRef.current !== config.sessionId;
    lastSessionIdRef.current = config.sessionId;
    if (sessionChanged) {
      setRuntime({
        ...initialRuntimeViewState,
        model: config.model,
        backend: config.backend,
        budget: config.maxBudgetUsd,
        domain: config.preferredDomain ?? "auto",
      });
      setStreaming(null);
      setPendingQuestion(undefined);
      setPendingContext(undefined);
      setPendingClarification(undefined);
      setAnswerIndex(0);
      setAnswers([]);
      setComposerValue("");
      setComposerMode(null);
    }

    if (activeRunRef.current?.running && activeRunRef.current.sessionId === config.sessionId) {
      handleEvent({
        type: "warn",
        message: `Foreground run for session ${config.sessionId ?? "direct"} is already active; duplicate start ignored.`,
        timestamp: Date.now(),
      });
      return;
    }

    const startedAt = Date.now();
    setStartTime(startedAt);
    setElapsed(0);
    setRunning(true);
    const orchestrator = new Orchestrator(config);
    activeRunRef.current = { sessionId: config.sessionId, running: true };

    orchestrator
      .run()
      .then((outcome) => {
        setElapsed(Date.now() - startedAt);
        handleRunOutcome(outcome);
        setRunning(false);
      })
      .catch((err: Error) => {
        setElapsed(Date.now() - startedAt);
        handleEvent({ type: "error", message: `Fatal: ${err.message}`, timestamp: Date.now() });
        if (config.sessionId) {
          updateSession(config.sessionId, { status: "failed", runtimeStatus: "failed", endTime: Date.now() });
        }
        setRunning(false);
      })
      .finally(() => {
        const activeRun = activeRunRef.current;
        if (activeRun && activeRun.sessionId === config.sessionId) {
          activeRun.running = false;
        }
        orchestrator.closeAll();
      });

    return () => {
      orchestrator.closeAll();
      if (activeRunRef.current?.sessionId === config.sessionId) {
        activeRunRef.current = null;
      }
    };
  }, [config]);

  useEffect(() => {
    if (!running) {
      setElapsed(Date.now() - startTime);
      return;
    }
    const timer = setInterval(() => setElapsed(Date.now() - startTime), 1000);
    return () => clearInterval(timer);
  }, [running, startTime]);

  useInput((input, key) => {
    if (pendingApproval) return;
    if (composerMode) {
      if (key.escape) {
        setComposerMode(null);
        setComposerValue("");
        setPendingClarification(undefined);
        setAnswerIndex(0);
        setAnswers([]);
      }
      return;
    }

    if (input === "q") {
      killAllServusChildren().then(() => exit());
    }
    if (input === "b" && !running) onBack();
    if (input === "f" && !running && onFollowUp) setComposerMode("follow-up");
    if (key.leftArrow || input === "[") setTab((value) => previousTab(value));
    if (key.rightArrow || input === "]" || input === "\t" || key.tab) setTab((value) => nextTab(value));
  }, { isActive: visible && !inputBlocked });

  function resolveApproval(approved: boolean) {
    pendingApproval?.resolve(approved);
    setPendingApproval(null);
  }

  function handleRunOutcome(outcome: OrchestratorRunOutcome) {
    if (outcome.status === "waiting_input") {
      const question = outcome.question ?? outcome.result?.question ?? outcome.result?.summary;
      setPendingQuestion(question);
      setPendingContext(outcome.questionContext ?? outcome.result?.questionContext);
      setPendingClarification(outcome.clarification ?? outcome.result?.clarification);
      setAnswerIndex(0);
      setAnswers([]);
      setComposerMode("answer");
      if (config.sessionId) {
        updateSession(config.sessionId, {
          status: "waiting_input",
          runtimeStatus: "waiting_input",
          endTime: Date.now(),
        });
      }
      return;
    }

    if (outcome.status === "completed") {
      handleEvent({ type: "complete", message: "Run completed", timestamp: Date.now() });
      if (config.sessionId) {
        updateSession(config.sessionId, { status: "completed", runtimeStatus: "completed", endTime: Date.now() });
      }
      return;
    }

    handleEvent({ type: "error", message: "Run failed", timestamp: Date.now() });
    if (config.sessionId) {
      updateSession(config.sessionId, { status: "failed", runtimeStatus: "failed", endTime: Date.now() });
    }
  }

  function submitComposer(value: string) {
    const text = value.trim();
    if (!text || !onFollowUp) return;

    if (composerMode === "answer") {
      const clarification = pendingClarification ?? runtime.clarification;
      const questions = getQuestionList(runtime, pendingQuestion, clarification);
      const currentQuestion = questions[Math.min(answerIndex, questions.length - 1)] ?? "Missing detail";
      const nextAnswers = [...answers, { question: currentQuestion, answer: text }];
      bus.push({
        type: "user_input:response",
        message: `Answered clarification question ${Math.min(answerIndex + 1, questions.length)}/${questions.length}`,
        metadata: {
          mode: clarification?.mode ?? "blocking_facts",
          index: answerIndex,
          total: questions.length,
          question: currentQuestion,
          answer: text,
          sameSession: true,
        },
      });

      if (answerIndex < questions.length - 1) {
        setAnswers(nextAnswers);
        setAnswerIndex((index) => index + 1);
        setComposerValue("");
        return;
      }

      const followUpText = [
        "Answers to Servus clarification for the same session:",
        "",
        `Mode: ${clarification?.mode ?? "blocking_facts"}`,
        "",
        ...nextAnswers.flatMap((item, index) => [
          `${index + 1}. ${item.question}`,
          `Answer: ${item.answer}`,
          "",
        ]),
        "",
        "---",
        "Context Servus provided before asking:",
        clarification?.context ?? pendingContext ?? runtime.questionContext ?? pendingQuestion ?? runtime.question ?? "More information was needed.",
      ].join("\n");

      onFollowUp(followUpText, { sameSession: true });
      setComposerMode(null);
      setComposerValue("");
      setPendingQuestion(undefined);
      setPendingContext(undefined);
      setPendingClarification(undefined);
      setAnswerIndex(0);
      setAnswers([]);
      return;
    }

    onFollowUp(text);
    setComposerMode(null);
    setComposerValue("");
    setPendingQuestion(undefined);
    setPendingContext(undefined);
    setPendingClarification(undefined);
    setAnswerIndex(0);
    setAnswers([]);
  }

  function renderComposerPanel() {
    if (!composerMode) return null;
    const isAnswer = composerMode === "answer";
    const clarification = pendingClarification ?? runtime.clarification;
    const questions = getQuestionList(runtime, pendingQuestion, clarification);
    const currentQuestion = questions[Math.min(answerIndex, questions.length - 1)] ?? "What should Servus use?";
    const context = cleanPromptContext(
      clarification?.context ?? pendingContext ?? runtime.questionContext,
      currentQuestion,
    );
    return (
      <Box
        flexDirection="column"
        borderStyle="double"
        borderColor={isAnswer ? COLORS.accent : COLORS.primary}
        paddingX={1}
        marginTop={1}
      >
        <Text color={isAnswer ? COLORS.accent : COLORS.primary} bold>
          {isAnswer ? "Servus Needs Input" : "Follow-up"}
        </Text>
        <Text color="gray">
          {isAnswer
            ? `${clarificationModeLabel(clarification)} ${Math.min(answerIndex + 1, questions.length)}/${questions.length} - same session.`
            : "Continue this session with feedback or new work."}
        </Text>
        {isAnswer && (
          <Box marginTop={1} flexDirection="column">
            <Text color={COLORS.accent} bold>Question</Text>
            <Text color="white" bold wrap="wrap">
              {currentQuestion}
            </Text>
            {answers.length > 0 && (
              <Text color={COLORS.secondary}>
                Collected {answers.length}/{questions.length}
              </Text>
            )}
            {clarification?.choices?.map((group) => (
              <Box key={group.id} flexDirection="column" marginTop={1}>
                <Text color={COLORS.secondary} bold>{group.label}</Text>
                {group.options.slice(0, 12).map((option, index) => (
                  <Text key={`${group.id}:${option}:${index}`} color="gray" wrap="wrap">
                    {index + 1}. {option}
                  </Text>
                ))}
              </Box>
            ))}
            {context && answerIndex === 0 && (
              <Box flexDirection="column" marginTop={1}>
                <Text color={COLORS.muted}>Context</Text>
                <Text color="gray" wrap="wrap">{context}</Text>
              </Box>
            )}
          </Box>
        )}
        <Box gap={1} marginTop={1}>
          <Text color={isAnswer ? COLORS.accent : COLORS.primary}>{">"}</Text>
          <TextInput
            value={composerValue}
            onChange={setComposerValue}
            onSubmit={submitComposer}
            placeholder={isAnswer ? "Reply with the missing details..." : "Add follow-up request..."}
          />
        </Box>
        <KeyHints hints={[{ key: "Enter", label: isAnswer ? answerIndex < questions.length - 1 ? "next question" : "continue same session" : "run follow-up" }, { key: "Esc", label: "cancel" }]} />
      </Box>
    );
  }

  if (!visible) return null;

  return (
    <Box flexDirection="column" flexGrow={1}>
      <MetricStrip
        metrics={[
          {
            label: "Status",
            value: running ? "running" : runtime.status,
            tone: runtime.status === "failed" ? "bad" : running || runtime.status === "waiting_input" ? "warn" : "good",
          },
          { label: "Domain", value: runtime.domain },
          { label: "Engine", value: runtime.engine },
          { label: "Model", value: config.model },
          { label: "Session", value: config.sessionId ?? "direct" },
          { label: "Elapsed", value: formatDuration(elapsed) },
          { label: "Cost", value: `$${runtime.cost.toFixed(4)}`, tone: "good" },
          { label: "Budget", value: config.maxBudgetUsd ? `$${config.maxBudgetUsd}` : "none" },
        ]}
      />

      <Box marginTop={1} gap={1}>
        {TABS.map((item) => (
          <Text key={item} color={tab === item ? COLORS.primary : COLORS.muted} bold={tab === item}>
            {tab === item ? `[${item}]` : item}
          </Text>
        ))}
      </Box>

      <Box flexGrow={1} marginTop={1}>
        <Box flexDirection="column" flexGrow={1}>
          {tab === "stream" && (
            <LogViewer
              logs={runtime.logs.map(toLogEntry)}
              title="Runtime Stream"
              streaming={streaming}
            />
          )}
          {tab === "tools" && <ToolTimeline tools={runtime.tools} />}
          {tab === "approvals" && <Approvals approvals={runtime.approvals} />}
          {tab === "errors" && (
            <LogViewer logs={runtime.errors.map(toLogEntry)} title="Errors" />
          )}
          {tab === "artifacts" && (
            <ProofPanel proofDir={runtime.proofDir} artifacts={runtime.artifacts} />
          )}
        </Box>

        <Box width={34} flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
          <Text color={COLORS.secondary} bold>Runtime</Text>
          <Text color="white">Phase: {runtime.phase}</Text>
          <Text color="white">Tasks: {runtime.completed}/{runtime.total || 0}</Text>
          <Text color="white">Active tools: {runtime.activeTools.length}</Text>
          {runtime.activeTools.slice(-4).map((tool) => <Text key={tool} color={COLORS.accent}>* {tool}</Text>)}
          <Text> </Text>
          <Text color={COLORS.secondary} bold>Approvals</Text>
          <Text color="white">Total: {runtime.approvals.length}</Text>
          <Text color="white">Pending: {runtime.approvals.filter((item) => item.approved === undefined).length}</Text>
          <Text> </Text>
          <Text color={COLORS.secondary} bold>Proof</Text>
          <Text color="gray" wrap="wrap">{runtime.proofDir ?? "not created yet"}</Text>
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text color="gray">
          {running
            ? "Use [ and ] to switch tabs. High-risk actions appear as approval panels."
            : runtime.status === "waiting_input"
              ? "Servus is waiting for input at the bottom of the screen."
              : "Run finished. Press f for follow-up or b to return to Launchpad."}
        </Text>
      </Box>
      <ApprovalModal pending={pendingApproval} onResolve={resolveApproval} />
      {renderComposerPanel()}
    </Box>
  );
}

function Approvals({ approvals }: { approvals: RuntimeViewState["approvals"] }) {
  if (approvals.length === 0) return <Text color="gray">No approvals requested.</Text>;
  return (
    <Box flexDirection="column">
      <Text color={COLORS.secondary} bold>Approvals</Text>
      {approvals.slice(-20).map((item) => (
        <Box key={item.id} gap={1}>
          <Text color={item.approved === undefined ? COLORS.accent : item.approved ? COLORS.primary : COLORS.error}>
            {item.approved === undefined ? "*" : item.approved ? "o" : "x"}
          </Text>
          <Text color="white">{item.risk}</Text>
          <Text color="gray">{item.action}</Text>
          <Text color="gray" wrap="truncate">{item.detail}</Text>
        </Box>
      ))}
    </Box>
  );
}

function toLogEntry(item: RuntimeViewState["logs"][number]): LogEntry {
  return {
    id: item.id,
    agent: item.agent,
    color: item.color,
    message: item.message,
    type: item.type,
  };
}

function nextTab(current: Tab): Tab {
  return TABS[(TABS.indexOf(current) + 1) % TABS.length];
}

function previousTab(current: Tab): Tab {
  return TABS[(TABS.indexOf(current) - 1 + TABS.length) % TABS.length];
}

function getQuestionList(runtime: RuntimeViewState, fallback?: string, clarification?: ClarificationRequest): string[] {
  const source = clarification?.message ?? fallback ?? runtime.question ?? runtime.questionContext ?? "";
  const extracted = extractSimplePrompt(source);
  const questions = (clarification?.questions ?? runtime.questions)
    .filter(Boolean)
    .filter((question) => !isGenericQuestion(question));
  if (extracted && (questions.length === 0 || questions.some(isGenericQuestion))) return [extracted];
  if (questions.length > 0) return questions;
  return [extracted ?? fallback ?? runtime.question ?? "What should Servus use?"];
}

function clarificationModeLabel(clarification?: ClarificationRequest): string {
  if (clarification?.mode === "discovered_choices") return "Choice";
  if (clarification?.mode === "consent") return "Approval";
  return "Question";
}

function cleanPromptContext(context: string | undefined, question: string): string {
  if (!context) return "";
  const questionKey = normalizePromptText(question);
  const lines = context
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => {
      const normalized = normalizePromptText(line);
      if (!normalized) return true;
      if (normalized === questionKey) return false;
      if (isGenericQuestion(line)) return false;
      const extracted = extractSimplePrompt(line);
      return !extracted || normalizePromptText(extracted) !== questionKey;
    });
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function extractSimplePrompt(text: string): string | undefined {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = stripMarkdown(lines[index]);
    if (isGenericQuestion(line)) continue;
    if (/\b(?:mobile|phone)\s+number\b/i.test(line) || /\bphone\b/i.test(line)) {
      return /login|verification|otp|booking/i.test(line)
        ? "What mobile number should Servus use for login/verification?"
        : "What mobile number should Servus use?";
    }
    if (/\bemail(?:\s+address)?\b/i.test(line)) {
      return "What email address should Servus use?";
    }
    if (line.includes("?")) return line;
    const request = line.match(/^(?:please\s+)?(?:send|provide|share|enter|type)\s+(.+?)(?:[.!]?\s*)$/i);
    if (request?.[1]) return `What is ${request[1].replace(/[.!?]+$/g, "")}?`;
  }
  return undefined;
}

function isGenericQuestion(value: string): boolean {
  return /\bprovide the missing basic details needed to continue\b/i.test(value) ||
    /\bwhat detail should servus use to continue\b/i.test(value) ||
    /\breply with your selected option\b/i.test(value);
}

function normalizePromptText(value: string): string {
  return stripMarkdown(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function stripMarkdown(value: string): string {
  return value
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}
