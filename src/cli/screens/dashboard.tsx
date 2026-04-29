import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ApprovalModal } from "../components/approval-modal.js";
import { COLORS } from "../theme.js";
import {
  applyComposerTextInput,
  normalizeComposerCursor,
  SelectionHint,
  StableComposerInput,
} from "../components/stable-composer.js";
import {
  hydrateRuntimeViewState,
  reduceRunEvent,
  type RuntimeViewState,
} from "../state/run-store.js";
import { bus, type ApprovalRequestPayload, type ServusEvent } from "../../events.js";
import { Orchestrator, type OrchestratorConfig, type OrchestratorRunOutcome } from "../../orchestrator.js";
import { formatDuration } from "../../log.js";
import { appendEvent, appendLog, getSession, updateSession } from "../../session-store.js";
import { killAllServusChildren } from "../../child-registry.js";
import type { ClarificationRequest } from "../../clarification.js";
import { CodingRuntime } from "../../coding-runtime.js";
import { SERVUS_DIR } from "../../config.js";
import { loadCustomCodingCommands, parseCodingCommand } from "../../coding-commands.js";
import {
  clearCodingUserMessages,
  queueCodingUserMessage,
} from "../../coding-message-queue.js";
import { runTuiMcpCommand } from "../mcp-command.js";

interface PendingApproval {
  request: ApprovalRequestPayload;
  resolve: (approved: boolean) => void;
}

interface Props {
  config: OrchestratorConfig;
  visible?: boolean;
  onBack: () => void;
  onFollowUp?: (followUpText: string, options?: { sameSession?: boolean }) => void;
  onOpenOverlay?: (overlay: "help" | "models" | "sessions" | "agents" | "tools" | "mcp" | "settings" | "capabilities" | "diff") => void;
  clearSignal?: number;
  onInputLockedChange?: (locked: boolean) => void;
  inputBlocked?: boolean;
}

const CHAT_PAGE_SIZE = 30;
const MESSAGE_PREVIEW_LINES = 7;
type ComposerMode = "follow-up" | "answer" | "message";
type StreamingMessage = { agent: string; color?: string; text: string; timestamp: number };

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  agent?: string;
  content: string;
  timestamp: number;
}

type LiveCommandSuggestion = {
  command: string;
  description: string;
  category: "session" | "coding" | "tools" | "config" | "mcp";
};

const LIVE_COMMANDS: LiveCommandSuggestion[] = [
  { command: "/help", description: "Show shortcuts and command help", category: "session" },
  { command: "/new", description: "Start a new run from home", category: "session" },
  { command: "/models", description: "Open model picker", category: "config" },
  { command: "/model", description: "Open model picker", category: "config" },
  { command: "/sessions", description: "Open session switcher", category: "session" },
  { command: "/resume", description: "Resume a saved session", category: "session" },
  { command: "/fork", description: "Fork this session", category: "session" },
  { command: "/status", description: "Show session and repo status", category: "session" },
  { command: "/transcript", description: "Summarize recent transcript", category: "session" },
  { command: "/plan", description: "Switch or request plan mode", category: "coding" },
  { command: "/build", description: "Continue implementation mode", category: "coding" },
  { command: "/coordinate", description: "Coordinate helper agents", category: "coding" },
  { command: "/explore", description: "Run read-only exploration", category: "coding" },
  { command: "/review", description: "Review current changes", category: "coding" },
  { command: "/agents", description: "List available agents", category: "tools" },
  { command: "/tools", description: "List available tools", category: "tools" },
  { command: "/files", description: "Show read and changed files", category: "coding" },
  { command: "/commands", description: "Show custom commands", category: "tools" },
  { command: "/capabilities", description: "Open capabilities overlay", category: "tools" },
  { command: "/settings", description: "Open settings overlay", category: "config" },
  { command: "/mcp", description: "Open MCP overlay", category: "mcp" },
  { command: "/mcp tools", description: "List MCP tools", category: "mcp" },
  { command: "/mcp resources", description: "List MCP resources", category: "mcp" },
  { command: "/mcp prompts", description: "List MCP prompts", category: "mcp" },
  { command: "/mcp test", description: "Test an MCP server", category: "mcp" },
  { command: "/mcp auth status", description: "Show MCP auth state", category: "mcp" },
  { command: "/mcp instructions", description: "Show MCP server instructions", category: "mcp" },
  { command: "/permissions", description: "Show permission rules", category: "config" },
  { command: "/hooks", description: "Show hooks", category: "tools" },
  { command: "/skills", description: "Show skills", category: "tools" },
  { command: "/output-style", description: "Select response style", category: "config" },
  { command: "/diff", description: "Show latest diff", category: "coding" },
  { command: "/revert", description: "Revert a checkpoint", category: "coding" },
  { command: "/verify", description: "Run or queue verification", category: "coding" },
  { command: "/compact", description: "Compact context", category: "session" },
  { command: "/context", description: "Show context usage", category: "session" },
  { command: "/memory", description: "Show project memory", category: "session" },
  { command: "/remember", description: "Save project memory", category: "session" },
  { command: "/doctor", description: "Run diagnostics", category: "tools" },
  { command: "/init", description: "Create SERVUS.md files", category: "coding" },
];

