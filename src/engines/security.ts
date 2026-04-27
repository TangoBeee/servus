import { createAgent, type IAgent } from "../agent.js";
import { log, ANSI, formatDuration } from "../log.js";
import { bus } from "../events.js";
import { createSecurityTools } from "../tools-security.js";
import type { Engine, EngineContext, EngineResult } from "../engine.js";
import { detectClarificationRequest, stripProtocolTags } from "../clarification.js";
import { SERVUS_OPERATING_LOOP } from "../prompts/operating-loop.js";
import { resultFromValidatedResponse } from "../agentic-loop.js";

const SECURITY_PROMPT = `
# Role: Cyber Security Agent

You are the Cyber Security Agent in the Servus agent system.
You identify, analyze, and safely validate security issues in systems that the
user explicitly puts in scope.

${SERVUS_OPERATING_LOOP}

## Operational Modes

### Offensive Mode (Red Team)

Purpose: simulate attacker thinking in a safe and authorized environment.

Use for user intent such as "find", "test", "attack", "validate", "audit",
"pentest", "exploit path", "bypass", or "enumerate".

Capabilities:
- Attack surface discovery: endpoints, inputs, services, auth flows.
- Vulnerability discovery: OWASP Top 10 plus advanced logic/config issues.
- Safe exploit simulation: non-destructive validation only.
- Attack chain construction: realistic multi-step risk paths.
- Business logic abuse analysis.
- Authentication and authorization weakness testing by reasoning and safe checks.

### Defensive Mode (Blue Team)

Purpose: protect systems, detect threats, and help developers fix issues.

Use for user intent such as "fix", "secure", "prevent", "harden", "patch",
"detect", "monitor", "alert", "remediate", or "comply".

Capabilities:
- Vulnerability remediation and secure code/config guidance.
- Misconfiguration detection for apps, APIs, servers, and cloud-like config.
- Threat detection logic from logs, anomalies, and patterns.
- Monitoring and alerting strategies.
- Prevention techniques and compliance mapping.

### Hybrid Mode

Use when the task asks for both finding/testing and fixing/preventing.
Run Offensive first, then Defensive. For every vulnerability found:
1. Identify and safely validate the issue.
2. Immediately explain impact.
3. Provide fixes.
4. Suggest prevention, monitoring, and detection strategies.

## Safety Contract

- Only operate on explicit targets provided by the user.
- Do not scan ranges, brute force, exploit destructively, persist access, evade detection,
  exfiltrate data, or use credentials.
- Use safe evidence collection only: headers, TLS details, single-URL probes,
  local static scans, and developer-readable reasoning.
- If scope is unclear, ask one concise question before testing.
- Clearly label uncertainty and confidence.

## Tools

- security_readiness: describe available safe security capabilities.
- security_scope_check: verify an explicit target.
- security_http_probe: fetch one explicit URL safely.
- security_header_audit: check common web security headers.
- security_tls_summary: summarize TLS certificate/protocol data.
- security_static_secrets_scan: scan local project files for likely secrets with masked values.
- security_mode_plan: explain Offensive/Defensive/Hybrid mode selection.
- security_playbook: choose safe class-specific checklists for JWT, GraphQL, uploads, IDOR, XSS, injection, SSRF, race/business logic, AI security, and rapid triage.
- security_attack_surface_map: safely inventory one URL or local code path.
- security_static_code_scan: local static code security pattern scan.
- security_dependency_audit: local dependency manifest audit with offline evidence.
- security_config_audit: local configuration hardening checks.
- security_log_analysis: local log review for suspicious patterns and detection ideas.
- security_create_report: write a markdown security report artifact.

## Playbook Discipline

Use focused playbooks before class-specific analysis. If the task mentions JWT,
GraphQL, file uploads, IDOR/access control, XSS, injection, SSRF, race/business
logic, or AI-agent security, call security_playbook first and use its checklist
to structure your work.

The playbooks are methodology only. Do not invent or provide destructive payloads,
evasion steps, persistence, credential theft, malware, or exfiltration instructions.
For each checklist item, track whether it is confirmed, not found, or needs more
scope. Tie every finding to evidence, impact, remediation, and detection.

## Workflow

1. Target Understanding: identify app/API/local repo/system type and scope.
2. Reconnaissance: enumerate only safe, explicit URLs/files/endpoints provided or discovered from the target response.
3. Vulnerability Analysis: reason about OWASP Top 10, authz/authn, IDOR, injection, XSS, misconfig, sensitive exposure.
4. Exploit Validation: use non-destructive evidence. Do not submit harmful payloads.
5. Attack Chain Reasoning: combine findings into realistic but safe escalation paths.
6. Remediation: provide developer-friendly fixes and config/code guidance.
7. Reporting: produce a professional structured report.

## Enhanced Output Format

Every final response must include:

Mode Used (Offensive / Defensive / Hybrid)
Target Summary
Attack Surface Overview
Findings (with severity: Low / Medium / High / Critical)
Exploit Validation (safe)
Attack Chain (if applicable)
Impact
Remediation Steps
Prevention Strategies
Confidence Level (High / Medium / Low)

When complete, call \`servus_done\` with scope, findings, and safe evidence.

If a required target/scope detail is missing, call \`servus_need_input\` and ask one clear question.
`.trim();

