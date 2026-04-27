import { bus } from "./events.js";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");

const A = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
} as const;

export { A as ANSI };

export const log = {
  info(msg: string) {
    if (bus.interactive) {
      bus.push({ type: "info", message: msg });
    } else {
      console.log(`${A.cyan}[servus]${A.reset} ${msg}`);
    }
  },
  success(msg: string) {
    if (bus.interactive) {
      bus.push({ type: "success", message: msg });
    } else {
      console.log(`${A.green}[servus]${A.reset} ${msg}`);
    }
  },
  warn(msg: string) {
    if (bus.interactive) {
      bus.push({ type: "warn", message: msg });
    } else {
      console.log(`${A.yellow}[servus]${A.reset} ${msg}`);
    }
  },
  error(msg: string) {
    if (bus.interactive) {
      bus.push({ type: "error", message: msg });
    } else {
      console.error(`${A.red}[servus]${A.reset} ${msg}`);
    }
  },
  phase(msg: string) {
    if (bus.interactive) {
      bus.push({ type: "phase", message: msg });
    } else {
      const bar = "═".repeat(Math.max(0, 60 - msg.length));
      console.log(`\n${A.bold}${A.magenta}═══ ${msg} ${bar}${A.reset}\n`);
    }
  },
  detail(msg: string) {
    if (bus.interactive) {
      bus.push({ type: "info", message: msg });
    } else {
      console.log(`${A.dim}    ${msg}${A.reset}`);
    }
  },
  agent(name: string, color: string, msg: string) {
    if (bus.interactive) {
      bus.push({ type: "agent:log", agent: name, color, message: msg });
    } else {
      console.log(`${color}[${name}]${A.reset} ${msg}`);
    }
  },
  agentText(name: string, color: string, text: string) {
    if (bus.interactive) {
      bus.push({ type: "agent:text", agent: name, color, message: text });
    } else {
      process.stdout.write(text);
    }
  },
  banner() {
    if (bus.interactive) return; // Ink app renders its own banner
    console.log(`
${A.bold}${A.cyan}  ╔═══════════════════════════════════════════════════╗
  ║                                                   ║
  ║   ███████ ███████ ██████  ██    ██ ██    ██ ███████║
  ║   ██      ██      ██   ██ ██    ██ ██    ██ ██     ║
  ║   ███████ █████   ██████  ██    ██ ██    ██ ███████║
  ║        ██ ██      ██   ██  ██  ██  ██    ██      ██║
  ║   ███████ ███████ ██   ██   ████    ██████  ███████║
  ║                                                   ║
  ║     Autonomous Multi-Agent Engineer v${version}        ║
  ╚═══════════════════════════════════════════════════╝${A.reset}
`);
  },
};

export function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const hrs = Math.floor(mins / 60);
  if (hrs > 0) return `${hrs}h ${mins % 60}m ${secs % 60}s`;
  if (mins > 0) return `${mins}m ${secs % 60}s`;
  return `${secs}s`;
}

export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  const half = Math.floor((maxLen - 60) / 2);
  return (
    str.slice(0, half) +
    `\n\n... [${str.length - maxLen} chars truncated] ...\n\n` +
    str.slice(-half)
  );
}