export function Dashboard({ config, visible = true, onBack, onFollowUp, onOpenOverlay, clearSignal = 0, onInputLockedChange, inputBlocked = false }: Props) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const activeRunRef = useRef<{ sessionId?: string; running: boolean } | null>(null);
  const orchestratorRef = useRef<Orchestrator | null>(null);
  const cancelledRunRef = useRef(false);
  const lastSessionIdRef = useRef<string | undefined>(config.sessionId);
  const [runtime, setRuntime] = useState<RuntimeViewState>({
    ...hydrateRuntimeViewState(config.sessionId ? getSession(config.sessionId) : null, {
      model: config.model,
      backend: config.backend,
      budget: config.maxBudgetUsd,
      domain: config.preferredDomain ?? "auto",
    }),
  });
  const [running, setRunning] = useState(true);
  const [startTime, setStartTime] = useState(Date.now());
  const [elapsed, setElapsed] = useState(0);
  const [transcriptOffset, setTranscriptOffset] = useState(0);
  const [logsExpanded, setLogsExpanded] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>(() => loadCodingTranscript(config.sessionId));
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [streaming, setStreaming] = useState<StreamingMessage | null>(null);
  const [composerMode, setComposerMode] = useState<ComposerMode | null>(null);
  const [composerValue, setComposerValue] = useState("");
  const [composerCursor, setComposerCursor] = useState(0);
  const [liveCommandIndex, setLiveCommandIndex] = useState(0);
  const [pendingQuestion, setPendingQuestion] = useState<string | undefined>(undefined);
  const [pendingContext, setPendingContext] = useState<string | undefined>(undefined);
  const [pendingClarification, setPendingClarification] = useState<ClarificationRequest | undefined>(undefined);
  const [answerIndex, setAnswerIndex] = useState(0);
  const [answers, setAnswers] = useState<Array<{ question: string; answer: string }>>([]);
  const [queuedMessages, setQueuedMessages] = useState<string[]>([]);
  const [liveCommandRunning, setLiveCommandRunning] = useState<string | null>(null);
  const queuedMessagesRef = useRef<string[]>([]);
  const streamingRef = useRef<StreamingMessage | null>(null);
  const runtimeDomainRef = useRef<RuntimeViewState["domain"]>(runtime.domain);

  function setComposerText(next: string) {
    setComposerValue(next);
    setComposerCursor(next.length);
  }

  useEffect(() => {
    setLiveCommandIndex(0);
    setComposerCursor((current) => normalizeComposerCursor(composerValue, current));
  }, [composerValue]);

  useEffect(() => {
    const suggestions = composerValue.startsWith("/")
      ? liveCommandSuggestions(composerValue, config.cwd)
      : [];
    setLiveCommandIndex((index) => clampIndex(index, suggestions.length));
  }, [composerValue, config.cwd]);

  useEffect(() => {
    onInputLockedChange?.(visible);
    return () => onInputLockedChange?.(false);
  }, [visible, onInputLockedChange]);

  useEffect(() => {
    runtimeDomainRef.current = runtime.domain;
  }, [runtime.domain]);

  const commitStreamingMessage = useCallback(() => {
    const current = streamingRef.current;
    if (!current?.text.trim()) {
      streamingRef.current = null;
      setStreaming(null);
      return;
    }
    const committed: ChatMessage = {
      id: `${current.timestamp}:stream:${current.agent}:${current.text.length}`,
      role: "assistant",
      agent: current.agent,
      content: cleanHumanMessage(current.text),
      timestamp: current.timestamp,
    };
    setChatMessages((prev) => appendChatMessage(prev, committed));
    streamingRef.current = null;
    setStreaming(null);
  }, []);

  const handleEvent = useCallback((event: ServusEvent) => {
    const metadata = event.metadata;
    if (
      event.type === "coding:user_message" &&
      metadata !== undefined &&
      metadata.sessionId === config.sessionId &&
      (metadata.status === "drained" || metadata.status === "cleared")
    ) {
      queuedMessagesRef.current = [];
      setQueuedMessages([]);
    }

    if (event.type === "assistant:delta") {
      const agent = event.agent ?? "Servus";
      if (streamingRef.current && streamingRef.current.agent !== agent) {
        commitStreamingMessage();
      }
      const previous = streamingRef.current;
      const next: StreamingMessage = previous && previous.agent === agent
        ? {
          ...previous,
          color: event.color ?? previous.color,
          text: previous.text + event.message,
          timestamp: previous.timestamp,
        }
        : {
          agent,
          color: event.color,
          text: event.message,
          timestamp: event.timestamp,
        };
      streamingRef.current = next;
      setStreaming(next);
      return;
    }
    if (event.type === "agent:text") {
      return;
    }

    commitStreamingMessage();
    const domainForEvent = domainFromEvent(event) ?? runtimeDomainRef.current;
    runtimeDomainRef.current = domainForEvent;
    const transcriptMessage = eventToTranscriptMessage(event, domainForEvent);
    if (transcriptMessage) {
      setChatMessages((prev) => appendChatMessage(prev, transcriptMessage));
    }
    setRuntime((prev) => reduceRunEvent(prev, event));
    if (config.sessionId) {
      appendEvent(config.sessionId, event);
      appendLog(
        config.sessionId,
        `[${event.agent ?? "servus"}] ${event.type}: ${(event.message ?? "").slice(0, 500)}`,
      );
    }
  }, [commitStreamingMessage, config.sessionId]);

  useEffect(() => {
    if (clearSignal === 0) return;
    setRuntime((prev) => ({ ...prev, logs: [], errors: [] }));
    streamingRef.current = null;
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
      setRuntime(hydrateRuntimeViewState(config.sessionId ? getSession(config.sessionId) : null, {
        model: config.model,
        backend: config.backend,
        budget: config.maxBudgetUsd,
        domain: config.preferredDomain ?? "auto",
      }));
      streamingRef.current = null;
      setStreaming(null);
      setPendingQuestion(undefined);
      setPendingContext(undefined);
      setPendingClarification(undefined);
      setAnswerIndex(0);
      setAnswers([]);
      setComposerText("");
      setComposerMode(null);
      setTranscriptOffset(0);
      setChatMessages(loadCodingTranscript(config.sessionId));
      setQueuedMessages([]);
      queuedMessagesRef.current = [];
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
    orchestratorRef.current = orchestrator;
    cancelledRunRef.current = false;
    activeRunRef.current = { sessionId: config.sessionId, running: true };

    orchestrator
      .run()
      .then((outcome) => {
        if (cancelledRunRef.current) return;
        setElapsed(Date.now() - startedAt);
        handleRunOutcome(outcome);
        setRunning(false);
      })
      .catch((err: Error) => {
        if (cancelledRunRef.current) return;
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
        if (orchestratorRef.current === orchestrator) orchestratorRef.current = null;
        orchestrator.closeAll();
      });

    return () => {
      orchestrator.closeAll();
      if (orchestratorRef.current === orchestrator) orchestratorRef.current = null;
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
    if (input.includes("\r") || input.includes("\n")) {
      submitComposer(composerValue);
      return;
    }
    if (key.ctrl && input === "p") {
      setComposerText(composerValue.startsWith("/") ? composerValue : "/");
      return;
    }
    if (key.ctrl && input === "o") {
      setLogsExpanded((value) => !value);
      return;
    }
    if (key.tab && composerValue.startsWith("/")) {
      const suggestion = liveCommandSuggestions(composerValue, config.cwd)[liveCommandIndex];
      if (suggestion) setComposerText(`${suggestion.command} `);
      return;
    }
    if (composerValue.startsWith("/") && key.downArrow) {
      const suggestions = liveCommandSuggestions(composerValue, config.cwd);
      if (suggestions.length > 0) {
        setLiveCommandIndex((index) => Math.min(suggestions.length - 1, index + 1));
      }
      return;
    }
    if (composerValue.startsWith("/") && key.upArrow) {
      setLiveCommandIndex((index) => Math.max(0, index - 1));
      return;
    }
    if (key.escape && composerValue) {
      setComposerText("");
      return;
    }
    if (key.escape && composerMode && composerMode !== "answer") {
      setComposerMode(null);
      return;
    }
    if (key.ctrl && input === "c" && running) {
      cancelRun();
      return;
    }
    if (key.ctrl && input === "d" && !running) {
      onBack();
      return;
    }
    if (key.pageUp) {
      setTranscriptOffset((value) => Math.min(value + CHAT_PAGE_SIZE, Math.max(0, chatMessages.length - CHAT_PAGE_SIZE)));
      return;
    }
    if (key.pageDown) {
      setTranscriptOffset((value) => Math.max(0, value - CHAT_PAGE_SIZE));
      return;
    }

    const edited = applyComposerTextInput(composerValue, composerCursor, input, key);
    if (edited.handled) {
      setComposerValue(edited.value);
      setComposerCursor(edited.cursor);
    }
  }, { isActive: visible && !inputBlocked });

  function cancelRun() {
    cancelledRunRef.current = true;
    orchestratorRef.current?.closeAll();
    void killAllServusChildren();
    setRunning(false);
    handleEvent({
      type: "warn",
      agent: "TUI",
      message: "Foreground run cancelled by user. The session is preserved for follow-up.",
      metadata: { sessionId: config.sessionId },
      timestamp: Date.now(),
    });
    if (config.sessionId) {
      updateSession(config.sessionId, {
        status: "failed",
        runtimeStatus: "cancelled",
        endTime: Date.now(),
      });
    }
  }

  function resolveApproval(approved: boolean) {
    pendingApproval?.resolve(approved);
    setPendingApproval(null);
  }

  function handleRunOutcome(outcome: OrchestratorRunOutcome) {
    commitStreamingMessage();
    if (outcome.status === "waiting_input") {
      if (flushQueuedMessages("Servus asked for input after these live messages were queued")) return;
      const question = outcome.question ?? outcome.result?.question ?? outcome.result?.summary;
      setPendingQuestion(question);
      setPendingContext(outcome.questionContext ?? outcome.result?.questionContext);
      setPendingClarification(outcome.clarification ?? outcome.result?.clarification);
      if (question) {
        const timestamp = Date.now();
        setChatMessages((prev) => appendChatMessage(prev, {
          id: `${timestamp}:waiting-input-question`,
          role: "assistant",
          agent: "Servus",
          content: `Question: ${cleanHumanMessage(question)}`,
          timestamp,
        }));
      }
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
      if (flushQueuedMessages("Continue after the previous run completed")) return;
      return;
    }

    handleEvent({ type: "error", message: "Run failed", timestamp: Date.now() });
    if (config.sessionId) {
      updateSession(config.sessionId, { status: "failed", runtimeStatus: "failed", endTime: Date.now() });
    }
    flushQueuedMessages("Continue after the previous run failed");
  }

  function submitComposer(value: string) {
    const text = value.trim();
    if (!text || !onFollowUp) return;
    const effectiveMode: ComposerMode = composerMode ?? (running ? "message" : "follow-up");

    const handledCommand = tryRunLiveCodingCommand(text);
    if (handledCommand) {
      if (composerMode !== "answer") setComposerMode(null);
      setComposerText("");
      return;
    }

    if (effectiveMode === "message" && running) {
      queueLiveMessage(text);
      if (composerMode !== "answer") setComposerMode(null);
      setComposerText("");
      return;
    }

    if (effectiveMode === "answer") {
      const clarification = pendingClarification ?? runtime.clarification;
      const questions = getQuestionList(runtime, pendingQuestion, clarification);
      const currentQuestion = questions[Math.min(answerIndex, questions.length - 1)] ?? "Missing detail";
      const nextAnswers = [...answers, { question: currentQuestion, answer: text }];
      bus.push({
        type: "user_input:response",
        message: text,
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
        setComposerText("");
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
      setComposerText("");
      setPendingQuestion(undefined);
      setPendingContext(undefined);
      setPendingClarification(undefined);
      setAnswerIndex(0);
      setAnswers([]);
      return;
    }

    bus.push({
      type: "user_input:response",
      agent: "You",
      message: text,
      metadata: { sessionId: config.sessionId, sameSession: true, followUp: true },
    });
    onFollowUp(text, { sameSession: true });
    setComposerMode(null);
    setComposerText("");
    setPendingQuestion(undefined);
    setPendingContext(undefined);
    setPendingClarification(undefined);
    setAnswerIndex(0);
    setAnswers([]);
  }

  function queueLiveMessage(text: string) {
    const persisted = queueCodingUserMessage({
      sessionId: config.sessionId,
      message: text,
      source: "tui",
    });
    const next = [...queuedMessagesRef.current, text].slice(-8);
    queuedMessagesRef.current = next;
    setQueuedMessages(next);
    bus.push({
      type: "user_input:response",
      message: text,
      metadata: {
        sessionId: config.sessionId,
        sameSession: true,
        queued: true,
        queueId: persisted?.id,
        message: text,
      },
    });
    if (config.sessionId) {
      updateSession(config.sessionId, {
        status: "running",
        runtimeStatus: "running",
      });
    }
  }

  function flushQueuedMessages(reason: string): boolean {
    const messages = queuedMessagesRef.current;
    if (messages.length === 0 || !onFollowUp) return false;
    clearCodingUserMessages(config.sessionId);
    queuedMessagesRef.current = [];
    setQueuedMessages([]);
    onFollowUp([
      reason,
      "",
      "Live messages queued by the user while the previous agent turn was running:",
      "",
      ...messages.flatMap((message, index) => [`${index + 1}. ${message}`, ""]),
    ].join("\n"), { sameSession: true });
    return true;
  }

  function tryRunLiveCodingCommand(text: string): boolean {
    const slash = text.split(/\s+/)[0]?.toLowerCase() ?? "";
    const overlay = runOverlayForCommand(slash);
    const hasArguments = text.trim().split(/\s+/).length > 1;
    const shouldOpenOverlay = overlay && onOpenOverlay && !(
      (slash === "/mcp" && text.trim() !== "/mcp") ||
      (slash === "/diff" && hasArguments)
    );
    if (shouldOpenOverlay) {
      onOpenOverlay(overlay);
      return true;
    }

    if (text.startsWith("/mcp")) {
      setLiveCommandRunning("mcp");
      void runTuiMcpCommand(text, config.cwd)
        .then((summary) => {
          bus.push({
            type: "info",
            agent: "MCP",
            message: summary,
            metadata: { command: "mcp", sessionId: config.sessionId },
          });
        })
        .catch((err: unknown) => {
          bus.push({
            type: "error",
            agent: "MCP",
            message: `MCP command failed: ${err instanceof Error ? err.message : String(err)}`,
            metadata: { command: "mcp", sessionId: config.sessionId },
          });
        })
        .finally(() => setLiveCommandRunning(null));
      return true;
    }
    const command = parseCodingCommand(text);
    if (!command?.immediate) return false;
    const domain = config.preferredDomain ?? runtime.domain;
    if (domain !== "coding") {
      bus.push({
        type: "warn",
        agent: "TUI",
        message: `/${command.name} is a coding-session command and this run is ${domain}.`,
        metadata: { command: command.name, domain },
      });
      return true;
    }

    if (running && command.name === "revert") {
      bus.push({
        type: "warn",
        agent: "TUI",
        message: "/revert is disabled while the coding agent is running. Wait for a pause or completion so Servus does not reverse files mid-edit.",
        metadata: { command: command.name },
      });
      return true;
    }

    if (running && command.name === "verify") {
      queueLiveMessage(text);
      bus.push({
        type: "warn",
        agent: "TUI",
        message: "/verify was queued for this same session after the current agent turn; running tests mid-edit can produce false failures.",
        metadata: { command: command.name },
      });
      return true;
    }

    setLiveCommandRunning(command.name);
    bus.push({
      type: "info",
      agent: "TUI",
      message: `Running same-session command /${command.name}`,
      metadata: { command: command.name, sessionId: config.sessionId },
    });
    void runLiveCodingCommand(text)
      .catch((err: unknown) => {
        bus.push({
          type: "error",
          agent: "TUI",
          message: `/${command.name} failed: ${err instanceof Error ? err.message : String(err)}`,
          metadata: { command: command.name },
        });
      })
      .finally(() => setLiveCommandRunning(null));
    return true;
  }

  async function runLiveCodingCommand(text: string): Promise<void> {
    const command = parseCodingCommand(text);
    if (!command?.immediate) return;
    const runtimeCommand = new CodingRuntime({
      task: text,
      cwd: config.cwd,
      model: config.model,
      backend: config.backend,
      maxConsecutiveFailures: config.maxConsecutiveFailures,
      verifyCommand: config.verifyCommand,
      maxBudgetUsd: config.maxBudgetUsd,
      sessionId: config.sessionId,
    });
    await runtimeCommand.initialize();

    if (command.name === "status") {
      const summary = await runtimeCommand.buildStatusSummary();
      bus.push({ type: "info", agent: "CodingRuntime", message: summary, metadata: { command: command.name } });
      return;
    }
    if (command.name === "transcript") {
      bus.push({
        type: "info",
        agent: "CodingRuntime",
        message: runtimeCommand.buildTranscriptSummary(command.args),
        metadata: { command: command.name },
      });
      return;
    }
    if (command.name === "help") {
      bus.push({
        type: "info",
        agent: "CodingRuntime",
        message: runtimeCommand.buildHelpSummary(),
        metadata: { command: command.name },
      });
      return;
    }
    if (command.name === "tools") {
      bus.push({
        type: "info",
        agent: "CodingRuntime",
        message: runtimeCommand.buildToolsSummary(),
        metadata: { command: command.name },
      });
      return;
    }
    if (command.name === "diff") {
      const result = await runtimeCommand.buildDiffSummary(command.args || "latest");
      bus.push({
        type: "coding:diff",
        agent: "CodingRuntime",
        message: result.summary,
        metadata: { command: command.name, artifacts: result.artifacts },
      });
      return;
    }
    if (command.name === "sessions" || command.name === "search") {
      bus.push({
        type: "info",
        agent: "CodingRuntime",
        message: runtimeCommand.buildSessionsSummary(command.args),
        metadata: { command: command.name },
      });
      return;
    }
    if (command.name === "compact") {
      bus.push({
        type: "context:compact",
        agent: "CodingRuntime",
        message: "Manual coding compaction boundary requested from Live Run",
        metadata: { command: command.name, sessionId: config.sessionId },
      });
      return;
    }
    if (command.name === "context") {
      bus.push({
        type: "info",
        agent: "CodingRuntime",
        message: runtimeCommand.buildContextSummary(),
        metadata: { command: command.name },
      });
      return;
    }
    if (command.name === "remember") {
      const result = runtimeCommand.rememberInstruction(command.args);
      bus.push({
        type: result.ok ? "coding:memory" : "error",
        agent: "CodingRuntime",
        message: result.summary,
        metadata: { command: command.name, artifacts: result.artifacts },
      });
      return;
    }
    if (command.name === "memory") {
      bus.push({
        type: "coding:memory",
        agent: "CodingRuntime",
        message: runtimeCommand.buildMemorySummary(),
        metadata: { command: command.name },
      });
      return;
    }
    if (command.name === "files") {
      bus.push({
        type: "info",
        agent: "CodingRuntime",
        message: await runtimeCommand.buildFilesSummary(),
        metadata: { command: command.name },
      });
      return;
    }
    if (command.name === "agents") {
      bus.push({
        type: "info",
        agent: "CodingRuntime",
        message: runtimeCommand.buildAgentsSummary(),
        metadata: { command: command.name },
      });
      return;
    }
    if (command.name === "model" || command.name === "models") {
      bus.push({
        type: "info",
        agent: "CodingRuntime",
        message: runtimeCommand.buildModelsSummary(),
        metadata: { command: command.name },
      });
      return;
    }
    if (command.name === "permissions") {
      bus.push({
        type: "info",
        agent: "CodingRuntime",
        message: runtimeCommand.buildPermissionsSummary(),
        metadata: { command: command.name },
      });
      return;
    }
    if (command.name === "hooks") {
      bus.push({
        type: "info",
        agent: "CodingRuntime",
        message: runtimeCommand.buildHooksSummary(),
        metadata: { command: command.name },
      });
      return;
    }
    if (command.name === "commands") {
      bus.push({
        type: "info",
        agent: "CodingRuntime",
        message: runtimeCommand.buildCommandsSummary(),
        metadata: { command: command.name },
      });
      return;
    }
    if (command.name === "settings") {
      bus.push({
        type: "info",
        agent: "CodingRuntime",
        message: runtimeCommand.buildSettingsSummary(),
        metadata: { command: command.name },
      });
      return;
    }
    if (command.name === "skills") {
      bus.push({
        type: "info",
        agent: "CodingRuntime",
        message: runtimeCommand.buildSkillsSummary(),
        metadata: { command: command.name },
      });
      return;
    }
    if (command.name === "output-style") {
      const result = runtimeCommand.buildOutputStylesSummary(command.args);
      bus.push({
        type: result.ok ? "info" : "error",
        agent: "CodingRuntime",
        message: result.summary,
        metadata: { command: command.name, artifacts: result.artifacts },
      });
      return;
    }
    if (command.name === "doctor") {
      bus.push({
        type: "info",
        agent: "CodingRuntime",
        message: await runtimeCommand.buildDoctorSummary(),
        metadata: { command: command.name },
      });
      return;
    }
    if (command.name === "init") {
      const result = runtimeCommand.initializeProjectFiles();
      bus.push({
        type: result.ok ? "coding:memory" : "error",
        agent: "CodingRuntime",
        message: result.summary,
        metadata: { command: command.name, artifacts: result.artifacts },
      });
      return;
    }
    if (command.name === "verify") {
      const attempt = await runtimeCommand.verify("project", command.args);
      bus.push({
        type: "coding:verification_verdict",
        agent: "CodingRuntime",
        message: `Verification ${attempt.status}: ${attempt.command}`,
        metadata: { command: attempt.command, status: attempt.status, failureCategory: attempt.failureCategory },
      });
      return;
    }
    if (command.name === "revert") {
      const result = await runtimeCommand.revertCheckpoint(command.args || "latest");
      bus.push({
        type: result.ok ? "coding:revert" : "error",
        agent: "CodingRuntime",
        message: result.summary,
        metadata: { command: command.name, artifacts: result.artifacts },
      });
    }
  }

  function renderComposerPanel() {
    const effectiveMode: ComposerMode = composerMode ?? (running ? "message" : "follow-up");
    const isAnswer = effectiveMode === "answer";
    const clarification = pendingClarification ?? runtime.clarification;
    const questions = getQuestionList(runtime, pendingQuestion, clarification);
    const currentQuestion = questions[Math.min(answerIndex, questions.length - 1)] ?? "What should Servus use?";
    const context = cleanPromptContext(
      clarification?.context ?? pendingContext ?? runtime.questionContext,
      currentQuestion,
    );
    const fullSuggestions = composerValue.startsWith("/") ? liveCommandSuggestions(composerValue, config.cwd) : [];
    const suggestionHeight = 6;
    const suggestionOffset = Math.max(0, Math.min(liveCommandIndex - suggestionHeight + 1, Math.max(0, fullSuggestions.length - suggestionHeight)));
    const suggestions = fullSuggestions.slice(suggestionOffset, suggestionOffset + suggestionHeight);
    const suggestionTopPadding = suggestions.length > 0 ? Math.max(0, suggestionHeight - suggestions.length) : 0;
    const composerWidth = Math.max(32, (stdout?.columns ?? 120) - ((stdout?.columns ?? 120) >= 112 ? 38 : 4));
    const inputWidth = Math.max(20, composerWidth - 6);
    const questionWidth = Math.max(24, composerWidth - 6);
    const suggestionWell = (
      <Box height={suggestionHeight} flexDirection="column" overflow="hidden" paddingX={2}>
        {suggestions.length > 0 ? (
          <>
            {Array.from({ length: suggestionTopPadding }).map((_, index) => (
              <Text key={`live-command-pad-${index}`}> </Text>
            ))}
            {suggestions.map((suggestion, localIndex) => {
              const index = suggestionOffset + localIndex;
              return (
                <Box key={`${suggestion.command}:${suggestion.description}`}>
                  <SelectionHint selected={index === liveCommandIndex}>{suggestion.command.padEnd(20)}</SelectionHint>
                  <Text color={index === liveCommandIndex ? "white" : "gray"} wrap="truncate"> {suggestion.description}</Text>
                </Box>
              );
            })}
          </>
        ) : (
          <Text color="gray">
            {isAnswer ? "Answer the pinned question below." : "Type naturally, / for commands, @ for files, ! for shell."}
          </Text>
        )}
      </Box>
    );

    return (
      <Box flexDirection="column" marginTop={1} backgroundColor="black">
        {isAnswer && (
          <Box flexDirection="column" borderStyle="single" borderColor={COLORS.accent} paddingX={1}>
            <Text color={COLORS.accent} bold>
              {clarificationModeLabel(clarification)} {Math.min(answerIndex + 1, questions.length)}/{questions.length}
            </Text>
            <PreviewText value={currentQuestion} width={questionWidth} color="white" maxLines={3} />
            {answers.length > 0 && (
              <Text color={COLORS.secondary}>
                Collected {answers.length}/{questions.length}
              </Text>
            )}
            {clarification?.choices?.map((group) => (
              <Box key={group.id} flexDirection="column" marginTop={1}>
                <Text color={COLORS.secondary} bold>{group.label}</Text>
                {group.options.slice(0, 6).map((option, index) => (
                  <Text key={`${group.id}:${option}:${index}`} color="gray" wrap="wrap">
                    {hardWrapText(`${index + 1}. ${option}`, questionWidth)}
                  </Text>
                ))}
                {group.options.length > 6 && (
                  <Text color={COLORS.muted}>… {group.options.length - 6} more options</Text>
                )}
              </Box>
            ))}
            {context && answerIndex === 0 && (
              <Box flexDirection="column" marginTop={1}>
                <Text color={COLORS.muted}>Context</Text>
                <PreviewText value={context} width={questionWidth} color="gray" maxLines={4} />
              </Box>
            )}
          </Box>
        )}
        {suggestionWell}
        <Box borderStyle="single" borderColor={isAnswer ? COLORS.accent : COLORS.blue} paddingX={1} flexDirection="column">
          <Box gap={1} height={3}>
            <Text color={isAnswer ? COLORS.accent : COLORS.blue}>▌</Text>
            <StableComposerInput
              value={composerValue}
              cursor={composerCursor}
              width={inputWidth}
              maxLines={3}
              active={!pendingApproval}
              placeholder={isAnswer ? "Reply with the missing details..." : "Send a same-session message, /command, or follow-up..."}
            />
          </Box>
          <Box marginTop={1} justifyContent="space-between">
            <Text color={COLORS.blue}>Build</Text>
            <Text color="gray">tab complete · ctrl+p commands · ctrl+c cancel · ctrl+d home</Text>
          </Box>
        </Box>
      </Box>
    );
  }

  if (!visible) return null;
  const terminalWidth = stdout?.columns ?? 120;
  const terminalHeight = stdout?.rows ?? 36;
  const showSidebar = terminalWidth >= 112;
  const sidebarWidth = showSidebar ? 36 : 0;
  const transcriptWidth = Math.max(44, terminalWidth - sidebarWidth - 4);
  const transcriptHeight = Math.max(8, terminalHeight - 12);

  return (
    <Box flexDirection="column" flexGrow={1} backgroundColor="black">
      <Box height={transcriptHeight}>
        <Box flexDirection="column" width={transcriptWidth} paddingRight={1}>
          <ChatTranscript
            messages={chatMessages}
            streaming={streaming}
            finalSummary={
              runtime.status === "completed" || runtime.status === "failed"
                ? runtime.sessionReplay?.lastAssistantMessage
                : runtime.sessionReplay?.lastAssistantMessage
            }
            offset={transcriptOffset}
            width={transcriptWidth}
            height={transcriptHeight}
            expanded={logsExpanded}
          />
        </Box>
        {showSidebar && (
          <RunSidebar
            runtime={runtime}
            queuedMessages={queuedMessages}
            liveCommandRunning={liveCommandRunning}
            targetCwd={runtime.targetCwd ?? config.cwd}
            sessionId={config.sessionId}
            model={config.model}
            running={running}
            elapsed={elapsed}
          />
        )}
      </Box>
      <ApprovalModal pending={pendingApproval} onResolve={resolveApproval} />
      {renderComposerPanel()}
      <Box justifyContent="space-between">
        <Text color="gray">{shortPath(runtime.targetCwd ?? config.cwd)}</Text>
        <Text color="gray">
          {runtime.contextUsage
            ? `${formatCompact(runtime.contextUsage.estimatedTokens)} (${runtime.contextUsage.compactPercent}%)`
            : "context n/a"} · ctrl+p commands · ctrl+o {logsExpanded ? "collapse" : "expand"}
        </Text>
      </Box>
    </Box>
  );
}

function ChatTranscript({
  messages,
  streaming,
  finalSummary,
  offset,
  width,
  height,
  expanded,
}: {
  messages: ChatMessage[];
  streaming: StreamingMessage | null;
  finalSummary?: string;
  offset: number;
  width: number;
  height: number;
  expanded: boolean;
}) {
  const pageSize = Math.max(4, Math.min(CHAT_PAGE_SIZE, Math.floor(height / 4)));
  const safeOffset = Math.min(Math.max(0, offset), Math.max(0, messages.length - pageSize));
  const end = Math.max(0, messages.length - safeOffset);
  const start = Math.max(0, end - pageSize);
  const visibleMessages = messages.slice(start, end);
  const atBottom = safeOffset === 0;
  const finalAlreadyVisible = finalSummary
    ? messages.some((message) => normalizeForCompare(message.content) === normalizeForCompare(finalSummary))
    : true;
  if (visibleMessages.length === 0 && !streaming && !finalSummary) {
    return (
      <Box flexDirection="column" paddingX={1} height={height} width={width} overflow="hidden">
        <Text color="gray">Servus is starting. The transcript will appear here.</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" paddingX={1} height={height} width={width} overflow="hidden">
      {messages.length > visibleMessages.length && (
        <Text color="gray">showing {start + 1}-{end}/{messages.length}{atBottom ? " live" : " scrolled"}</Text>
      )}
      {visibleMessages.map((message) => (
        <ChatMessageBlock key={message.id} message={message} width={width} expanded={expanded} />
      ))}
      {finalSummary && atBottom && !finalAlreadyVisible && !streaming && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={COLORS.primary} bold>Servus</Text>
          <PreviewText
            value={finalSummary}
            width={Math.max(16, width - 4)}
            color="white"
            maxLines={expanded ? 10_000 : MESSAGE_PREVIEW_LINES}
          />
        </Box>
      )}
      {streaming && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={streaming.color ?? COLORS.accent}>┃ {streaming.agent}</Text>
          <PreviewText
            value={`${streaming.text}▌`}
            width={Math.max(16, width - 4)}
            color="white"
            maxLines={expanded ? 10_000 : MESSAGE_PREVIEW_LINES}
          />
        </Box>
      )}
      {finalSummary && visibleMessages.length === 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={COLORS.primary} bold>Servus</Text>
          <PreviewText
            value={finalSummary}
            width={Math.max(16, width - 4)}
            color="white"
            maxLines={expanded ? 10_000 : MESSAGE_PREVIEW_LINES}
          />
        </Box>
      )}
    </Box>
  );
}

