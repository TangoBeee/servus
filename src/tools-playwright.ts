import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { generateObject, tool } from "ai";
import type { ToolResultOutput } from "@ai-sdk/provider-utils";
import { z } from "zod";
import { log } from "./log.js";
import { bus } from "./events.js";
import { assessRisk, requestConsent } from "./consent.js";
import { loadConfig } from "./config.js";
import { resolveModel } from "./provider.js";
import {
  browserSessionDir,
  browserScreenshotsDir,
  browserUserDataDir,
  loadBrowserSessionState,
  normalizeBrowserSessionId,
  recordBrowserAction,
  saveBrowserSessionState,
  updateBrowserSessionState,
  writeBrowserSnapshot,
  type BrowserSessionState,
} from "./browser-session.js";
import type { EngineContext } from "./engine.js";
import type { BrowserContext, Frame, Locator, Page } from "playwright";

const DEFAULT_BROWSER_TIMEOUT_MS = 30_000;
const MAX_EXTRACT_CHARS = 50_000;
const MAX_SNAPSHOT_ELEMENTS = 120;
const SNAPSHOT_LINE_CHARS = 180;
const RECENT_ACTION_LIMIT = 16;
const MAX_ACTION_CACHE_ENTRIES = 200;

type BrowserMethod =
  | "click"
  | "double_click"
  | "fill"
  | "type"
  | "press"
  | "select"
  | "hover"
  | "scroll"
  | "back"
  | "wait";

type BrowserActMethod =
  | BrowserMethod
  | "drag"
  | "upload";

interface LocatorQuery {
  selector: string;
  nth: number;
  frameUrl?: string;
  frameName?: string;
}

interface SnapshotElement {
  ref: string;
  legacyId: number;
  tag: string;
  role: string;
  type: string;
  text: string;
  label: string;
  placeholder: string;
  href: string;
  selector: string;
  visible: boolean;
  enabled: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
  value?: string;
  frameUrl?: string;
  inModal?: boolean;
  activePopup?: boolean;
  topMost?: boolean;
  zIndex?: number;
  scrollableSelector?: string;
  locatorQuery: LocatorQuery;
}

interface SnapshotResult {
  url: string;
  title: string;
  timestamp: number;
  path: string;
  elements: SnapshotElement[];
  activeSurface?: ActiveSurfaceInfo;
  blockedReason?: string;
}

interface ActiveSurfaceInfo {
  selector: string;
  text: string;
  bounds?: { x: number; y: number; width: number; height: number };
  zIndex?: number;
  reason: string;
}

interface TextMatchCandidate {
  tag: string;
  role: string;
  type: string;
  text: string;
  label: string;
  placeholder: string;
  href: string;
  selector: string;
  visible: boolean;
  enabled: boolean;
  bounds?: { x: number; y: number; width: number; height: number };
  value?: string;
  inModal?: boolean;
  activePopup?: boolean;
  topMost?: boolean;
  zIndex?: number;
  scrollableSelector?: string;
}

interface BrowserRuntime {
  sessionId: string;
  context: BrowserContext;
  page: Page;
  refs: Map<string, SnapshotElement>;
  legacyIds: Map<number, string>;
  recentActions: Array<{
    signature: string;
    before: string;
    after: string;
  }>;
  proofScreenshots: string[];
}

interface CachedBrowserAction {
  id: string;
  instructionKey: string;
  urlKey: string;
  createdAt: number;
  lastUsedAt?: number;
  hits: number;
  method: BrowserMethod;
  locatorQuery: LocatorQuery;
  selector: string;
  name: string;
  text?: string;
  value?: string;
  key?: string;
}

interface ActionOutcome {
  success: boolean;
  content: string;
  method: BrowserMethod;
  ref?: string;
  selector?: string;
  attempt: number;
  selfHealed?: boolean;
  fallbackUsed?: boolean;
  noProgress?: boolean;
  visualChanged?: boolean;
  screenshot?: string;
}

const CANDIDATE_SELECTORS = [
  "dialog[open]",
  "[aria-modal='true']",
  "[role='dialog']",
  "[role='listbox']",
  "[role='option']",
  "[role='menu']",
  "[role='menuitem']",
  "[role='combobox']",
  "[role='searchbox']",
  "[role='textbox']",
  "[class*='modal' i]",
  "[class*='popup' i]",
  "[class*='popover' i]",
  "[class*='dropdown' i]",
  "[class*='listbox' i]",
  "[class*='suggest' i]",
  "[class*='autocomplete' i]",
  "button",
  "a[href]",
  "input:not([type='hidden'])",
  "textarea",
  "select",
  "summary",
  "li",
  "[role='button']",
  "[role='link']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='listitem']",
  "[role='tab']",
  "[role='grid']",
  "[role='tree']",
  "[contenteditable='true']",
  "[aria-label]",
  "[placeholder]",
  "[data-testid]",
  "[data-test]",
  "[aria-expanded]",
  "[aria-controls]",
  "[aria-haspopup]",
  "[aria-activedescendant]",
  "[data-value]",
  "[popover]",
  "[class*='close' i]",
  "[class*='drawer' i]",
  "[class*='menu' i]",
  "[onclick]",
  "iframe",
];

const ACTIVE_SURFACE_SELECTOR = [
  "dialog[open]",
  "[aria-modal='true']",
  "[role='dialog']",
  "[role='alertdialog']",
  "[role='listbox']",
  "[role='menu']",
  "[role='tree']",
  "[role='grid']",
  "[popover]",
  "[class*='modal' i]",
  "[class*='popup' i]",
  "[class*='popover' i]",
  "[class*='drawer' i]",
  "[class*='dropdown' i]",
  "[class*='listbox' i]",
  "[class*='suggest' i]",
  "[class*='autocomplete' i]",
].join(",");

const POPUP_ANCESTOR_SELECTOR = [
  "dialog",
  "[aria-modal='true']",
  "[role='dialog']",
  "[role='alertdialog']",
  "[role='listbox']",
  "[role='menu']",
  "[role='tree']",
  "[role='grid']",
  "[popover]",
  "[class*='modal' i]",
  "[class*='popup' i]",
  "[class*='overlay' i]",
  "[class*='drawer' i]",
  "[class*='dropdown' i]",
  "[class*='listbox' i]",
  "[class*='suggest' i]",
  "[class*='autocomplete' i]",
].join(",");

const runtimes = new Map<string, BrowserRuntime>();

async function getRuntime(ctx: EngineContext): Promise<BrowserRuntime> {
  const sessionId = normalizeBrowserSessionId(ctx.sessionId);
  const existing = runtimes.get(sessionId);
  if (existing) return existing;

  log.info(`Starting Playwright browser session ${sessionId}...`);
  bus.push({
    type: "agent:status",
    agent: "Browser",
    message: `starting Playwright browser session ${sessionId}...`,
  });

  const { chromium } = await import("playwright");
  const config = loadConfig();
  const envHeadless = process.env.SERVUS_BROWSER_HEADLESS;
  const headless = envHeadless === undefined
    ? config.browser?.headless ?? false
    : /^(1|true|yes)$/i.test(envHeadless);
  const timeoutMs = config.browser?.timeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS;
  const session = loadBrowserSessionState(sessionId);
  const timezoneId = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  updateBrowserSessionState(sessionId, { status: "opening" });
  const context = await chromium.launchPersistentContext(browserUserDataDir(sessionId), {
    headless,
    viewport: { width: 1365, height: 900 },
    locale: "en-US",
    timezoneId,
    userAgent: realisticUserAgent(),
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
    },
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-default-browser-check",
      "--disable-dev-shm-usage",
    ],
  });
  context.setDefaultTimeout(timeoutMs);
  await installLocalStealthBasics(context);

  const page = context.pages()[0] ?? await context.newPage();
  page.setDefaultTimeout(timeoutMs);
  page.on("crash", () => {
    updateBrowserSessionState(sessionId, { status: "crashed", blockedReason: "Browser page crashed" });
  });

  if (shouldRestoreUrl(session, page)) {
    await page.goto(session.url, { waitUntil: "domcontentloaded", timeout: timeoutMs }).catch(() => undefined);
    await settlePage(page);
  }

  const runtime: BrowserRuntime = {
    sessionId,
    context,
    page,
    refs: new Map(),
    legacyIds: new Map(),
    recentActions: [],
    proofScreenshots: [],
  };
  runtimes.set(sessionId, runtime);
  await savePageState(runtime, "open");
  log.success(`Playwright browser ready for session ${sessionId}`);
  return runtime;
}

async function closeBrowser(sessionId?: string): Promise<void> {
  const id = normalizeBrowserSessionId(sessionId);
  const runtime = runtimes.get(id);
  if (!runtime) {
    updateBrowserSessionState(id, { status: "closed" });
    return;
  }

  await savePageState(runtime, "closed").catch(() => undefined);
  await runtime.context.close().catch(() => undefined);
  runtimes.delete(id);
}

function shouldRestoreUrl(session: BrowserSessionState, page: Page): boolean {
  return (
    session.url !== "" &&
    session.url !== "about:blank" &&
    page.url() === "about:blank"
  );
}

function realisticUserAgent(): string {
  return "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
}

async function installLocalStealthBasics(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const defineGetter = (target: object, property: string, value: unknown) => {
      try {
        Object.defineProperty(target, property, {
          configurable: true,
          get: () => value,
        });
      } catch {
        // Ignore non-configurable browser properties.
      }
    };
    defineGetter(Navigator.prototype, "webdriver", undefined);
    defineGetter(Navigator.prototype, "languages", ["en-US", "en"]);
    defineGetter(Navigator.prototype, "plugins", [1, 2, 3, 4, 5]);
  }).catch(() => undefined);
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (/^(https?:|file:|data:|about:)/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function clamp(text: string, max = MAX_EXTRACT_CHARS): string {
  if (text.length <= max) return text;
  const keep = Math.floor((max - 80) / 2);
  return `${text.slice(0, keep)}\n\n[... truncated ${text.length - max} characters ...]\n\n${text.slice(-keep)}`;
}

async function guardRisk(
  ctx: EngineContext,
  action: string,
  detail: string,
): Promise<string | null> {
  const { risk, labels } = assessRisk(`${action}\n${detail}`);
  if (risk !== "high" && risk !== "critical") return null;
  if (action.startsWith("browser_") && !requiresBrowserConsent(action, detail)) {
    return null;
  }

  const approved = ctx.onConsent
    ? await ctx.onConsent(action, detail)
    : await requestConsent({
        action,
        detail: labels.length ? `${detail} (${labels.join(", ")})` : detail,
        risk,
        engine: "browser",
      });

  return approved ? null : `Action blocked by consent gate: ${action}`;
}

function requiresBrowserConsent(action: string, detail: string): boolean {
  const text = `${action}\n${detail}`;
  return (
    /\b(pay now|submit payment|payment|checkout|place order|complete purchase|confirm (?:booking|reservation|purchase|order)|final(?:ly)? (?:book|reserve|buy|purchase)|send message|send email|post|publish|delete|remove account)\b/i.test(text) ||
    /\b(card number|cvv|cvc|otp|one[-\s]?time password|password|credential|secret|api[_-]?key)\b/i.test(text)
  );
}

async function settlePage(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: 4_000 }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => undefined);
  await page.waitForTimeout(250).catch(() => undefined);
}

async function humanDelay(page: Page): Promise<void> {
  await page.waitForTimeout(80 + Math.floor(Math.random() * 180)).catch(() => undefined);
}

async function savePageState(
  runtime: BrowserRuntime,
  status: BrowserSessionState["status"] = "open",
  patch: Partial<BrowserSessionState> = {},
): Promise<void> {
  const title = await runtime.page.title().catch(() => "");
  const state = loadBrowserSessionState(runtime.sessionId);
  saveBrowserSessionState({
    ...state,
    ...patch,
    status,
    url: runtime.page.url(),
    title,
    userDataDir: browserUserDataDir(runtime.sessionId),
  });
}

async function detectBlockPage(page: Page): Promise<string | undefined> {
  const title = await page.title().catch(() => "");
  const body = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
  const text = `${title}\n${body}`.slice(0, 8_000);
  if (/\b(cloudflare|attention required|checking your browser|verify you are human|captcha|hcaptcha|recaptcha|access denied|you have been blocked|unusual traffic|are you a robot)\b/i.test(text)) {
    return "Anti-bot, captcha, or access-denied page detected.";
  }
  return undefined;
}

async function detectActiveSurfaceInfo(page: Page): Promise<ActiveSurfaceInfo | undefined> {
  return page.evaluate(() => {
    const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
    const cssPath = (node: Element) => {
      if (node.id) return `#${CSS.escape(node.id)}`;
      const parts: string[] = [];
      let current: Element | null = node;
      while (current && current !== document.documentElement && parts.length < 8) {
        const parent: Element | null = current.parentElement;
        const tag = current.tagName.toLowerCase();
        if (!parent) {
          parts.unshift(tag);
          break;
        }
        const siblings = (Array.from(parent.children) as Element[]).filter((child) => child.tagName === current!.tagName);
        const index = siblings.indexOf(current) + 1;
        parts.unshift(`${tag}:nth-of-type(${Math.max(index, 1)})`);
        current = parent;
      }
      return parts.join(" > ");
    };
    const alpha = (value: string) => {
      const match = value.match(/rgba?\(([^)]+)\)/i);
      if (!match) return value && value !== "transparent" ? 1 : 0;
      const parts = match[1].split(",").map((part) => part.trim());
      if (parts.length < 4) return 1;
      const parsed = Number(parts[3]);
      return Number.isFinite(parsed) ? parsed : 1;
    };
    const isVisible = (el: Element, rect = el.getBoundingClientRect()) => {
      const style = window.getComputedStyle(el);
      return rect.width > 8 && rect.height > 8 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
    };
    const topMostScore = (el: Element, rect: DOMRect) => {
      const points = [
        [rect.left + rect.width / 2, rect.top + rect.height / 2],
        [rect.left + Math.min(rect.width - 2, 16), rect.top + Math.min(rect.height - 2, 16)],
        [rect.right - Math.min(rect.width - 2, 16), rect.bottom - Math.min(rect.height - 2, 16)],
      ];
      return points.reduce((score, [rawX, rawY]) => {
        const x = Math.min(Math.max(rawX, 0), Math.max(window.innerWidth - 1, 0));
        const y = Math.min(Math.max(rawY, 0), Math.max(window.innerHeight - 1, 0));
        const hit = document.elementFromPoint(x, y);
        return score + (hit && (hit === el || el.contains(hit) || hit.contains(el)) ? 1 : 0);
      }, 0);
    };

    const explicitSelector = [
      "dialog[open]",
      "[aria-modal='true']",
      "[role='dialog']",
      "[role='alertdialog']",
      "[role='listbox']",
      "[role='menu']",
      "[popover]",
      "[class*='modal' i]",
      "[class*='popup' i]",
      "[class*='popover' i]",
      "[class*='drawer' i]",
      "[class*='dropdown' i]",
      "[class*='listbox' i]",
      "[class*='suggest' i]",
      "[class*='autocomplete' i]",
    ].join(",");

    const viewportArea = Math.max(window.innerWidth * window.innerHeight, 1);
    let best: { el: Element; score: number; reason: string } | undefined;
    const candidates = Array.from(document.querySelectorAll("body *"));
    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      if (!isVisible(el, rect)) continue;
      const text = clean(el.textContent).slice(0, 1600);
      if (!text) continue;
      const style = window.getComputedStyle(el);
      const area = rect.width * rect.height;
      if (area < viewportArea * 0.01 || area > viewportArea * 0.9) continue;
      const z = Number.parseInt(style.zIndex || "0", 10);
      const topScore = topMostScore(el, rect);
      const explicit = el.matches(explicitSelector);
      const elevated = explicit || style.position === "fixed" || style.position === "absolute" || (Number.isFinite(z) && z > 1) || style.boxShadow !== "none" || alpha(style.backgroundColor) > 0.74;
      const centered = rect.left + rect.width / 2 > window.innerWidth * 0.05 &&
        rect.left + rect.width / 2 < window.innerWidth * 0.95 &&
        rect.top + rect.height / 2 > window.innerHeight * 0.05 &&
        rect.top + rect.height / 2 < window.innerHeight * 0.95;
      if (!centered || !elevated) continue;

      const score =
        (explicit ? 160 : 0) +
        topScore * 70 +
        (style.position === "fixed" ? 60 : 0) +
        (style.boxShadow !== "none" ? 24 : 0) +
        (Number.isFinite(z) ? Math.min(z, 120) : 0) +
        Math.min(area / viewportArea * 60, 60);
      if (!best || score > best.score) {
        best = { el, score, reason: explicit ? "explicit modal/dropdown surface" : "visual top-layer surface" };
      }
    }
    if (!best) return undefined;
    const rect = best.el.getBoundingClientRect();
    const style = window.getComputedStyle(best.el);
    const parsedZ = Number.parseInt(style.zIndex || "0", 10);
    return {
      selector: cssPath(best.el),
      text: clean(best.el.textContent).slice(0, 800),
      bounds: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      zIndex: Number.isFinite(parsedZ) ? parsedZ : undefined,
      reason: best.reason,
    };
  });
}

async function captureSnapshot(
  runtime: BrowserRuntime,
  instruction?: string,
  maxElements = MAX_SNAPSHOT_ELEMENTS,
): Promise<SnapshotResult> {
  await settlePage(runtime.page);
  const blockedReason = await detectBlockPage(runtime.page);
  if (blockedReason) {
    updateBrowserSessionState(runtime.sessionId, { status: "blocked", blockedReason });
  }

  const elements: SnapshotElement[] = [];
  const seen = new Set<string>();
  const frames = runtime.page.frames();

  for (const frame of frames) {
    if (elements.length >= maxElements) break;
    await collectFrameElements(frame, elements, seen, maxElements, instruction);
  }

  elements.sort((a, b) => {
    const popupDelta = Number(Boolean(b.activePopup)) - Number(Boolean(a.activePopup));
    if (popupDelta !== 0) return popupDelta;
    const topDelta = Number(Boolean(b.topMost)) - Number(Boolean(a.topMost));
    if (topDelta !== 0) return topDelta;
    const modalDelta = Number(Boolean(b.inModal)) - Number(Boolean(a.inModal));
    if (modalDelta !== 0) return modalDelta;
    const zDelta = (b.zIndex ?? 0) - (a.zIndex ?? 0);
    if (zDelta !== 0) return zDelta;
    const ay = a.bounds?.y ?? Number.MAX_SAFE_INTEGER;
    const by = b.bounds?.y ?? Number.MAX_SAFE_INTEGER;
    return ay - by;
  });
  elements.forEach((element, index) => {
    element.legacyId = index + 1;
  });

  runtime.refs = new Map(elements.map((element) => [element.ref, element]));
  runtime.legacyIds = new Map(elements.map((element) => [element.legacyId, element.ref]));

  const title = await runtime.page.title().catch(() => "");
  const activeSurface = await detectActiveSurfaceInfo(runtime.page).catch(() => undefined);
  const snapshot: SnapshotResult = {
    url: runtime.page.url(),
    title,
    timestamp: Date.now(),
    path: "",
    elements,
    ...(activeSurface ? { activeSurface } : {}),
    ...(blockedReason ? { blockedReason } : {}),
  };
  const path = writeBrowserSnapshot(runtime.sessionId, {
    ...snapshot,
    path: undefined,
    instruction,
  });
  snapshot.path = path;
  await savePageState(runtime, blockedReason ? "blocked" : "open", {
    lastSnapshot: path,
    blockedReason,
  });
  return snapshot;
}

