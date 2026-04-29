import { EventEmitter } from "node:events";

export type ServusEventType =
  | "agent:log"
  | "agent:text"
  | "assistant:message"
  | "assistant:delta"
  | "agent:tool_call"
  | "agent:tool_result"
  | "agent:status"
  | "agent:working_note"
  | "agent:blocker"
  | "agent:error"
  | "engine:start"
  | "engine:complete"
  | "engine:needs_input"
  | "engine:error"
  | "runtime:state"
  | "domain:workflow_state"
  | "session:hydrated"
  | "session:start"
  | "evidence:add"
  | "context:compact"
  | "context:usage"
  | "tool:start"
  | "tool:finish"
  | "approval:request"
  | "approval:response"
  | "user_input:request"
  | "user_input:response"
  | "artifact:add"
  | "coding:intent"
  | "coding:question"
  | "coding:question_skipped"
  | "coding:assumption"
  | "coding:workspace_policy"
  | "coding:todo_update"
  | "coding:plan_update"
  | "coding:plan_ready"
  | "coding:reminder"
  | "coding:verification_verdict"
  | "coding:helper_start"
  | "coding:helper_finish"
  | "coding:checkpoint"
  | "coding:diff"
  | "coding:verify_start"
  | "coding:verify_finish"
  | "coding:repair"
  | "coding:review"
  | "coding:revert"
  | "coding:memory"
  | "coding:settings"
  | "coding:hook"
  | "agent:hook"
  | "coding:attachment"
  | "coding:user_message"
  | "coding:turn_start"
  | "coding:turn_finish"
  | "coding:final_summary"
  | "coding:completed"
  | "coding:failed"
  | "coding:orienting"
  | "coding:discovering"
  | "coding:planning"
  | "coding:editing"
  | "coding:verifying"
  | "coding:repairing"
  | "coding:reviewing"
  | "coding:waiting_input"
  | "skill:load"
  | "plugin:load"
  | "consent:request"
  | "consent:response"
  | "mcp:status"
  | "mcp:progress"
  | "mcp:auth_required"
  | "mcp:test_result"
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