function ChatMessageBlock({ message, width, expanded }: { message: ChatMessage; width: number; expanded: boolean }) {
  const contentWidth = Math.max(16, width - 8);
  if (message.role === "user") {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box borderStyle="single" borderColor={COLORS.blue} paddingX={1} width={Math.max(20, width - 4)} flexDirection="column">
          <Text color={COLORS.blue}>You</Text>
          <PreviewText value={message.content} width={contentWidth} color="white" maxLines={expanded ? 10_000 : MESSAGE_PREVIEW_LINES} />
        </Box>
      </Box>
    );
  }
  const isSystem = message.role === "system";
  const isTool = message.role === "tool";
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={isSystem ? COLORS.secondary : isTool ? COLORS.blue : COLORS.accent}>
        {isSystem ? "◇" : isTool ? "□" : "┃"} {message.agent ?? "Servus"}
      </Text>
      <PreviewText
        value={message.content}
        width={Math.max(16, width - 4)}
        color={isSystem || isTool ? "gray" : "white"}
        maxLines={expanded ? 10_000 : MESSAGE_PREVIEW_LINES}
      />
    </Box>
  );
}

function PreviewText({
  value,
  width,
  color,
  maxLines,
}: {
  value: string;
  width: number;
  color: string;
  maxLines: number;
}) {
  const wrapped = hardWrapText(value, width);
  const preview = clampLines(wrapped, maxLines);
  return (
    <Box flexDirection="column">
      <Text color={color} wrap="wrap">{preview.text}</Text>
      {preview.truncated && (
        <Text color={COLORS.muted}>
          … {preview.hiddenLines} more lines. Use /transcript or Logs for full detail.
        </Text>
      )}
    </Box>
  );
}