async function collectFrameElements(
  frame: Frame,
  elements: SnapshotElement[],
  seen: Set<string>,
  maxElements: number,
  instruction?: string,
): Promise<void> {
  const topLayer = await collectTopLayerElements(
    frame,
    Math.max(30, Math.min(80, maxElements)),
  ).catch(() => []);
  for (const candidate of topLayer) {
    if (elements.length >= maxElements) return;
    const item = snapshotElementFromTextCandidate(frame, candidate, elements.length + 1);
    const key = elementDedupeKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    elements.push(item);
  }

  const textMatches = await collectTextMatchElements(
    frame,
    instruction ?? "",
    Math.max(30, Math.min(80, maxElements)),
  ).catch(() => []);
  for (const candidate of textMatches) {
    if (elements.length >= maxElements) return;
    const item = snapshotElementFromTextCandidate(frame, candidate, elements.length + 1);
    const key = elementDedupeKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    elements.push(item);
  }

  const hitTestElements = await collectHitTestElements(
    frame,
    Math.max(30, Math.min(100, maxElements)),
  ).catch(() => []);
  for (const candidate of hitTestElements) {
    if (elements.length >= maxElements) return;
    const item = snapshotElementFromTextCandidate(frame, candidate, elements.length + 1);
    const key = elementDedupeKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    elements.push(item);
  }

  for (const selector of CANDIDATE_SELECTORS) {
    if (elements.length >= maxElements) return;
    const locator = frame.locator(selector);
    const count = Math.min(await locator.count().catch(() => 0), 80);
    for (let nth = 0; nth < count && elements.length < maxElements; nth++) {
      const item = await readSnapshotElement(frame, selector, nth, elements.length + 1).catch(() => null);
      if (!item || !item.visible) continue;
      const key = elementDedupeKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      elements.push(item);
    }
  }
}

async function collectTopLayerElements(
  frame: Frame,
  limit: number,
): Promise<TextMatchCandidate[]> {
  return frame.evaluate(({ limit }) => {
    const clean = (value: string | null | undefined) =>
      (value ?? "").replace(/\s+/g, " ").trim();
    const viewportArea = Math.max(window.innerWidth * window.innerHeight, 1);
    const surfaceSelector = [
      "dialog",
      "[aria-modal='true']",
      "[role='dialog']",
      "[role='alertdialog']",
      "[role='listbox']",
      "[role='menu']",
      "[role='tree']",
      "[role='grid']",
      "[popover]",
      "[class*='modal' i]",
      "[class*='popup' i]",
      "[class*='overlay' i]",
      "[class*='drawer' i]",
      "[class*='dropdown' i]",
      "[class*='listbox' i]",
      "[class*='suggest' i]",
      "[class*='autocomplete' i]",
    ].join(",");

    const alpha = (value: string) => {
      const rgba = value.match(/rgba?\(([^)]+)\)/i);
      if (!rgba) return value && value !== "transparent" ? 1 : 0;
      const parts = rgba[1].split(",").map((part) => part.trim());
      if (parts.length < 4) return 1;
      const parsed = Number(parts[3]);
      return Number.isFinite(parsed) ? parsed : 1;
    };

    const cssPath = (node: Element) => {
      if (node.id) return `#${CSS.escape(node.id)}`;
      const parts: string[] = [];
      let current: Element | null = node;
      while (current && current !== document.documentElement && parts.length < 8) {
        const parentEl: Element | null = current.parentElement;
        const tag = current.tagName.toLowerCase();
        if (!parentEl) {
          parts.unshift(tag);
          break;
        }
        const tagName = current.tagName;
        const siblings = (Array.from(parentEl.children) as Element[])
          .filter((child) => child.tagName === tagName);
        const index = siblings.indexOf(current) + 1;
        parts.unshift(`${tag}:nth-of-type(${Math.max(index, 1)})`);
        current = parentEl;
      }
      return parts.join(" > ");
    };

    const isVisible = (el: Element, rect = el.getBoundingClientRect()) => {
      if (rect.width < 3 || rect.height < 3) return false;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
        return false;
      }
      return rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
    };

    const isTopMost = (el: Element, rect = el.getBoundingClientRect()) => {
      const points = [
        [rect.left + rect.width / 2, rect.top + rect.height / 2],
        [rect.left + Math.min(Math.max(rect.width - 1, 1), 12), rect.top + Math.min(Math.max(rect.height - 1, 1), 12)],
        [rect.right - Math.min(Math.max(rect.width - 1, 1), 12), rect.bottom - Math.min(Math.max(rect.height - 1, 1), 12)],
      ];
      return points.some(([rawX, rawY]) => {
        const x = Math.min(Math.max(rawX, 0), Math.max(window.innerWidth - 1, 0));
        const y = Math.min(Math.max(rawY, 0), Math.max(window.innerHeight - 1, 0));
        const hit = document.elementFromPoint(x, y);
        return Boolean(hit && (hit === el || el.contains(hit) || hit.contains(el)));
      });
    };

    const isScrollable = (node: Element) => {
      const style = window.getComputedStyle(node);
      const overflow = `${style.overflow} ${style.overflowX} ${style.overflowY}`;
      return (
        /(auto|scroll|overlay)/i.test(overflow) &&
        (node.scrollHeight > node.clientHeight + 2 || node.scrollWidth > node.clientWidth + 2)
      );
    };

    const directText = (el: Element) => {
      const own = Array.from(el.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent || "")
        .join(" ");
      return clean(own) || clean(el.getAttribute("aria-label")) || clean(el.getAttribute("title")) || clean(el.textContent);
    };

    const visibleElements = Array.from(document.querySelectorAll("body *"))
      .map((el) => ({ el, rect: el.getBoundingClientRect(), style: window.getComputedStyle(el) }))
      .filter(({ el, rect }) => isVisible(el, rect));

    const dimBackdrop = visibleElements.some(({ el, rect, style }) => {
      if (el === document.body || el === document.documentElement) return false;
      const area = rect.width * rect.height;
      const bgAlpha = alpha(style.backgroundColor);
      return (
        area > viewportArea * 0.45 &&
        rect.left <= window.innerWidth * 0.12 &&
        rect.top <= window.innerHeight * 0.18 &&
        rect.right >= window.innerWidth * 0.82 &&
        rect.bottom >= window.innerHeight * 0.7 &&
        (style.position === "fixed" || style.position === "absolute" || bgAlpha >= 0.18 || style.backdropFilter !== "none")
      );
    });

    const surfaces = visibleElements
      .map(({ el, rect, style }) => {
        const text = clean(el.textContent);
        if (!text || text.length > 1800) return null;
        const area = rect.width * rect.height;
        if (area < viewportArea * 0.012 || area > viewportArea * 0.78) return null;
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const centered =
          centerX > window.innerWidth * 0.12 &&
          centerX < window.innerWidth * 0.88 &&
          centerY > window.innerHeight * 0.08 &&
          centerY < window.innerHeight * 0.94;
        const z = Number.parseInt(style.zIndex || "0", 10);
        const bgAlpha = alpha(style.backgroundColor);
        const topMost = isTopMost(el, rect);
        const explicit = el.matches(surfaceSelector);
        const elevated =
          explicit ||
          style.position === "fixed" ||
          style.position === "absolute" ||
          (Number.isFinite(z) && z > 1) ||
          style.boxShadow !== "none" ||
          Number.parseFloat(style.borderRadius || "0") > 6 ||
          bgAlpha > 0.72;
        if (!centered || (!elevated && !dimBackdrop)) return null;
        const score =
          (explicit ? 80 : 0) +
          (topMost ? 60 : 0) +
          (dimBackdrop ? 45 : 0) +
          (bgAlpha > 0.72 ? 20 : 0) +
          (style.boxShadow !== "none" ? 16 : 0) +
          (Number.isFinite(z) ? Math.min(z, 70) : 0) +
          Math.min((area / viewportArea) * 45, 45);
        if (score < 45) return null;
        return { el, rect, style, score };
      })
      .filter((item): item is { el: Element; rect: DOMRect; style: CSSStyleDeclaration; score: number } => Boolean(item))
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);

    if (surfaces.length === 0) return [];

    const bestSurfaceElements = new Set<Element>();
    for (const surface of surfaces) {
      bestSurfaceElements.add(surface.el);
      for (const child of Array.from(surface.el.querySelectorAll("*"))) {
        bestSurfaceElements.add(child);
      }
    }

    const scored: Array<{ candidate: TextMatchCandidate; score: number }> = [];
    for (const el of bestSurfaceElements) {
      const rect = el.getBoundingClientRect();
      if (!isVisible(el, rect)) continue;
      const text = directText(el);
      const placeholder = el.getAttribute("placeholder") || "";
      const value = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
        ? el.value
        : "";
      const href = el.getAttribute("href") || "";
      const label = clean(el.getAttribute("aria-label")) || clean(el.getAttribute("title"));
      const name = clean([label, text, placeholder, value, href].join(" "));
      if (!name && !el.matches("button,a,input,textarea,select,[role],[onclick],[tabindex],svg")) continue;
      if (name.length > 260) continue;

      const style = window.getComputedStyle(el);
      const isClickable =
        el.matches("button,a,input,textarea,select,[role='button'],[role='option'],[role='menuitem'],[role='tab'],[onclick],[tabindex],[aria-haspopup],[aria-expanded]") ||
        style.cursor === "pointer";
      const isReadableLeaf = el.children.length === 0 || rect.width * rect.height < viewportArea * 0.035;
      if (!isClickable && !isReadableLeaf) continue;

      let scrollable: Element | null = null;
      for (let current: Element | null = el; current; current = current.parentElement) {
        if (isScrollable(current)) {
          scrollable = current;
          break;
        }
        if (current === document.body) break;
      }

      const z = Number.parseInt(style.zIndex || "0", 10);
      const topMost = isTopMost(el, rect);
      const score =
        (isClickable ? 40 : 16) +
        (topMost ? 18 : 0) +
        (style.cursor === "pointer" ? 12 : 0) +
        (el.matches("[role='option'],[role='menuitem'],button,a") ? 10 : 0) +
        Math.max(0, 120 - name.length) / 20 +
        (Number.isFinite(z) ? Math.min(z, 25) : 0);

      scored.push({
        score,
        candidate: {
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role") || "",
          type: el.getAttribute("type") || "",
          text,
          label,
          placeholder,
          href,
          selector: cssPath(el),
          visible: true,
          enabled: !(el instanceof HTMLButtonElement || el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) || !el.disabled,
          bounds: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
          ...(value ? { value } : {}),
          inModal: true,
          activePopup: true,
          ...(topMost ? { topMost: true } : {}),
          ...(Number.isFinite(z) && z ? { zIndex: z } : {}),
          ...(scrollable ? { scrollableSelector: cssPath(scrollable) } : {}),
        },
      });
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((item) => item.candidate);
  }, { limit });
}

async function collectTextMatchElements(
  frame: Frame,
  instruction: string,
  limit: number,
): Promise<TextMatchCandidate[]> {
  const hints = buildTextTargetHints(instruction);

  return frame.evaluate(({ phrases, tokens, limit }) => {
    const normalize = (value: string) =>
      value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const tokenSet = new Set(tokens);
    const viewportArea = Math.max(window.innerWidth * window.innerHeight, 1);
    const isVisible = (el: Element, rect: DOMRect) => {
      if (rect.width < 3 || rect.height < 3) return false;
      const style = window.getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
      return rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
    };
    const backgroundAlpha = (value: string) => {
      const rgba = value.match(/rgba?\(([^)]+)\)/i);
      if (!rgba) return value && value !== "transparent" ? 1 : 0;
      const parts = rgba[1].split(",").map((part) => part.trim());
      if (parts.length < 4) return 1;
      const alpha = Number(parts[3]);
      return Number.isFinite(alpha) ? alpha : 1;
    };
    const isTopMost = (el: Element, rect: DOMRect) => {
      const points = [
        [rect.left + rect.width / 2, rect.top + rect.height / 2],
        [rect.left + Math.min(rect.width - 1, 12), rect.top + Math.min(rect.height - 1, 12)],
        [rect.right - Math.min(rect.width - 1, 12), rect.bottom - Math.min(rect.height - 1, 12)],
      ];
      return points.some(([rawX, rawY]) => {
        const x = Math.min(Math.max(rawX, 0), Math.max(window.innerWidth - 1, 0));
        const y = Math.min(Math.max(rawY, 0), Math.max(window.innerHeight - 1, 0));
        const hit = document.elementFromPoint(x, y);
        return Boolean(hit && (hit === el || el.contains(hit) || hit.contains(el)));
      });
    };
    const cssPath = (node: Element) => {
      if (node.id) return `#${CSS.escape(node.id)}`;
      const parts: string[] = [];
      let current: Element | null = node;
      while (current && current !== document.documentElement && parts.length < 8) {
        const parentEl: Element | null = current.parentElement;
        const tag = current.tagName.toLowerCase();
        if (!parentEl) {
          parts.unshift(tag);
          break;
        }
        const siblings = Array.from(parentEl.children).filter((child) => child.tagName === current!.tagName);
        const index = siblings.indexOf(current) + 1;
        parts.unshift(`${tag}:nth-of-type(${Math.max(index, 1)})`);
        current = parentEl;
      }
      return parts.join(" > ");
    };
    const isScrollable = (node: Element) => {
      const style = window.getComputedStyle(node);
      const overflow = `${style.overflow} ${style.overflowX} ${style.overflowY}`;
      return (
        /(auto|scroll|overlay)/i.test(overflow) &&
        (node.scrollHeight > node.clientHeight + 2 || node.scrollWidth > node.clientWidth + 2)
      );
    };
    const allElements = Array.from(document.querySelectorAll("body *"));
    const visibleElements = allElements
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return { el, rect, style };
      })
      .filter(({ el, rect }) => isVisible(el, rect));
    const dimBackdrop = visibleElements.some(({ el, rect, style }) => {
      if (el === document.body || el === document.documentElement) return false;
      const area = rect.width * rect.height;
      const alpha = backgroundAlpha(style.backgroundColor);
      return (
        area > viewportArea * 0.45 &&
        rect.left <= window.innerWidth * 0.1 &&
        rect.top <= window.innerHeight * 0.15 &&
        rect.right >= window.innerWidth * 0.85 &&
        rect.bottom >= window.innerHeight * 0.75 &&
        (style.position === "fixed" || style.position === "absolute" || alpha >= 0.2) &&
        (alpha >= 0.18 || style.backdropFilter !== "none")
      );
    });
    const overlayPanels = visibleElements
      .map(({ el, rect, style }) => {
        if (el === document.body || el === document.documentElement) return null;
        const area = rect.width * rect.height;
        if (area < viewportArea * 0.015 || area > viewportArea * 0.72) return null;
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const centered =
          centerX > window.innerWidth * 0.18 &&
          centerX < window.innerWidth * 0.82 &&
          centerY > window.innerHeight * 0.12 &&
          centerY < window.innerHeight * 0.9;
        const alpha = backgroundAlpha(style.backgroundColor);
        const z = Number.parseInt(style.zIndex || "0", 10);
        const text = (el.textContent || "").replace(/\s+/g, " ").trim();
        const topMost = isTopMost(el, rect);
        const visuallyElevated =
          style.position === "fixed" ||
          style.position === "absolute" ||
          Number.isFinite(z) && z > 1 ||
          style.boxShadow !== "none" ||
          Number.parseFloat(style.borderRadius || "0") > 6 ||
          alpha > 0.75;
        if (!centered || !text || text.length > 1200) return null;
        if (!visuallyElevated && (!dimBackdrop || !topMost)) return null;
        const score =
          (dimBackdrop ? 40 : 0) +
          (topMost ? 30 : 0) +
          (alpha > 0.75 ? 20 : 0) +
          (Number.isFinite(z) ? Math.min(z, 50) : 0) +
          Math.min(area / viewportArea * 30, 30);
        if (score < 35) return null;
        return { el, score };
      })
      .filter((item): item is { el: Element; score: number } => Boolean(item))
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map((item) => item.el);
    const popupSelector = [
      "dialog",
      "[aria-modal='true']",
      "[role='dialog']",
      "[role='alertdialog']",
      "[role='listbox']",
      "[role='menu']",
      "[role='tree']",
      "[role='grid']",
      "[popover]",
      "[class*='modal' i]",
      "[class*='popup' i]",
      "[class*='overlay' i]",
      "[class*='drawer' i]",
      "[class*='dropdown' i]",
      "[class*='listbox' i]",
      "[class*='suggest' i]",
      "[class*='autocomplete' i]",
    ].join(",");
    const readText = (el: Element) => (el.textContent || "").replace(/\s+/g, " ").trim();
    const directText = (el: Element) => {
      const own = Array.from(el.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent || "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      return own || readText(el);
    };
    const candidates = Array.from(document.querySelectorAll("button,a,[role='button'],[role='option'],[role='menuitem'],[role='tab'],[onclick],[tabindex],input,textarea,select,div,span,li,p"));
    const scored: Array<{ candidate: TextMatchCandidate; score: number }> = [];

    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      if (!isVisible(el, rect)) continue;
      const text = directText(el);
      const aria = el.getAttribute("aria-label") || "";
      const title = el.getAttribute("title") || "";
      const placeholder = el.getAttribute("placeholder") || "";
      const value = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement ? el.value : "";
      const href = el.getAttribute("href") || "";
      const visibleName = [aria, title, text, placeholder, value, href].join(" ").replace(/\s+/g, " ").trim();
      if (!visibleName || visibleName.length > 220) continue;
      const normalized = normalize(visibleName);
      if (!normalized) continue;
      const insideOverlayPanel = overlayPanels.some((panel) => panel === el || panel.contains(el));

      let score = 0;
      for (const phrase of phrases) {
        if (phrase && normalized.includes(phrase)) score += phrase.includes(" ") ? 24 : 14;
      }
      const words = new Set(normalized.split(/\s+/).filter(Boolean));
      for (const token of tokenSet) {
        if (words.has(token)) score += token.length > 4 ? 6 : 4;
      }
      if (/\b\d{1,2}\s+\d{2}\s+(am|pm)\b/i.test(normalized)) score += 10;
      if (el.matches("button,a,[role='button'],[role='option'],[role='menuitem'],[role='tab'],[onclick],[tabindex]")) score += 8;
      if (/pointer/i.test(window.getComputedStyle(el).cursor)) score += 6;

      const popup = el.closest(popupSelector);
      if (popup) score += 10;
      if (insideOverlayPanel) {
        score += 24;
        if (visibleName.length <= 80) score += 8;
        if (el.children.length === 0 || el.matches("button,a,[role='button'],[role='option'],[onclick],[tabindex]")) score += 8;
      }

      if (score < 14) continue;

      const centerX = Math.min(Math.max(rect.left + rect.width / 2, 0), Math.max(window.innerWidth - 1, 0));
      const centerY = Math.min(Math.max(rect.top + rect.height / 2, 0), Math.max(window.innerHeight - 1, 0));
      const hit = document.elementFromPoint(centerX, centerY);
      const topMost = Boolean(hit && (hit === el || el.contains(hit) || hit.contains(el)));
      const style = window.getComputedStyle(el);
      const parsedZ = Number.parseInt(style.zIndex || "0", 10);
      let scrollable: Element | null = null;
      for (let current: Element | null = el; current; current = current.parentElement) {
        if (isScrollable(current)) {
          scrollable = current;
          break;
        }
        if (current === document.body) break;
      }

      scored.push({
        score,
        candidate: {
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role") || "",
          type: el.getAttribute("type") || "",
          text,
          label: aria || title,
          placeholder,
          href,
          selector: cssPath(el),
          visible: true,
          enabled: !(el instanceof HTMLButtonElement || el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) || !el.disabled,
          bounds: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
          ...(value ? { value } : {}),
          ...(popup || insideOverlayPanel ? { inModal: true, activePopup: true } : {}),
          ...(topMost ? { topMost: true } : {}),
          ...(Number.isFinite(parsedZ) && parsedZ ? { zIndex: parsedZ } : {}),
          ...(scrollable ? { scrollableSelector: cssPath(scrollable) } : {}),
        },
      });
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((item) => item.candidate);
  }, { ...hints, limit });
}

