import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { SERVUS_DIR } from "./config.js";

export type BrowserSessionStatus = "opening" | "open" | "waiting_input" | "closed" | "crashed" | "blocked";

export interface BrowserActionRecord {
  timestamp: number;
  tool: string;
  method?: string;
  instruction?: string;
  ref?: string;
  selector?: string;
  url?: string;
  title?: string;
  success: boolean;
  error?: string;
  selfHealed?: boolean;
}

export interface BrowserSessionState {
  sessionId: string;
  status: BrowserSessionStatus;
  url: string;
  title: string;
  userDataDir: string;
  lastSnapshot?: string;
  lastScreenshot?: string;
  actionHistory: BrowserActionRecord[];
  failedActionHistory: BrowserActionRecord[];
  blockedReason?: string;
}

const DEFAULT_SESSION_ID = "direct";
const MAX_HISTORY = 200;

export function normalizeBrowserSessionId(sessionId?: string): string {
  return (sessionId?.trim() || DEFAULT_SESSION_ID).replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function browserSessionDir(sessionId?: string): string {
  return join(SERVUS_DIR, "browser-sessions", normalizeBrowserSessionId(sessionId));
}

export function browserUserDataDir(sessionId?: string): string {
  return join(browserSessionDir(sessionId), "user-data");
}

export function browserSnapshotsDir(sessionId?: string): string {
  return join(browserSessionDir(sessionId), "snapshots");
}

export function browserScreenshotsDir(sessionId?: string): string {
  return join(browserSessionDir(sessionId), "screenshots");
}

export function loadBrowserSessionState(sessionId?: string): BrowserSessionState {
  const id = normalizeBrowserSessionId(sessionId);
  const dir = browserSessionDir(id);
  const userDataDir = browserUserDataDir(id);
  mkdirSync(dir, { recursive: true });
  mkdirSync(userDataDir, { recursive: true });
  mkdirSync(browserSnapshotsDir(id), { recursive: true });
  mkdirSync(browserScreenshotsDir(id), { recursive: true });

  const statePath = join(dir, "state.json");
  if (existsSync(statePath)) {
    try {
      const parsed = JSON.parse(readFileSync(statePath, "utf-8")) as Partial<BrowserSessionState>;
      return {
        sessionId: id,
        status: parsed.status ?? "closed",
        url: parsed.url ?? "about:blank",
        title: parsed.title ?? "",
        userDataDir,
        lastSnapshot: parsed.lastSnapshot,
        lastScreenshot: parsed.lastScreenshot,
        actionHistory: Array.isArray(parsed.actionHistory) ? parsed.actionHistory.slice(-MAX_HISTORY) : [],
        failedActionHistory: Array.isArray(parsed.failedActionHistory) ? parsed.failedActionHistory.slice(-MAX_HISTORY) : [],
        blockedReason: parsed.blockedReason,
      };
    } catch {
      // Fall through to a clean state if the state file is corrupt.
    }
  }

  return {
    sessionId: id,
    status: "closed",
    url: "about:blank",
    title: "",
    userDataDir,
    actionHistory: [],
    failedActionHistory: [],
  };
}

export function saveBrowserSessionState(state: BrowserSessionState): void {
  const dir = browserSessionDir(state.sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2) + "\n");
}

export function updateBrowserSessionState(
  sessionId: string | undefined,
  patch: Partial<Omit<BrowserSessionState, "sessionId" | "userDataDir">>,
): BrowserSessionState {
  const state = loadBrowserSessionState(sessionId);
  const next: BrowserSessionState = {
    ...state,
    ...patch,
    sessionId: state.sessionId,
    userDataDir: state.userDataDir,
    actionHistory: patch.actionHistory ?? state.actionHistory,
    failedActionHistory: patch.failedActionHistory ?? state.failedActionHistory,
  };
  saveBrowserSessionState(next);
  return next;
}

export function recordBrowserAction(sessionId: string | undefined, action: BrowserActionRecord): BrowserSessionState {
  const state = loadBrowserSessionState(sessionId);
  const actionHistory = [...state.actionHistory, action].slice(-MAX_HISTORY);
  const failedActionHistory = action.success
    ? state.failedActionHistory
    : [...state.failedActionHistory, action].slice(-MAX_HISTORY);
  const next = {
    ...state,
    actionHistory,
    failedActionHistory,
    url: action.url ?? state.url,
    title: action.title ?? state.title,
  };
  saveBrowserSessionState(next);
  return next;
}

export function writeBrowserSnapshot(sessionId: string | undefined, snapshot: unknown): string {
  const id = normalizeBrowserSessionId(sessionId);
  const dir = browserSnapshotsDir(id);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `snapshot-${Date.now()}.json`);
  writeFileSync(path, JSON.stringify(snapshot, null, 2) + "\n");
  updateBrowserSessionState(id, { lastSnapshot: path });
  return path;
}