function RunSidebar({
  runtime,
  queuedMessages,
  liveCommandRunning,
  targetCwd,
  sessionId,
  model,
  running,
  elapsed,
}: {
  runtime: RuntimeViewState;
  queuedMessages: string[];
  liveCommandRunning: string | null;
  targetCwd: string;
  sessionId?: string;
  model: string;
  running: boolean;
  elapsed: number;
}) {
  return (
    <Box width={36} flexDirection="column" paddingLeft={1}>
      <Text color="white" bold>
        {sessionId ? `Session ${sessionId.slice(0, 8)}` : "Direct session"}
      </Text>
      <Text color="gray">{running ? "Running" : runtime.status} · {formatDuration(elapsed)}</Text>
      <Text> </Text>
      <Text color="white" bold>Context</Text>
      <Text color="gray">
        {runtime.contextUsage
          ? `${runtime.contextUsage.estimatedTokens.toLocaleString()} tokens`
          : "tokens unavailable"}
      </Text>
      <Text color="gray">${runtime.cost.toFixed(2)} spent</Text>
      <Text color="gray">{runtime.contextUsage ? `${runtime.contextUsage.compactPercent}% used` : "usage n/a"}</Text>
      <Text> </Text>
      <Text color="white" bold>Run</Text>
      <Text color="gray">Mode {runtime.domain}</Text>
      <Text color="gray">Model {shortModel(model)}</Text>
      <Text color="gray" wrap="truncate">Cwd {shortPath(targetCwd)}</Text>
      <Text color="gray">Phase {runtime.phase}</Text>
      <Text> </Text>
      <Text color="white" bold>Activity</Text>
      <Text color="gray">Tools {runtime.activeTools.length} active / {runtime.tools.length} total</Text>
      <Text color="gray">Files {runtime.changedFiles.length}</Text>
      <Text color="gray">Todos {runtime.todos.filter((todo) => todo.status !== "completed").length}</Text>
      <Text color="gray">Queued {queuedMessages.length}</Text>
      <Text color="gray">Cmd {liveCommandRunning ? `/${liveCommandRunning}` : "idle"}</Text>
      {runtime.tools.slice(-4).map((tool) => (
        <Text
          key={`${tool.id}:${tool.status}`}
          color={tool.status === "failed" ? COLORS.error : tool.status === "running" ? COLORS.accent : COLORS.secondary}
          wrap="wrap"
        >
          {formatHumanToolActivity(tool)}
        </Text>
      ))}
      <Text> </Text>
      <DomainFocusPanel runtime={runtime} />
      <Text> </Text>
      <Text color="white" bold>Logs</Text>
      <Text color="gray">{runtime.logs.length} technical events hidden from chat</Text>
      <Text color="gray">Use /status or session files for detail</Text>
      <Text> </Text>
      {runtime.todos.slice(-5).map((todo) => (
        <Text
          key={todo.id}
          color={todo.status === "in_progress" ? COLORS.accent : todo.status === "completed" ? COLORS.primary : "gray"}
          wrap="wrap"
        >
          {todo.status === "in_progress" ? "›" : todo.status === "completed" ? "✓" : "·"} {todo.content}
        </Text>
      ))}
      {runtime.errors.slice(-3).map((error) => (
        <Text key={error.id} color={COLORS.error} wrap="wrap">! {error.message}</Text>
      ))}
      <Box flexGrow={1} />
      <Box borderStyle="single" borderColor="gray" paddingX={1} flexDirection="column">
        <Text color="white" bold>Getting started</Text>
        <Text color="gray" wrap="wrap">Type naturally. Use /commands for tools, sessions, models, MCP, diff, verify, and memory.</Text>
        <Text color="white">Commands <Text color="gray">ctrl+p or /</Text></Text>
      </Box>
    </Box>
  );
}