export class SecurityEngine implements Engine {
  readonly name = "security";
  readonly description =
    "Performs safe, explicit-scope security reconnaissance, vulnerability analysis, validation, and reporting.";

  private agent: IAgent | null = null;

  async execute(ctx: EngineContext): Promise<EngineResult> {
    const startTime = Date.now();
    const mode = inferSecurityMode(ctx.task);

    try {
      this.agent = await createAgent(ctx.backend, {
        name: "Security",
        role: "cyber-security",
        color: ANSI.magenta,
        model: ctx.model,
        prompt: SECURITY_PROMPT,
        extraTools: createSecurityTools(ctx) as Record<string, unknown>,
        disallowedTools: ["bash", "write", "edit", "patch", "webfetch"],
        sessionId: ctx.sessionId,
      }, { cwd: ctx.cwd });

      log.success("Cyber Security agent initialized");
      bus.push({
        type: "runtime:state",
        agent: "Security",
        message: `Security mode: ${mode}`,
        metadata: { securityMode: mode },
      });
      this.emitStatus("working");

      const response = await this.agent.send([
        "## Security Task",
        ctx.task,
        "",
        "## Selected Operational Mode",
        mode,
        "",
        modeGuidance(mode),
        "",
        "## Working Directory",
        "`" + ctx.cwd + "`",
        "",
        "Perform only safe, authorized, explicit-scope testing.",
        "Call servus_done with scope, findings, and safe evidence when finished.",
        "If the target/scope is missing or ambiguous, call servus_need_input and ask one question.",
      ].join("\n"));

      const cost = this.agent.cost;
      const elapsed = Date.now() - startTime;
      const clarification = detectClarificationRequest(response.text, ctx.task);
      const cleaned = stripProtocolTags(response.text);
      const finalized = resultFromValidatedResponse(ctx, "security", response);
      if (finalized) {
        this.emitStatus(finalized.needsInput ? "waiting_input" : finalized.success ? "done" : "error");
        return finalized;
      }

      if (clarification) {
        log.warn("Security task is waiting for user input.");
        this.emitStatus("waiting_input");
        return {
          success: false,
          needsInput: true,
          summary: clarification.message,
          question: clarification.message,
          questions: clarification.questions,
          questionContext: clarification.context,
          clarification,
          cost,
          error: "Needs user input",
        };
      }

      if (response.text.includes("<task_status>DONE</task_status>")) {
        this.emitStatus("done");
        log.success("Security task completed in " + formatDuration(elapsed));
        return {
          success: true,
          summary: cleaned,
          cost,
        };
      }

      this.emitStatus("error");
      return {
        success: false,
        summary: "Security agent did not complete the task within the allowed turns.",
        cost,
        error: "Agent did not signal DONE",
      };
    } catch (err) {
      this.emitStatus("error");
      return {
        success: false,
        summary: "Security engine failed: " + (err instanceof Error ? err.message : String(err)),
        cost: this.agent?.cost ?? 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  close(): void {
    this.agent?.close();
  }

  private emitStatus(status: "working" | "waiting_input" | "done" | "error"): void {
    bus.push({
      type: "agent:status",
      agent: "Security",
      message: status,
    });
  }
}

type SecurityMode = "Offensive" | "Defensive" | "Hybrid";

function inferSecurityMode(task: string): SecurityMode {
  const text = task.toLowerCase();
  const offensive =
    /\b(find|test|attack|attacker|red\s*team|pentest|penetration|exploit|validate|bypass|enumerate|recon|surface|vulnerabilit|owasp|xss|sqli|idor|csrf)\b/.test(text);
  const defensive =
    /\b(fix|secure|prevent|defend|blue\s*team|harden|patch|remediate|monitor|detect|alert|logging|siem|compliance|mitigate|protect)\b/.test(text);
  if (offensive && defensive) return "Hybrid";
  if (defensive) return "Defensive";
  return "Offensive";
}

function modeGuidance(mode: SecurityMode): string {
  if (mode === "Hybrid") {
    return [
      "Run Offensive analysis first to identify and safely validate findings.",
      "Then switch immediately to Defensive analysis for each finding: impact, fixes, prevention, monitoring, and detection.",
      "Do not defer remediation to a separate section without tying it to each vulnerability.",
    ].join("\n");
  }
  if (mode === "Defensive") {
    return [
      "Prioritize remediation, hardening, detection logic, monitoring, and developer-friendly fixes.",
      "Use offensive reasoning only to explain how the issue would be abused and detected.",
    ].join("\n");
  }
  return [
    "Prioritize safe attack surface discovery, vulnerability discovery, non-destructive validation, and attack-chain reasoning.",
    "For every validated or suspected issue, still include defensive fixes and prevention strategies.",
  ].join("\n");
}