async function collectHitTestElements(
  frame: Frame,
  limit: number,
): Promise<TextMatchCandidate[]> {
  return frame.evaluate(({ limit }) => {
    const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
    const cssPath = (node: Element) => {
      if (node.id) return `#${CSS.escape(node.id)}`;
      const parts: string[] = [];
      let current: Element | null = node;
      while (current && current !== document.documentElement && parts.length < 8) {
        const parent: Element | null = current.parentElement;
        const tag = current.tagName.toLowerCase();
        if (!parent) {
          parts.unshift(tag);
          break;
        }
        const siblings = (Array.from(parent.children) as Element[]).filter((child) => child.tagName === current!.tagName);
        const index = siblings.indexOf(current) + 1;
        parts.unshift(`${tag}:nth-of-type(${Math.max(index, 1)})`);
        current = parent;
      }
      return parts.join(" > ");
    };
    const isVisible = (el: Element, rect = el.getBoundingClientRect()) => {
      const style = window.getComputedStyle(el);
      return rect.width >= 4 && rect.height >= 4 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
    };
    const popupSelector = [
      "dialog",
      "[aria-modal='true']",
      "[role='dialog']",
      "[role='alertdialog']",
      "[role='listbox']",
      "[role='menu']",
      "[role='tree']",
      "[role='grid']",
      "[popover]",
      "[class*='modal' i]",
      "[class*='popup' i]",
      "[class*='overlay' i]",
      "[class*='drawer' i]",
      "[class*='dropdown' i]",
      "[class*='listbox' i]",
      "[class*='suggest' i]",
      "[class*='autocomplete' i]",
    ].join(",");
    const roleFor = (el: Element) => {
      const explicit = el.getAttribute("role") || "";
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute("type") || "";
      if (tag === "button") return "button";
      if (tag === "a") return "link";
      if (tag === "select") return "select";
      if (tag === "textarea") return "textbox";
      if (tag === "input") return type === "checkbox" ? "checkbox" : type === "radio" ? "radio" : type === "submit" || type === "button" ? "button" : "textbox";
      if (el.hasAttribute("aria-haspopup") || el.hasAttribute("aria-expanded")) return "button";
      return "";
    };
    const isScrollable = (node: Element) => {
      const style = window.getComputedStyle(node);
      const overflow = `${style.overflow} ${style.overflowX} ${style.overflowY}`;
      return /(auto|scroll|overlay)/i.test(overflow) && (node.scrollHeight > node.clientHeight + 2 || node.scrollWidth > node.clientWidth + 2);
    };
    const directText = (el: Element) => {
      const own = Array.from(el.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent || "")
        .join(" ");
      return clean(own) || clean(el.getAttribute("aria-label")) || clean(el.getAttribute("title")) || clean(el.textContent);
    };

    const points: Array<[number, number]> = [];
    const columns = 9;
    const rows = 7;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < columns; x++) {
        points.push([
          Math.round((window.innerWidth * (x + 0.5)) / columns),
          Math.round((window.innerHeight * (y + 0.5)) / rows),
        ]);
      }
    }

    const seen = new Set<Element>();
    const scored: Array<{ score: number; candidate: TextMatchCandidate }> = [];
    for (const [x, y] of points) {
      for (const raw of document.elementsFromPoint(x, y)) {
        let el: Element | null = raw;
        for (let depth = 0; el && depth < 4; depth++, el = el.parentElement) {
          if (seen.has(el)) continue;
          seen.add(el);
          const rect = el.getBoundingClientRect();
          if (!isVisible(el, rect)) continue;
          const style = window.getComputedStyle(el);
          const text = directText(el);
          const label = clean(el.getAttribute("aria-label")) || clean(el.getAttribute("title"));
          const placeholder = clean(el.getAttribute("placeholder"));
          const href = clean(el.getAttribute("href"));
          const value = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement ? el.value : "";
          const name = clean([label, text, placeholder, value, href].join(" "));
          if (!name || name.length > 260) continue;
          const role = roleFor(el);
          const clickable = el.matches("button,a,input,textarea,select,[role],[onclick],[tabindex],[aria-haspopup],[aria-expanded]") || style.cursor === "pointer";
          const popup = el.closest(popupSelector);
          if (!clickable && !popup && el.children.length > 0) continue;
          let scrollable: Element | null = null;
          for (let current: Element | null = el; current; current = current.parentElement) {
            if (isScrollable(current)) {
              scrollable = current;
              break;
            }
            if (current === document.body) break;
          }
          const parsedZ = Number.parseInt(style.zIndex || "0", 10);
          const score =
            (clickable ? 40 : 12) +
            (popup ? 24 : 0) +
            (style.cursor === "pointer" ? 14 : 0) +
            (role ? 10 : 0) +
            (Number.isFinite(parsedZ) ? Math.min(parsedZ, 30) : 0) +
            Math.max(0, 160 - name.length) / 12;
          scored.push({
            score,
            candidate: {
              tag: el.tagName.toLowerCase(),
              role,
              type: el.getAttribute("type") || "",
              text,
              label,
              placeholder,
              href,
              selector: cssPath(el),
              visible: true,
              enabled: !(el instanceof HTMLButtonElement || el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) || !el.disabled,
              bounds: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              },
              ...(value ? { value } : {}),
              ...(popup ? { inModal: true, activePopup: true } : {}),
              topMost: true,
              ...(Number.isFinite(parsedZ) && parsedZ ? { zIndex: parsedZ } : {}),
              ...(scrollable ? { scrollableSelector: cssPath(scrollable) } : {}),
            },
          });
        }
      }
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((item) => item.candidate);
  }, { limit });
}

function snapshotElementFromTextCandidate(
  frame: Frame,
  candidate: TextMatchCandidate,
  legacyId: number,
): SnapshotElement {
  const frameUrl = frame.parentFrame() ? frame.url() : undefined;
  const role = candidate.role || inferRole(candidate.tag, candidate.type, candidate.selector);
  const ref = makeRef({
    frameUrl: frameUrl ?? "main",
    selector: candidate.selector,
    nth: 0,
    tag: candidate.tag,
    role,
    label: candidate.label,
    text: candidate.text,
    placeholder: candidate.placeholder,
    href: candidate.href,
  });

  return {
    ref,
    legacyId,
    tag: candidate.tag,
    role,
    type: clean(candidate.type),
    text: truncateField(clean(candidate.text || candidate.value || ""), SNAPSHOT_LINE_CHARS),
    label: truncateField(clean(candidate.label), SNAPSHOT_LINE_CHARS),
    placeholder: truncateField(clean(candidate.placeholder), SNAPSHOT_LINE_CHARS),
    href: truncateField(clean(candidate.href), SNAPSHOT_LINE_CHARS),
    selector: `${candidate.selector} >> nth=0`,
    visible: candidate.visible,
    enabled: candidate.enabled,
    ...(candidate.bounds ? { bounds: candidate.bounds } : {}),
    ...(candidate.value ? { value: truncateField(candidate.value, SNAPSHOT_LINE_CHARS) } : {}),
    ...(frameUrl ? { frameUrl } : {}),
    ...(candidate.inModal ? { inModal: true } : {}),
    ...(candidate.activePopup ? { activePopup: true } : {}),
    ...(candidate.topMost ? { topMost: true } : {}),
    ...(candidate.zIndex ? { zIndex: candidate.zIndex } : {}),
    ...(candidate.scrollableSelector ? { scrollableSelector: candidate.scrollableSelector } : {}),
    locatorQuery: {
      selector: candidate.selector,
      nth: 0,
      ...(frameUrl ? { frameUrl, frameName: frame.name() } : {}),
    },
  };
}

async function readSnapshotElement(
  frame: Frame,
  selector: string,
  nth: number,
  legacyId: number,
): Promise<SnapshotElement | null> {
  const locator = frame.locator(selector).nth(nth);
  const visible = await locator.isVisible().catch(() => false);
  if (!visible) return null;

  const tag = await locator.evaluate((el) => el.tagName.toLowerCase()).catch(() => "element");
  const type = clean(await locator.getAttribute("type").catch(() => ""));
  const role = clean(await locator.getAttribute("role").catch(() => "")) || inferRole(tag, type, selector);
  const href = clean(await locator.getAttribute("href").catch(() => ""));
  const placeholder = clean(await locator.getAttribute("placeholder").catch(() => ""));
  const ariaLabel = clean(await locator.getAttribute("aria-label").catch(() => ""));
  const title = clean(await locator.getAttribute("title").catch(() => ""));
  const label = ariaLabel || await readLabel(locator);
  const text = clean(
    await locator.innerText({ timeout: 800 }).catch(async () =>
      await locator.textContent({ timeout: 800 }).catch(() => ""),
    ),
  );
  const value = await readValue(locator, tag);
  const enabled = await locator.isEnabled().catch(() => true);
  const bounds = await locator.boundingBox().catch(() => null);
  const meta = await locator.evaluate((el, popupSelector) => {
    const rect = el.getBoundingClientRect();
    const centerX = Math.min(Math.max(rect.left + rect.width / 2, 0), Math.max(window.innerWidth - 1, 0));
    const centerY = Math.min(Math.max(rect.top + rect.height / 2, 0), Math.max(window.innerHeight - 1, 0));
    const hit = rect.width > 0 && rect.height > 0 ? document.elementFromPoint(centerX, centerY) : null;
    const topMost = Boolean(hit && (hit === el || el.contains(hit) || hit.contains(el)));
    const style = window.getComputedStyle(el);
    const parsedZ = Number.parseInt(style.zIndex || "0", 10);
    const popup = el.closest(popupSelector);

    const isScrollable = (node: Element) => {
      const nodeStyle = window.getComputedStyle(node);
      const overflow = `${nodeStyle.overflow} ${nodeStyle.overflowX} ${nodeStyle.overflowY}`;
      return (
        /(auto|scroll|overlay)/i.test(overflow) &&
        (node.scrollHeight > node.clientHeight + 2 || node.scrollWidth > node.clientWidth + 2)
      );
    };

    const cssPath = (node: Element) => {
      if (node.id) return `#${CSS.escape(node.id)}`;
      const parts: string[] = [];
      let current: Element | null = node;
      while (current && current !== document.documentElement && parts.length < 7) {
        const parentEl: Element | null = current.parentElement;
        const tag = current.tagName.toLowerCase();
        if (!parentEl) {
          parts.unshift(tag);
          break;
        }
        const tagName = current.tagName;
        const siblings = (Array.from(parentEl.children) as Element[]).filter((child) => child.tagName === tagName);
        const index = siblings.indexOf(current) + 1;
        parts.unshift(`${tag}:nth-of-type(${Math.max(index, 1)})`);
        current = parentEl;
      }
      return parts.join(" > ");
    };

    let scrollable: Element | null = null;
    for (let current: Element | null = el; current; current = current.parentElement) {
      if (isScrollable(current)) {
        scrollable = current;
        break;
      }
      if (current === document.body) break;
    }
    if (!scrollable && popup instanceof Element) {
      const candidates = [popup, ...Array.from(popup.querySelectorAll("*"))];
      scrollable = candidates.find(isScrollable) ?? null;
    }

    return {
      inModal: Boolean(popup),
      activePopup: Boolean(popup),
      topMost,
      zIndex: Number.isFinite(parsedZ) ? parsedZ : 0,
      scrollableSelector: scrollable ? cssPath(scrollable) : "",
    };
  }, POPUP_ANCESTOR_SELECTOR).catch(() => ({
    inModal: false,
    activePopup: false,
    topMost: false,
    zIndex: 0,
    scrollableSelector: "",
  }));
  const frameUrl = frame.parentFrame() ? frame.url() : undefined;
  const ref = makeRef({
    frameUrl: frameUrl ?? "main",
    selector,
    nth,
    tag,
    role,
    label,
    text,
    placeholder,
    href,
  });

  return {
    ref,
    legacyId,
    tag,
    role,
    type,
    text: truncateField(text || value || title, SNAPSHOT_LINE_CHARS),
    label: truncateField(label || title, SNAPSHOT_LINE_CHARS),
    placeholder: truncateField(placeholder, SNAPSHOT_LINE_CHARS),
    href: truncateField(href, SNAPSHOT_LINE_CHARS),
    selector: `${selector} >> nth=${nth}`,
    visible,
    enabled,
    ...(bounds ? { bounds: roundBounds(bounds) } : {}),
    ...(value ? { value: truncateField(value, SNAPSHOT_LINE_CHARS) } : {}),
    ...(frameUrl ? { frameUrl } : {}),
    ...(meta.inModal ? { inModal: true } : {}),
    ...(meta.activePopup ? { activePopup: true } : {}),
    ...(meta.topMost ? { topMost: true } : {}),
    ...(meta.zIndex ? { zIndex: meta.zIndex } : {}),
    ...(meta.scrollableSelector ? { scrollableSelector: meta.scrollableSelector } : {}),
    locatorQuery: {
      selector,
      nth,
      ...(frameUrl ? { frameUrl, frameName: frame.name() } : {}),
    },
  };
}

async function readLabel(locator: Locator): Promise<string> {
  return clean(await locator.evaluate((el) => {
    const own = el.getAttribute("aria-label") || el.getAttribute("title") || "";
    if (own) return own;
    const id = el.getAttribute("id");
    if (id) {
      const labels = Array.from(document.querySelectorAll(`label[for="${CSS.escape(id)}"]`))
        .map((label) => label.textContent || "")
        .join(" ");
      if (labels.trim()) return labels;
    }
    return el.closest("label")?.textContent || "";
  }).catch(() => ""));
}

async function readValue(locator: Locator, tag: string): Promise<string> {
  if (tag !== "input" && tag !== "textarea" && tag !== "select") return "";
  return clean(await locator.inputValue({ timeout: 800 }).catch(() => ""));
}

function inferRole(tag: string, type: string, selector: string): string {
  if (tag === "a") return "link";
  if (tag === "button") return "button";
  if (tag === "select") return "select";
  if (tag === "textarea") return "textbox";
  if (tag === "li") return "listitem";
  if (tag === "input") {
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "submit" || type === "button") return "button";
    return "textbox";
  }
  if (selector.includes("contenteditable")) return "textbox";
  if (selector.includes("role='combobox'")) return "combobox";
  if (selector.includes("role='searchbox'")) return "searchbox";
  if (selector.includes("role='listbox'")) return "listbox";
  if (selector.includes("role='option'")) return "option";
  if (selector.includes("role='menuitem'")) return "menuitem";
  if (selector.includes("aria-haspopup") || selector.includes("aria-expanded") || selector.includes("aria-controls")) return "button";
  if (tag === "iframe") return "iframe";
  return "";
}

function makeRef(fields: Record<string, unknown>): string {
  const hash = createHash("sha1").update(JSON.stringify(fields)).digest("hex").slice(0, 10);
  return `ref_${hash}`;
}

function elementDedupeKey(element: SnapshotElement): string {
  return [
    element.frameUrl ?? "main",
    element.tag,
    element.role,
    element.text,
    element.label,
    element.placeholder,
    element.href,
    element.bounds ? `${element.bounds.x}:${element.bounds.y}:${element.bounds.width}:${element.bounds.height}` : "",
  ].join("|").toLowerCase();
}

function roundBounds(bounds: { x: number; y: number; width: number; height: number }) {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  };
}

function clean(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function truncateField(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function snapshotToText(snapshot: SnapshotResult, legacy = false): string {
  const header = [
    `URL: ${snapshot.url}`,
    `Title: ${snapshot.title}`,
    `Snapshot: ${snapshot.path}`,
    snapshot.blockedReason ? `Blocked: ${snapshot.blockedReason}` : "",
    snapshot.activeSurface
      ? `Active surface: ${snapshot.activeSurface.reason} ${snapshot.activeSurface.bounds ? `at=${Math.round(snapshot.activeSurface.bounds.x + snapshot.activeSurface.bounds.width / 2)},${Math.round(snapshot.activeSurface.bounds.y + snapshot.activeSurface.bounds.height / 2)} size=${snapshot.activeSurface.bounds.width}x${snapshot.activeSurface.bounds.height}` : ""} selector=${snapshot.activeSurface.selector}`
      : "",
  ].filter(Boolean).join("\n");

  if (snapshot.elements.length === 0) {
    return `${header}\nNo visible interactive elements found.`;
  }

  const lines = snapshot.elements.map((element) => {
    const name = element.label || element.text || element.placeholder || element.href || "(unnamed)";
    const parts = [
      `<${element.tag}>`,
      element.role ? `role=${element.role}` : "",
      element.type ? `type=${element.type}` : "",
      element.href ? `href=${element.href}` : "",
      element.enabled ? "enabled" : "disabled",
      element.activePopup ? "popup" : "",
      element.inModal && !element.activePopup ? "modal" : "",
      element.topMost ? "top" : "",
      element.zIndex ? `z=${element.zIndex}` : "",
      element.bounds
        ? `at=${Math.round(element.bounds.x + element.bounds.width / 2)},${Math.round(element.bounds.y + element.bounds.height / 2)} size=${element.bounds.width}x${element.bounds.height}`
        : "",
      element.scrollableSelector ? "scrollable" : "",
      element.frameUrl ? `frame=${element.frameUrl}` : "",
    ].filter(Boolean).join(" ");
    const id = legacy ? `${element.legacyId}. ${element.ref}` : element.ref;
    return `${id} ${parts} "${name}"`;
  });
  return `${header}\nInteractive refs:\n${lines.join("\n")}`;
}

function resolveLocator(runtime: BrowserRuntime, element: SnapshotElement): Locator {
  const query = element.locatorQuery;
  if (query.frameUrl) {
    const frame = runtime.page.frames().find((candidate) =>
      candidate.url() === query.frameUrl || (!!query.frameName && candidate.name() === query.frameName),
    );
    if (frame) return frame.locator(query.selector).nth(query.nth);
  }
  return runtime.page.locator(query.selector).nth(query.nth);
}

function resolveSelectorLocator(
  runtime: BrowserRuntime,
  selector: string,
  frameUrl?: string,
  frameName?: string,
): Locator {
  if (frameUrl) {
    const frame = runtime.page.frames().find((candidate) =>
      candidate.url() === frameUrl || (!!frameName && candidate.name() === frameName),
    );
    if (frame) return frame.locator(selector).first();
  }
  return runtime.page.locator(selector).first();
}

async function scrollElementForAction(
  runtime: BrowserRuntime,
  element: SnapshotElement,
  locator: Locator,
): Promise<void> {
  await locator.evaluate((el) => {
    el.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
  }).catch(async () => {
    await locator.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
  });

  if (element.scrollableSelector) {
    const scroller = resolveSelectorLocator(
      runtime,
      element.scrollableSelector,
      element.locatorQuery.frameUrl,
      element.locatorQuery.frameName,
    );
    await scroller.evaluate((container) => {
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && container.contains(focused)) {
        focused.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" });
      }
    }).catch(() => undefined);
  }
}

async function scrollBrowserSurface(
  runtime: BrowserRuntime,
  direction: "up" | "down" | "left" | "right" = "down",
  amount = 700,
  ref?: string,
): Promise<string> {
  const dx = direction === "left" ? -amount : direction === "right" ? amount : 0;
  const dy = direction === "up" ? -amount : direction === "down" ? amount : 0;

  if (ref) {
    const element = await elementByRef(runtime, ref);
    const locator = resolveLocator(runtime, element);
    await scrollElementForAction(runtime, element, locator);
    if (element.scrollableSelector) {
      const scrolled = await scrollSelectorSurface(
        runtime,
        element.scrollableSelector,
        dx,
        dy,
        element.locatorQuery.frameUrl,
        element.locatorQuery.frameName,
      );
      if (scrolled) return `Scrolled container for ${ref} ${direction}.`;
    }
    const box = await locator.boundingBox({ timeout: 2_000 }).catch(() => null);
    if (box) {
      await runtime.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await runtime.page.mouse.wheel(dx, dy);
      return `Scrolled near ${ref} ${direction}.`;
    }
  }

  const activeSurface = await findActiveSurface(runtime.page);
  if (activeSurface) {
    const scrolled = await activeSurface.evaluate((surface, delta) => {
      const isScrollable = (node: Element) => {
        const style = window.getComputedStyle(node);
        const overflow = `${style.overflow} ${style.overflowX} ${style.overflowY}`;
        return (
          /(auto|scroll|overlay)/i.test(overflow) &&
          (node.scrollHeight > node.clientHeight + 2 || node.scrollWidth > node.clientWidth + 2)
        );
      };
      const candidates = [surface, ...Array.from(surface.querySelectorAll("*"))];
      const target = candidates.find(isScrollable) ?? surface;
      const before = `${target.scrollLeft}:${target.scrollTop}`;
      target.scrollBy({ left: delta.dx, top: delta.dy, behavior: "auto" });
      const after = `${target.scrollLeft}:${target.scrollTop}`;
      return before !== after;
    }, { dx, dy }).catch(() => false);
    if (scrolled) return `Scrolled active popup ${direction}.`;

    const box = await activeSurface.boundingBox({ timeout: 2_000 }).catch(() => null);
    if (box) {
      await runtime.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await runtime.page.mouse.wheel(dx, dy);
      return `Wheel scrolled over active popup ${direction}.`;
    }
  }

  await runtime.page.mouse.wheel(dx, dy);
  return `Scrolled page ${direction}.`;
}

async function scrollSelectorSurface(
  runtime: BrowserRuntime,
  selector: string,
  dx: number,
  dy: number,
  frameUrl?: string,
  frameName?: string,
): Promise<boolean> {
  const target = resolveSelectorLocator(runtime, selector, frameUrl, frameName);
  return target.evaluate((surface, delta) => {
    const before = `${surface.scrollLeft}:${surface.scrollTop}`;
    surface.scrollBy({ left: delta.dx, top: delta.dy, behavior: "auto" });
    const after = `${surface.scrollLeft}:${surface.scrollTop}`;
    return before !== after;
  }, { dx, dy }).catch(() => false);
}

async function findActiveSurface(page: Page): Promise<Locator | null> {
  const surfaces = page.locator(ACTIVE_SURFACE_SELECTOR);
  const count = Math.min(await surfaces.count().catch(() => 0), 60);
  let best: { locator: Locator; score: number } | null = null;

  for (let index = 0; index < count; index++) {
    const locator = surfaces.nth(index);
    const visible = await locator.isVisible().catch(() => false);
    if (!visible) continue;
    const box = await locator.boundingBox({ timeout: 500 }).catch(() => null);
    if (!box || box.width < 4 || box.height < 4) continue;
    const score = await locator.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const x = Math.min(Math.max(rect.left + rect.width / 2, 0), Math.max(window.innerWidth - 1, 0));
      const y = Math.min(Math.max(rect.top + rect.height / 2, 0), Math.max(window.innerHeight - 1, 0));
      const hit = document.elementFromPoint(x, y);
      const topMost = Boolean(hit && (hit === el || el.contains(hit) || hit.contains(el)));
      const z = Number.parseInt(window.getComputedStyle(el).zIndex || "0", 10);
      const areaScore = Math.min((rect.width * rect.height) / 1000, 500);
      return (topMost ? 10_000 : 0) + (Number.isFinite(z) ? z : 0) + areaScore;
    }).catch(() => 0);
    if (!best || score > best.score) best = { locator, score };
  }

  if (best?.locator) return best.locator;

  const visualSelector = await page.evaluate(() => {
    const cleanSelector = (node: Element) => {
      if (node.id) return `#${CSS.escape(node.id)}`;
      const parts: string[] = [];
      let current: Element | null = node;
      while (current && current !== document.documentElement && parts.length < 8) {
        const parentEl: Element | null = current.parentElement;
        const tag = current.tagName.toLowerCase();
        if (!parentEl) {
          parts.unshift(tag);
          break;
        }
        const siblings = Array.from(parentEl.children).filter((child) => child.tagName === current!.tagName);
        const index = siblings.indexOf(current) + 1;
        parts.unshift(`${tag}:nth-of-type(${Math.max(index, 1)})`);
        current = parentEl;
      }
      return parts.join(" > ");
    };
    const visible = (el: Element, rect: DOMRect) => {
      const style = window.getComputedStyle(el);
      return rect.width > 8 && rect.height > 8 && style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0;
    };
    const alpha = (value: string) => {
      const rgba = value.match(/rgba?\(([^)]+)\)/i);
      if (!rgba) return value && value !== "transparent" ? 1 : 0;
      const parts = rgba[1].split(",").map((part) => part.trim());
      return parts.length >= 4 ? Number(parts[3]) || 0 : 1;
    };
    const viewportArea = Math.max(window.innerWidth * window.innerHeight, 1);
    let best: { selector: string; score: number } | null = null;
    for (const el of Array.from(document.querySelectorAll("body *"))) {
      const rect = el.getBoundingClientRect();
      if (!visible(el, rect)) continue;
      const style = window.getComputedStyle(el);
      const text = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      const area = rect.width * rect.height;
      if (area < viewportArea * 0.015 || area > viewportArea * 0.72) continue;
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      if (centerX < window.innerWidth * 0.15 || centerX > window.innerWidth * 0.85 || centerY < window.innerHeight * 0.1 || centerY > window.innerHeight * 0.92) continue;
      const z = Number.parseInt(style.zIndex || "0", 10);
      const bg = alpha(style.backgroundColor);
      const topHit = document.elementFromPoint(
        Math.min(Math.max(centerX, 0), Math.max(window.innerWidth - 1, 0)),
        Math.min(Math.max(centerY, 0), Math.max(window.innerHeight - 1, 0)),
      );
      const topMost = Boolean(topHit && (topHit === el || el.contains(topHit) || topHit.contains(el)));
      const elevated = style.position === "fixed" || style.position === "absolute" || (Number.isFinite(z) && z > 1) || style.boxShadow !== "none" || bg > 0.75;
      if (!topMost && !elevated) continue;
      const scrollable = style.overflow.includes("auto") || style.overflow.includes("scroll") || el.scrollHeight > el.clientHeight + 2;
      const score = (topMost ? 100 : 0) + (scrollable ? 40 : 0) + (Number.isFinite(z) ? Math.min(z, 50) : 0) + Math.min(area / viewportArea * 30, 30);
      if (!best || score > best.score) best = { selector: cleanSelector(el), score };
    }
    return best?.selector ?? "";
  }).catch(() => "");

  return visualSelector ? page.locator(visualSelector).first() : null;
}