function DomainFocusPanel({ runtime }: { runtime: RuntimeViewState }) {
  const domain = runtime.domain;
  const workflow = runtime.workflow ? <WorkflowMiniView workflow={runtime.workflow} /> : null;
  if (domain === "coding") {
    return (
      <Box flexDirection="column">
        <Text color="white" bold>Coding</Text>
        {workflow}
        <Text color="gray">Changed {runtime.changedFiles.length} · checkpoints {runtime.checkpoints.length}</Text>
        {runtime.changedFiles.slice(-3).map((file) => (
          <Text key={file} color={COLORS.secondary} wrap="truncate">• {file}</Text>
        ))}
        {runtime.verification.at(-1) && (
          <Text color={COLORS.accent} wrap="wrap">Verify {runtime.verification.at(-1)}</Text>
        )}
      </Box>
    );
  }
  if (domain === "browser") {
    return (
      <Box flexDirection="column">
        <Text color="white" bold>Browser</Text>
        {workflow}
        <Text color="gray">Actions {runtime.tools.length} · proofs {runtime.artifacts.length}</Text>
        {runtime.activeTools.slice(-2).map((tool) => (
          <Text key={tool} color={COLORS.blue} wrap="wrap">↳ {tool}</Text>
        ))}
        {runtime.evidence.slice(-2).map((item) => (
          <Text key={item.id} color={COLORS.secondary} wrap="wrap">Proof {item.summary}</Text>
        ))}
      </Box>
    );
  }
  if (domain === "desktop") {
    return (
      <Box flexDirection="column">
        <Text color="white" bold>Desktop</Text>
        {workflow}
        <Text color="gray">File/OS actions {runtime.tools.length}</Text>
        {runtime.evidence.slice(-3).map((item) => (
          <Text key={item.id} color={COLORS.secondary} wrap="wrap">• {item.summary}</Text>
        ))}
      </Box>
    );
  }
  if (domain === "data") {
    return (
      <Box flexDirection="column">
        <Text color="white" bold>Data & Docs</Text>
        {workflow}
        <Text color="gray">Artifacts {runtime.artifacts.length} · evidence {runtime.evidence.length}</Text>
        {runtime.artifacts.slice(-3).map((artifact) => (
          <Text key={artifact} color={COLORS.secondary} wrap="truncate">• {artifact}</Text>
        ))}
      </Box>
    );
  }
  if (domain === "media") {
    return (
      <Box flexDirection="column">
        <Text color="white" bold>Media</Text>
        {workflow}
        <Text color="gray">Jobs {runtime.tools.length} · outputs {runtime.artifacts.length}</Text>
        {runtime.artifacts.slice(-3).map((artifact) => (
          <Text key={artifact} color={COLORS.secondary} wrap="truncate">• {artifact}</Text>
        ))}
      </Box>
    );
  }
  if (domain === "security") {
    return (
      <Box flexDirection="column">
        <Text color="white" bold>Security</Text>
        {workflow}
        <Text color="gray">Findings/evidence {runtime.evidence.length}</Text>
        {runtime.evidence.slice(-3).map((item) => (
          <Text key={item.id} color={item.type.toLowerCase().includes("finding") ? COLORS.error : COLORS.secondary} wrap="wrap">
            • {item.summary}
          </Text>
        ))}
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      <Text color="white" bold>{domain === "auto" ? "Auto Router" : "General"}</Text>
      {workflow}
      <Text color="gray">Evidence {runtime.evidence.length} · tools {runtime.tools.length}</Text>
      {runtime.evidence.slice(-2).map((item) => (
        <Text key={item.id} color={COLORS.secondary} wrap="wrap">• {item.summary}</Text>
      ))}
    </Box>
  );
}

function WorkflowMiniView({ workflow }: { workflow: NonNullable<RuntimeViewState["workflow"]> }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={COLORS.accent}>Phase {workflow.phase}</Text>
      {workflow.activeStep && <Text color="gray" wrap="wrap">↳ {workflow.activeStep}</Text>}
      {workflow.evidence.slice(-2).map((item, index) => (
        <Text key={`${item.type}:${index}`} color={COLORS.secondary} wrap="wrap">• {item.type}: {item.summary}</Text>
      ))}
    </Box>
  );
}

