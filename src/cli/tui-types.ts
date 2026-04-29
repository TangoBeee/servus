export type TuiView = "home" | "run" | "overlay";

export type TuiOverlay =
  | "commands"
  | "models"
  | "sessions"
  | "agents"
  | "tools"
  | "mcp"
  | "settings"
  | "capabilities"
  | "diff"
  | "help";

export type ComposerMode = "prompt" | "command" | "mention" | "shell";

export interface TuiCommand {
  id: string;
  label: string;
  aliases: string[];
  description: string;
  keybind?: string;
  category: string;
  availability?: "always" | "run" | "coding";
  insertText?: string;
}
