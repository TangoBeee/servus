export const COLORS = {
  primary: "#9fcf8f",
  secondary: "#8ab4c7",
  accent: "#c79b62",
  violet: "#b79adf",
  blue: "#75a7d8",
  error: "#e06c75",
  muted: "#7c7c7c",
  agent: {
    planner: "blue",
    developer: "green",
    tester: "yellow",
    manager: "magenta",
  },
} as const;

export const BANNER = `
  ███████ ███████ ██████  ██    ██ ██    ██ ███████
  ██      ██      ██   ██ ██    ██ ██    ██ ██
  ███████ █████   ██████  ██    ██ ██    ██ ███████
       ██ ██      ██   ██  ██  ██  ██    ██      ██
  ███████ ███████ ██   ██   ████    ██████  ███████`;

export const TAGLINE = "Autonomous Multi-Agent Engineer v2.0";

export const ICONS = {
  check: "\u2713",
  cross: "\u2717",
  dot: "\u2022",
  arrow: "\u25B6",
  working: "\u25CF",
  idle: "\u25CB",
  separator: "\u2502",
  ellipsis: "\u2026",
} as const;

export const SCREEN_ACCENTS: Record<string, string> = {
  launchpad: "green",
  "live-run": "cyan",
  sessions: "yellow",
  capabilities: "magenta",
  plugins: "blue",
  settings: "green",
  background: "yellow",
};