function eventToTranscriptMessage(event: ServusEvent, domain: RuntimeViewState["domain"]): ChatMessage | undefined {
  const formatted = formatHumanEvent(event, domain);
  if (!formatted) return undefined;
  return {
    id: `${event.timestamp}:${event.type}:${formatted.agent ?? formatted.role}`,
    role: formatted.role,
    agent: formatted.agent,
    content: formatted.content.trim(),
    timestamp: event.timestamp,
  };
}

function formatHumanEvent(
  event: ServusEvent,
  domain: RuntimeViewState["domain"],
): Pick<ChatMessage, "role" | "agent" | "content"> | undefined {
  if (!shouldShowInTranscript(event)) return undefined;
  const message = cleanHumanMessage(event.message);
  if (!message && event.type !== "approval:response") return undefined;

  if (event.type === "user_input:response") {
    return { role: "user", agent: "You", content: message };
  }
  if (event.type === "assistant:message" || event.type === "coding:final_summary") {
    return { role: "assistant", agent: event.agent ?? "Servus", content: message };
  }
  if (event.type === "agent:working_note") {
    return { role: "assistant", agent: event.agent ?? "Thinking", content: message };
  }
  if (event.type === "agent:blocker") {
    return { role: "assistant", agent: event.agent ?? "Blocked", content: `I’m blocked:\n${message}` };
  }
  if (event.type === "engine:start") {
    const runDomain = stringFromMetadata(event, "domain") || event.agent || "agent";
    return { role: "assistant", agent: "Servus", content: `I’m starting the ${humanizeDomain(runDomain)} run and setting up the workspace.` };
  }
  if (event.type === "phase") {
    return { role: "assistant", agent: event.agent ?? "Servus", content: domainNarration(domain, "phase", message) };
  }
  if (event.type === "agent:status") {
    return { role: "assistant", agent: event.agent ?? "Agent", content: domainNarration(domain, "status", message, event.agent) };
  }
  if (event.type === "agent:log") {
    return { role: "assistant", agent: event.agent ?? "Agent", content: domainNarration(domain, "log", message, event.agent) };
  }
  if (event.type === "info") {
    if (isNoisyInfoMessage(message)) return undefined;
    return { role: "assistant", agent: event.agent ?? "Servus", content: domainNarration(domain, "info", message, event.agent) };
  }
  if (event.type === "task:start") {
    return { role: "assistant", agent: event.agent ?? "Task", content: `I’m starting this step: ${message || "task started"}.` };
  }
  if (event.type === "task:complete") {
    return { role: "assistant", agent: event.agent ?? "Task", content: `I finished this step: ${message || "task completed"}.` };
  }
  if (event.type === "task:fail") {
    return { role: "assistant", agent: event.agent ?? "Task", content: `I hit a problem in this step: ${message || "task failed"}.` };
  }
  if (event.type === "verification") {
    return { role: "assistant", agent: "Verification", content: readableVerification(message) };
  }
  if (event.type === "evidence:add") {
    const summary = event.metadata?.evidence && typeof event.metadata.evidence === "object"
      ? String((event.metadata.evidence as Record<string, unknown>).summary ?? message)
      : message;
    return { role: "assistant", agent: "Evidence", content: `I found evidence: ${cleanHumanMessage(summary)}` };
  }
  if (event.type === "artifact:add") {
    return { role: "assistant", agent: "Artifact", content: `I saved an artifact: ${truncateOneLine(message, 80)}` };
  }
  if (event.type === "tool:start") {
    const tool = String(event.metadata?.tool ?? event.agent ?? "tool");
    return { role: "assistant", agent: event.agent ?? "Servus", content: toolStartNarration(domain, tool, message) };
  }
  if (event.type === "tool:finish" && event.metadata?.isError !== true && shouldShowToolFinish(event)) {
    const tool = String(event.metadata?.tool ?? event.agent ?? "tool");
    return { role: "assistant", agent: event.agent ?? "Servus", content: toolFinishNarration(domain, tool, message) };
  }
  if (event.type === "tool:finish" && event.metadata?.isError === true) {
    const tool = String(event.metadata?.tool ?? event.agent ?? "tool");
    return { role: "assistant", agent: "Tool failed", content: `I tried to ${humanizeToolName(tool).toLowerCase()}, but it failed.\n${message}` };
  }
  if (event.type === "engine:needs_input" || event.type === "user_input:request" || event.type === "coding:question") {
    const question = stringFromMetadata(event, "question") || message;
    return { role: "assistant", agent: "Servus", content: `Question: ${cleanHumanMessage(question)}` };
  }
  if (event.type === "approval:request" || event.type === "consent:request") {
    const action = stringFromMetadata(event, "action") || "Approval needed";
    const detail = stringFromMetadata(event, "detail") || message;
    return { role: "assistant", agent: "Approval", content: `I need your approval before I do this: ${action}\n${detail}` };
  }
  if (event.type === "approval:response" || event.type === "consent:response") {
    const approved = event.metadata?.approved === true;
    return { role: "assistant", agent: "Approval", content: approved ? "Approved. I’ll continue." : "Denied. I won’t perform that action." };
  }
  if (event.type === "coding:verification_verdict" || event.type === "coding:verify_finish") {
    return { role: "assistant", agent: "Verification", content: readableVerification(message) };
  }
  if (event.type === "coding:diff") {
    return { role: "assistant", agent: "Diff", content: `I prepared a diff summary:\n${message}` };
  }
  if (event.type === "coding:revert") {
    return { role: "assistant", agent: "Revert", content: `I handled the revert request:\n${message}` };
  }
  if (event.type === "coding:memory") {
    return { role: "assistant", agent: "Memory", content: `I updated or checked project memory:\n${message}` };
  }
  if (event.type === "context:compact") {
    return { role: "assistant", agent: "Context", content: "I compacted the context so I can keep going without losing the important session state." };
  }
  if (event.agent === "CodingRuntime" && typeof event.metadata?.command === "string") {
    return { role: "assistant", agent: `/${event.metadata.command}`, content: message };
  }
  if ((event.agent === "MCP" || event.agent === "TUI") && typeof event.metadata?.command === "string") {
    return { role: "system", agent: event.agent, content: message };
  }
  if (event.type === "engine:error" || event.type === "agent:error" || event.type === "coding:failed" || event.type === "error") {
    return { role: "assistant", agent: "Error", content: `I hit an error: ${message}` };
  }
  if (event.type === "warn") {
    return { role: "assistant", agent: event.agent ?? "Warning", content: `Heads up: ${message}` };
  }
  if (event.type === "success") {
    return { role: "assistant", agent: event.agent ?? "Success", content: `Done: ${message}` };
  }
  if (event.type === "engine:complete" || event.type === "coding:completed" || event.type === "complete") {
    if (isGenericCompletionMessage(message)) return undefined;
    return { role: "assistant", agent: event.agent ?? "Servus", content: message };
  }
  return undefined;
}