async function elementByRef(runtime: BrowserRuntime, ref: string): Promise<SnapshotElement> {
  let element = runtime.refs.get(ref);
  if (element) return element;
  await captureSnapshot(runtime, `Refresh stale ref ${ref}`);
  element = runtime.refs.get(ref);
  if (!element) throw new Error(`No element with ref ${ref}. Call browser_snapshot and use a current ref.`);
  return element;
}

async function performRefAction(
  ctx: EngineContext,
  runtime: BrowserRuntime,
  element: SnapshotElement,
  method: BrowserMethod,
  options: { text?: string; key?: string; value?: string; reason?: string; clickCount?: number; instruction?: string },
  attempt: number,
): Promise<ActionOutcome> {
  const detail = actionDetail(method, element, options);
  const blocked = await guardRisk(ctx, `browser_${method}`, detail);
  if (blocked) {
    return {
      success: false,
      content: blocked,
      method,
      ref: element.ref,
      selector: element.selector,
      attempt,
    };
  }

  const page = runtime.page;
  const before = await pageSignature(page);
  const beforeVisual = await visualSignature(page).catch(() => "");
  const beforeState = `${before}|visual:${beforeVisual}`;
  const locator = resolveLocator(runtime, element);

  await humanDelay(page);
  if (method !== "press" && method !== "scroll" && method !== "back" && method !== "wait") {
    await scrollElementForAction(runtime, element, locator);
  }

  let fallbackUsed = false;
  let alreadySettled = false;
  if (method === "click") {
    const clickResult = await clickWithProgressFallback(page, locator, options.clickCount ?? 1, beforeState);
    fallbackUsed = clickResult.fallbackUsed;
    alreadySettled = true;
  } else if (method === "double_click") {
    await locator.dblclick({ timeout: 10_000 });
  } else if (method === "fill" || method === "type") {
    const text = options.text ?? options.value;
    if (text == null) throw new Error("No text was provided for fill/type action.");
    await fillLocator(page, locator, text, method === "type");
  } else if (method === "select") {
    const value = options.value ?? options.text;
    if (value == null) throw new Error("No value was provided for select action.");
    if (element.tag === "select") {
      await selectLocator(locator, value);
    } else if (isOptionLike(element) && optionMatches(element, value)) {
      await clickLocator(page, locator, 1);
    } else {
      await selectCustomOption(runtime, element, locator, value, options.instruction);
    }
  } else if (method === "hover") {
    await locator.hover({ timeout: 10_000 });
  } else if (method === "press") {
    await page.keyboard.press(options.key ?? "Enter");
  }

  if (!alreadySettled) await settlePage(page);
  const blockedReason = await detectBlockPage(page);
  if (blockedReason) {
    await savePageState(runtime, "blocked", { blockedReason });
  } else {
    await savePageState(runtime, "open", { blockedReason: undefined });
  }

  const after = await pageSignature(page);
  const afterVisual = await visualSignature(page).catch(() => "");
  const afterState = `${after}|visual:${afterVisual}`;
  const visualChanged = Boolean(beforeVisual && afterVisual && beforeVisual !== afterVisual);
  const noProgress = noteRecentAction(runtime, {
    signature: `${method}:${element.ref}:${options.instruction ?? options.reason ?? options.text ?? options.value ?? options.key ?? ""}`,
    before: beforeState,
    after: afterState,
  });
  const stateChanged = beforeState !== afterState;
  const actionSucceeded = !noProgress && (stateChanged || allowsNoStateChange(method));
  const actionScreenshot = visualChanged || !actionSucceeded || fallbackUsed
    ? await captureViewportScreenshot(runtime, `action-${method}`).catch(() => undefined)
    : undefined;
  const title = await page.title().catch(() => "");
  recordBrowserAction(runtime.sessionId, {
    timestamp: Date.now(),
    tool: `browser_${method}`,
    method,
    instruction: options.instruction,
    ref: element.ref,
    selector: element.selector,
    url: page.url(),
    title,
    success: actionSucceeded,
    selfHealed: fallbackUsed,
  });

  if (blockedReason) {
    return {
      success: false,
      content: `${blockedReason} Use official alternatives, fetch/search, or ask the user to take over.`,
      method,
      ref: element.ref,
      selector: element.selector,
      attempt,
      fallbackUsed,
    };
  }

  if (noProgress || !actionSucceeded) {
    return {
      success: false,
      content: noProgress
        ? "No progress detected after repeated identical browser action. Stop retrying this action; take a fresh snapshot, use another route, or ask the user for guidance."
        : "The browser action executed, but no page, URL, form, popup, selection, or interactive state change was detected. Treat this action as not completed and choose a more precise target.",
      method,
      ref: element.ref,
      selector: element.selector,
      attempt,
      noProgress: true,
      fallbackUsed,
      visualChanged,
      ...(actionScreenshot ? { screenshot: actionScreenshot } : {}),
    };
  }

  return {
    success: true,
    content: `Action ${method} completed.`,
    method,
    ref: element.ref,
    selector: element.selector,
    attempt,
    fallbackUsed,
    visualChanged,
    ...(actionScreenshot ? { screenshot: actionScreenshot } : {}),
  };
}

function allowsNoStateChange(method: BrowserMethod): boolean {
  return method === "hover" || method === "wait" || method === "scroll";
}

async function fillLocator(page: Page, locator: Locator, text: string, typeSlowly: boolean): Promise<void> {
  try {
    if (typeSlowly) {
      await locator.click({ timeout: 8_000 });
      await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
      await page.keyboard.type(text, { delay: 35 });
      return;
    }
    await locator.fill(text, { timeout: 8_000 });
  } catch {
    await locator.click({ timeout: 8_000 });
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.insertText(text);
  }
}

async function clickLocator(page: Page, locator: Locator, clickCount: number): Promise<void> {
  try {
    await locator.click({ timeout: 10_000, clickCount });
    return;
  } catch {
    try {
      await locator.click({ timeout: 5_000, clickCount, force: true });
      return;
    } catch {
      const box = await locator.boundingBox({ timeout: 3_000 }).catch(() => null);
      if (!box) throw new Error("Element could not be clicked and has no visible bounds.");
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { clickCount });
    }
  }
}

async function clickWithProgressFallback(
  page: Page,
  locator: Locator,
  clickCount: number,
  beforeState: string,
): Promise<{ fallbackUsed: boolean }> {
  await clickLocator(page, locator, clickCount);
  await settlePage(page);

  const afterLocatorClick = await browserStateKey(page);
  if (afterLocatorClick !== beforeState) return { fallbackUsed: false };

  const pointerFallback = await hardPointerClickLocator(page, locator, clickCount);
  if (pointerFallback) {
    await settlePage(page);
    const afterPointerClick = await browserStateKey(page);
    if (afterPointerClick !== beforeState) return { fallbackUsed: true };
  }

  const domFallback = await domClickLocator(locator);
  if (domFallback) {
    await settlePage(page);
    return { fallbackUsed: true };
  }

  return { fallbackUsed: pointerFallback };
}

async function browserStateKey(page: Page): Promise<string> {
  const signature = await pageSignature(page);
  const visual = await visualSignature(page).catch(() => "");
  return `${signature}|visual:${visual}`;
}

async function hardPointerClickLocator(
  page: Page,
  locator: Locator,
  clickCount: number,
): Promise<boolean> {
  const point = await locator.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    const x = Math.min(Math.max(rect.left + rect.width / 2, 1), Math.max(window.innerWidth - 2, 1));
    const y = Math.min(Math.max(rect.top + rect.height / 2, 1), Math.max(window.innerHeight - 2, 1));
    return { x, y };
  }).catch(() => null);

  if (!point) {
    const box = await locator.boundingBox({ timeout: 2_000 }).catch(() => null);
    if (!box) return false;
    await dispatchMouseClick(page, box.x + box.width / 2, box.y + box.height / 2, clickCount);
    return true;
  }

  await dispatchMouseClick(page, point.x, point.y, clickCount);
  return true;
}

async function domClickLocator(locator: Locator): Promise<boolean> {
  return locator.evaluate((el) => {
    const target = el as HTMLElement;
    if (typeof target.click === "function") {
      target.click();
      return true;
    }

    const rect = el.getBoundingClientRect();
    const eventInit = {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      view: window,
    };
    el.dispatchEvent(new PointerEvent("pointerdown", eventInit));
    el.dispatchEvent(new MouseEvent("mousedown", eventInit));
    el.dispatchEvent(new PointerEvent("pointerup", eventInit));
    el.dispatchEvent(new MouseEvent("mouseup", eventInit));
    el.dispatchEvent(new MouseEvent("click", eventInit));
    return true;
  }).catch(() => false);
}

async function dispatchMouseClick(
  page: Page,
  x: number,
  y: number,
  clickCount = 1,
): Promise<void> {
  const cdp = await page.context().newCDPSession(page).catch(() => null);
  if (!cdp) {
    await page.mouse.click(x, y, { clickCount });
    return;
  }

  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
  }).catch(() => undefined);

  for (let i = 0; i < clickCount; i++) {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: i + 1,
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: i + 1,
    });
  }
}

async function selectLocator(locator: Locator, value: string): Promise<void> {
  await locator.selectOption({ label: value }, { timeout: 8_000 }).catch(async () => {
    await locator.selectOption(value, { timeout: 8_000 });
  });
}

async function selectCustomOption(
  runtime: BrowserRuntime,
  element: SnapshotElement,
  locator: Locator,
  value: string,
  instruction?: string,
): Promise<void> {
  const page = runtime.page;
  await clickLocator(page, locator, 1).catch(async () => {
    await locator.focus({ timeout: 5_000 });
  });
  await page.waitForTimeout(250);

  const shouldType = isEditableLike(element) || /\b(search|type|enter|autocomplete|suggestion)\b/i.test(instruction ?? "");
  let typed = false;
  if (shouldType) {
    await fillLocator(page, locator, value, isSearchLike(element)).catch(async () => {
      await page.keyboard.type(value, { delay: 35 });
    });
    typed = true;
    await page.waitForTimeout(350);
  }
  await settlePage(page);

  let snapshot = await captureSnapshot(runtime, `Find dropdown option: ${value}`);
  let option = findOptionCandidate(snapshot.elements, value, element);
  if (!option && !typed) {
    await page.keyboard.type(value, { delay: 35 }).catch(() => undefined);
    await page.waitForTimeout(350);
    snapshot = await captureSnapshot(runtime, `Find dropdown option after type-ahead: ${value}`);
    option = findOptionCandidate(snapshot.elements, value, element);
  }

  if (!option) {
    throw new Error(`Dropdown/search option "${value}" was not visible after opening the control. Take a fresh snapshot, scroll the active popup, or ask the user if the option is not available.`);
  }

  const optionLocator = resolveLocator(runtime, option);
  await scrollElementForAction(runtime, option, optionLocator);
  await clickLocator(page, optionLocator, 1);
}

function isEditableLike(element: SnapshotElement): boolean {
  return (
    element.tag === "input" ||
    element.tag === "textarea" ||
    element.role === "textbox" ||
    element.role === "searchbox" ||
    element.role === "combobox" ||
    element.selector.includes("contenteditable")
  );
}

function isSearchLike(element: SnapshotElement): boolean {
  return (
    element.role === "searchbox" ||
    /\b(search|find|where|destination|city|location)\b/i.test(`${element.label} ${element.placeholder} ${element.text}`)
  );
}

function isOptionLike(element: SnapshotElement): boolean {
  return (
    element.role === "option" ||
    element.role === "menuitem" ||
    element.role === "listitem" ||
    element.tag === "li" ||
    Boolean(element.activePopup && ["button", "link", "tab"].includes(element.role))
  );
}

function optionMatches(element: SnapshotElement, value: string): boolean {
  const haystack = normalizeText(`${element.label} ${element.text} ${element.value ?? ""}`);
  const needle = normalizeText(value);
  return Boolean(needle && (haystack === needle || haystack.includes(needle) || needle.includes(haystack)));
}

function findOptionCandidate(
  elements: SnapshotElement[],
  value: string,
  source: SnapshotElement,
): SnapshotElement | undefined {
  const desired = normalizeText(value);
  const tokens = normalizeWords(value);
  let best: { element: SnapshotElement; score: number } | undefined;

  for (const element of elements) {
    if (!element.visible || !element.enabled || element.ref === source.ref) continue;
    const name = normalizeText(`${element.label} ${element.text} ${element.value ?? ""} ${element.placeholder}`);
    if (!name) continue;

    let score = 0;
    if (name === desired) score += 40;
    else if (name.startsWith(desired) || desired.startsWith(name)) score += 26;
    else if (name.includes(desired)) score += 22;

    for (const token of tokens) {
      if (name.includes(token)) score += token.length > 4 ? 5 : 3;
    }

    if (isOptionLike(element)) score += 16;
    if (element.activePopup) score += 14;
    if (element.inModal) score += 8;
    if (element.topMost) score += 6;
    if (element.zIndex) score += Math.min(element.zIndex, 20);
    if (isEditableLike(element)) score -= 10;

    if (!best || score > best.score) best = { element, score };
  }

  return best && best.score >= 18 ? best.element : undefined;
}

function actionDetail(method: BrowserMethod, element: SnapshotElement, options: { text?: string; value?: string; key?: string; reason?: string }): string {
  const name = element.label || element.text || element.placeholder || element.href || element.tag;
  return [
    `Method: ${method}`,
    `Ref: ${element.ref}`,
    `Element: ${name}`,
    options.text ? `Text: ${options.text}` : "",
    options.value ? `Value: ${options.value}` : "",
    options.key ? `Key: ${options.key}` : "",
    options.reason ? `Reason: ${options.reason}` : "",
  ].filter(Boolean).join("\n");
}

