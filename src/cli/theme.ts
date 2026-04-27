export const COLORS = {
  primary: "green",
  secondary: "cyan",
  accent: "yellow",
  violet: "magenta",
  blue: "blue",
  error: "red",
  muted: "gray",
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