function shouldShowInTranscript(event: ServusEvent): boolean {
  if (event.type === "user_input:response") return true;
  if (event.type === "assistant:message" || event.type === "coding:final_summary") return true;
  if (event.type === "agent:working_note" || event.type === "agent:blocker") return true;
  if (event.type === "engine:start" || event.type === "phase") return true;
  if (event.type === "agent:status" || event.type === "agent:log") return true;
  if (event.type === "task:start" || event.type === "task:complete") return true;
  if (event.type === "task:fail") return true;
  if (event.type === "verification" || event.type === "evidence:add" || event.type === "artifact:add") return true;
  if (event.type === "tool:start" && shouldShowImportantToolEvent(event)) return true;
  if (event.type === "tool:finish" && shouldShowImportantToolEvent(event) && event.metadata?.isError !== true) return true;
  if (event.type === "tool:finish" && event.metadata?.isError === true) return true;
  if (event.type === "engine:needs_input" || event.type === "user_input:request" || event.type === "coding:question") return true;
  if (event.type === "approval:request" || event.type === "approval:response") return true;
  if (event.type === "consent:request" || event.type === "consent:response") return true;
  if (event.type === "engine:error" || event.type === "agent:error" || event.type === "coding:failed" || event.type === "error") return true;
  if (event.type === "engine:complete" || event.type === "coding:completed" || event.type === "complete") return true;
  if (event.type === "coding:diff" || event.type === "coding:revert" || event.type === "coding:memory") return true;
  if (event.type === "context:compact") return true;
  if (event.type === "warn") return true;
  if (event.agent === "CodingRuntime" && typeof event.metadata?.command === "string") return true;
  if ((event.agent === "MCP" || event.agent === "TUI") && typeof event.metadata?.command === "string") return true;
  return false;
}

function loadCodingTranscript(sessionId: string | undefined): ChatMessage[] {
  if (!sessionId) return [];
  const path = join(SERVUS_DIR, "sessions", sessionId, "coding", "transcript.jsonl");
  const messages: ChatMessage[] = [];
  try {
    if (existsSync(path)) {
      messages.push(...readFileSync(path, "utf-8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line, index): ChatMessage | undefined => {
          try {
            const parsed = JSON.parse(line) as {
              timestamp?: number;
              type?: string;
              agent?: string;
              content?: string;
              metadata?: Record<string, unknown>;
            };
            const role = transcriptRole(parsed.type);
            if (!role) return undefined;
            const content = parsed.content ??
              (parsed.metadata ? JSON.stringify(parsed.metadata, null, 2) : "");
            const message: ChatMessage = {
              id: `${parsed.timestamp ?? index}:${parsed.type ?? "message"}:${index}`,
              role,
              content: content.trim(),
              timestamp: parsed.timestamp ?? Date.now(),
              ...(parsed.agent ? { agent: parsed.agent } : {}),
            };
            return message;
          } catch {
            return undefined;
          }
        })
        .filter((item): item is ChatMessage => !!item && !!item.content));
    }
    messages.push(...loadSessionEventMessages(sessionId, messages));
    const session = getSession(sessionId);
    if (session?.finalSummary && !messages.some((item) => item.content === session.finalSummary)) {
      messages.push({
        id: `${session.endTime ?? Date.now()}:final-summary`,
        role: "assistant",
        agent: "Servus",
        content: session.finalSummary,
        timestamp: session.endTime ?? Date.now(),
      });
    }
    return messages
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(-240);
  } catch {
    return [];
  }
}

function loadSessionEventMessages(sessionId: string, existing: ChatMessage[]): ChatMessage[] {
  const path = join(SERVUS_DIR, "sessions", sessionId, "events.jsonl");
  if (!existsSync(path)) return [];
  const seen = new Set(existing.map((item) => `${item.timestamp}:${item.role}:${item.agent ?? ""}:${item.content}`));
  try {
    return readFileSync(path, "utf-8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line, index): ChatMessage | undefined => {
        try {
          const parsed = JSON.parse(line) as ServusEvent;
          const message = eventToTranscriptMessage(parsed, "auto");
          if (!message) return undefined;
          const key = `${message.timestamp}:${message.role}:${message.agent ?? ""}:${message.content}`;
          if (seen.has(key)) return undefined;
          seen.add(key);
          return { ...message, id: `${message.id}:${index}` };
        } catch {
          return undefined;
        }
      })
      .filter((item): item is ChatMessage => !!item && !!item.content);
  } catch {
    return [];
  }
}

function transcriptRole(type: string | undefined): ChatMessage["role"] | undefined {
  if (type === "user") return "user";
  if (type === "assistant") return "assistant";
  if (type === "system" || type === "validation_failure" || type === "interruption") return "system";
  return undefined;
}

function formatToolChatEvent(event: Pick<ServusEvent, "type" | "message" | "metadata">): string {
  const tool = String(event.metadata?.tool ?? "tool");
  if (event.type === "tool:start") {
    const readonly = event.metadata?.readOnly === true ? "read" : event.metadata?.readOnly === false ? "write" : "tool";
    return `>> ${tool} started (${readonly})\n${event.message}`;
  }
  const duration = typeof event.metadata?.durationMs === "number"
    ? ` in ${formatToolDuration(event.metadata.durationMs)}`
    : "";
  const status = event.metadata?.isError ? "failed" : "finished";
  const output = typeof event.metadata?.output === "string"
    ? event.metadata.output
    : event.message;
  return `<< ${tool} ${status}${duration}\n${compactToolPreview(output)}`;
}

function compactToolPreview(value: string): string {
  const cleaned = value.trim();
  if (cleaned.length <= 900) return cleaned;
  return `${cleaned.slice(0, 620)}\n...\n${cleaned.slice(-220)}`;
}

function hardWrapText(value: string, width: number): string {
  const safeWidth = Math.max(8, width);
  return value
    .split(/\r?\n/)
    .map((line) => {
      if (line.length <= safeWidth) return line;
      const chunks: string[] = [];
      let remaining = line;
      while (remaining.length > safeWidth) {
        chunks.push(remaining.slice(0, safeWidth));
        remaining = remaining.slice(safeWidth);
      }
      if (remaining) chunks.push(remaining);
      return chunks.join("\n");
    })
    .join("\n");
}

function liveCommandSuggestions(input: string, cwd: string): LiveCommandSuggestion[] {
  const commands: LiveCommandSuggestion[] = [
    ...LIVE_COMMANDS,
    ...loadCustomCodingCommands(cwd).map((command): LiveCommandSuggestion => ({
      command: `/${command.id}`,
      description: command.description,
      category: "tools",
    })),
  ];
  const query = input.trim().toLowerCase();
  if (!query || query === "/") return commands;
  const needle = query.slice(1);
  return commands
    .filter((item) =>
      item.command.startsWith(query) ||
      item.command.includes(needle) ||
      item.description.toLowerCase().includes(needle) ||
      item.category.includes(needle)
    )
    .sort((a, b) => commandScore(a, query, needle) - commandScore(b, query, needle));
}

function commandScore(command: LiveCommandSuggestion, query: string, needle: string): number {
  if (command.command.startsWith(query)) return 0;
  if (command.command.slice(1).startsWith(needle)) return 1;
  if (command.description.toLowerCase().includes(needle)) return 2;
  return 3;
}

function runOverlayForCommand(command: string):
  | "help"
  | "models"
  | "sessions"
  | "mcp"
  | "settings"
  | "capabilities"
  | undefined {
  if (command === "/help") return "help";
  if (command === "/models" || command === "/model") return "models";
  if (command === "/sessions" || command === "/resume") return "sessions";
  if (command === "/mcp") return "mcp";
  if (command === "/settings") return "settings";
  if (command === "/capabilities") return "capabilities";
  return undefined;
}

