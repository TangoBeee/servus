import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export const SERVUS_DIR = process.env.SERVUS_DIR ?? join(process.env.SERVUS_HOME ?? homedir(), ".servus");
const CONFIG_PATH = join(SERVUS_DIR, "config.json");

export interface ServusConfig {
  defaultModel: string;
  defaultBackend: "custom" | "auto";
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
    headers?: Record<string, string>;
    timeoutMs?: number;
    toolFilter?: string[];
    resourceFilter?: string[];
    transport?: "auto" | "stdio" | "streamable-http" | "sse" | "http";
    auth?: {
      type?: "none" | "bearer" | "header" | "oauth" | "client_credentials";
      tokenEnv?: string;
      headerName?: string;
      clientIdEnv?: string;
      clientSecretEnv?: string;
      scopes?: string[];
      redirectUrl?: string;
    };
    disabled?: boolean;
  }>;
  lspServers?: Record<string, {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    extensions?: string[];
    languages?: Record<string, string>;
    languageId?: string;
    initializationOptions?: unknown;
  }>;
  browser?: {
    headless?: boolean;
    timeoutMs?: number;
  };
  permissions?: {
    allow?: string[];
    deny?: string[];
    mcp?: {
      allow?: string[];
      deny?: string[];
      ask?: string[];
    };
  };
  trustedFolders?: string[];
  memory?: {
    enabled?: boolean;
    maxBytes?: number;
  };
}

const DEFAULTS: ServusConfig = {
  defaultModel: "gpt-5.4",
  defaultBackend: "auto",
  maxFailures: 5,
  theme: "matrix",
};
const LEGACY_PROVIDER_BACKEND = `${"claude"}-code`;
const REMOVED_PROVIDER_SDK_BACKEND = `${"provider"}-sdk`;

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
    return normalizeConfig({ ...DEFAULTS, ...raw });
  } catch {
    return { ...DEFAULTS };
  }
}

function normalizeConfig(config: ServusConfig): ServusConfig {
  return {
    ...config,
    defaultBackend:
      String(config.defaultBackend) === LEGACY_PROVIDER_BACKEND ||
      String(config.defaultBackend) === REMOVED_PROVIDER_SDK_BACKEND
        ? "custom"
        : config.defaultBackend,
  };
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
