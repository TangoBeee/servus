import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { getApiKeyStatus, loadConfig } from "./config.js";
import { loadPlugins } from "./plugins.js";
import { loadSkills } from "./skills.js";
import {
  DATA_TOOL_METADATA,
  DESKTOP_TOOL_METADATA,
  EXTENSION_TOOL_METADATA,
  MEDIA_TOOL_METADATA,
  SECURITY_TOOL_METADATA,
} from "./tool-metadata.js";

const require = createRequire(import.meta.url);

export type CapabilityStatus = "ready" | "degraded" | "blocked" | "empty" | "configured";

export interface CapabilityDescriptor {
  id: string;
  title: string;
  status: CapabilityStatus;
  tools: string[];
  dependencies: string[];
  missing: string[];
  notes: string[];
}

export const CORE_TOOLS = [
  "bash",
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "ls",
  "webfetch",
  "patch",
  "todowrite",
];

export const BROWSER_TOOLS = [
  "browser_navigate",
  "browser_snapshot",
  "browser_act",
  "browser_click_ref",
  "browser_fill_ref",
  "browser_select_ref",
  "browser_click_at",
  "browser_type_at",
  "browser_scroll_at",
  "browser_extract",
  "browser_screenshot",
  "browser_close",
];

export const DESKTOP_TOOLS = DESKTOP_TOOL_METADATA.map((tool) => tool.name);

export const MEDIA_TOOLS = MEDIA_TOOL_METADATA.map((tool) => tool.name);

export const DATA_TOOLS = DATA_TOOL_METADATA.map((tool) => tool.name);

export const EXTENSION_TOOLS = EXTENSION_TOOL_METADATA.map((tool) => tool.name);

export const SECURITY_TOOLS = SECURITY_TOOL_METADATA.map((tool) => tool.name);

export function getCapabilityDescriptors(cwd: string): CapabilityDescriptor[] {
  const cfg = loadConfig();
  const keys = getApiKeyStatus();
  const skills = loadSkills({ cwd, extraDirs: cfg.skills?.dirs });
  const plugins = loadPlugins({ cwd, extraDirs: cfg.plugins?.dirs, disabled: cfg.plugins?.disabled });
  const mcpCount = Object.keys(cfg.mcpServers ?? {}).length;
  const mediaMissing = ["yt-dlp", "ffmpeg", "ffprobe"].filter((command) => !commandAvailable(command));
  const desktopMissing = desktopMissingDependencies();
  const dataMissing = ["unpdf", "mammoth", "csv-parse", "node-xlsx"].filter((pkg) => !packageAvailable(pkg));

  return [
    {
      id: "coding",
      title: "Coding",
      status: "ready",
      tools: CORE_TOOLS,
      dependencies: ["git", "project toolchain"],
      missing: [],
      notes: ["Plan/develop/test engine", "Verification discovery"],
    },
    {
      id: "browser",
      title: "Browser",
      status: "ready",
      tools: BROWSER_TOOLS,
      dependencies: ["playwright"],
      missing: [],
      notes: [cfg.browser?.headless ? "Headless default" : "Visible default", "Native Playwright automation"],
    },
    {
      id: "desktop",
      title: "Desktop",
      status: desktopMissing.length ? "degraded" : "ready",
      tools: DESKTOP_TOOLS,
      dependencies: desktopDependencies(),
      missing: desktopMissing,
      notes: ["Safe local file/OS automation", "Consent for destructive/privacy-sensitive actions"],
    },
    {
      id: "media",
      title: "Media",
      status: mediaMissing.length ? "degraded" : "ready",
      tools: MEDIA_TOOLS,
      dependencies: ["yt-dlp", "ffmpeg", "ffprobe"],
      missing: mediaMissing,
      notes: [mediaMissing.length ? `Install: brew install ${mediaMissing.join(" ")}` : "Local media processing ready"],
    },
    {
      id: "data",
      title: "Data & Docs",
      status: dataMissing.length ? "blocked" : "ready",
      tools: DATA_TOOLS,
      dependencies: ["unpdf", "mammoth", "csv-parse", "node-xlsx"],
      missing: dataMissing,
      notes: ["PDF/DOCX/CSV/TSV/XLSX extraction", "Table conversion and report generation"],
    },
    {
      id: "extension",
      title: "Extension Builder",
      status: "ready",
      tools: EXTENSION_TOOLS,
      dependencies: [".servus/skills", ".servus/plugins"],
      missing: [],
      notes: [
        "Creates project/user skills and plugin manifests",
        "Bundled plugin skills load into Servus automatically",
      ],
    },
    {
      id: "security",
      title: "Cyber Security",
      status: "ready",
      tools: SECURITY_TOOLS,
      dependencies: ["node fetch", "node tls", "local filesystem"],
      missing: [],
      notes: [
        "Offensive / Defensive / Hybrid modes",
        "Safe recon, OWASP reasoning, headers/TLS, static/dependency/config/log analysis",
        "Class-specific playbooks for JWT, GraphQL, uploads, IDOR, XSS, SSRF, and AI-agent security",
      ],
    },
    {
      id: "providers",
      title: "Providers",
      status: Object.values(keys).some(Boolean) ? "ready" : "blocked",
      tools: [],
      dependencies: Object.keys(keys),
      missing: Object.entries(keys).filter(([, ok]) => !ok).map(([key]) => key),
      notes: Object.entries(keys).map(([key, ok]) => `${ok ? "ok" : "--"} ${shortProviderKey(key)}`),
    },
    {
      id: "skills",
      title: "Skills",
      status: skills.length ? "ready" : "empty",
      tools: [],
      dependencies: [],
      missing: [],
      notes: [`${skills.length} loaded`, "Sources: bundled/project/user/plugin"],
    },
    {
      id: "plugins",
      title: "Plugins",
      status: plugins.length ? "ready" : "empty",
      tools: [],
      dependencies: [],
      missing: [],
      notes: [`${plugins.length} manifests`, "Local plugins first"],
    },
    {
      id: "mcp",
      title: "MCP",
      status: mcpCount ? "configured" : "empty",
      tools: [],
      dependencies: [],
      missing: [],
      notes: [`${mcpCount} configured servers`, "stdio/http client pending"],
    },
  ];
}

function commandAvailable(command: string): boolean {
  try {
    execFileSync("which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function packageAvailable(pkg: string): boolean {
  try {
    require.resolve(pkg);
    return true;
  } catch {
    return false;
  }
}

function desktopDependencies(): string[] {
  if (process.platform === "darwin") return ["open", "mdfind", "pbpaste", "pbcopy", "osascript"];
  return ["xdg-open", "find", "xclip", "gio"];
}

function desktopMissingDependencies(): string[] {
  return desktopDependencies().filter((command) => !commandAvailable(command));
}

function shortProviderKey(key: string): string {
  return key
    .replace("ANTHROPIC_API_KEY", "Anthropic")
    .replace("OPENAI_API_KEY", "OpenAI")
    .replace("GOOGLE_GENERATIVE_AI_API_KEY", "Google GenAI")
    .replace("GOOGLE_API_KEY", "Google API");
}