function shortPath(path: string): string {
  const home = process.env.HOME;
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function shortModel(model: string): string {
  return model
    .replace(/^claude-/, "Provider ")
    .replace(/^gpt-/, "GPT ")
    .replace(/^gemini-/, "Gemini ")
    .slice(0, 22);
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}

function formatCompact(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return String(value);
}

function appendChatMessage(messages: ChatMessage[], message: ChatMessage): ChatMessage[] {
  if (!message.content.trim()) return messages;
  if (messages.some((item) => item.id === message.id)) return messages;
  if (
    message.role !== "user" &&
    messages.slice(-25).some((item) =>
      item.role === message.role &&
      item.agent === message.agent &&
      item.content.trim() === message.content.trim()
    )
  ) {
    return messages;
  }
  return [...messages, message].slice(-120);
}

function formatToolDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function formatHumanToolActivity(tool: RuntimeViewState["tools"][number]): string {
  const icon = tool.status === "failed" ? "!" : tool.status === "running" ? "…" : "✓";
  const duration = tool.durationMs !== undefined ? ` ${formatToolDuration(tool.durationMs)}` : "";
  const target = extractToolTarget(tool.preview);
  return `${icon} ${humanizeToolName(tool.tool)}${target ? ` ${target}` : ""}${duration}`;
}

function formatHumanToolFromEvent(tool: string, message: string): string {
  const target = extractToolTarget(message);
  return `${humanizeToolName(tool)}${target ? ` ${target}` : ""}`;
}

function domainNarration(
  domain: RuntimeViewState["domain"],
  kind: "phase" | "status" | "log" | "info",
  message: string,
  agent?: string,
): string {
  const cleaned = humanizeProgressMessage(message);
  if (!cleaned) return agent ? `${humanizeDomain(agent)} is working.` : "I’m working on it.";
  const normalized = message.trim().toLowerCase();
  if (kind === "status") {
    if (normalized === "working") return domainWorkingNarration(domain, agent);
    if (normalized === "done") return `I finished this ${humanizeDomain(agent ?? String(domain)).toLowerCase()} step and I’m checking whether there is anything left.`;
    if (normalized === "error") return `I hit an error in the ${humanizeDomain(agent ?? String(domain)).toLowerCase()} path and I’m stopping that attempt.`;
  }
  const prefix = domainNarrationPrefix(domain);
  if (/^(starting|started|opening|running|checking|analyzing|analysing|searching|reading|loading)\b/i.test(cleaned)) {
    return `I’m ${cleaned.charAt(0).toLowerCase()}${cleaned.slice(1)}`;
  }
  return `${prefix} ${cleaned}`;
}

function domainWorkingNarration(domain: RuntimeViewState["domain"], agent?: string): string {
  if (domain === "browser") {
    return "I’m reading the current page, checking visible controls, and deciding the next browser action.";
  }
  if (domain === "security") {
    return "I’m scoping the target, looking for safe evidence, and keeping validation non-destructive.";
  }
  if (domain === "desktop") {
    return "I’m checking local paths and file evidence before choosing the next desktop action.";
  }
  if (domain === "data") {
    return "I’m inspecting the document or table structure so the output is based on real data.";
  }
  if (domain === "media") {
    return "I’m checking the media inputs, available tools, and the safest processing step.";
  }
  if (domain === "coding") {
    return "I’m reading the repo context, narrowing the change, and checking what evidence I need before editing.";
  }
  if (domain === "general") {
    return "I’m breaking down the request and checking what evidence I need before answering.";
  }
  return `${humanizeDomain(agent ?? "Servus")} is routing the task and choosing the right agent.`;
}

function domainNarrationPrefix(domain: RuntimeViewState["domain"]): string {
  if (domain === "browser") return "I’m checking the page:";
  if (domain === "security") return "I’m assessing the target:";
  if (domain === "desktop") return "I’m checking the local system:";
  if (domain === "data") return "I’m inspecting the data:";
  if (domain === "media") return "I’m processing the media task:";
  if (domain === "coding") return "I’m working through the code:";
  if (domain === "general") return "I’m working through the request:";
  return "I’m working:";
}

function toolStartNarration(domain: RuntimeViewState["domain"], tool: string, message: string): string {
  const action = humanizeToolName(tool).toLowerCase();
  const target = extractToolTarget(message);
  if (domain === "browser") return `I’m using the browser to ${action}${target ? ` on ${target}` : ""}.`;
  if (domain === "security") return `I’m using ${action} to gather safe evidence${target ? ` from ${target}` : ""}.`;
  if (domain === "desktop") return `I’m using a desktop tool to ${action}${target ? ` ${target}` : ""}.`;
  if (domain === "data") return `I’m using a data tool to ${action}${target ? ` ${target}` : ""}.`;
  if (domain === "media") return `I’m using a media tool to ${action}${target ? ` ${target}` : ""}.`;
  if (domain === "coding") return `I’m using a coding tool to ${action}${target ? ` ${target}` : ""}.`;
  return `I’m using a tool to ${action}${target ? ` ${target}` : ""}.`;
}

function toolFinishNarration(domain: RuntimeViewState["domain"], tool: string, message: string): string {
  const action = humanizeToolName(tool).toLowerCase();
  const target = extractToolTarget(message);
  if (domain === "browser") return `I finished that browser step${target ? ` for ${target}` : ""}.`;
  if (domain === "security") return `I finished that safe security check${target ? ` for ${target}` : ""}.`;
  if (domain === "desktop") return `I finished that desktop step${target ? ` for ${target}` : ""}.`;
  if (domain === "data") return `I finished that data step${target ? ` for ${target}` : ""}.`;
  if (domain === "media") return `I finished that media step${target ? ` for ${target}` : ""}.`;
  if (domain === "coding") return `I finished that coding step: ${action}${target ? ` ${target}` : ""}.`;
  return `I finished that step: ${action}${target ? ` ${target}` : ""}.`;
}

function humanizeToolName(tool: string): string {
  const normalized = tool.toLowerCase();
  if (normalized === "read" || normalized.includes("read")) return "Read";
  if (normalized === "write" || normalized.includes("write")) return "Saved";
  if (normalized.includes("edit") || normalized.includes("patch")) return "Edited";
  if (normalized.includes("grep") || normalized.includes("search") || normalized.includes("glob")) return "Searched";
  if (normalized.includes("ls") || normalized.includes("list")) return "Listed";
  if (normalized.includes("bash") || normalized.includes("shell")) return "Ran command";
  if (normalized.includes("verify") || normalized.includes("test")) return "Verified";
  if (normalized.includes("navigate")) return "Opened page";
  if (normalized.includes("click")) return "Clicked";
  if (normalized.includes("fill") || normalized.includes("type")) return "Filled";
  if (normalized.includes("select")) return "Selected";
  if (normalized.includes("screenshot")) return "Captured proof";
  if (normalized.includes("extract")) return "Extracted";
  if (normalized.includes("mcp")) return "Used MCP";
  return tool.replace(/[_-]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase()).slice(0, 28);
}

function humanizeDomain(value: string): string {
  const cleaned = value.replace(/[_-]+/g, " ").trim();
  return cleaned ? cleaned.replace(/\b\w/g, (char) => char.toUpperCase()) : "Agent";
}

function humanizeAgentStatus(message: string, agent?: string): string {
  const normalized = message.trim().toLowerCase();
  const name = agent ? humanizeDomain(agent) : "Agent";
  if (normalized === "working") return `${name} is working.`;
  if (normalized === "done") return `${name} finished its work.`;
  if (normalized === "error") return `${name} hit an error.`;
  return humanizeProgressMessage(message);
}

function humanizeProgressMessage(message: string): string {
  const cleaned = cleanHumanMessage(message);
  if (!cleaned) return "";
  return sentenceCase(cleaned.replace(/[_-]+/g, " "));
}

function sentenceCase(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function isNoisyInfoMessage(message: string): boolean {
  return /^(cost|tokens|context usage|session hydrated|runtime state)/i.test(message.trim()) ||
    /duplicate start ignored/i.test(message);
}

function shouldShowToolFinish(event: ServusEvent): boolean {
  if (event.metadata?.isError === true) return true;
  const duration = typeof event.metadata?.durationMs === "number" ? event.metadata.durationMs : 0;
  const tool = String(event.metadata?.tool ?? event.agent ?? "").toLowerCase();
  if (duration >= 1200) return true;
  return /bash|shell|command|verify|test|browser|click|fill|select|navigate|screenshot|download|convert|extract|write|edit|patch|move|copy|trash|delete|mcp/.test(tool);
}

function extractToolTarget(preview: string): string {
  const quoted = preview.match(/["'`]([^"'`\n]{1,80})["'`]/)?.[1];
  const path = quoted ?? preview.match(/(?:^|\s)([./~\w-][\w./~ -]{1,80}\.\w{1,8})(?:\s|$)/)?.[1];
  if (!path) return "";
  return truncateOneLine(path, 34);
}

function stringFromMetadata(event: ServusEvent, key: string): string {
  const value = event.metadata?.[key];
  return typeof value === "string" ? value : "";
}

function domainFromEvent(event: ServusEvent): RuntimeViewState["domain"] | undefined {
  const raw = stringFromMetadata(event, "domain");
  if (
    raw === "auto" ||
    raw === "coding" ||
    raw === "browser" ||
    raw === "desktop" ||
    raw === "media" ||
    raw === "data" ||
    raw === "security" ||
    raw === "general" ||
    raw === "extension"
  ) {
    return raw;
  }
  return undefined;
}

function cleanHumanMessage(value: string): string {
  return value
    .replace(/\[servus\]\s*/gi, "")
    .replace(/\n{4,}/g, "\n\n")
    .trim();
}

function readableVerification(value: string): string {
  if (/pass|passed|success/i.test(value)) return `Verification passed: ${value}`;
  if (/fail|error/i.test(value)) return `Verification needs attention: ${value}`;
  return `Verification: ${value}`;
}

function isGenericCompletionMessage(value: string): boolean {
  return /^(run completed|completed|done|task completed)\.?$/i.test(value.trim());
}

function clampLines(value: string, maxLines: number): { text: string; truncated: boolean; hiddenLines: number } {
  const lines = value.split(/\r?\n/);
  if (lines.length <= maxLines) return { text: value, truncated: false, hiddenLines: 0 };
  return {
    text: lines.slice(0, maxLines).join("\n"),
    truncated: true,
    hiddenLines: lines.length - maxLines,
  };
}

function truncateOneLine(value: string, maxLength: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > maxLength ? `${oneLine.slice(0, Math.max(0, maxLength - 1))}…` : oneLine;
}

function shouldShowImportantToolEvent(event: ServusEvent): boolean {
  const tool = String(event.metadata?.tool ?? event.agent ?? event.message ?? "").toLowerCase();
  return /bash|shell|command|verify|test|browser|click|fill|select|navigate|screenshot|download|convert|extract|write|edit|patch|move|copy|trash|delete|mcp|security|scan|request|http|document|table|report|media/.test(tool);
}

function normalizeForCompare(value: string): string {
  return value.replace(/\s+/g, " ").trim();
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
