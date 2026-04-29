import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { streamText, stepCountIs, type ModelMessage } from "ai";
import { z } from "zod";
import { registerChild, unregisterChild } from "./child-registry.js";
import { findServusProjectRoot } from "./coding-project.js";
import { loadConfig, SERVUS_DIR } from "./config.js";
import { truncate } from "./log.js";
import { loadPlugins } from "./plugins.js";
import { resolveModel } from "./provider.js";

export type CodingPermissionBehavior = "allow" | "ask" | "deny";
export type CodingHookEvent =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "Notification"
  | "PreCompact"
  | "PostCompact"
  | "Stop"
  | "StopFailure"
  | "SubagentStop"
  | "TaskCreated"
  | "TaskCompleted";

export interface CodingPermissionRule {
  behavior: CodingPermissionBehavior;
  rule: string;
  source: "project" | "user";
  reason?: string;
}

export interface CodingHookCommand {
  type: "command" | "http" | "prompt";
  command?: string;
  url?: string;
  prompt?: string;
  model?: string;
  timeoutMs?: number;
  statusMessage?: string;
  blocking?: boolean;
  async?: boolean;
  once?: boolean;
  headers?: Record<string, string>;
}

export interface CodingHookMatcher {
  matcher?: string;
  hooks: CodingHookCommand[];
  source: "project" | "user" | "plugin";
}

export interface CodingSettings {
  sources: string[];
  outputStyle?: string;
  permissions: {
    allow: CodingPermissionRule[];
    ask: CodingPermissionRule[];
    deny: CodingPermissionRule[];
  };
  hooks: Partial<Record<CodingHookEvent, CodingHookMatcher[]>>;
}

export interface CodingHookInput {
  sessionId?: string;
  cwd: string;
  agentName: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: string;
  isError?: boolean;
  event: CodingHookEvent;
}

export interface CodingHookRunResult {
  hook: CodingHookCommand;
  source: "project" | "user" | "plugin";
  event: CodingHookEvent;
  ok: boolean;
  blocked: boolean;
  output: string;
  durationMs: number;
}

const PermissionConfigSchema = z.object({
  allow: z.array(z.string()).optional(),
  ask: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
}).optional();

const HookCommandSchema = z.object({
  type: z.enum(["command", "http", "prompt"]).default("command"),
  command: z.string().optional(),
  url: z.string().url().optional(),
  prompt: z.string().optional(),
  model: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  timeout: z.number().positive().optional(),
  statusMessage: z.string().optional(),
  blocking: z.boolean().optional(),
  async: z.boolean().optional(),
  once: z.boolean().optional(),
  headers: z.record(z.string(), z.string()).optional(),
}).refine((input) => {
  if (input.type === "command") return !!input.command;
  if (input.type === "http") return !!input.url;
  return !!input.prompt;
}, {
  message: "command hooks require command; http hooks require url; prompt hooks require prompt",
});

const HookMatcherSchema = z.object({
  matcher: z.string().optional(),
  hooks: z.array(HookCommandSchema),
});

const HookEventSchema = z.enum([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "PreCompact",
  "PostCompact",
  "Stop",
  "StopFailure",
  "SubagentStop",
  "TaskCreated",
  "TaskCompleted",
]);

const HooksConfigSchema = z.partialRecord(
  HookEventSchema,
  z.array(HookMatcherSchema),
);

const SettingsSchema = z.object({
  outputStyle: z.string().optional(),
  permissions: PermissionConfigSchema,
  hooks: HooksConfigSchema.optional(),
});

export function loadCodingSettings(cwd: string): CodingSettings {
  const projectRoot = findServusProjectRoot(cwd);
  const candidates: Array<{ source: "project" | "user"; path: string }> = [
    { source: "user", path: join(SERVUS_DIR, "settings.json") },
    { source: "project", path: resolve(projectRoot, ".servus/settings.json") },
  ];

  const settings: CodingSettings = {
    sources: [],
    permissions: { allow: [], ask: [], deny: [] },
    hooks: {},
  };

  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) continue;
    try {
      const parsed = SettingsSchema.safeParse(JSON.parse(readFileSync(candidate.path, "utf-8")));
      if (!parsed.success) continue;
      settings.sources.push(candidate.path.replace(process.env.HOME || homedir(), "~"));
      if (parsed.data.outputStyle) settings.outputStyle = parsed.data.outputStyle;
      for (const behavior of ["allow", "ask", "deny"] as const) {
        const rules = parsed.data.permissions?.[behavior] ?? [];
        settings.permissions[behavior].push(
          ...rules.map((rule) => ({ behavior, rule, source: candidate.source })),
        );
      }
      appendHookSettings(settings, parsed.data.hooks, candidate.source);
    } catch {
      // Invalid settings should not break a coding run.
    }
  }

  loadPluginHookSettings(settings, cwd);

  return settings;
}

