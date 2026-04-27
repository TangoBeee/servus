import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const SERVUS_DIR = join(homedir(), ".servus");
const CONFIG_PATH = join(SERVUS_DIR, "config.json");

export interface ServusConfig {
  defaultModel: string;
  defaultBackend: "claude-code" | "custom" | "auto";
  maxFailures: number;
  budget?: number;
  verifyCommand?: string;
  theme: "matrix" | "cyber" | "minimal";
  providerUrl?: string;
  providers?: Record<string, Record<string, unknown>>;
  tools?: {
    disabled?: string[];
    requireConsent?: string[];
  };
  skills?: {
    enabled?: boolean;
    dirs?: string[];
    maxPromptChars?: number;
  };
  plugins?: {
    enabled?: boolean;
    dirs?: string[];
    disabled?: string[];
  };
  mcpServers?: Record<string, {
    command?: string;
    args?: string[];
    url?: string;
    env?: Record<string, string>;
  }>;
  browser?: {
    headless?: boolean;
    timeoutMs?: number;
  };
  permissions?: {
    allow?: string[];
    deny?: string[];
  };
  memory?: {
    enabled?: boolean;
    maxBytes?: number;
  };
}

const DEFAULTS: ServusConfig = {
  defaultModel: "claude-sonnet-4-20250514",
  defaultBackend: "auto",
  maxFailures: 5,
  theme: "matrix",
};

export function ensureServusDir(): void {
  try {
    mkdirSync(SERVUS_DIR, { recursive: true });
    mkdirSync(join(SERVUS_DIR, "sessions"), { recursive: true });
  } catch {
    // May fail in sandboxed environments — non-fatal
  }
}

export function loadConfig(): ServusConfig {
  ensureServusDir();
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(config: ServusConfig): void {
  ensureServusDir();
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

export function getApiKeyStatus(): Record<string, boolean> {
  return {
    ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
    GOOGLE_GENERATIVE_AI_API_KEY: !!process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    GOOGLE_API_KEY: !!process.env.GOOGLE_API_KEY,
  };
}
