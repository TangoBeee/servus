import React, { useCallback, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { Shell } from "./layout/shell.js";
import { CommandPalette, type CommandItem } from "./components/command-palette.js";
import { TuiOverlayPanel } from "./components/tui-overlays.js";
import { HomeScreen } from "./screens/home.js";
import type { TaskConfig } from "./screens/new-task.js";
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
import { normalizeAgentBackend, type AgentBackend } from "../agent.js";
import type { TaskDomain } from "../engine.js";
import type { TuiOverlay } from "./tui-types.js";

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
  const [overlay, setOverlay] = useState<TuiOverlay | null>(null);
  const [clearSignal, setClearSignal] = useState(0);
  const [inputLocked, setInputLocked] = useState(false);

  const navigate = useCallback((next: Screen) => {
    setOverlay(null);
    setScreen(normalizeScreen(next));
  }, []);
  const goHome = useCallback(() => {
    setOverlay(null);
    setScreen("launchpad");
  }, []);

  const handleFollowUp = useCallback((followUpText: string, options: FollowUpOptions = {}) => {
    setOrchConfig((prev) => {
      if (!prev) return null;
      const newTask = options.sameSession
        ? [
            "Same Servus session continuation.",
            "The user sent this follow-up message in the same session:",
            "",
            followUpText,
            "",
            "Continue from the existing session transcript and do not restart or reroute the task unless the user explicitly asks.",
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
      backend: normalizeAgentBackend(session.backend),
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
    { id: "launchpad", label: "Home", hint: "chat composer", group: "Navigate", run: () => navigate("launchpad") },
    { id: "live-run", label: "Live Run", hint: "watch active session", group: "Navigate", run: () => navigate("live-run") },
    { id: "sessions", label: "Sessions", hint: "history and resume", group: "Overlays", run: () => setOverlay("sessions") },
    { id: "models", label: "Models", hint: "provider-aware picker", group: "Overlays", run: () => setOverlay("models") },
    { id: "mcp", label: "MCP", hint: "servers/tools/resources", group: "Overlays", run: () => setOverlay("mcp") },
    { id: "capabilities", label: "Capabilities", hint: "tools/providers/readiness", group: "Overlays", run: () => setOverlay("capabilities") },
    { id: "plugins", label: "Plugins & Skills", hint: "local extension inventory", group: "Navigate", run: () => navigate("plugins") },
    { id: "settings", label: "Settings", hint: "providers/runtime/browser/safety", group: "Overlays", run: () => setOverlay("settings") },
    { id: "jobs", label: "Background Jobs", hint: "scheduled/background runs", group: "Navigate", run: () => navigate("background") },
    { id: "help", label: "Help", hint: "shortcuts and slash commands", group: "Overlays", run: () => setOverlay("help") },
    { id: "clear-logs", label: "Clear Live Run Logs", hint: "dashboard only", group: "Run", run: () => setClearSignal((value) => value + 1) },
    { id: "toggle-headless", label: "Toggle Browser Headless", hint: "updates default", group: "Settings", run: toggleBrowserHeadless },
  ], [navigate]);

  useInput((input, key) => {
    if ((key.ctrl && input === "k") || (key.ctrl && input === "p")) {
      if (inputLocked && !paletteOpen) return;
      setPaletteOpen((value) => !value);
      return;
    }
    if (paletteOpen || inputLocked) return;
    if (key.escape && overlay) {
      setOverlay(null);
    }
  });

  const title = overlay ? screenTitleForOverlay(overlay) : screenTitle(screen);
  const right = orchConfig ? `${formatBackendLabel(orchConfig.backend)} | ${orchConfig.model}` : "ready";

  return (
    <Shell
      screen={screen}
      title={title}
      right={right}
      onNavigate={navigate}
      footerHints={footerHints(screen, !!orchConfig)}
      activeRun={!!orchConfig}
      celebrate={false}
    >
      {paletteOpen ? (
        <CommandPalette items={commands} onClose={() => setPaletteOpen(false)} />
      ) : (
        <>
          {overlay ? (
            renderOverlay(overlay, {
              cwd: orchConfig?.cwd ?? process.cwd(),
              onClose: () => setOverlay(null),
              onFollowSession: handleSessionFollowUp,
              setInputLocked,
              inputBlocked: false,
            })
          ) : screen === "launchpad" && (
            <HomeScreen
              onSubmit={handleTaskSubmit}
              onOpenOverlay={setOverlay}
              onInputLockedChange={setInputLocked}
              inputBlocked={false}
            />
          )}

          {orchConfig && (
            <Dashboard
              config={orchConfig}
              visible={!overlay && screen === "live-run"}
              onBack={goHome}
              onFollowUp={handleFollowUp}
              onOpenOverlay={setOverlay}
              clearSignal={clearSignal}
              onInputLockedChange={setInputLocked}
              inputBlocked={false}
            />
          )}

          {!overlay && screen === "live-run" && !orchConfig && (
            <Box flexDirection="column" marginTop={1}>
              <Text color="gray">No active foreground run.</Text>
              <Text color="gray">Use Home to start a task. The live run will attach to the same session.</Text>
            </Box>
          )}

          {!overlay && screen === "sessions" && (
            <SessionsScreen
              onBack={goHome}
              onFollowUp={handleSessionFollowUp}
              onInputLockedChange={setInputLocked}
              inputBlocked={false}
            />
          )}
          {!overlay && screen === "background" && (
            <BackgroundScreen onBack={goHome} onInputLockedChange={setInputLocked} inputBlocked={false} />
          )}
          {!overlay && screen === "capabilities" && <CapabilitiesScreen cwd={orchConfig?.cwd} />}
          {!overlay && screen === "plugins" && <PluginsSkillsScreen cwd={orchConfig?.cwd} inputBlocked={false} />}
          {!overlay && screen === "settings" && (
            <ConfigScreen onBack={goHome} onInputLockedChange={setInputLocked} inputBlocked={false} />
          )}
        </>
      )}
    </Shell>
  );
}

function renderOverlay(overlay: TuiOverlay, {
  cwd,
  onClose,
  onFollowSession,
  setInputLocked,
  inputBlocked,
}: {
  cwd: string;
  onClose: () => void;
  onFollowSession: (session: SessionRecord, followUpText: string) => void;
  setInputLocked: (locked: boolean) => void;
  inputBlocked: boolean;
}) {
  if (overlay === "sessions") {
    return (
      <SessionsScreen
        onBack={onClose}
        onFollowUp={onFollowSession}
        onInputLockedChange={setInputLocked}
        inputBlocked={inputBlocked}
      />
    );
  }
  if (overlay === "capabilities") return <CapabilitiesScreen cwd={cwd} />;
  if (overlay === "settings") {
    return <ConfigScreen onBack={onClose} onInputLockedChange={setInputLocked} inputBlocked={inputBlocked} />;
  }
  return <TuiOverlayPanel overlay={overlay} cwd={cwd} onClose={onClose} />;
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

function screenTitleForOverlay(overlay: TuiOverlay): string {
  if (overlay === "models") return "Models";
  if (overlay === "sessions") return "Sessions";
  if (overlay === "agents") return "Agents";
  if (overlay === "tools") return "Tools";
  if (overlay === "mcp") return "MCP";
  if (overlay === "settings") return "Settings";
  if (overlay === "capabilities") return "Capabilities";
  if (overlay === "diff") return "Diff";
  if (overlay === "help") return "Help";
  return "Overlay";
}

function footerHints(screen: Screen, hasRun: boolean) {
  if (screen === "launchpad") return [{ key: "Enter", label: "send" }, { key: "Tab", label: "complete" }, { key: "Esc", label: "clear/close" }];
  if (screen === "live-run") return [{ key: "[ ]", label: "tabs" }, ...(hasRun ? [{ key: "/", label: "commands" }, { key: "f/m", label: "message" }, { key: "c", label: "cancel run" }] : [])];
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

function formatBackendLabel(backend: AgentBackend): string {
  return backend === "custom" ? "runtime" : backend;
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