function loadPluginHookSettings(settings: CodingSettings, cwd: string): void {
  const config = loadConfig();
  if (config.plugins?.enabled === false) return;
  for (const plugin of loadPlugins({ cwd, extraDirs: config.plugins?.dirs, disabled: config.plugins?.disabled })) {
    const parsed = HooksConfigSchema.safeParse(plugin.hooks ?? {});
    if (!parsed.success || Object.keys(parsed.data).length === 0) continue;
    settings.sources.push(`${plugin.id}:hooks`);
    appendHookSettings(settings, parsed.data, "plugin");
  }
}

function appendHookSettings(
  settings: CodingSettings,
  hooks: Partial<Record<CodingHookEvent, z.infer<typeof HookMatcherSchema>[]>> | undefined,
  source: CodingHookMatcher["source"],
): void {
  for (const [event, matchers] of Object.entries(hooks ?? {})) {
    const hookEvent = event as CodingHookEvent;
    const current = settings.hooks[hookEvent] ?? [];
    current.push(...matchers.map((matcher) => ({
      matcher: matcher.matcher,
      hooks: matcher.hooks.map(normalizeHookCommand),
      source,
    })));
    settings.hooks[hookEvent] = current;
  }
}

function normalizeHookCommand(hook: z.infer<typeof HookCommandSchema>): CodingHookCommand {
  return {
    type: hook.type,
    ...(hook.command ? { command: hook.command } : {}),
    ...(hook.url ? { url: hook.url } : {}),
    ...(hook.prompt ? { prompt: hook.prompt } : {}),
    ...(hook.model ? { model: hook.model } : {}),
    ...(hook.timeoutMs || hook.timeout ? { timeoutMs: hook.timeoutMs ?? Math.ceil(hook.timeout! * 1000) } : {}),
    ...(hook.statusMessage ? { statusMessage: hook.statusMessage } : {}),
    ...(hook.blocking !== undefined ? { blocking: hook.blocking } : {}),
    ...(hook.async !== undefined ? { async: hook.async } : {}),
    ...(hook.once !== undefined ? { once: hook.once } : {}),
    ...(hook.headers ? { headers: hook.headers } : {}),
  };
}

const executedOnceHooks = new Set<string>();

export function decideCodingPermission(
  settings: CodingSettings | undefined,
  toolName: string,
  input: unknown,
): CodingPermissionRule | undefined {
  if (!settings) return undefined;
  const groups = [settings.permissions.deny, settings.permissions.ask, settings.permissions.allow];
  for (const group of groups) {
    const match = group.find((rule) => matchesServusRule(rule.rule, toolName, input));
    if (match) return match;
  }
  return undefined;
}

export function findMatchingHooks(
  settings: CodingSettings | undefined,
  event: CodingHookEvent,
  toolName?: string,
  input?: unknown,
): CodingHookMatcher[] {
  const matchers = settings?.hooks[event] ?? [];
  return matchers.filter((matcher) => !matcher.matcher || matchesServusRule(matcher.matcher, toolName ?? "", input));
}

export async function runCodingHooks(
  settings: CodingSettings | undefined,
  event: CodingHookEvent,
  input: CodingHookInput,
): Promise<CodingHookRunResult[]> {
  const matchers = findMatchingHooks(settings, event, input.toolName, input.toolInput);
  const results: CodingHookRunResult[] = [];
  for (const matcher of matchers) {
    for (const hook of matcher.hooks) {
      const hookKey = hookRunKey(matcher.source, event, matcher.matcher, hook);
      if (hook.once && executedOnceHooks.has(hookKey)) continue;
      if (hook.once) executedOnceHooks.add(hookKey);

      if (hook.async) {
        void runOneHook(hook, input).catch(() => undefined);
        results.push({
          hook,
          source: matcher.source,
          event,
          ok: true,
          blocked: false,
          output: "Hook started in background.",
          durationMs: 0,
        });
        continue;
      }

      const started = Date.now();
      const output = await runOneHook(hook, input);
      const durationMs = Date.now() - started;
      const ok = output.code === 0;
      const blocked = output.code === 2 || ((event === "PreToolUse" || hook.blocking === true) && output.code !== 0);
      results.push({
        hook,
        source: matcher.source,
        event,
        ok,
        blocked,
        output: truncate(output.text, 4000),
        durationMs,
      });
    }
  }
  return results;
}

async function runOneHook(
  hook: CodingHookCommand,
  input: CodingHookInput,
): Promise<{ code: number; text: string }> {
  return hook.type === "http"
    ? await runHttpHook(hook, input)
    : hook.type === "prompt"
      ? await runPromptHook(hook, input)
      : await runCommandHook(hook, input);
}

