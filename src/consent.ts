/**
 * Consent Gate — safety layer for risky operations.
 *
 * Provides a mechanism to pause and request user approval before
 * performing irreversible or sensitive actions (payments, deletions,
 * sending emails, etc.).
 */

import { bus } from "./events.js";
import { log } from "./log.js";
import * as readline from "node:readline";

// ─── Risk Levels ────────────────────────────────────────────────────────────

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface ConsentRequest {
  /** What action is being attempted */
  action: string;
  /** Detailed description of what will happen */
  detail: string;
  /** Risk level */
  risk: RiskLevel;
  /** Engine requesting consent */
  engine: string;
}

// ─── Risk Classification ────────────────────────────────────────────────────

/** Patterns that indicate risky operations */
const RISK_PATTERNS: { pattern: RegExp; risk: RiskLevel; label: string }[] = [
  // Critical — financial / account actions
  { pattern: /\b(purchase|payment|checkout|buy|pay|order|subscribe|book|booking|reserve|reservation)\b/i, risk: "critical", label: "Financial transaction or booking" },
  { pattern: /\b(send\s+email|compose\s+email|reply\s+to)\b/i, risk: "critical", label: "Sending email" },
  { pattern: /\b(post\s+to|tweet|publish|submit\s+form)\b/i, risk: "high", label: "Public posting" },
  { pattern: /\b(password|secret|token|api[_-]?key|credential)\b/i, risk: "high", label: "Credential entry or secret access" },

  // High — destructive / irreversible
  { pattern: /\brm\s+-rf\b/, risk: "high", label: "Recursive file deletion" },
  { pattern: /\bsudo\b/, risk: "high", label: "Superuser command" },
  { pattern: /\bcurl\s+.*\|\s*(ba)?sh\b/, risk: "high", label: "Remote script execution" },
  { pattern: /\bformat\s+(disk|drive|volume)\b/i, risk: "critical", label: "Disk formatting" },

  // Medium — potentially sensitive
  { pattern: /\b(upload|send\s+file)\b/i, risk: "medium", label: "File upload" },
];

// ─── Consent API ────────────────────────────────────────────────────────────

/**
 * Assess the risk level of an action based on its description.
 */
export function assessRisk(action: string): { risk: RiskLevel; labels: string[] } {
  const labels: string[] = [];
  let maxRisk: RiskLevel = "low";
  const riskOrder: RiskLevel[] = ["low", "medium", "high", "critical"];

  for (const { pattern, risk, label } of RISK_PATTERNS) {
    if (pattern.test(action)) {
      labels.push(label);
      if (riskOrder.indexOf(risk) > riskOrder.indexOf(maxRisk)) {
        maxRisk = risk;
      }
    }
  }

  return { risk: maxRisk, labels };
}

/**
 * Request user consent for a risky operation.
 *
 * In interactive (TUI) mode: emits a consent:request event and waits for response.
 * In non-interactive mode: auto-approves low/medium, blocks high/critical.
 */
export async function requestConsent(request: ConsentRequest): Promise<boolean> {
  const { action, detail, risk, engine } = request;

  // Emit the consent request event
  bus.push({
    type: "consent:request",
    agent: engine,
    message: `[${risk.toUpperCase()}] ${action}: ${detail}`,
    metadata: { risk, action, detail, engine },
  });

  // Auto-approve low-risk actions
  if (risk === "low") {
    bus.push({ type: "consent:response", message: "auto-approved (low risk)", metadata: { approved: true } });
    return true;
  }

  // In interactive mode, prompt the user
  if (bus.interactive) {
    const handledByUi = await bus.requestApproval({ action, detail, risk, engine });
    if (handledByUi !== undefined) {
      bus.push({
        type: "consent:response",
        message: handledByUi ? "approved by user" : "denied by user",
        metadata: { approved: handledByUi },
      });
      return handledByUi;
    }

    log.warn(`⚠ CONSENT REQUIRED [${risk.toUpperCase()}]`);
    log.warn(`Engine: ${engine}`);
    log.warn(`Action: ${action}`);
    log.warn(`Detail: ${detail}`);

    const approved = await promptUser(`Allow this ${risk}-risk action? (y/n): `);
    const result = approved.toLowerCase().startsWith("y");

    bus.push({
      type: "consent:response",
      message: result ? "approved by user" : "denied by user",
      metadata: { approved: result },
    });

    if (result) {
      log.success("User approved the action.");
    } else {
      log.error("User denied the action.");
    }

    return result;
  }

  // Non-interactive mode: auto-approve medium, block high/critical
  if (risk === "medium") {
    log.warn(`Auto-approving medium-risk action: ${action}`);
    bus.push({ type: "consent:response", message: "auto-approved (medium risk, non-interactive)", metadata: { approved: true } });
    return true;
  }

  // Block high/critical in non-interactive mode
  log.error(`Blocked ${risk}-risk action in non-interactive mode: ${action}`);
  bus.push({
    type: "consent:response",
    message: `blocked (${risk} risk, non-interactive)`,
    metadata: { approved: false },
  });
  return false;
}

// ─── Internal ───────────────────────────────────────────────────────────────

function promptUser(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