async function pageSignature(page: Page): Promise<string> {
  const title = await page.title().catch(() => "");
  const body = await page.locator("body").innerText({ timeout: 1_000 }).catch(() => "");
  const interactiveState = await page.evaluate(() => {
    const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
    const isVisible = (el: Element) => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 3 || rect.height < 3) return false;
      const style = window.getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
      return rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
    };
    const alpha = (value: string) => {
      const rgba = value.match(/rgba?\(([^)]+)\)/i);
      if (!rgba) return value && value !== "transparent" ? 1 : 0;
      const parts = rgba[1].split(",").map((part) => part.trim());
      return parts.length >= 4 ? Number(parts[3]) || 0 : 1;
    };
    const viewportArea = Math.max(window.innerWidth * window.innerHeight, 1);
    const nodes = Array.from(document.querySelectorAll([
      "input",
      "select",
      "textarea",
      "[aria-selected]",
      "[aria-checked]",
      "[aria-pressed]",
      "[aria-expanded]",
      "[role='dialog']",
      "[role='listbox']",
      "[role='option']",
      "[class*='selected' i]",
      "[class*='active' i]",
      "[class*='checked' i]",
      "[class*='open' i]",
    ].join(","))).slice(0, 100);
    const visualNodes = Array.from(document.querySelectorAll("body *"))
      .filter(isVisible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const area = rect.width * rect.height;
        const text = clean(el.textContent).slice(0, 160);
        const z = Number.parseInt(style.zIndex || "0", 10);
        const elevated =
          style.position === "fixed" ||
          style.position === "absolute" ||
          Number.isFinite(z) && z > 1 ||
          style.boxShadow !== "none" ||
          alpha(style.backgroundColor) > 0.2 && area > viewportArea * 0.04;
        return { el, rect, style, text, z, elevated, area };
      })
      .filter((item) => item.text && item.elevated)
      .sort((a, b) => {
        const az = Number.isFinite(a.z) ? a.z : 0;
        const bz = Number.isFinite(b.z) ? b.z : 0;
        return bz - az || b.area - a.area;
      })
      .slice(0, 40);

    const semantic = nodes.map((el) => {
      const inputValue = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement
        ? el.value
        : "";
      return [
        el.tagName.toLowerCase(),
        clean(el.getAttribute("role")),
        clean(el.getAttribute("aria-selected")),
        clean(el.getAttribute("aria-checked")),
        clean(el.getAttribute("aria-pressed")),
        clean(el.getAttribute("aria-expanded")),
        clean(inputValue),
        clean(el.className.toString()).slice(0, 80),
        clean(el.textContent).slice(0, 120),
      ].join(":");
    });
    const visual = visualNodes.map(({ el, rect, style, text, z }) => [
      el.tagName.toLowerCase(),
      style.position,
      Number.isFinite(z) ? String(z) : "0",
      Math.round(rect.x),
      Math.round(rect.y),
      Math.round(rect.width),
      Math.round(rect.height),
      clean(style.backgroundColor),
      text,
    ].join(":"));
    return [...semantic, ...visual].join("|");
  }).catch(() => "");
  const compactBody = body.replace(/\s+/g, " ");
  return `${page.url()}|${title}|${compactBody.slice(0, 1200)}|${compactBody.slice(-1200)}|${interactiveState}`;
}

async function visualSignature(page: Page): Promise<string> {
  const buffer = await page.screenshot({
    fullPage: false,
    type: "png",
    animations: "disabled",
    caret: "hide",
  });
  return createHash("sha1").update(buffer).digest("hex");
}

async function captureViewportScreenshot(
  runtime: BrowserRuntime,
  label: string,
): Promise<string> {
  const safeLabel = label.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase();
  const targetPath = resolve(
    browserScreenshotsDir(runtime.sessionId),
    `${safeLabel}-${Date.now()}.png`,
  );
  mkdirSync(dirname(targetPath), { recursive: true });
  await runtime.page.screenshot({
    path: targetPath,
    fullPage: false,
    animations: "disabled",
    caret: "hide",
  });
  runtime.proofScreenshots.push(targetPath);
  await savePageState(runtime, "open", { lastScreenshot: targetPath });
  bus.push({
    type: "artifact:add",
    agent: "Browser",
    message: `Browser viewport screenshot: ${targetPath}`,
    metadata: { artifact: targetPath, kind: "screenshot" },
  });
  return targetPath;
}

async function captureAnnotatedScreenshot(
  runtime: BrowserRuntime,
  label: string,
  elements: SnapshotElement[],
): Promise<string> {
  const annotations = elements
    .filter((element) => element.bounds && element.visible)
    .slice(0, 80)
    .map((element) => {
      const bounds = element.bounds!;
      const name = element.label || element.text || element.placeholder || element.href || element.tag;
      return {
        ref: element.ref,
        legacyId: element.legacyId,
        name: truncateField(name, 80),
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      };
    });

  await runtime.page.evaluate((items) => {
    document.querySelectorAll("[data-servus-annotation='true']").forEach((node) => node.remove());
    const root = document.createElement("div");
    root.setAttribute("data-servus-annotation", "true");
    Object.assign(root.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483647",
      pointerEvents: "none",
      fontFamily: "Arial, sans-serif",
      fontSize: "12px",
      lineHeight: "1",
    });

    for (const item of items) {
      const x = Math.max(0, Math.min(item.x, window.innerWidth - 1));
      const y = Math.max(0, Math.min(item.y, window.innerHeight - 1));
      const w = Math.max(4, Math.min(item.width, window.innerWidth - x));
      const h = Math.max(4, Math.min(item.height, window.innerHeight - y));

      const box = document.createElement("div");
      Object.assign(box.style, {
        position: "fixed",
        left: `${x}px`,
        top: `${y}px`,
        width: `${w}px`,
        height: `${h}px`,
        border: "2px solid #ff2d55",
        borderRadius: "4px",
        boxSizing: "border-box",
        background: "rgba(255, 45, 85, 0.05)",
      });

      const label = document.createElement("div");
      label.textContent = String(item.legacyId);
      label.title = `${item.ref} ${item.name}`;
      Object.assign(label.style, {
        position: "fixed",
        left: `${Math.max(0, Math.min(x, window.innerWidth - 34))}px`,
        top: `${Math.max(0, y - 16)}px`,
        minWidth: "18px",
        height: "16px",
        padding: "2px 4px",
        borderRadius: "4px",
        background: "#ff2d55",
        color: "#fff",
        fontWeight: "700",
        textAlign: "center",
        boxSizing: "border-box",
      });

      root.appendChild(box);
      root.appendChild(label);
    }

    document.documentElement.appendChild(root);
  }, annotations).catch(() => undefined);

  try {
    return await captureViewportScreenshot(runtime, label);
  } finally {
    await runtime.page.evaluate(() => {
      document.querySelectorAll("[data-servus-annotation='true']").forEach((node) => node.remove());
    }).catch(() => undefined);
  }
}

function modelOutputWithOptionalScreenshot(output: unknown): ToolResultOutput {
  const text = typeof output === "string"
    ? output
    : JSON.stringify(output ?? "");
  const screenshotPath = extractScreenshotPath(text);
  if (!screenshotPath) return { type: "text", value: text };

  try {
    const data = readFileSync(screenshotPath).toString("base64");
    return {
      type: "content",
      value: [
        { type: "text", text },
        { type: "image-data", data, mediaType: "image/png" },
      ],
    };
  } catch {
    return { type: "text", value: text };
  }
}

function extractScreenshotPath(text: string): string | undefined {
  const match = text.match(/\b(?:Screenshot(?: saved)?|Browser screenshot|Browser viewport screenshot):\s*(\/[^\n\r]+)/i);
  return match?.[1]?.trim();
}

function noteRecentAction(
  runtime: BrowserRuntime,
  action: { signature: string; before: string; after: string },
): boolean {
  runtime.recentActions.push(action);
  runtime.recentActions = runtime.recentActions.slice(-RECENT_ACTION_LIMIT);
  if (action.before !== action.after) return false;

  const recentSame = runtime.recentActions
    .slice(-4)
    .filter((item) => item.signature === action.signature && item.before === item.after);
  return recentSame.length >= 3;
}

async function runRefActionWithSelfHeal(
  ctx: EngineContext,
  runtime: BrowserRuntime,
  element: SnapshotElement,
  method: BrowserMethod,
  options: { text?: string; key?: string; value?: string; reason?: string; clickCount?: number; instruction?: string },
): Promise<ActionOutcome> {
  try {
    const first = await performRefAction(ctx, runtime, element, method, options, 1);
    if (!first.noProgress || !options.instruction) return first;

    const snapshot = await captureSnapshot(runtime, `Self-heal ${method} after no progress: ${options.instruction}`);
    const alternate = chooseAction(
      snapshot.elements,
      options.instruction,
      options.value ?? options.text,
      new Set([element.ref]),
    ).element;
    if (!alternate) return first;

    const second = await performRefAction(ctx, runtime, alternate, method, options, 2);
    second.selfHealed = true;
    second.content = `${second.content} Self-healed from no-progress ref ${element.ref} to ${alternate.ref}.`;
    return second;
  } catch (err: unknown) {
    const firstError = err instanceof Error ? err.message : String(err);
    const snapshot = await captureSnapshot(runtime, `Self-heal ${method} after failure: ${firstError}`);
    const healed = findSimilarElement(snapshot.elements, element);
    if (!healed) {
      recordBrowserAction(runtime.sessionId, {
        timestamp: Date.now(),
        tool: `browser_${method}`,
        method,
        ref: element.ref,
        selector: element.selector,
        url: runtime.page.url(),
        title: await runtime.page.title().catch(() => ""),
        success: false,
        error: firstError,
      });
      return {
        success: false,
        content: `Action failed and no similar element was found after refresh: ${firstError}`,
        method,
        ref: element.ref,
        selector: element.selector,
        attempt: 1,
      };
    }
    const outcome = await performRefAction(ctx, runtime, healed, method, options, 2);
    outcome.selfHealed = true;
    outcome.content = `${outcome.content} Self-healed from stale ref ${element.ref} to ${healed.ref}.`;
    return outcome;
  }
}

async function dragBetweenRefs(
  ctx: EngineContext,
  runtime: BrowserRuntime,
  source: SnapshotElement,
  target: SnapshotElement,
  instruction?: string,
): Promise<ActionOutcome> {
  const blocked = await guardRisk(
    ctx,
    "browser_drag_ref",
    `Drag ${source.ref} to ${target.ref}${instruction ? `\nInstruction: ${instruction}` : ""}`,
  );
  if (blocked) {
    return {
      success: false,
      content: blocked,
      method: "click",
      ref: source.ref,
      selector: source.selector,
      attempt: 1,
    };
  }
  const before = await browserStateKey(runtime.page);
  const sourceLocator = resolveLocator(runtime, source);
  const targetLocator = resolveLocator(runtime, target);
  await scrollElementForAction(runtime, source, sourceLocator);
  await scrollElementForAction(runtime, target, targetLocator);
  await sourceLocator.dragTo(targetLocator, { timeout: 12_000 });
  await settlePage(runtime.page);
  await savePageState(runtime, "open");
  const after = await browserStateKey(runtime.page);
  const success = before !== after;
  const screenshot = await captureViewportScreenshot(runtime, "drag-ref").catch(() => undefined);
  const title = await runtime.page.title().catch(() => "");
  recordBrowserAction(runtime.sessionId, {
    timestamp: Date.now(),
    tool: "browser_drag_ref",
    method: "drag",
    instruction,
    ref: source.ref,
    selector: `${source.selector} -> ${target.selector}`,
    url: runtime.page.url(),
    title,
    success,
  });
  return {
    success,
    content: success
      ? "Drag action completed and page state changed."
      : "Drag action completed, but no page or visual state change was detected.",
    method: "click",
    ref: source.ref,
    selector: `${source.selector} -> ${target.selector}`,
    attempt: 1,
    visualChanged: success,
    ...(screenshot ? { screenshot } : {}),
  };
}

async function uploadFileToRef(
  ctx: EngineContext,
  runtime: BrowserRuntime,
  element: SnapshotElement,
  filePath: string,
  instruction?: string,
): Promise<ActionOutcome> {
  const targetPath = isAbsolute(filePath) ? filePath : resolve(ctx.cwd, filePath);
  const blocked = await guardRisk(
    ctx,
    "browser_upload_ref",
    `Upload local file ${targetPath} to ${element.ref}${instruction ? `\nInstruction: ${instruction}` : ""}`,
  );
  if (blocked) {
    return {
      success: false,
      content: blocked,
      method: "click",
      ref: element.ref,
      selector: element.selector,
      attempt: 1,
    };
  }
  if (!existsSync(targetPath)) {
    return {
      success: false,
      content: `Upload file does not exist: ${targetPath}`,
      method: "click",
      ref: element.ref,
      selector: element.selector,
      attempt: 1,
    };
  }
  const before = await browserStateKey(runtime.page);
  const locator = resolveLocator(runtime, element);
  await locator.setInputFiles(targetPath, { timeout: 12_000 });
  await settlePage(runtime.page);
  await savePageState(runtime, "open");
  const after = await browserStateKey(runtime.page);
  const success = before !== after || element.tag === "input";
  const screenshot = await captureViewportScreenshot(runtime, "upload-ref").catch(() => undefined);
  const title = await runtime.page.title().catch(() => "");
  recordBrowserAction(runtime.sessionId, {
    timestamp: Date.now(),
    tool: "browser_upload_ref",
    method: "upload",
    instruction,
    ref: element.ref,
    selector: element.selector,
    url: runtime.page.url(),
    title,
    success,
  });
  return {
    success,
    content: success
      ? `Uploaded ${basename(targetPath)}.`
      : `Tried to upload ${basename(targetPath)}, but no state change was detected.`,
    method: "click",
    ref: element.ref,
    selector: element.selector,
    attempt: 1,
    visualChanged: success,
    ...(screenshot ? { screenshot } : {}),
  };
}

function findSimilarElement(elements: SnapshotElement[], target: SnapshotElement): SnapshotElement | undefined {
  const targetName = normalizeWords(`${target.label} ${target.text} ${target.placeholder} ${target.href}`);
  let best: { element: SnapshotElement; score: number } | undefined;
  for (const element of elements) {
    let score = 0;
    if (element.tag === target.tag) score += 2;
    if (element.role === target.role) score += 2;
    const name = normalizeWords(`${element.label} ${element.text} ${element.placeholder} ${element.href}`);
    for (const token of targetName) {
      if (name.includes(token)) score += 1;
    }
    if (!best || score > best.score) best = { element, score };
  }
  return best && best.score >= 3 ? best.element : undefined;
}

function chooseAction(
  elements: SnapshotElement[],
  instruction: string,
  value?: string,
  avoidRefs: Set<string> = new Set(),
): { method: BrowserMethod; element?: SnapshotElement; text?: string; value?: string; key?: string; error?: string } {
  const method = inferMethod(instruction);
  if (method === "scroll" || method === "back" || method === "wait") return { method };
  if (method === "press") return { method, key: extractKey(instruction) ?? "Enter" };

  const text = method === "fill" || method === "type" ? (value ?? extractFillText(instruction)) : undefined;
  const selectValue = method === "select" ? (value ?? extractSelectValue(instruction)) : undefined;
  if ((method === "fill" || method === "type") && !text) {
    return { method, error: "browser_act inferred a fill/type action, but no text value was provided or discoverable from the instruction." };
  }

  const targetTokens = normalizeWords(instruction)
    .filter((token) => !ACTION_STOP_WORDS.has(token) && (!text || !normalizeWords(text).includes(token)));
  let best: { element: SnapshotElement; score: number } | undefined;

  for (const element of elements) {
    if (!element.visible || !element.enabled) continue;
    if (avoidRefs.has(element.ref)) continue;
    const score = scoreElement(element, targetTokens, method, instruction, value);
    if (!best || score > best.score) best = { element, score };
  }

  if (!best || best.score < 2) {
    return { method, error: "No reliable target element found for browser_act. Take a fresh snapshot or specify a ref." };
  }

  return {
    method,
    element: best.element,
    ...(text ? { text } : {}),
    ...(selectValue ? { value: selectValue } : {}),
  };
}

const modelActionDecisionSchema = z.object({
  method: z.enum(["click", "double_click", "fill", "type", "press", "select", "hover", "scroll", "back", "wait", "drag", "upload"]),
  ref: z.string().optional().describe("A ref from the supplied snapshot. Required for element actions."),
  targetRef: z.string().optional().describe("Second ref for drag/drop actions."),
  text: z.string().optional().describe("Text to fill or type."),
  value: z.string().optional().describe("Option value/label to select or file path for upload."),
  key: z.string().optional().describe("Keyboard key for press."),
  twoStep: z.boolean().optional().describe("True when this action opens a popup/dropdown/search menu and needs a fresh snapshot after the first step."),
  confidence: z.enum(["low", "medium", "high"]),
  reason: z.string(),
});

type ModelActionDecision = z.infer<typeof modelActionDecisionSchema>;

async function chooseActionWithModel(
  ctx: EngineContext,
  snapshot: SnapshotResult,
  instruction: string,
  value?: string,
): Promise<{ method: BrowserActMethod; element?: SnapshotElement; target?: SnapshotElement; text?: string; value?: string; key?: string; twoStep?: boolean; reason?: string; source: "model" | "heuristic"; error?: string }> {
  const heuristic = chooseAction(snapshot.elements, instruction, value);
  if (snapshot.elements.length === 0) {
    return { ...heuristic, source: "heuristic" };
  }

  try {
    const resolved = resolveModel(ctx.model);
    const compactSnapshot = snapshotToText({
      ...snapshot,
      elements: snapshot.elements.slice(0, Math.min(snapshot.elements.length, 90)),
    });
    const response = await generateObject({
      model: resolved.model,
      schema: modelActionDecisionSchema,
      temperature: 0,
      prompt: [
        "You are Servus Browser Act selector. Pick exactly one browser action from the supplied snapshot.",
        "Use only refs that appear in the snapshot. Prefer active popup/modal/listbox refs over background refs.",
        "For dropdowns/search/autocomplete, choose the control first and set twoStep=true if the visible option is not already present.",
        "If the option is already visible, choose the option ref directly with method=click or select.",
        "Do not guess a ref when confidence is low.",
        "",
        `Instruction: ${instruction}`,
        value ? `Explicit value: ${value}` : "",
        "",
        compactSnapshot,
      ].filter(Boolean).join("\n"),
    });
    const decision = response.object as ModelActionDecision;
    if (decision.confidence === "low") {
      return { ...heuristic, source: "heuristic", error: heuristic.error };
    }

    const element = decision.ref ? snapshot.elements.find((item) => item.ref === decision.ref) : undefined;
    const target = decision.targetRef ? snapshot.elements.find((item) => item.ref === decision.targetRef) : undefined;
    if (!element && !["scroll", "back", "wait", "press"].includes(decision.method)) {
      return { ...heuristic, source: "heuristic", error: heuristic.error };
    }

    return {
      method: decision.method,
      ...(element ? { element } : {}),
      ...(target ? { target } : {}),
      ...(decision.text ? { text: decision.text } : heuristic.text ? { text: heuristic.text } : {}),
      ...(decision.value ? { value: decision.value } : heuristic.value ? { value: heuristic.value } : value ? { value } : {}),
      ...(decision.key ? { key: decision.key } : heuristic.key ? { key: heuristic.key } : {}),
      twoStep: decision.twoStep,
      reason: decision.reason,
      source: "model",
    };
  } catch (err: unknown) {
    bus.push({
      type: "tool:finish",
      agent: "Browser",
      message: `browser_act model selector fallback: ${err instanceof Error ? err.message : String(err)}`,
      metadata: { tool: "browser_act.selector" },
    });
    return { ...heuristic, source: "heuristic", error: heuristic.error };
  }
}

const observeDecisionSchema = z.object({
  observations: z.array(z.object({
    ref: z.string(),
    description: z.string(),
    method: z.string().optional(),
    arguments: z.array(z.string()).optional(),
    confidence: z.enum(["low", "medium", "high"]),
  })).max(12),
});

async function modelObserve(
  ctx: EngineContext,
  snapshot: SnapshotResult,
  instruction: string,
): Promise<string | undefined> {
  if (!instruction.trim() || snapshot.elements.length === 0) return undefined;
  try {
    const resolved = resolveModel(ctx.model);
    const response = await generateObject({
      model: resolved.model,
      schema: observeDecisionSchema,
      temperature: 0,
      prompt: [
        "You are Servus Browser Observe. Return the most relevant actionable refs for the instruction.",
        "Use only refs from the snapshot. Prefer visible active modal/dropdown/listbox elements.",
        "",
        `Instruction: ${instruction}`,
        "",
        snapshotToText({ ...snapshot, elements: snapshot.elements.slice(0, 100) }),
      ].join("\n"),
    });
    const observations = response.object.observations
      .filter((item) => snapshot.elements.some((element) => element.ref === item.ref))
      .filter((item) => item.confidence !== "low");
    if (!observations.length) return undefined;
    return [
      "Model-ranked actions:",
      ...observations.map((item, index) => {
        const args = item.arguments?.length ? ` args=${JSON.stringify(item.arguments)}` : "";
        return `${index + 1}. ${item.ref}${item.method ? ` method=${item.method}` : ""}${args} - ${item.description} (${item.confidence})`;
      }),
    ].join("\n");
  } catch {
    return undefined;
  }
}