function hookRunKey(
  source: string,
  event: CodingHookEvent,
  matcher: string | undefined,
  hook: CodingHookCommand,
): string {
  return JSON.stringify({
    source,
    event,
    matcher: matcher ?? "*",
    type: hook.type,
    command: hook.command,
    url: hook.url,
    prompt: hook.prompt,
  });
}

export function matchesServusRule(rule: string, toolName: string, input: unknown): boolean {
  const trimmed = rule.trim();
  if (!trimmed || trimmed === "*") return true;
  const match = trimmed.match(/^([A-Za-z0-9_*.-]+)(?:\(([\s\S]*)\))?$/);
  if (!match?.[1]) return false;
  const toolPattern = match[1];
  const inputPattern = match[2]?.trim();
  if (!wildcardMatch(toolPattern, toolName)) return false;
  if (!inputPattern || inputPattern === "*") return true;
  const haystack = `${JSON.stringify(input ?? {})}\n${extractPrimaryInput(input)}`;
  return wildcardMatch(inputPattern, haystack);
}

function wildcardMatch(pattern: string, value: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[\\s\\S]*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i").test(value) || new RegExp(escaped, "i").test(value);
}

function extractPrimaryInput(input: unknown): string {
  if (!input || typeof input !== "object") return String(input ?? "");
  const record = input as Record<string, unknown>;
  const primary = record.command ?? record.filePath ?? record.file_path ?? record.path ?? record.pattern ?? record.url;
  return typeof primary === "string" ? primary : JSON.stringify(input);
}

async function runPromptHook(
  hook: CodingHookCommand,
  input: CodingHookInput,
): Promise<{ code: number; text: string }> {
  try {
    const renderedPrompt = (hook.prompt ?? "")
      .replaceAll("$ARGUMENTS", JSON.stringify(input, null, 2))
      .replaceAll("{{args}}", JSON.stringify(input, null, 2))
      .replaceAll("{{ARGUMENTS}}", JSON.stringify(input, null, 2));
    const resolved = resolveModel(hook.model ?? process.env.SERVUS_HOOK_MODEL ?? process.env.SERVUS_DEFAULT_MODEL ?? "gpt-5-mini");
    let text = "";
    const result = await streamText({
      model: resolved.model,
      system: [
        "You are a Servus coding hook evaluator.",
        "Return concise output. If this hook should block the operation, include a clear line starting with BLOCK:",
        "Otherwise include PASS: followed by a short reason.",
      ].join(" "),
      messages: [{ role: "user", content: renderedPrompt }] as ModelMessage[],
      stopWhen: stepCountIs(1),
    });
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") text += part.text;
    }
    const blocked = /^\s*(BLOCK|DENY|REJECT|FAIL)\b/im.test(text);
    return { code: blocked ? 2 : 0, text: truncate(text.trim() || "(prompt hook produced no output)", 4000) };
  } catch (err: unknown) {
    return {
      code: 1,
      text: err instanceof Error ? err.message : String(err),
    };
  }
}

async function runCommandHook(
  hook: CodingHookCommand,
  input: CodingHookInput,
): Promise<{ code: number; text: string }> {
  const command = hook.command ?? "";
  const timeoutMs = hook.timeoutMs ?? 30_000;
  return new Promise((resolve) => {
    const child = spawn("/bin/bash", ["-lc", command], {
      cwd: input.cwd,
      env: { ...process.env, SERVUS_HOOK_EVENT: input.event, FORCE_COLOR: "0" },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    registerChild(child.pid!, { processGroup: process.platform !== "win32" });
    child.stdin?.end(JSON.stringify(input));
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));
    let settled = false;
    const done = (code: number, killed = false) => {
      if (settled) return;
      settled = true;
      unregisterChild(child.pid!);
      const text = Buffer.concat(chunks).toString("utf-8").trim();
      resolve({
        code,
        text: killed ? `${text}\nHook timed out after ${timeoutMs}ms.`.trim() : text,
      });
    };
    const timer = setTimeout(() => {
      try {
        if (process.platform !== "win32") process.kill(-child.pid!, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // already exited
      }
      done(124, true);
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      done(code ?? 1);
    });
  });
}

async function runHttpHook(
  hook: CodingHookCommand,
  input: CodingHookInput,
): Promise<{ code: number; text: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), hook.timeoutMs ?? 30_000);
  try {
    const response = await fetch(hook.url!, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(hook.headers ?? {}),
      },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
    const text = await response.text();
    return {
      code: response.ok ? 0 : response.status,
      text,
    };
  } catch (err: unknown) {
    return {
      code: 1,
      text: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}
