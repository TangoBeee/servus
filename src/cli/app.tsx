import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { Shell } from "./layout/shell.js";
import { CommandPalette, type CommandItem } from "./components/command-palette.js";
import { NewTask, type TaskConfig } from "./screens/new-task.js";
import { Dashboard } from "./screens/dashboard.js";
import { ConfigScreen } from "./screens/config.js";
import { SessionsScreen } from "./screens/sessions.js";
import { BackgroundScreen } from "./screens/background.js";
import { CapabilitiesScreen } from "./screens/capabilities.js";
import { PluginsSkillsScreen } from "./screens/plugins-skills.js";
import type { Screen } from "./screens/main-menu.js";
import { startBackground } from "../background.js";
import { createSession, getSession, updateSession, type SessionRecord } from "../session-store.js";
import { bus } from "../events.js";
import { loadConfig, saveConfig } from "../config.js";
import type { OrchestratorConfig } from "../orchestrator.js";
import type { AgentBackend } from "../agent.js";
import type { TaskDomain } from "../engine.js";

interface Props {
  initialScreen?: Screen;
  initialConfig?: OrchestratorConfig;
}

interface FollowUpOptions {
  sameSession?: boolean;
}

export function App({ initialScreen, initialConfig }: Props) {
  const [screen, setScreen] = useState<Screen>(normalizeScreen(initialScreen ?? "launchpad"));
  const [orchConfig, setOrchConfig] = useState<OrchestratorConfig | null>(initialConfig ?? null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [clearSignal, setClearSignal] = useState(0);
  const [inputLocked, setInputLocked] = useState(false);
  const [secretBuffer, setSecretBuffer] = useState("");
  const [celebrate, setCelebrate] = useState(false);

  const navigate = useCallback((next: Screen) => setScreen(normalizeScreen(next)), []);
  const goHome = useCallback(() => {
    setScreen("launchpad");
  }, []);

  const handleFollowUp = useCallback((followUpText: string, options: FollowUpOptions = {}) => {
    setOrchConfig((prev) => {
      if (!prev) return null;
      const newTask = options.sameSession
        ? [
            "Same Servus session continuation.",
            "The user answered the latest clarification or approval prompt:",
            "",
            followUpText,
          ].join("\n")
        : `Follow-up from user:\n\n${followUpText}\n\n---\n(Original task: ${prev.task})`;

      if (options.sameSession && prev.sessionId) {
        const lockedDomain = continuationDomain(prev.sessionId, prev.preferredDomain);
        updateSession(prev.sessionId, {
          status: "running",
          runtimeStatus: "running",
          ...(lockedDomain ? { domain: lockedDomain } : {}),
          endTime: undefined,
        });
        return {
          ...prev,
          task: newTask,
          sessionId: prev.sessionId,
          ...(lockedDomain ? { preferredDomain: lockedDomain } : {}),
        };
      }

      const session = createSession(newTask, prev.model, prev.backend, prev.cwd, {
        domain: prev.preferredDomain ?? "auto",
      });
      return {
        ...prev,
        task: newTask,
        sessionId: session.id,
      };
    });
    setScreen("live-run");
  }, []);

  const handleSessionFollowUp = useCallback((session: SessionRecord, followUpText: string) => {
    const newTask = `Same Servus session continuation for ${session.id}:\n\n${followUpText}`;
    updateSession(session.id, {
      status: "running",
      runtimeStatus: "running",
      endTime: undefined,
    });
    const config: OrchestratorConfig = {
      task: newTask,
      cwd: session.cwd,
      model: session.model,
      backend: session.backend as AgentBackend,
      maxConsecutiveFailures: 5,
      maxBudgetUsd: undefined,
      preferredDomain: isConcreteDomain(session.domain) ? session.domain : "auto",
      sessionId: session.id,
    };
    setOrchConfig(config);
    setScreen("live-run");
  }, []);

  const handleTaskSubmit = useCallback(async (tc: TaskConfig) => {
    process.env.SERVUS_BROWSER_HEADLESS = tc.browserHeadless ? "1" : "0";

    const config: OrchestratorConfig = {
      task: tc.task,
      cwd: tc.cwd,
      model: tc.model,
      backend: tc.backend,
      maxConsecutiveFailures: tc.maxFailures,
      verifyCommand: tc.verifyCommand,
      maxBudgetUsd: tc.budget,
      preferredDomain: tc.domainMode,
    };

    if (tc.runInBackground) {
      try {
        const name = await startBackground(tc.task, {
          model: tc.model,
          mode: tc.backend,
          cwd: tc.cwd,
          maxFailures: tc.maxFailures,
          budget: tc.budget,
          verify: tc.verifyCommand,
          domain: tc.domainMode,
        });
        createSession(tc.task, tc.model, tc.backend, tc.cwd, { domain: tc.domainMode });
        bus.push({ type: "success", message: `Background job started: ${name}` });
        setScreen("background");
      } catch (err: unknown) {
        bus.push({
          type: "error",
          message: `Failed to start background job: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    } else {
      const session = createSession(tc.task, tc.model, tc.backend, tc.cwd, { domain: tc.domainMode });
      setOrchConfig({ ...config, sessionId: session.id });
      setScreen("live-run");
    }
  }, []);

  const commands: CommandItem[] = useMemo(() => [
    { id: "launchpad", label: "New Run", hint: "Launchpad", group: "Navigate", run: () => navigate("launchpad") },
    { id: "live-run", label: "Live Run", hint: "watch active session", group: "Navigate", run: () => navigate("live-run") },
    { id: "sessions", label: "Sessions", hint: "history and resume", group: "Navigate", run: () => navigate("sessions") },
    { id: "capabilities", label: "Capabilities", hint: "tools/providers/readiness", group: "Navigate", run: () => navigate("capabilities") },
    { id: "plugins", label: "Plugins & Skills", hint: "local extension inventory", group: "Navigate", run: () => navigate("plugins") },
    { id: "settings", label: "Settings", hint: "providers/runtime/browser/safety", group: "Navigate", run: () => navigate("settings") },
    { id: "jobs", label: "Background Jobs", hint: "scheduled/background runs", group: "Navigate", run: () => navigate("background") },
    { id: "clear-logs", label: "Clear Live Run Logs", hint: "dashboard only", group: "Run", run: () => setClearSignal((value) => value + 1) },
    { id: "toggle-headless", label: "Toggle Browser Headless", hint: "updates default", group: "Settings", run: toggleBrowserHeadless },
    { id: "glow", label: "Toggle Glow Mode", hint: "hidden console effect", group: "Fun", run: () => setCelebrate((value) => !value) },
  ], [navigate]);

  useEffect(() => {
    if (!celebrate) return;
    const timer = setTimeout(() => setCelebrate(false), 12_000);
    return () => clearTimeout(timer);
  }, [celebrate]);

  useInput((input, key) => {
    if (key.ctrl && input === "k") {
      if (inputLocked && !paletteOpen) return;
      setPaletteOpen((value) => !value);
      return;
    }
    if (paletteOpen || inputLocked) return;
    if (/^[a-z]$/i.test(input)) {
      const nextBuffer = (secretBuffer + input.toLowerCase()).slice(-6);
      setSecretBuffer(nextBuffer);
      if (nextBuffer === "servus") setCelebrate(true);
    }
    const hotkeys: Record<string, Screen> = {
      "1": "launchpad",
      "2": "live-run",
      "3": "sessions",
      "4": "capabilities",
      "5": "plugins",
      "6": "settings",
      "7": "background",
    };
    if (hotkeys[input]) {
      navigate(hotkeys[input]);
    }
  });

  const title = screenTitle(screen);
  const right = orchConfig ? `${orchConfig.backend} | ${orchConfig.model}` : "ready";

  return (
    <Shell
      screen={screen}
      title={title}
      right={right}
      onNavigate={navigate}
      footerHints={footerHints(screen, !!orchConfig)}
      activeRun={!!orchConfig}
      celebrate={celebrate}
    >
      {paletteOpen && <CommandPalette items={commands} onClose={() => setPaletteOpen(false)} />}

      {screen === "launchpad" && (
        <NewTask
          onSubmit={handleTaskSubmit}
          onBack={goHome}
          onInputLockedChange={setInputLocked}
          inputBlocked={paletteOpen}
        />
      )}

      {orchConfig && (
        <Dashboard
          config={orchConfig}
          visible={screen === "live-run"}
          onBack={goHome}
          onFollowUp={handleFollowUp}
          clearSignal={clearSignal}
          onInputLockedChange={setInputLocked}
          inputBlocked={paletteOpen}
        />
      )}

      {screen === "live-run" && !orchConfig && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">No active foreground run.</Text>
          <Text color="gray">Open Launchpad and start a task in foreground mode to attach the live dashboard.</Text>
        </Box>
      )}

      {screen === "sessions" && (
        <SessionsScreen
          onBack={goHome}
          onFollowUp={handleSessionFollowUp}
          onInputLockedChange={setInputLocked}
          inputBlocked={paletteOpen}
        />
      )}
      {screen === "background" && (
        <BackgroundScreen onBack={goHome} onInputLockedChange={setInputLocked} inputBlocked={paletteOpen} />
      )}
      {screen === "capabilities" && <CapabilitiesScreen cwd={orchConfig?.cwd} />}
      {screen === "plugins" && <PluginsSkillsScreen cwd={orchConfig?.cwd} inputBlocked={paletteOpen} />}
      {screen === "settings" && (
        <ConfigScreen onBack={goHome} onInputLockedChange={setInputLocked} inputBlocked={paletteOpen} />
      )}
    </Shell>
  );
}

function normalizeScreen(screen: Screen): Screen {
  if (screen === "menu" || screen === "new-task") return "launchpad";
  if (screen === "dashboard") return "live-run";
  if (screen === "config") return "settings";
  return screen;
}

function screenTitle(screen: Screen): string {
  const normalized = normalizeScreen(screen);
  if (normalized === "launchpad") return "Launchpad";
  if (normalized === "live-run") return "Live Run";
  if (normalized === "sessions") return "Sessions";
  if (normalized === "capabilities") return "Capabilities";
  if (normalized === "plugins") return "Plugins & Skills";
  if (normalized === "settings") return "Settings";
  if (normalized === "background") return "Background Jobs";
  return "Operator Console";
}

function footerHints(screen: Screen, hasRun: boolean) {
  if (screen === "launchpad") return [{ key: "j/k", label: "navigate fields" }, { key: "Enter", label: "edit/toggle" }, { key: "r", label: "run" }];
  if (screen === "live-run") return [{ key: "[/]", label: "tabs" }, ...(hasRun ? [{ key: "f", label: "follow-up when done" }] : [])];
  return [{ key: "j/k", label: "navigate" }, { key: "b", label: "back" }];
}

function toggleBrowserHeadless() {
  const cfg = loadConfig();
  saveConfig({
    ...cfg,
    browser: {
      ...cfg.browser,
      headless: !(cfg.browser?.headless ?? false),
    },
  });
}

function continuationDomain(
  sessionId: string,
  fallback: OrchestratorConfig["preferredDomain"],
): TaskDomain | undefined {
  const session = getSession(sessionId);
  if (isConcreteDomain(session?.domain)) return session.domain;
  return isConcreteDomain(fallback) ? fallback : undefined;
}

function isConcreteDomain(domain: unknown): domain is TaskDomain {
  return (
    domain === "coding" ||
    domain === "desktop" ||
    domain === "browser" ||
    domain === "media" ||
    domain === "data" ||
    domain === "extension" ||
    domain === "security" ||
    domain === "general"
  );
}
