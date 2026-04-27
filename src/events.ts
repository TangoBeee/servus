import { EventEmitter } from "node:events";

export type ServusEventType =
  | "agent:log"
  | "agent:text"
  | "agent:tool_call"
  | "agent:tool_result"
  | "agent:status"
  | "agent:error"
  | "engine:start"
  | "engine:complete"
  | "engine:needs_input"
  | "engine:error"
  | "runtime:state"
  | "context:compact"
  | "tool:start"
  | "tool:finish"
  | "approval:request"
  | "approval:response"
  | "user_input:request"
  | "user_input:response"
  | "artifact:add"
  | "skill:load"
  | "plugin:load"
  | "consent:request"
  | "consent:response"
  | "phase"
  | "task:start"
  | "task:complete"
  | "task:fail"
  | "verification"
  | "cost"
  | "complete"
  | "error"
  | "info"
  | "warn"
  | "success";

export interface ServusEvent {
  type: ServusEventType;
  agent?: string;
  color?: string;
  message: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface ApprovalRequestPayload {
  action: string;
  detail: string;
  risk: "low" | "medium" | "high" | "critical";
  engine: string;
}

class ServusBus extends EventEmitter {
  private _interactive = false;
  private approvalHandler: ((request: ApprovalRequestPayload) => Promise<boolean>) | null = null;

  get interactive() {
    return this._interactive;
  }

  set interactive(v: boolean) {
    this._interactive = v;
  }

  setApprovalHandler(handler: ((request: ApprovalRequestPayload) => Promise<boolean>) | null) {
    this.approvalHandler = handler;
  }

  async requestApproval(request: ApprovalRequestPayload): Promise<boolean | undefined> {
    this.push({
      type: "approval:request",
      agent: request.engine,
      message: `[${request.risk.toUpperCase()}] ${request.action}: ${request.detail}`,
      metadata: { ...request },
    });

    if (!this.approvalHandler) return undefined;

    const approved = await this.approvalHandler(request);
    this.push({
      type: "approval:response",
      agent: request.engine,
      message: approved ? "approved" : "denied",
      metadata: { ...request, approved },
    });
    return approved;
  }

  push(event: Omit<ServusEvent, "timestamp">) {
    const full: ServusEvent = { ...event, timestamp: Date.now() };
    this.emit("event", full);
    return full;
  }
}

export const bus = new ServusBus();