const browserAgentStepSchema = z.object({
  status: z.enum(["act", "done", "extract", "need_input"]),
  instruction: z.string().optional().describe("One atomic browser action when status=act."),
  value: z.string().optional().describe("Optional value for the action."),
  question: z.string().optional().describe("One clear user question when status=need_input."),
  reason: z.string(),
});

async function runBrowserAgentSubtask(
  ctx: EngineContext,
  runtime: BrowserRuntime,
  instruction: string,
  maxSteps: number,
): Promise<string> {
  const lines: string[] = [`Browser agent subtask: ${instruction}`];
  for (let step = 1; step <= maxSteps; step++) {
    const snapshot = await captureSnapshot(runtime, `${instruction} (agent step ${step})`, 90);
    if (snapshot.blockedReason) {
      const screenshot = await captureViewportScreenshot(runtime, `browser-agent-blocked-${step}`).catch(() => undefined);
      return [
        ...lines,
        `Blocked: ${snapshot.blockedReason}`,
        screenshot ? `Screenshot: ${screenshot}` : "",
      ].filter(Boolean).join("\n");
    }

    let decision: z.infer<typeof browserAgentStepSchema>;
    try {
      const resolved = resolveModel(ctx.model);
      const response = await generateObject({
        model: resolved.model,
        schema: browserAgentStepSchema,
        temperature: 0,
        prompt: [
          "You are the Servus Browser Agent controller.",
          "Given the user's browser subtask and current snapshot, choose exactly one next step.",
          "Use status=done only when the current page already proves the subtask is complete.",
          "Use status=need_input only when user data/choice is truly required.",
          "Use status=act with one atomic action otherwise. Prefer dropdown/modal/listbox active surface controls.",
          "",
          `Subtask: ${instruction}`,
          "",
          snapshotToText(snapshot),
        ].join("\n"),
      });
      decision = response.object;
    } catch (err: unknown) {
      return [
        ...lines,
        `Controller model failed: ${err instanceof Error ? err.message : String(err)}`,
        snapshotToText(snapshot).slice(0, 4_000),
      ].join("\n");
    }

    lines.push(`Step ${step}: ${decision.status} - ${decision.reason}`);
    if (decision.status === "done") {
      const screenshot = await captureViewportScreenshot(runtime, `browser-agent-done-${step}`).catch(() => undefined);
      lines.push(`URL: ${runtime.page.url()}`);
      if (screenshot) lines.push(`Screenshot: ${screenshot}`);
      return lines.join("\n");
    }
    if (decision.status === "need_input") {
      lines.push(`Needs input: ${decision.question ?? "More information is required."}`);
      return lines.join("\n");
    }
    if (decision.status === "extract") {
      const text = await runtime.page.locator("body").innerText({ timeout: 5_000 }).catch(async () => runtime.page.content());
      lines.push(clamp(text, 8_000));
      return lines.join("\n");
    }

    const actionInstruction = decision.instruction ?? instruction;
    const cached = await tryCachedAction(ctx, runtime, actionInstruction, decision.value);
    if (cached) {
      lines.push(formatOutcome(runtime, cached));
      continue;
    }

    const actionSnapshot = await captureSnapshot(runtime, actionInstruction, 100);
    const action = await chooseActionWithModel(ctx, actionSnapshot, actionInstruction, decision.value);
    if (!action.element) {
      lines.push(`Unable to select action target: ${action.error ?? "no element"}`);
      return lines.join("\n");
    }
    if (action.method === "drag" || action.method === "upload") {
      lines.push(`Action ${action.method} requires explicit refs; use browser_drag_ref or browser_upload_ref.`);
      return lines.join("\n");
    }
    const outcome = await runRefActionWithSelfHeal(ctx, runtime, action.element, action.method, {
      text: action.text,
      value: action.value,
      key: action.key,
      instruction: actionInstruction,
    });
    lines.push(formatOutcome(runtime, outcome));
    if (outcome.success) {
      cacheSuccessfulAction(runtime, actionInstruction, action.element, action.method, {
        text: action.text,
        value: action.value,
        key: action.key,
      });
    }
    if (!outcome.success || outcome.noProgress) return lines.join("\n");
  }
  lines.push(`Stopped after ${maxSteps} step(s). Take browser_snapshot and continue with a smaller action.`);
  return lines.join("\n");
}

function cacheFilePath(sessionId: string): string {
  return join(browserSessionDir(sessionId), "action-cache.json");
}

function loadActionCache(sessionId: string): CachedBrowserAction[] {
  const path = cacheFilePath(sessionId);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as CachedBrowserAction[];
    return Array.isArray(parsed) ? parsed.slice(-MAX_ACTION_CACHE_ENTRIES) : [];
  } catch {
    return [];
  }
}

function saveActionCache(sessionId: string, entries: CachedBrowserAction[]): void {
  const path = cacheFilePath(sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(entries.slice(-MAX_ACTION_CACHE_ENTRIES), null, 2) + "\n");
}

function instructionCacheKey(instruction: string, value?: string): string {
  return normalizeText(`${instruction} ${value ?? ""}`).slice(0, 300);
}

function urlCacheKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split(/[?#]/)[0] ?? url;
  }
}

function cacheSuccessfulAction(
  runtime: BrowserRuntime,
  instruction: string,
  element: SnapshotElement,
  method: BrowserMethod,
  options: { text?: string; value?: string; key?: string },
): void {
  if (!["click", "double_click", "fill", "type", "select", "hover", "press"].includes(method)) return;
  const instructionKey = instructionCacheKey(instruction, options.value ?? options.text);
  if (!instructionKey) return;
  const urlKey = urlCacheKey(runtime.page.url());
  const cache = loadActionCache(runtime.sessionId)
    .filter((entry) => !(entry.instructionKey === instructionKey && entry.urlKey === urlKey));
  cache.push({
    id: createHash("sha1").update(`${urlKey}|${instructionKey}|${element.selector}`).digest("hex").slice(0, 16),
    instructionKey,
    urlKey,
    createdAt: Date.now(),
    hits: 0,
    method,
    locatorQuery: element.locatorQuery,
    selector: element.selector,
    name: element.label || element.text || element.placeholder || element.href || element.tag,
    ...(options.text ? { text: options.text } : {}),
    ...(options.value ? { value: options.value } : {}),
    ...(options.key ? { key: options.key } : {}),
  });
  saveActionCache(runtime.sessionId, cache);
}

async function tryCachedAction(
  ctx: EngineContext,
  runtime: BrowserRuntime,
  instruction: string,
  value?: string,
): Promise<ActionOutcome | undefined> {
  const instructionKey = instructionCacheKey(instruction, value);
  const urlKey = urlCacheKey(runtime.page.url());
  const cache = loadActionCache(runtime.sessionId);
  const entry = [...cache].reverse().find((candidate) =>
    candidate.urlKey === urlKey &&
    (candidate.instructionKey === instructionKey || instructionKey.includes(candidate.instructionKey) || candidate.instructionKey.includes(instructionKey)),
  );
  if (!entry) return undefined;

  const element: SnapshotElement = {
    ref: `cached_${entry.id}`,
    legacyId: 0,
    tag: "cached",
    role: "",
    type: "",
    text: entry.name,
    label: entry.name,
    placeholder: "",
    href: "",
    selector: entry.selector,
    visible: true,
    enabled: true,
    locatorQuery: entry.locatorQuery,
  };
  const outcome = await performRefAction(ctx, runtime, element, entry.method, {
    text: value ?? entry.text,
    value: value ?? entry.value,
    key: entry.key,
    instruction,
  }, 1).catch(() => undefined);
  if (!outcome?.success) return undefined;
  const updated = cache.map((candidate) =>
    candidate.id === entry.id
      ? { ...candidate, hits: candidate.hits + 1, lastUsedAt: Date.now() }
      : candidate,
  );
  saveActionCache(runtime.sessionId, updated);
  return {
    ...outcome,
    content: `${outcome.content} Replayed cached browser action ${entry.id}.`,
  };
}

const ACTION_STOP_WORDS = new Set([
  "click",
  "double",
  "tap",
  "press",
  "fill",
  "type",
  "enter",
  "write",
  "select",
  "choose",
  "open",
  "go",
  "the",
  "a",
  "an",
  "button",
  "link",
  "field",
  "input",
  "dropdown",
  "combobox",
  "listbox",
  "autocomplete",
  "suggestion",
  "option",
  "menu",
  "with",
  "into",
  "in",
  "on",
  "for",
  "to",
]);

function inferMethod(instruction: string): BrowserMethod {
  const lower = instruction.toLowerCase();
  if (/\b(double[-\s]?click|dblclick)\b/.test(lower)) return "double_click";
  if (
    /\b(dropdown|combobox|select menu|option|listbox|autocomplete|suggestion)\b/.test(lower) &&
    /\b(select|choose|pick|search|type|enter|fill|set)\b/.test(lower)
  ) return "select";
  if (/\b(fill|type|enter|write|search for|input)\b/.test(lower)) return /\btype\b/.test(lower) ? "type" : "fill";
  if (/\bselect\b|\b(choose).*\b(dropdown|option|from)\b|\bdropdown\b/.test(lower)) return "select";
  if (/\bhover|mouseover\b/.test(lower)) return "hover";
  if (/\bscroll\b/.test(lower)) return "scroll";
  if (/\bgo back|back\b/.test(lower)) return "back";
  if (/\bpress\b/.test(lower)) return "press";
  return "click";
}

function extractFillText(instruction: string): string | undefined {
  const quoted = extractQuoted(instruction);
  if (quoted) return quoted;
  const withValue = instruction.match(/\b(?:fill|type|enter|write)\s+.+?\s+with\s+(.+)$/i);
  if (withValue?.[1]) return withValue[1].trim();
  const search = instruction.match(/\bsearch(?:\s+for)?\s+(.+)$/i);
  if (search?.[1]) return search[1].trim();
  const fill = instruction.match(/\b(?:fill|type|enter|write)\s+(.+?)\s+(?:in|into|on)\b/i);
  return fill?.[1]?.trim();
}

function extractQuoted(instruction: string): string | undefined {
  const match = instruction.match(/["'“”](.+?)["'“”]/);
  return match?.[1]?.trim();
}

function extractSelectValue(instruction: string): string | undefined {
  const quoted = extractQuoted(instruction);
  if (quoted) return quoted;
  const choose = instruction.match(/\b(?:select|choose|pick|set)\s+(.+?)(?:\s+(?:from|in|on|for)\b|$)/i);
  if (choose?.[1]) return choose[1].trim();
  const search = instruction.match(/\b(?:search|type|enter|fill)\s+(.+?)(?:\s+(?:in|into|on|from)\b|$)/i);
  return search?.[1]?.trim();
}

function extractKey(instruction: string): string | undefined {
  const match = instruction.match(/\bpress\s+([A-Za-z0-9+_-]+)\b/i);
  return match?.[1];
}

function scoreElement(
  element: SnapshotElement,
  tokens: string[],
  method: BrowserMethod,
  instruction = "",
  value?: string,
): number {
  const haystack = normalizeWords(`${element.label} ${element.text} ${element.placeholder} ${element.href} ${element.role} ${element.type}`);
  const haystackText = normalizeText(`${element.label} ${element.text} ${element.placeholder} ${element.href} ${element.value ?? ""}`);
  const hints = buildTextTargetHints(`${instruction} ${value ?? ""}`);
  let score = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) score += token.length > 4 ? 3 : 2;
  }
  for (const phrase of hints.phrases) {
    if (phrase && haystackText.includes(phrase)) score += phrase.includes(" ") ? 22 : 12;
  }
  for (const token of hints.tokens) {
    if (haystack.includes(token)) score += token.length > 4 ? 4 : 3;
  }
  if ((method === "fill" || method === "type") && ["input", "textarea"].includes(element.tag)) score += 5;
  if ((method === "fill" || method === "type") && element.role === "textbox") score += 4;
  if (method === "select" && element.tag === "select") score += 6;
  if (method === "select" && ["combobox", "listbox"].includes(element.role)) score += 6;
  if (method === "select" && isOptionLike(element)) score += 5;
  if (method === "click" && ["button", "link", "tab", "menuitem"].includes(element.role)) score += 3;
  if (element.activePopup) score += 8;
  if (element.topMost) score += 4;
  if (element.inModal) score += 4;
  if (element.inModal && /\b(close|dismiss|accept|allow|continue|ok|yes|no|cancel|done)\b/i.test(`${element.label} ${element.text}`)) score += 5;
  if (method === "click" && /\b(slot|showtime|time|seat|date)\b/i.test(instruction) && /\b\d{1,2}\s+\d{2}\s+(am|pm)\b/i.test(haystackText)) score += 20;
  if (method === "click" && /\b(slot|showtime|time)\b/i.test(instruction) && !/\b\d{1,2}\s+\d{2}\s+(am|pm)\b/i.test(haystackText) && ["link", "tab"].includes(element.role)) score -= 8;
  if ((element.text.length > 140 || element.label.length > 140) && method === "click") score -= 5;
  if (method === "hover" && element.visible) score += 1;
  if (/\bsearch\b/i.test(`${element.label} ${element.placeholder} ${element.text}`)) score += 2;
  return score;
}

function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1);
}

function normalizeText(text: string): string {
  return normalizeWords(text).join(" ");
}

function buildTextTargetHints(instruction: string): { phrases: string[]; tokens: string[] } {
  const phrases = new Set<string>();
  for (const match of instruction.matchAll(/\b\d{1,2}\s*:\s*\d{2}\s*(?:am|pm)\b/gi)) {
    phrases.add(normalizeText(match[0]));
  }
  for (const match of instruction.matchAll(/\b\d{1,2}\s*(?:am|pm)\b/gi)) {
    phrases.add(normalizeText(match[0]));
  }
  for (const match of instruction.matchAll(/\b(?:imax|4dx|3d|2d|screenx|dolby|laser|vip|premium|standard|economy|business|first class|showtime|slot)\b/gi)) {
    phrases.add(normalizeText(match[0]));
  }
  const quoted = extractQuoted(instruction);
  if (quoted) phrases.add(normalizeText(quoted));

  const tokens = normalizeWords(instruction)
    .filter((token) => !ACTION_STOP_WORDS.has(token))
    .filter((token) => token.length > 2 || /^\d+$/.test(token))
    .filter((token) => !/^(visible|current|page|under|after|before|from|this|that|with|user|servus)$/.test(token));

  return {
    phrases: Array.from(phrases).filter(Boolean),
    tokens: Array.from(new Set(tokens)).slice(0, 18),
  };
}

function formatOutcome(runtime: BrowserRuntime, outcome: ActionOutcome): string {
  const parts = [
    outcome.content,
    `URL: ${runtime.page.url()}`,
    outcome.ref ? `Ref: ${outcome.ref}` : "",
    outcome.selector ? `Selector: ${outcome.selector}` : "",
    `Method: ${outcome.method}`,
    `Attempt: ${outcome.attempt}`,
    outcome.selfHealed ? "Self-healed: true" : "",
    outcome.fallbackUsed ? "Fallback action: coordinate/dom click" : "",
    outcome.noProgress ? "No-progress guard: true" : "",
    outcome.visualChanged ? "Visual change detected: true" : "",
    outcome.screenshot ? `Screenshot: ${outcome.screenshot}` : "",
  ].filter(Boolean);
  return parts.join("\n");
}

async function withToolEvents<T>(
  toolName: string,
  preview: string,
  work: () => Promise<T>,
): Promise<T> {
  bus.push({ type: "tool:start", agent: "Browser", message: preview, metadata: { tool: toolName } });
  try {
    const result = await work();
    bus.push({ type: "tool:finish", agent: "Browser", message: `${toolName} finished`, metadata: { tool: toolName } });
    return result;
  } catch (err: unknown) {
    bus.push({
      type: "tool:finish",
      agent: "Browser",
      message: `${toolName} failed: ${err instanceof Error ? err.message : String(err)}`,
      metadata: { tool: toolName },
    });
    throw err;
  }
}

