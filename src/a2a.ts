/**
 * A2A (Agent-to-Agent) protocol types — inspired by Google's specification.
 *
 * These types model the A2A data structures (Agent Card, Task, Message)
 * for inter-agent communication within Servus.  The current implementation
 * uses in-process routing; the types are designed so that HTTP transport
 * (JSON-RPC 2.0 + SSE) can be layered on later without structural changes.
 *
 * @see https://google.github.io/A2A/specification/
 */

// ─── Agent Card ─────────────────────────────────────────────────────────────

/** Describes an agent's identity, capabilities, and skills. */
export interface AgentCard {
  name: string;
  description: string;
  url?: string;
  version: string;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    stateTransitionHistory: boolean;
  };
  skills: AgentSkill[];
  defaultInputModes: ContentType[];
  defaultOutputModes: ContentType[];
}

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
}

export type ContentType = "text" | "text/plain" | "application/json";

// ─── Task ───────────────────────────────────────────────────────────────────

export type TaskStatus =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "failed"
  | "canceled";

export interface A2ATask {
  id: string;
  sessionId: string;
  status: TaskStatus;
  messages: A2AMessage[];
  artifacts: Artifact[];
  metadata?: Record<string, unknown>;
}

// ─── Message ────────────────────────────────────────────────────────────────

export interface A2AMessage {
  role: "user" | "agent";
  parts: MessagePart[];
  metadata?: Record<string, unknown>;
}

export type MessagePart = TextPart | FilePart | DataPart;

export interface TextPart {
  type: "text";
  text: string;
}

export interface FilePart {
  type: "file";
  file: {
    name?: string;
    mimeType: string;
    bytes?: string; // base64
    uri?: string;
  };
}

export interface DataPart {
  type: "data";
  data: Record<string, unknown>;
}

// ─── Artifact ───────────────────────────────────────────────────────────────

export interface Artifact {
  name: string;
  description?: string;
  parts: MessagePart[];
  index: number;
  append?: boolean;
  lastChunk?: boolean;
  metadata?: Record<string, unknown>;
}

// ─── Agent Cards for Servus Team ────────────────────────────────────────────

export const PLANNER_CARD: AgentCard = {
  name: "Planner",
  description:
    "Software Architect — analyses codebases, maps dependencies, produces deterministic execution plans.",
  version: "2.0.0",
  capabilities: {
    streaming: true,
    pushNotifications: false,
    stateTransitionHistory: true,
  },
  skills: [
    {
      id: "analyse",
      name: "Codebase Analysis",
      description: "Deep structural analysis of any project type",
      tags: ["analysis", "architecture"],
    },
    {
      id: "plan",
      name: "Plan Generation",
      description: "Create ordered execution plans with dependency awareness",
      tags: ["planning", "strategy"],
    },
    {
      id: "init",
      name: "Init Script",
      description: "Generate verification pipeline scripts",
      tags: ["build", "test", "ci"],
    },
  ],
  defaultInputModes: ["text"],
  defaultOutputModes: ["text"],
};

export const DEVELOPER_CARD: AgentCard = {
  name: "Developer",
  description:
    "Senior Developer — implements code changes with production quality, follows Generate-Validate-Fix cycle.",
  version: "2.0.0",
  capabilities: {
    streaming: true,
    pushNotifications: false,
    stateTransitionHistory: true,
  },
  skills: [
    {
      id: "implement",
      name: "Code Implementation",
      description: "Write, edit, and refactor production code",
      tags: ["coding", "implementation"],
    },
    {
      id: "debug",
      name: "Debugging",
      description: "Diagnose and fix bugs from test failures and error logs",
      tags: ["debugging", "testing"],
    },
    {
      id: "refactor",
      name: "Refactoring",
      description: "Restructure code while preserving behavior",
      tags: ["refactoring", "quality"],
    },
  ],
  defaultInputModes: ["text"],
  defaultOutputModes: ["text"],
};

export const TESTER_CARD: AgentCard = {
  name: "Tester",
  description:
    "QA Lead — runs verification pipelines, reviews diffs, detects anti-patterns.",
  version: "2.0.0",
  capabilities: {
    streaming: true,
    pushNotifications: false,
    stateTransitionHistory: true,
  },
  skills: [
    {
      id: "test",
      name: "Test Execution",
      description: "Run lint, typecheck, unit tests, and builds",
      tags: ["testing", "verification"],
    },
    {
      id: "review",
      name: "Code Review",
      description: "Review diffs for quality issues and anti-patterns",
      tags: ["review", "quality"],
    },
  ],
  defaultInputModes: ["text"],
  defaultOutputModes: ["text"],
};

export const MANAGER_CARD: AgentCard = {
  name: "Manager",
  description:
    "Engineering Manager — reviews plans, analyses failures, provides strategic decisions and actionable feedback.",
  version: "2.0.0",
  capabilities: {
    streaming: true,
    pushNotifications: false,
    stateTransitionHistory: true,
  },
  skills: [
    {
      id: "review-plan",
      name: "Plan Review",
      description: "Evaluate execution plans for completeness and risk",
      tags: ["planning", "review"],
    },
    {
      id: "analyse-failure",
      name: "Failure Analysis",
      description: "Root-cause analysis of test/build failures",
      tags: ["debugging", "analysis"],
    },
    {
      id: "feedback",
      name: "Developer Feedback",
      description: "Produce specific, actionable fix guidance",
      tags: ["feedback", "mentoring"],
    },
  ],
  defaultInputModes: ["text"],
  defaultOutputModes: ["text"],
};