export function createPlaywrightTools(ctx: EngineContext) {
  const sessionId = normalizeBrowserSessionId(ctx.sessionId);

  return {
    _cleanup: async () => {
      await closeBrowser(sessionId);
    },
    _getProofScreenshots: () => runtimes.get(sessionId)?.proofScreenshots ?? [],

    browser_navigate: tool({
      description: "Navigate the persistent browser session to a URL.",
      inputSchema: z.object({
        url: z.string().describe("URL to open. If no protocol is provided, https:// is used."),
      }),
      execute: async ({ url }) => withToolEvents("browser_navigate", `Navigate to ${url}`, async () => {
        const runtime = await getRuntime(ctx);
        const targetUrl = normalizeUrl(url);
        await runtime.page.goto(targetUrl, { waitUntil: "domcontentloaded" });
        await settlePage(runtime.page);
        await savePageState(runtime, "open");
        return `Navigated to ${runtime.page.url()}`;
      }).catch((err: unknown) => `Error navigating: ${err instanceof Error ? err.message : String(err)}`),
    }),

    browser_current_state: tool({
      description: "Return current browser session state, URL, title, block status, and latest artifacts.",
      inputSchema: z.object({}),
      execute: async () => withToolEvents("browser_current_state", "Read browser state", async () => {
        const runtime = await getRuntime(ctx);
        await savePageState(runtime, "open");
        const session = loadBrowserSessionState(sessionId);
        return [
          `Session: ${session.sessionId}`,
          `Status: ${session.status}`,
          `URL: ${session.url}`,
          `Title: ${session.title}`,
          session.blockedReason ? `Blocked: ${session.blockedReason}` : "",
          session.lastSnapshot ? `Last snapshot: ${session.lastSnapshot}` : "",
          session.lastScreenshot ? `Last screenshot: ${session.lastScreenshot}` : "",
          `Actions: ${session.actionHistory.length}`,
          `Failed actions: ${session.failedActionHistory.length}`,
        ].filter(Boolean).join("\n");
      }).catch((err: unknown) => `Error reading browser state: ${err instanceof Error ? err.message : String(err)}`),
    }),

    browser_snapshot: tool({
      description: "Capture a compact hybrid page snapshot with stable action refs, useful DOM metadata, iframe awareness, and selectors. Set includeScreenshot when the visible UI may not match DOM text.",
      inputSchema: z.object({
        instruction: z.string().optional().describe("Optional goal for the snapshot."),
        maxElements: z.number().int().positive().max(200).optional(),
        includeScreenshot: z.boolean().optional().describe("Attach the current viewport image to the model-visible tool result."),
      }),
      execute: async ({ instruction, maxElements, includeScreenshot }) => withToolEvents("browser_snapshot", instruction ?? "Capture browser snapshot", async () => {
        const runtime = await getRuntime(ctx);
        const snapshot = await captureSnapshot(runtime, instruction, maxElements ?? MAX_SNAPSHOT_ELEMENTS);
        const text = snapshotToText(snapshot);
        if (!includeScreenshot) return text;
        const screenshot = await captureAnnotatedScreenshot(runtime, "snapshot-annotated", snapshot.elements);
        return `${text}\nScreenshot: ${screenshot}\nThe screenshot is annotated with the numeric IDs shown in the ref list. Use browser_click_at when a visible control is missing from the text refs.`;
      }).catch((err: unknown) => `Error capturing browser snapshot: ${err instanceof Error ? err.message : String(err)}`),
      toModelOutput: ({ output }) => modelOutputWithOptionalScreenshot(output),
    }),

    browser_observe: tool({
      description: "Servus observe. Captures the page and returns model-ranked actionable refs plus visible interactive elements.",
      inputSchema: z.object({
        instruction: z.string().optional().describe("Optional goal for the observation."),
      }),
      execute: async ({ instruction }) => withToolEvents("browser_observe", instruction ?? "Observe page", async () => {
        const runtime = await getRuntime(ctx);
        const snapshot = await captureSnapshot(runtime, instruction);
        const ranked = instruction ? await modelObserve(ctx, snapshot, instruction) : undefined;
        return [
          ranked,
          snapshotToText(snapshot, true),
        ].filter(Boolean).join("\n\n");
      }).catch((err: unknown) => `Error observing page: ${err instanceof Error ? err.message : String(err)}`),
    }),

    browser_act: tool({
      description: "Perform one natural-language atomic browser action. Internally snapshots, selects a stable ref, executes deterministically, and self-heals once if stale.",
      inputSchema: z.object({
        instruction: z.string().describe("Atomic action, e.g. click Search, fill email with user@example.com, select Economy."),
        value: z.string().optional().describe("Optional explicit text/select value for fill/select actions."),
        useCache: z.boolean().optional().describe("Replay a successful cached action when available. Defaults true."),
      }),
      execute: async ({ instruction, value, useCache }) => withToolEvents("browser_act", instruction, async () => {
        const runtime = await getRuntime(ctx);
        if (useCache !== false) {
          const cached = await tryCachedAction(ctx, runtime, instruction, value);
          if (cached) return `${formatOutcome(runtime, cached)}\nCached: true`;
        }
        const snapshot = await captureSnapshot(runtime, instruction);
        const decision = await chooseActionWithModel(ctx, snapshot, instruction, value);
        if (decision.error || !decision.element) {
          if (decision.method === "scroll") {
            const direction = /left/i.test(instruction)
              ? "left"
              : /right/i.test(instruction)
                ? "right"
                : /up/i.test(instruction)
                  ? "up"
                  : "down";
            const result = await scrollBrowserSurface(runtime, direction);
            await settlePage(runtime.page);
            return `${result}\nURL: ${runtime.page.url()}`;
          }
          if (decision.method === "back") {
            await runtime.page.goBack({ waitUntil: "domcontentloaded" }).catch(() => undefined);
            await settlePage(runtime.page);
            return `Went back.\nURL: ${runtime.page.url()}`;
          }
          if (decision.method === "wait") {
            await runtime.page.waitForTimeout(1_000);
            return `Waited.\nURL: ${runtime.page.url()}`;
          }
          return `Unable to act safely: ${decision.error ?? "No target element selected."}\nTake browser_snapshot and use a ref-specific tool.`;
        }

        if (decision.method === "drag") {
          if (!decision.target) return "Unable to drag safely: no target ref selected. Use browser_drag_ref with explicit source and target refs.";
          const outcome = await dragBetweenRefs(ctx, runtime, decision.element, decision.target, instruction);
          return formatOutcome(runtime, outcome);
        }

        if (decision.method === "upload") {
          const filePath = decision.value ?? decision.text ?? value;
          if (!filePath) return "Unable to upload safely: no file path was provided.";
          const outcome = await uploadFileToRef(ctx, runtime, decision.element, filePath, instruction);
          return formatOutcome(runtime, outcome);
        }

        const outcome = await runRefActionWithSelfHeal(ctx, runtime, decision.element, decision.method, {
          text: decision.text,
          value: decision.value,
          key: decision.key,
          instruction,
        });
        if (outcome.success) {
          cacheSuccessfulAction(runtime, instruction, decision.element, decision.method, {
            text: decision.text,
            value: decision.value,
            key: decision.key,
          });
        }
        if (outcome.success && decision.twoStep) {
          const fresh = await captureSnapshot(runtime, `Second step after ${instruction}`);
          const nextValue = decision.value ?? decision.text ?? value;
          if (nextValue) {
            const option = findOptionCandidate(fresh.elements, nextValue, decision.element);
            if (option) {
              const second = await runRefActionWithSelfHeal(ctx, runtime, option, "click", {
                instruction: `Click visible option ${nextValue} after opening control for: ${instruction}`,
              });
              return `${formatOutcome(runtime, outcome)}\n\nSecond step:\n${formatOutcome(runtime, second)}`;
            }
          }
        }
        return formatOutcome(runtime, outcome);
      }).catch((err: unknown) => `Error in browser_act: ${err instanceof Error ? err.message : String(err)}`),
      toModelOutput: ({ output }) => modelOutputWithOptionalScreenshot(output),
    }),

    browser_agent: tool({
      description: "Run a bounded Servus mini browser controller for a high-level browser subtask. It plans one atomic action at a time, captures snapshots between actions, and stops on blockers or completion.",
      inputSchema: z.object({
        instruction: z.string().describe("High-level browser subtask, e.g. choose 2D format from the open modal or find evening showtimes."),
        maxSteps: z.number().int().positive().max(8).optional(),
      }),
      execute: async ({ instruction, maxSteps }) => withToolEvents("browser_agent", instruction, async () => {
        const runtime = await getRuntime(ctx);
        return runBrowserAgentSubtask(ctx, runtime, instruction, maxSteps ?? 4);
      }).catch((err: unknown) => `Error in browser_agent: ${err instanceof Error ? err.message : String(err)}`),
      toModelOutput: ({ output }) => modelOutputWithOptionalScreenshot(output),
    }),

    browser_click_ref: tool({
      description: "Click a stable ref from browser_snapshot. Self-heals once if the element went stale.",
      inputSchema: z.object({
        ref: z.string().describe("Stable ref from browser_snapshot."),
        reason: z.string().optional().describe("Why this click is needed."),
        clickCount: z.number().int().positive().max(2).optional(),
      }),
      execute: async ({ ref, reason, clickCount }) => withToolEvents("browser_click_ref", `Click ${ref}`, async () => {
        const runtime = await getRuntime(ctx);
        const element = await elementByRef(runtime, ref);
        const outcome = await runRefActionWithSelfHeal(ctx, runtime, element, clickCount === 2 ? "double_click" : "click", {
          reason,
          instruction: reason,
          clickCount,
        });
        return formatOutcome(runtime, outcome);
      }).catch((err: unknown) => `Error clicking ref ${ref}: ${err instanceof Error ? err.message : String(err)}`),
      toModelOutput: ({ output }) => modelOutputWithOptionalScreenshot(output),
    }),

    browser_fill_ref: tool({
      description: "Fill or type text into a stable input ref from browser_snapshot.",
      inputSchema: z.object({
        ref: z.string().describe("Stable ref from browser_snapshot."),
        text: z.string().describe("Text to enter."),
        typeSlowly: z.boolean().optional().describe("Use slower keyboard typing instead of direct fill."),
      }),
      execute: async ({ ref, text, typeSlowly }) => withToolEvents("browser_fill_ref", `Fill ${ref}`, async () => {
        const runtime = await getRuntime(ctx);
        const element = await elementByRef(runtime, ref);
        const outcome = await runRefActionWithSelfHeal(ctx, runtime, element, typeSlowly ? "type" : "fill", {
          text,
        });
        return formatOutcome(runtime, outcome);
      }).catch((err: unknown) => `Error filling ref ${ref}: ${err instanceof Error ? err.message : String(err)}`),
      toModelOutput: ({ output }) => modelOutputWithOptionalScreenshot(output),
    }),

    browser_select_ref: tool({
      description: "Select an option in a stable select/dropdown ref from browser_snapshot.",
      inputSchema: z.object({
        ref: z.string().describe("Stable ref from browser_snapshot."),
        value: z.string().describe("Visible label or value to select."),
      }),
      execute: async ({ ref, value }) => withToolEvents("browser_select_ref", `Select ${value} in ${ref}`, async () => {
        const runtime = await getRuntime(ctx);
        const element = await elementByRef(runtime, ref);
        const outcome = await runRefActionWithSelfHeal(ctx, runtime, element, "select", { value });
        return formatOutcome(runtime, outcome);
      }).catch((err: unknown) => `Error selecting ref ${ref}: ${err instanceof Error ? err.message : String(err)}`),
      toModelOutput: ({ output }) => modelOutputWithOptionalScreenshot(output),
    }),

    browser_hover_ref: tool({
      description: "Hover a stable ref from browser_snapshot.",
      inputSchema: z.object({
        ref: z.string().describe("Stable ref from browser_snapshot."),
      }),
      execute: async ({ ref }) => withToolEvents("browser_hover_ref", `Hover ${ref}`, async () => {
        const runtime = await getRuntime(ctx);
        const element = await elementByRef(runtime, ref);
        const outcome = await runRefActionWithSelfHeal(ctx, runtime, element, "hover", {});
        return formatOutcome(runtime, outcome);
      }).catch((err: unknown) => `Error hovering ref ${ref}: ${err instanceof Error ? err.message : String(err)}`),
      toModelOutput: ({ output }) => modelOutputWithOptionalScreenshot(output),
    }),

    browser_drag_ref: tool({
      description: "Drag one stable ref onto another stable ref. Use for sliders, drag-and-drop upload zones, sortable lists, and canvas-like controls when refs exist.",
      inputSchema: z.object({
        sourceRef: z.string().describe("Source ref from browser_snapshot."),
        targetRef: z.string().describe("Target ref from browser_snapshot."),
        reason: z.string().optional(),
      }),
      execute: async ({ sourceRef, targetRef, reason }) => withToolEvents("browser_drag_ref", `Drag ${sourceRef} to ${targetRef}`, async () => {
        const runtime = await getRuntime(ctx);
        const source = await elementByRef(runtime, sourceRef);
        const target = await elementByRef(runtime, targetRef);
        const outcome = await dragBetweenRefs(ctx, runtime, source, target, reason);
        return formatOutcome(runtime, outcome);
      }).catch((err: unknown) => `Error dragging refs: ${err instanceof Error ? err.message : String(err)}`),
      toModelOutput: ({ output }) => modelOutputWithOptionalScreenshot(output),
    }),

    browser_upload_ref: tool({
      description: "Upload a local file through a file input ref from browser_snapshot.",
      inputSchema: z.object({
        ref: z.string().describe("File input ref from browser_snapshot."),
        path: z.string().describe("Local file path to upload. Relative paths resolve from the run cwd."),
      }),
      execute: async ({ ref, path }) => withToolEvents("browser_upload_ref", `Upload ${path}`, async () => {
        const runtime = await getRuntime(ctx);
        const element = await elementByRef(runtime, ref);
        const outcome = await uploadFileToRef(ctx, runtime, element, path, `Upload ${path}`);
        return formatOutcome(runtime, outcome);
      }).catch((err: unknown) => `Error uploading file: ${err instanceof Error ? err.message : String(err)}`),
      toModelOutput: ({ output }) => modelOutputWithOptionalScreenshot(output),
    }),

    browser_click: tool({
      description: "Legacy alias: click an observed numeric ID from browser_observe.",
      inputSchema: z.object({
        id: z.number().int().positive().describe("Numeric element ID from browser_observe."),
        reason: z.string().optional().describe("Why this click is needed."),
      }),
      execute: async ({ id, reason }) => withToolEvents("browser_click", `Click observed element ${id}`, async () => {
        const runtime = await getRuntime(ctx);
        if (runtime.legacyIds.size === 0) await captureSnapshot(runtime, `Legacy click ${id}`);
        const ref = runtime.legacyIds.get(id);
        if (!ref) return `No observed element with id ${id}. Call browser_observe again.`;
        const element = await elementByRef(runtime, ref);
        const outcome = await runRefActionWithSelfHeal(ctx, runtime, element, "click", { reason, instruction: reason });
        return formatOutcome(runtime, outcome);
      }).catch((err: unknown) => `Error clicking element ${id}: ${err instanceof Error ? err.message : String(err)}`),
      toModelOutput: ({ output }) => modelOutputWithOptionalScreenshot(output),
    }),

    browser_fill: tool({
      description: "Legacy alias: fill text into an observed numeric ID from browser_observe.",
      inputSchema: z.object({
        id: z.number().int().positive().describe("Numeric element ID from browser_observe."),
        text: z.string().describe("Text to enter."),
      }),
      execute: async ({ id, text }) => withToolEvents("browser_fill", `Fill observed element ${id}`, async () => {
        const runtime = await getRuntime(ctx);
        if (runtime.legacyIds.size === 0) await captureSnapshot(runtime, `Legacy fill ${id}`);
        const ref = runtime.legacyIds.get(id);
        if (!ref) return `No observed element with id ${id}. Call browser_observe again.`;
        const element = await elementByRef(runtime, ref);
        const outcome = await runRefActionWithSelfHeal(ctx, runtime, element, "fill", { text });
        return formatOutcome(runtime, outcome);
      }).catch((err: unknown) => `Error filling element ${id}: ${err instanceof Error ? err.message : String(err)}`),
    }),

    browser_press: tool({
      description: "Legacy alias for browser_key. Press a keyboard key such as Enter, Tab, Escape, ArrowDown, or Control+A.",
      inputSchema: z.object({
        key: z.string().describe("Playwright key name to press."),
        reason: z.string().optional().describe("Why this key press is needed."),
      }),
      execute: async ({ key, reason }) => withToolEvents("browser_press", `Press ${key}`, async () => {
        const runtime = await getRuntime(ctx);
        const detail = `Press key ${key}${reason ? `; reason: ${reason}` : ""}`;
        const blocked = await guardRisk(ctx, "browser_key", detail);
        if (blocked) return blocked;
        await humanDelay(runtime.page);
        await runtime.page.keyboard.press(key);
        await settlePage(runtime.page);
        await savePageState(runtime, "open");
        return `Pressed ${key}. Current URL: ${runtime.page.url()}`;
      }).catch((err: unknown) => `Error pressing key ${key}: ${err instanceof Error ? err.message : String(err)}`),
    }),

    browser_key: tool({
      description: "Press a keyboard key. Use for keyboard shortcuts, not for blind tab-spam.",
      inputSchema: z.object({
        key: z.string().describe("Playwright key name to press."),
        reason: z.string().optional(),
      }),
      execute: async ({ key, reason }) => withToolEvents("browser_key", `Press ${key}`, async () => {
        const runtime = await getRuntime(ctx);
        const detail = `Press key ${key}${reason ? `; reason: ${reason}` : ""}`;
        const blocked = await guardRisk(ctx, "browser_key", detail);
        if (blocked) return blocked;
        await humanDelay(runtime.page);
        await runtime.page.keyboard.press(key);
        await settlePage(runtime.page);
        await savePageState(runtime, "open");
        return `Pressed ${key}. Current URL: ${runtime.page.url()}`;
      }).catch((err: unknown) => `Error pressing key ${key}: ${err instanceof Error ? err.message : String(err)}`),
    }),

    browser_scroll: tool({
      description: "Scroll the active popup/dropdown/modal when present, or the current page. A ref scrolls its nearest container.",
      inputSchema: z.object({
        direction: z.enum(["up", "down", "left", "right"]).optional(),
        amount: z.number().int().positive().max(3000).optional(),
        ref: z.string().optional().describe("Optional ref to scroll into view before page scroll."),
      }),
      execute: async ({ direction, amount, ref }) => withToolEvents("browser_scroll", `Scroll ${direction ?? "down"}`, async () => {
        const runtime = await getRuntime(ctx);
        const dir = direction ?? "down";
        const result = await scrollBrowserSurface(runtime, dir, amount ?? 700, ref);
        await settlePage(runtime.page);
        await savePageState(runtime, "open");
        return `${result}\nCurrent URL: ${runtime.page.url()}`;
      }).catch((err: unknown) => `Error scrolling: ${err instanceof Error ? err.message : String(err)}`),
    }),

    browser_wait: tool({
      description: "Wait for a short time or for DOM/network quiet.",
      inputSchema: z.object({
        ms: z.number().int().positive().max(15_000).optional(),
        state: z.enum(["domcontentloaded", "load", "networkidle"]).optional(),
      }),
      execute: async ({ ms, state }) => withToolEvents("browser_wait", "Wait in browser", async () => {
        const runtime = await getRuntime(ctx);
        if (state) await runtime.page.waitForLoadState(state, { timeout: ms ?? 8_000 }).catch(() => undefined);
        else await runtime.page.waitForTimeout(ms ?? 1_000);
        await savePageState(runtime, "open");
        return `Waited. Current URL: ${runtime.page.url()}`;
      }).catch((err: unknown) => `Error waiting: ${err instanceof Error ? err.message : String(err)}`),
    }),

    browser_back: tool({
      description: "Go back in browser history.",
      inputSchema: z.object({}),
      execute: async () => withToolEvents("browser_back", "Go back", async () => {
        const runtime = await getRuntime(ctx);
        await runtime.page.goBack({ waitUntil: "domcontentloaded" }).catch(() => undefined);
        await settlePage(runtime.page);
        await savePageState(runtime, "open");
        return `Went back. Current URL: ${runtime.page.url()}`;
      }).catch((err: unknown) => `Error going back: ${err instanceof Error ? err.message : String(err)}`),
    }),

    browser_forward: tool({
      description: "Go forward in browser history.",
      inputSchema: z.object({}),
      execute: async () => withToolEvents("browser_forward", "Go forward", async () => {
        const runtime = await getRuntime(ctx);
        await runtime.page.goForward({ waitUntil: "domcontentloaded" }).catch(() => undefined);
        await settlePage(runtime.page);
        await savePageState(runtime, "open");
        return `Went forward. Current URL: ${runtime.page.url()}`;
      }).catch((err: unknown) => `Error going forward: ${err instanceof Error ? err.message : String(err)}`),
    }),

    browser_reload: tool({
      description: "Reload the current page and wait for DOM/network quiet.",
      inputSchema: z.object({}),
      execute: async () => withToolEvents("browser_reload", "Reload page", async () => {
        const runtime = await getRuntime(ctx);
        await runtime.page.reload({ waitUntil: "domcontentloaded" });
        await settlePage(runtime.page);
        await savePageState(runtime, "open");
        return `Reloaded. Current URL: ${runtime.page.url()}`;
      }).catch((err: unknown) => `Error reloading page: ${err instanceof Error ? err.message : String(err)}`),
    }),

    browser_wait_for_selector: tool({
      description: "Wait for a CSS selector to appear, disappear, attach, or become visible.",
      inputSchema: z.object({
        selector: z.string().describe("CSS selector to wait for."),
        state: z.enum(["attached", "detached", "visible", "hidden"]).optional(),
        timeoutMs: z.number().int().positive().max(60_000).optional(),
      }),
      execute: async ({ selector, state, timeoutMs }) => withToolEvents("browser_wait_for_selector", `Wait for ${selector}`, async () => {
        const runtime = await getRuntime(ctx);
        await runtime.page.waitForSelector(selector, {
          state: state ?? "visible",
          timeout: timeoutMs ?? 15_000,
        });
        await savePageState(runtime, "open");
        return `Selector ${selector} is ${state ?? "visible"}.\nURL: ${runtime.page.url()}`;
      }).catch((err: unknown) => `Error waiting for selector: ${err instanceof Error ? err.message : String(err)}`),
    }),

    browser_pages: tool({
      description: "List open browser pages/tabs and the currently selected page.",
      inputSchema: z.object({}),
      execute: async () => withToolEvents("browser_pages", "List pages", async () => {
        const runtime = await getRuntime(ctx);
        const pages = runtime.context.pages();
        const lines = await Promise.all(pages.map(async (page, index) => {
          const title = await page.title().catch(() => "");
          const marker = page === runtime.page ? "*" : " ";
          return `${marker} ${index}: ${title || "(untitled)"} - ${page.url()}`;
        }));
        return lines.join("\n") || "No pages open.";
      }).catch((err: unknown) => `Error listing pages: ${err instanceof Error ? err.message : String(err)}`),
    }),

    browser_new_page: tool({
      description: "Open a new browser tab/page, optionally navigating to a URL, and make it active.",
      inputSchema: z.object({
        url: z.string().optional().describe("Optional URL to open."),
      }),
      execute: async ({ url }) => withToolEvents("browser_new_page", url ? `New page ${url}` : "New page", async () => {
        const runtime = await getRuntime(ctx);
        runtime.page = await runtime.context.newPage();
        runtime.page.setDefaultTimeout(loadConfig().browser?.timeoutMs ?? DEFAULT_BROWSER_TIMEOUT_MS);
        runtime.page.on("crash", () => {
          updateBrowserSessionState(sessionId, { status: "crashed", blockedReason: "Browser page crashed" });
        });
        if (url) {
          await runtime.page.goto(normalizeUrl(url), { waitUntil: "domcontentloaded" });
          await settlePage(runtime.page);
        }
        await savePageState(runtime, "open");
        return `Opened page ${runtime.context.pages().indexOf(runtime.page)}: ${runtime.page.url()}`;
      }).catch((err: unknown) => `Error opening new page: ${err instanceof Error ? err.message : String(err)}`),
    }),

    browser_select_page: tool({
      description: "Switch the active browser page/tab by index from browser_pages.",
      inputSchema: z.object({
        index: z.number().int().nonnegative().describe("Page index from browser_pages."),
      }),
      execute: async ({ index }) => withToolEvents("browser_select_page", `Select page ${index}`, async () => {
        const runtime = await getRuntime(ctx);
        const page = runtime.context.pages()[index];
        if (!page) return `No browser page at index ${index}.`;
        runtime.page = page;
        await runtime.page.bringToFront().catch(() => undefined);
        await settlePage(runtime.page);
        await savePageState(runtime, "open");
        return `Selected page ${index}: ${runtime.page.url()}`;
      }).catch((err: unknown) => `Error selecting page: ${err instanceof Error ? err.message : String(err)}`),
    }),

    browser_close_page: tool({
      description: "Close a browser page/tab by index. If no index is provided, close the active page and switch to another page.",
      inputSchema: z.object({
        index: z.number().int().nonnegative().optional(),
      }),
      execute: async ({ index }) => withToolEvents("browser_close_page", "Close page", async () => {
        const runtime = await getRuntime(ctx);
        const pages = runtime.context.pages();
        const target = typeof index === "number" ? pages[index] : runtime.page;
        if (!target) return `No browser page at index ${index}.`;
        if (pages.length <= 1) return "Refused to close the only open page. Use browser_close to close the browser session explicitly.";
        const closedIndex = pages.indexOf(target);
        await target.close().catch(() => undefined);
        const remaining = runtime.context.pages();
        runtime.page = remaining[Math.max(0, Math.min(closedIndex, remaining.length - 1))] ?? remaining[0]!;
        await runtime.page.bringToFront().catch(() => undefined);
        await savePageState(runtime, "open");
        return `Closed page ${closedIndex}. Active page: ${runtime.page.url()}`;
      }).catch((err: unknown) => `Error closing page: ${err instanceof Error ? err.message : String(err)}`),
    }),

    browser_hover: tool({
      description: "Hover a stable ref from browser_snapshot.",
      inputSchema: z.object({
        ref: z.string().describe("Stable ref from browser_snapshot."),
      }),
      execute: async ({ ref }) => withToolEvents("browser_hover", `Hover ${ref}`, async () => {
        const runtime = await getRuntime(ctx);
        const element = await elementByRef(runtime, ref);
        const outcome = await runRefActionWithSelfHeal(ctx, runtime, element, "hover", {});
        return formatOutcome(runtime, outcome);
      }).catch((err: unknown) => `Error hovering ref ${ref}: ${err instanceof Error ? err.message : String(err)}`),
      toModelOutput: ({ output }) => modelOutputWithOptionalScreenshot(output),
    }),

    browser_click_at: tool({
      description: "Click viewport coordinates from a model-visible screenshot. Use this for visible modals, dropdowns, canvas/seat maps, or controls missing from DOM refs.",
      inputSchema: z.object({
        x: z.number().finite().describe("Viewport x coordinate in CSS pixels."),
        y: z.number().finite().describe("Viewport y coordinate in CSS pixels."),
        reason: z.string().optional().describe("Why this coordinate click is needed."),
        clickCount: z.number().int().positive().max(2).optional(),
      }),
      execute: async ({ x, y, reason, clickCount }) => withToolEvents("browser_click_at", `Click at ${x},${y}`, async () => {
        const runtime = await getRuntime(ctx);
        const detail = `Click viewport coordinates ${Math.round(x)},${Math.round(y)}${reason ? `; reason: ${reason}` : ""}`;
        const blocked = await guardRisk(ctx, "browser_click_at", detail);
        if (blocked) return blocked;

        const before = await browserStateKey(runtime.page);
        await humanDelay(runtime.page);
        await dispatchMouseClick(runtime.page, x, y, clickCount ?? 1);
        await settlePage(runtime.page);
        await savePageState(runtime, "open");
        const after = await browserStateKey(runtime.page);
        const screenshot = await captureViewportScreenshot(runtime, "click-at").catch(() => undefined);
        const title = await runtime.page.title().catch(() => "");
        const success = before !== after;
        recordBrowserAction(runtime.sessionId, {
          timestamp: Date.now(),
          tool: "browser_click_at",
          method: "click",
          instruction: reason,
          selector: `viewport(${Math.round(x)},${Math.round(y)})`,
          url: runtime.page.url(),
          title,
          success,
        });

        return [
          success
            ? "Coordinate click completed and page state changed."
            : "Coordinate click completed, but no page or visual state change was detected. Take a fresh screenshot/snapshot or choose another target.",
          `URL: ${runtime.page.url()}`,
          `Coordinates: ${Math.round(x)},${Math.round(y)}`,
          screenshot ? `Screenshot: ${screenshot}` : "",
        ].filter(Boolean).join("\n");
      }).catch((err: unknown) => `Error clicking coordinates: ${err instanceof Error ? err.message : String(err)}`),
      toModelOutput: ({ output }) => modelOutputWithOptionalScreenshot(output),
    }),

    browser_type_at: tool({
      description: "Click viewport coordinates, then type text. Use for visible search boxes or inputs missing from DOM refs.",
      inputSchema: z.object({
        x: z.number().finite().describe("Viewport x coordinate in CSS pixels."),
        y: z.number().finite().describe("Viewport y coordinate in CSS pixels."),
        text: z.string().describe("Text to type."),
        clear: z.boolean().optional().describe("Select existing text before typing."),
      }),
      execute: async ({ x, y, text, clear }) => withToolEvents("browser_type_at", `Type at ${x},${y}`, async () => {
        const runtime = await getRuntime(ctx);
        const detail = `Type text at viewport coordinates ${Math.round(x)},${Math.round(y)}: ${text}`;
        const blocked = await guardRisk(ctx, "browser_type_at", detail);
        if (blocked) return blocked;

        const before = await browserStateKey(runtime.page);
        await humanDelay(runtime.page);
        await dispatchMouseClick(runtime.page, x, y, 1);
        if (clear) await runtime.page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
        await runtime.page.keyboard.type(text, { delay: 35 });
        await settlePage(runtime.page);
        await savePageState(runtime, "open");
        const after = await browserStateKey(runtime.page);
        const screenshot = await captureViewportScreenshot(runtime, "type-at").catch(() => undefined);
        const title = await runtime.page.title().catch(() => "");
        const success = before !== after;
        recordBrowserAction(runtime.sessionId, {
          timestamp: Date.now(),
          tool: "browser_type_at",
          method: "type",
          instruction: text,
          selector: `viewport(${Math.round(x)},${Math.round(y)})`,
          url: runtime.page.url(),
          title,
          success,
        });

        return [
          success
            ? "Coordinate type completed and page state changed."
            : "Coordinate type completed, but no page or visual state change was detected.",
          `URL: ${runtime.page.url()}`,
          `Coordinates: ${Math.round(x)},${Math.round(y)}`,
          screenshot ? `Screenshot: ${screenshot}` : "",
        ].filter(Boolean).join("\n");
      }).catch((err: unknown) => `Error typing at coordinates: ${err instanceof Error ? err.message : String(err)}`),
      toModelOutput: ({ output }) => modelOutputWithOptionalScreenshot(output),
    }),

    browser_scroll_at: tool({
      description: "Wheel-scroll at viewport coordinates. Use for scrollable modals, dropdown/listbox popups, or seat maps where background scrolling is wrong.",
      inputSchema: z.object({
        x: z.number().finite().describe("Viewport x coordinate in CSS pixels."),
        y: z.number().finite().describe("Viewport y coordinate in CSS pixels."),
        direction: z.enum(["up", "down", "left", "right"]).optional(),
        amount: z.number().int().positive().max(3000).optional(),
      }),
      execute: async ({ x, y, direction, amount }) => withToolEvents("browser_scroll_at", `Scroll at ${x},${y}`, async () => {
        const runtime = await getRuntime(ctx);
        const dir = direction ?? "down";
        const delta = amount ?? 700;
        const dx = dir === "left" ? -delta : dir === "right" ? delta : 0;
        const dy = dir === "up" ? -delta : dir === "down" ? delta : 0;
        await runtime.page.mouse.move(x, y);
        await runtime.page.mouse.wheel(dx, dy);
        await settlePage(runtime.page);
        await savePageState(runtime, "open");
        const screenshot = await captureViewportScreenshot(runtime, "scroll-at").catch(() => undefined);
        return [
          `Scrolled ${dir} at ${Math.round(x)},${Math.round(y)}.`,
          `URL: ${runtime.page.url()}`,
          screenshot ? `Screenshot: ${screenshot}` : "",
        ].filter(Boolean).join("\n");
      }).catch((err: unknown) => `Error scrolling at coordinates: ${err instanceof Error ? err.message : String(err)}`),
      toModelOutput: ({ output }) => modelOutputWithOptionalScreenshot(output),
    }),

    browser_extract: tool({
      description: "Extract readable text from the current page or a CSS selector.",
      inputSchema: z.object({
        instruction: z.string().optional().describe("Optional description of what information is needed."),
        selector: z.string().optional().describe("Optional CSS selector to extract from."),
        maxChars: z.number().int().positive().max(100_000).optional(),
      }),
      execute: async ({ instruction, selector, maxChars }) => withToolEvents("browser_extract", instruction ?? "Extract page text", async () => {
        const runtime = await getRuntime(ctx);
        await settlePage(runtime.page);
        const target = selector ? runtime.page.locator(selector).first() : runtime.page.locator("body").first();
        const title = await runtime.page.title().catch(() => "");
        const text = await target.innerText({ timeout: 5_000 }).catch(async () => runtime.page.content());
        await savePageState(runtime, "open");
        const header = [
          `URL: ${runtime.page.url()}`,
          `Title: ${title}`,
          instruction ? `Instruction: ${instruction}` : "",
        ].filter(Boolean).join("\n");
        return clamp(`${header}\n\n${text}`, maxChars ?? MAX_EXTRACT_CHARS);
      }).catch((err: unknown) => `Error extracting content: ${err instanceof Error ? err.message : String(err)}`),
    }),

    browser_screenshot: tool({
      description: "Take a screenshot of the current page. The saved PNG is also attached to the model-visible tool result, so use this when visual UI differs from the text snapshot.",
      inputSchema: z.object({
        savePath: z.string().optional().describe("Relative or absolute path for the screenshot."),
        fullPage: z.boolean().optional().describe("Capture the full page, default true."),
        annotateRefs: z.boolean().optional().describe("Overlay current snapshot refs on the viewport image. Ignored for full-page screenshots."),
      }),
      execute: async ({ savePath, fullPage, annotateRefs }) => withToolEvents("browser_screenshot", "Take browser screenshot", async () => {
        const runtime = await getRuntime(ctx);
        const targetPath = savePath
          ? (isAbsolute(savePath) ? savePath : resolve(ctx.cwd, savePath))
          : resolve(browserScreenshotsDir(sessionId), `screenshot-${Date.now()}.png`);

        mkdirSync(dirname(targetPath), { recursive: true });
        if (annotateRefs && !fullPage) {
          const snapshot = await captureSnapshot(runtime, "Annotate screenshot refs");
          await runtime.page.evaluate((items) => {
            document.querySelectorAll("[data-servus-annotation='true']").forEach((node) => node.remove());
            const root = document.createElement("div");
            root.setAttribute("data-servus-annotation", "true");
            Object.assign(root.style, {
              position: "fixed",
              inset: "0",
              zIndex: "2147483647",
              pointerEvents: "none",
              fontFamily: "Arial, sans-serif",
              fontSize: "12px",
            });
            for (const item of items) {
              const box = document.createElement("div");
              Object.assign(box.style, {
                position: "fixed",
                left: `${item.x}px`,
                top: `${item.y}px`,
                width: `${item.width}px`,
                height: `${item.height}px`,
                border: "2px solid #ff2d55",
                borderRadius: "4px",
                boxSizing: "border-box",
              });
              const label = document.createElement("div");
              label.textContent = String(item.legacyId);
              Object.assign(label.style, {
                position: "fixed",
                left: `${item.x}px`,
                top: `${Math.max(0, item.y - 16)}px`,
                padding: "2px 4px",
                borderRadius: "4px",
                background: "#ff2d55",
                color: "#fff",
                fontWeight: "700",
              });
              root.appendChild(box);
              root.appendChild(label);
            }
            document.documentElement.appendChild(root);
          }, snapshot.elements
            .filter((element) => element.bounds && element.visible)
            .slice(0, 80)
            .map((element) => ({
              legacyId: element.legacyId,
              x: element.bounds!.x,
              y: element.bounds!.y,
              width: element.bounds!.width,
              height: element.bounds!.height,
            }))).catch(() => undefined);
          try {
            await runtime.page.screenshot({ path: targetPath, fullPage: false, animations: "disabled", caret: "hide" });
          } finally {
            await runtime.page.evaluate(() => {
              document.querySelectorAll("[data-servus-annotation='true']").forEach((node) => node.remove());
            }).catch(() => undefined);
          }
        } else {
          await runtime.page.screenshot({ path: targetPath, fullPage: fullPage ?? true });
        }
        runtime.proofScreenshots.push(targetPath);
        await savePageState(runtime, "open", { lastScreenshot: targetPath });
        bus.push({
          type: "artifact:add",
          agent: "Browser",
          message: `Browser screenshot: ${targetPath}`,
          metadata: { artifact: targetPath, kind: "screenshot" },
        });

        return `Screenshot saved: ${targetPath}\nURL: ${runtime.page.url()}`;
      }).catch((err: unknown) => `Error taking screenshot: ${err instanceof Error ? err.message : String(err)}`),
      toModelOutput: ({ output }) => modelOutputWithOptionalScreenshot(output),
    }),

    browser_element_info: tool({
      description: "Return detailed DOM/accessibility/bounds info for a stable ref from browser_snapshot.",
      inputSchema: z.object({
        ref: z.string().describe("Stable ref from browser_snapshot."),
      }),
      execute: async ({ ref }) => withToolEvents("browser_element_info", `Inspect ${ref}`, async () => {
        const runtime = await getRuntime(ctx);
        const element = await elementByRef(runtime, ref);
        const locator = resolveLocator(runtime, element);
        const details = await locator.evaluate((el) => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          const attrs: Record<string, string> = {};
          for (const attr of Array.from(el.attributes)) attrs[attr.name] = attr.value;
          return {
            tag: el.tagName.toLowerCase(),
            text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 1000),
            attributes: attrs,
            bounds: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
            style: {
              display: style.display,
              visibility: style.visibility,
              position: style.position,
              zIndex: style.zIndex,
              overflow: style.overflow,
              pointerEvents: style.pointerEvents,
              cursor: style.cursor,
            },
          };
        });
        return JSON.stringify({
          ref,
          url: runtime.page.url(),
          snapshotElement: element,
          details,
        }, null, 2);
      }).catch((err: unknown) => `Error inspecting element ${ref}: ${err instanceof Error ? err.message : String(err)}`),
    }),

    browser_highlight: tool({
      description: "Temporarily highlight one or more refs in the browser and take a screenshot.",
      inputSchema: z.object({
        refs: z.array(z.string()).min(1).max(20).describe("Refs from browser_snapshot."),
      }),
      execute: async ({ refs }) => withToolEvents("browser_highlight", `Highlight ${refs.join(", ")}`, async () => {
        const runtime = await getRuntime(ctx);
        const elements = await Promise.all(refs.map((ref) => elementByRef(runtime, ref).catch(() => undefined)));
        const visible = elements.filter((element): element is SnapshotElement => Boolean(element));
        const screenshot = await captureAnnotatedScreenshot(runtime, "highlight", visible);
        return `Highlighted ${visible.length} refs.\nScreenshot: ${screenshot}\nURL: ${runtime.page.url()}`;
      }).catch((err: unknown) => `Error highlighting refs: ${err instanceof Error ? err.message : String(err)}`),
      toModelOutput: ({ output }) => modelOutputWithOptionalScreenshot(output),
    }),

    browser_set_viewport: tool({
      description: "Set the current page viewport size.",
      inputSchema: z.object({
        width: z.number().int().min(320).max(3840),
        height: z.number().int().min(240).max(2160),
      }),
      execute: async ({ width, height }) => withToolEvents("browser_set_viewport", `Set viewport ${width}x${height}`, async () => {
        const runtime = await getRuntime(ctx);
        await runtime.page.setViewportSize({ width, height });
        await settlePage(runtime.page);
        await savePageState(runtime, "open");
        return `Viewport set to ${width}x${height}.`;
      }).catch((err: unknown) => `Error setting viewport: ${err instanceof Error ? err.message : String(err)}`),
    }),

    browser_cookies: tool({
      description: "Read, add, or clear browser cookies for the persistent context.",
      inputSchema: z.object({
        action: z.enum(["list", "add", "clear"]).optional(),
        cookies: z.array(z.object({
          name: z.string(),
          value: z.string(),
          domain: z.string().optional(),
          path: z.string().optional(),
          url: z.string().optional(),
        })).optional(),
      }),
      execute: async ({ action, cookies }) => withToolEvents("browser_cookies", `${action ?? "list"} cookies`, async () => {
        const runtime = await getRuntime(ctx);
        const op = action ?? "list";
        if (op === "list") {
          const items = await runtime.context.cookies();
          return JSON.stringify(items.map((cookie) => ({
            name: cookie.name,
            domain: cookie.domain,
            path: cookie.path,
            expires: cookie.expires,
            sameSite: cookie.sameSite,
            secure: cookie.secure,
            httpOnly: cookie.httpOnly,
          })), null, 2);
        }
        const blocked = await guardRisk(ctx, `browser_cookies_${op}`, `${op} browser cookies`);
        if (blocked) return blocked;
        if (op === "clear") {
          await runtime.context.clearCookies();
          return "Cleared browser cookies.";
        }
        await runtime.context.addCookies((cookies ?? []).map((cookie) => ({
          ...cookie,
          url: cookie.url ?? (!cookie.domain ? runtime.page.url() : undefined),
          path: cookie.path ?? "/",
        })));
        return `Added ${cookies?.length ?? 0} cookie(s).`;
      }).catch((err: unknown) => `Error handling cookies: ${err instanceof Error ? err.message : String(err)}`),
    }),

    browser_set_headers: tool({
      description: "Set extra HTTP headers for future browser requests in this session.",
      inputSchema: z.object({
        headers: z.record(z.string(), z.string()).describe("Header names and values."),
      }),
      execute: async ({ headers }) => withToolEvents("browser_set_headers", "Set browser headers", async () => {
        const runtime = await getRuntime(ctx);
        const blocked = await guardRisk(ctx, "browser_set_headers", JSON.stringify(Object.keys(headers)));
        if (blocked) return blocked;
        await runtime.context.setExtraHTTPHeaders(headers);
        return `Set ${Object.keys(headers).length} extra HTTP header(s).`;
      }).catch((err: unknown) => `Error setting headers: ${err instanceof Error ? err.message : String(err)}`),
    }),

    browser_add_init_script: tool({
      description: "Add a JavaScript init script to future pages in this browser context. Requires consent because it can alter site behavior.",
      inputSchema: z.object({
        script: z.string().max(20_000).describe("JavaScript source to run before page scripts."),
        reason: z.string().optional(),
      }),
      execute: async ({ script, reason }) => withToolEvents("browser_add_init_script", "Add browser init script", async () => {
        const runtime = await getRuntime(ctx);
        const blocked = await guardRisk(ctx, "browser_add_init_script", reason ? `${reason}\n${script.slice(0, 1000)}` : script.slice(0, 1000));
        if (blocked) return blocked;
        await runtime.context.addInitScript(script);
        return "Init script added for future pages.";
      }).catch((err: unknown) => `Error adding init script: ${err instanceof Error ? err.message : String(err)}`),
    }),

    browser_close: tool({
      description: "Explicitly close this Servus browser session only when the user asked to close/cancel/stop or the engine is cleaning up after verified completion.",
      inputSchema: z.object({}),
      execute: async () => withToolEvents("browser_close", "Close browser", async () => {
        if (!/\b(close|cancel|stop|quit|exit|done with browser|close browser)\b/i.test(ctx.task)) {
          return "Browser close skipped. Servus keeps the browser open during active automation; cleanup is handled by the runtime after verified completion.";
        }
        await closeBrowser(sessionId);
        return "Browser closed.";
      }).catch((err: unknown) => `Error closing browser: ${err instanceof Error ? err.message : String(err)}`),
    }),
  };
}
