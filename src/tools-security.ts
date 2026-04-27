import { tool } from "ai";
import { z } from "zod";
import { connect } from "node:tls";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { assessRisk, requestConsent } from "./consent.js";
import type { EngineContext } from "./engine.js";

const MAX_BODY_BYTES = 80_000;
const MAX_SCAN_FILES = 600;
const MAX_FILE_BYTES = 1_000_000;

type SecurityToolContext = Pick<EngineContext, "cwd" | "onConsent">;

interface SecurityPlaybook {
  id: string;
  title: string;
  triggers: string[];
  summary: string;
  checklist: string[];
  evidence: string[];
  safeValidation: string[];
  defensiveActions: string[];
  detectionIdeas: string[];
  standards: string[];
}

const targetUrlSchema = z.object({
  url: z.string().describe("Explicit http(s) target URL provided by the user."),
  includeBody: z.boolean().optional().describe("Include a small text preview of the response body."),
  maxBytes: z.number().int().positive().max(MAX_BODY_BYTES).optional(),
});

const tlsSchema = z.object({
  host: z.string().describe("Explicit hostname to inspect. No wildcards or ranges."),
  port: z.number().int().min(1).max(65535).optional(),
});

const secretsScanSchema = z.object({
  path: z.string().optional().describe("Project-relative path to scan. Defaults to cwd."),
  maxFiles: z.number().int().positive().max(2_000).optional(),
});

const securityModeSchema = z.enum(["Offensive", "Defensive", "Hybrid"]);

const modePlanSchema = z.object({
  task: z.string().describe("The user's security task."),
});

const playbookSchema = z.object({
  topic: z.string().optional().describe("Security topic or vulnerability class, such as jwt, graphql, upload, idor, ssrf, xss, ai security, or rapid triage."),
  mode: securityModeSchema.optional(),
  targetType: z.string().optional().describe("Optional context such as web app, API, local repo, mobile backend, AI agent, or cloud config."),
});

const attackSurfaceSchema = z.object({
  target: z.string().describe("Explicit target URL or local project path."),
  maxBytes: z.number().int().positive().max(MAX_BODY_BYTES).optional(),
  maxFiles: z.number().int().positive().max(2_000).optional(),
});

const staticCodeScanSchema = z.object({
  path: z.string().optional().describe("Project-relative path to scan. Defaults to cwd."),
  maxFiles: z.number().int().positive().max(2_000).optional(),
});

const dependencyAuditSchema = z.object({
  path: z.string().optional().describe("Project path containing dependency manifests. Defaults to cwd."),
});

const configAuditSchema = z.object({
  path: z.string().optional().describe("Project-relative path to audit for security-sensitive config. Defaults to cwd."),
  maxFiles: z.number().int().positive().max(2_000).optional(),
});

const logAnalysisSchema = z.object({
  path: z.string().describe("Project-relative path to a log file."),
  maxLines: z.number().int().positive().max(50_000).optional(),
});

const reportSchema = z.object({
  title: z.string(),
  modeUsed: securityModeSchema.optional(),
  targetSummary: z.string(),
  attackSurfaceOverview: z.string().optional(),
  findings: z.array(z.object({
    title: z.string(),
    severity: z.enum(["Low", "Medium", "High", "Critical"]),
    details: z.string(),
    proofOfConcept: z.string().optional(),
    exploitValidation: z.string().optional(),
    attackChain: z.string().optional(),
    impact: z.string(),
    remediation: z.string(),
    preventionStrategies: z.string().optional(),
    confidence: z.enum(["Low", "Medium", "High"]),
  })),
  outputPath: z.string().optional().describe("Optional markdown path. Defaults to .servus-security-reports/<timestamp>.md."),
  overwrite: z.boolean().optional(),
});

const SECRET_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: "OpenAI API key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { label: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g },
  { label: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/g },
  { label: "Private key block", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { label: "Generic secret assignment", pattern: /\b(?:secret|token|api[_-]?key|password)\b\s*[:=]\s*["'][^"'\n]{12,}["']/gi },
];

const CODE_PATTERNS: Array<{ label: string; severity: string; pattern: RegExp; guidance: string }> = [
  {
    label: "Possible command injection sink",
    severity: "High",
    pattern: /\b(exec|spawn|execSync|spawnSync)\s*\([^)\n]*(req\.|request\.|params|query|body|input|argv|env)/gi,
    guidance: "Avoid shell execution with user-controlled input. Use argument arrays, allowlists, and strict validation.",
  },
  {
    label: "Possible SQL injection via string concatenation",
    severity: "High",
    pattern: /\b(query|execute|raw)\s*\([^)\n]*(\+|\$\{)[^)\n]*(req\.|request\.|params|query|body|input)/gi,
    guidance: "Use parameterized queries or ORM bind parameters.",
  },
  {
    label: "Possible XSS sink",
    severity: "Medium",
    pattern: /\b(innerHTML|outerHTML|dangerouslySetInnerHTML|document\.write)\b/gi,
    guidance: "Use safe DOM APIs, framework escaping, and sanitization for trusted HTML only.",
  },
  {
    label: "Dynamic code execution",
    severity: "High",
    pattern: /\b(eval|new Function)\s*\(/gi,
    guidance: "Remove dynamic code execution or strictly sandbox and validate inputs.",
  },
  {
    label: "TLS verification disabled",
    severity: "High",
    pattern: /\brejectUnauthorized\s*:\s*false\b|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0/gi,
    guidance: "Do not disable TLS verification outside isolated local tests.",
  },
  {
    label: "Weak password hashing primitive",
    severity: "Medium",
    pattern: /\b(createHash\s*\(\s*['"](md5|sha1)['"]|MD5|SHA1)\b/gi,
    guidance: "Use Argon2id, bcrypt, or scrypt for passwords; SHA-256/HMAC for non-password integrity use cases.",
  },
  {
    label: "JWT decoded without verification",
    severity: "High",
    pattern: /\bjwt\.decode\s*\(/gi,
    guidance: "Decode only for display. Authorization decisions must use verified signatures, issuer, audience, expiry, and an algorithm allowlist.",
  },
  {
    label: "GraphQL introspection or explorer enabled",
    severity: "Medium",
    pattern: /\b(introspection|graphiql|playground)\s*:\s*true\b/gi,
    guidance: "Restrict production introspection/explorer access and enforce authorization, query limits, and monitoring.",
  },
  {
    label: "File upload handling requires hardening review",
    severity: "Low",
    pattern: /\b(multer|busboy|formidable|graphqlUploadExpress|graphql-upload|originalname)\b/gi,
    guidance: "Use allowlisted MIME/content validation, random server filenames, storage outside executable paths, size limits, and malware scanning.",
  },
  {
    label: "Server-side URL fetch from user-controlled input",
    severity: "High",
    pattern: /\b(fetch|axios\.(?:get|post|request)|got|request)\s*\([^)\n]*(req\.|request\.|params|query|body|input)/gi,
    guidance: "Prevent SSRF with URL allowlists, DNS/IP checks, metadata-IP blocking, redirect limits, and egress policy.",
  },
  {
    label: "LLM prompt or tool input may include untrusted user data",
    severity: "Medium",
    pattern: /\b(prompt|systemPrompt|messages|toolCall|tool_call|agent)\b[^;\n]*(req\.|request\.|params|query|body|input|document|content)/gi,
    guidance: "Separate trusted instructions from untrusted content, validate tool schemas, restrict tools by task, and log model/tool decisions.",
  },
];

const CONFIG_PATTERNS: Array<{ label: string; severity: string; pattern: RegExp; guidance: string }> = [
  {
    label: "Wildcard CORS origin",
    severity: "Medium",
    pattern: /\b(cors|allowOrigins?|allowedOrigins?)\b[^\\n]*(\*|true)/gi,
    guidance: "Restrict CORS origins to explicit trusted origins and avoid credentials with wildcard origins.",
  },
  {
    label: "Debug mode enabled",
    severity: "Medium",
    pattern: /\b(debug|devMode|verbose)\b\s*[:=]\s*(true|1|on)/gi,
    guidance: "Disable debug output in production and avoid leaking stack traces or secrets.",
  },
  {
    label: "Cookie secure flag disabled",
    severity: "Medium",
    pattern: /\bsecure\b\s*[:=]\s*false/gi,
    guidance: "Set secure cookies over HTTPS and pair SameSite=None with Secure.",
  },
  {
    label: "Permissive host binding",
    severity: "Low",
    pattern: /\b(host|bind|listen)\b\s*[:=]\s*['"]?(0\.0\.0\.0|\*)/gi,
    guidance: "Bind only required interfaces or protect public listeners with network policy.",
  },
  {
    label: "Hardcoded default credential marker",
    severity: "High",
    pattern: /\b(admin|root|user)\b\s*[:=]\s*['"]?(admin|password|changeme|default|root)['"]?/gi,
    guidance: "Remove default credentials and enforce secret injection through a managed secret store.",
  },
  {
    label: "Permissive GraphQL development surface",
    severity: "Medium",
    pattern: /\b(introspection|graphiql|playground)\b\s*[:=]\s*(true|1|on)/gi,
    guidance: "Disable public development helpers or restrict them to authenticated internal users.",
  },
  {
    label: "Weak cookie same-site posture",
    severity: "Medium",
    pattern: /\bsameSite\b\s*[:=]\s*['"]?(none|false)['"]?/gi,
    guidance: "Use Lax or Strict where possible. If SameSite=None is required, pair it with Secure and CSRF protections.",
  },
];

const SECURITY_PLAYBOOKS: SecurityPlaybook[] = [
  {
    id: "rapid-triage",
    title: "Rapid Security Triage",
    triggers: ["quick", "fast", "triage", "overview", "first pass", "audit"],
    summary: "A short, evidence-first pass for understanding scope, exposed surfaces, and likely high-risk areas before deeper testing.",
    checklist: [
      "Confirm explicit authorized scope and target type.",
      "Identify public entry points, APIs, forms, auth flows, file inputs, and background jobs.",
      "Collect safe evidence: headers, TLS summary, response status, routes, dependency manifests, and config files.",
      "Separate confirmed findings from hypotheses and questions.",
      "Prioritize issues by exploitability, data sensitivity, privilege boundary, and business impact.",
    ],
    evidence: [
      "Target URL/path and timestamp.",
      "Endpoint or file reference for each observation.",
      "Observed status/header/config/code line without secrets.",
      "Reason the issue matters and what remains unverified.",
    ],
    safeValidation: [
      "Use read-only probes and local static scans.",
      "Avoid brute force, broad scanning, destructive state changes, or bypass payloads.",
      "Stop and ask for authorization when scope or credentials are unclear.",
    ],
    defensiveActions: [
      "Create a remediation backlog grouped by owner and blast radius.",
      "Add regression tests for confirmed classes.",
      "Add secure defaults and CI checks for repeated mistakes.",
    ],
    detectionIdeas: [
      "Dashboard unusual 4xx/5xx spikes by endpoint.",
      "Alert on auth failures followed by privileged access.",
      "Track high-risk config changes and dependency drift.",
    ],
    standards: ["OWASP ASVS", "OWASP Top 10", "CWE Top 25"],
  },
  {
    id: "auth-session",
    title: "Authentication, Session, And Authorization Review",
    triggers: ["auth", "login", "session", "cookie", "mfa", "password", "authorization", "role", "permission"],
    summary: "Review identity boundaries, session handling, role enforcement, and account lifecycle controls.",
    checklist: [
      "Map login, logout, signup, reset, MFA, token refresh, and privilege-change flows.",
      "Check server-side authorization on every object, tenant, and role boundary.",
      "Review session rotation, expiration, revocation, cookie flags, and CSRF protections.",
      "Look for mass assignment, default roles, hidden admin paths, and overbroad API scopes.",
      "Confirm rate limiting and monitoring on auth-sensitive operations.",
    ],
    evidence: [
      "Route/controller references for auth decisions.",
      "Cookie/session/token configuration.",
      "Role and tenant checks near data access.",
      "Logs or tests proving blocked unauthorized access.",
    ],
    safeValidation: [
      "Compare allowed versus denied behavior with non-privileged test accounts only when explicitly provided.",
      "Use static code review when credentials are not provided.",
      "Do not brute force, credential stuff, or bypass MFA.",
    ],
    defensiveActions: [
      "Centralize authorization checks and deny by default.",
      "Use secure cookie defaults, session rotation, and revocation.",
      "Add role/tenant regression tests around every sensitive endpoint.",
    ],
    detectionIdeas: [
      "Alert on repeated auth failures, reset attempts, and MFA failures.",
      "Alert on access-denied events followed by success on related objects.",
      "Log admin and cross-tenant access with user, tenant, object, and reason.",
    ],
    standards: ["OWASP ASVS V2", "OWASP ASVS V3", "OWASP API Top 10 API1/API5"],
  },
  {
    id: "jwt",
    title: "JWT And Token Security Review",
    triggers: ["jwt", "bearer", "token", "jwks", "jwk", "jku", "kid", "alg", "claims", "oauth"],
    summary: "Check token verification, key trust, claims validation, storage, transport, and lifecycle.",
    checklist: [
      "Confirm all authorization decisions use verified tokens, not decoded-only token contents.",
      "Enforce a small algorithm allowlist and expected key source.",
      "Validate issuer, audience, expiry, not-before, subject, tenant, and scope claims.",
      "Review key rotation, token revocation, refresh-token handling, and replay controls.",
      "Avoid storing sensitive data in readable token claims unless encrypted.",
    ],
    evidence: [
      "Token library calls and verification options.",
      "Claim validation code and middleware order.",
      "JWKS/key configuration and allowed issuers.",
      "Cookie/local-storage/header transport decisions.",
    ],
    safeValidation: [
      "Decode tokens only for inspection when the user provides them.",
      "Do not forge, replay, or tamper with tokens against live systems.",
      "Prefer code/config review and test recommendations.",
    ],
    defensiveActions: [
      "Use a maintained JWT/OIDC library with explicit verification options.",
      "Treat token claims as untrusted until verification and claim checks pass.",
      "Add tests for expired, wrong-audience, wrong-issuer, and missing-scope tokens.",
    ],
    detectionIdeas: [
      "Alert on rejected tokens by reason and source.",
      "Monitor token reuse after revocation or password reset.",
      "Track high failure rates for issuer/audience/signature checks.",
    ],
    standards: ["OWASP ASVS V2", "OWASP API Top 10 API2", "CWE-287"],
  },
  {
    id: "graphql",
    title: "GraphQL API Security Review",
    triggers: ["graphql", "apollo", "hasura", "schema", "query", "mutation", "subscription", "introspection", "relay"],
    summary: "Review GraphQL schema exposure, field authorization, query cost, batching, upload, and subscriptions.",
    checklist: [
      "Inventory GraphQL endpoints, schema exposure, queries, mutations, and subscriptions.",
      "Confirm field-level and object-level authorization for sensitive resolvers.",
      "Apply query depth, complexity, timeout, and rate limits.",
      "Review batching, file upload, and subscription channels for auth and resource controls.",
      "Avoid leaking sensitive schema, errors, or internal object identifiers.",
    ],
    evidence: [
      "GraphQL server configuration.",
      "Resolver authorization checks.",
      "Query limiting configuration.",
      "Schema or generated types with sensitive fields marked for review.",
    ],
    safeValidation: [
      "Use schema/config review and ordinary introspection policy checks.",
      "Do not send resource-exhaustion queries or abusive batches.",
      "Ask for an API sandbox before dynamic validation.",
    ],
    defensiveActions: [
      "Centralize resolver authorization and test per role/tenant.",
      "Enable depth/complexity limits, persisted queries where suitable, and safe errors.",
      "Disable public developer tooling unless intentionally exposed behind auth.",
    ],
    detectionIdeas: [
      "Alert on unusually deep or costly queries.",
      "Track mutation failures and authorization denials by field.",
      "Monitor batching volume and subscription fan-out.",
    ],
    standards: ["OWASP GraphQL Cheat Sheet", "OWASP API Top 10 API1/API4/API6"],
  },
  {
    id: "file-upload",
    title: "File Upload And Import Review",
    triggers: ["upload", "file", "attachment", "avatar", "import", "archive", "csv import", "media upload"],
    summary: "Review upload validation, storage, processing, archive extraction, and download paths.",
    checklist: [
      "Allowlist file types by content and business need, not extension alone.",
      "Store uploads outside executable paths with random server-side names.",
      "Enforce size, count, archive depth, and processing time limits.",
      "Strip dangerous metadata and scan untrusted uploads where appropriate.",
      "Protect download URLs with auth, tenant checks, and short-lived access where needed.",
    ],
    evidence: [
      "Upload middleware/config and validation code.",
      "Storage path construction and naming.",
      "Processing pipeline and queue limits.",
      "Access-control checks for uploaded objects.",
    ],
    safeValidation: [
      "Use fixture files in local/dev environments only.",
      "Do not upload executable, evasive, or malware-like content.",
      "Prefer static review when only production is in scope.",
    ],
    defensiveActions: [
      "Use content sniffing, allowlists, random names, and non-executable storage.",
      "Normalize paths and block archive traversal.",
      "Add malware scanning and quarantine workflows when risk warrants.",
    ],
    detectionIdeas: [
      "Alert on rejected file types, large archives, repeated failures, and processing errors.",
      "Log upload owner, object id, size, hash, content type, and scanner verdict.",
    ],
    standards: ["OWASP File Upload Cheat Sheet", "CWE-434", "CWE-22"],
  },
  {
    id: "idor-access-control",
    title: "IDOR And Object Authorization Review",
    triggers: ["idor", "bola", "bfla", "object id", "tenant", "access control", "authorization bypass", "horizontal", "vertical"],
    summary: "Review object ownership, tenant isolation, and function-level authorization.",
    checklist: [
      "Map every object identifier in routes, queries, bodies, and background actions.",
      "Confirm server-side ownership/tenant checks before every read or write.",
      "Review role transitions, admin-only functions, exports, and bulk endpoints.",
      "Check mass assignment and over-posting risks around role or owner fields.",
      "Verify denied attempts are logged without leaking sensitive object data.",
    ],
    evidence: [
      "Route and data-access references for object checks.",
      "Role/tenant middleware order.",
      "Tests showing denied cross-object and cross-role access.",
    ],
    safeValidation: [
      "Use provided test accounts only and avoid accessing real third-party data.",
      "When accounts are unavailable, produce a code-review finding with confidence.",
    ],
    defensiveActions: [
      "Resolve object by both id and owner/tenant in the same query.",
      "Use policy helpers and deny-by-default authorization.",
      "Add role/tenant regression tests for list, detail, update, delete, and export paths.",
    ],
    detectionIdeas: [
      "Alert on repeated 403s across many object ids.",
      "Monitor admin or export actions by role and tenant.",
      "Log authorization denials with normalized object type, not sensitive values.",
    ],
    standards: ["OWASP API Top 10 API1/API5", "OWASP ASVS V4", "CWE-639"],
  },
  {
    id: "xss-output-handling",
    title: "XSS And Output Handling Review",
    triggers: ["xss", "cross-site scripting", "html", "dom", "csp", "sanitizer", "innerhtml", "template"],
    summary: "Review untrusted content rendering, contextual escaping, sanitization, and browser containment.",
    checklist: [
      "Inventory places where user, CMS, markdown, or external content reaches HTML, JS, URL, or CSS contexts.",
      "Prefer framework escaping and safe DOM APIs.",
      "Use a maintained sanitizer for intended rich HTML and configure allowed tags/attributes narrowly.",
      "Avoid dangerous DOM sinks and inline script patterns.",
      "Use CSP as a blast-radius reduction control, not the primary fix.",
    ],
    evidence: [
      "Source-to-sink path for untrusted content.",
      "Rendering component or template reference.",
      "Sanitizer configuration and CSP header.",
    ],
    safeValidation: [
      "Do not inject active scripts into live systems.",
      "Use static source/sink review and local harmless render fixtures.",
    ],
    defensiveActions: [
      "Replace unsafe sinks with text rendering or sanitized rich-text components.",
      "Add encoding/sanitizer regression tests.",
      "Tighten CSP and remove inline script allowances where possible.",
    ],
    detectionIdeas: [
      "Log sanitizer drops and blocked CSP reports.",
      "Monitor unusual script-error bursts or CSP report spikes by path.",
    ],
    standards: ["OWASP Top 10 A03", "CWE-79", "OWASP XSS Prevention Cheat Sheet"],
  },
  {
    id: "injection",
    title: "Injection Review",
    triggers: ["sqli", "sql injection", "command injection", "nosql", "ldap", "template injection", "ssti", "injection"],
    summary: "Review interpreter boundaries where user-controlled data reaches SQL, shell, templates, expressions, or query languages.",
    checklist: [
      "Inventory all database, shell, template, expression, and search-query sinks.",
      "Verify parameterized APIs or safe argument arrays are used.",
      "Apply allowlists for commands, fields, sort keys, filters, and operators.",
      "Avoid exposing raw interpreter errors to users.",
      "Add negative tests around every high-risk sink.",
    ],
    evidence: [
      "Sink reference and user-controlled source path.",
      "Parameterization or allowlist code.",
      "Error handling behavior and tests.",
    ],
    safeValidation: [
      "Do not run destructive or time-delay payloads.",
      "Use code review, safe fixtures, and test-environment-only validation.",
    ],
    defensiveActions: [
      "Replace concatenation with bind parameters or typed query builders.",
      "Use execFile/spawn argument arrays instead of shell strings.",
      "Centralize validation for field/operator allowlists.",
    ],
    detectionIdeas: [
      "Alert on interpreter error spikes and rejected operator/field values.",
      "Monitor command execution failures and unusual query shapes.",
    ],
    standards: ["OWASP Top 10 A03", "CWE-89", "CWE-78"],
  },
  {
    id: "ssrf-egress",
    title: "SSRF And Egress Control Review",
    triggers: ["ssrf", "webhook", "url fetch", "callback", "metadata", "egress", "proxy"],
    summary: "Review server-side URL fetching, callbacks, webhooks, and outbound network controls.",
    checklist: [
      "Identify all server-side fetchers for URLs provided by users, partners, or documents.",
      "Use destination allowlists for business-approved hosts and schemes.",
      "Block local, private, link-local, metadata, and unexpected redirected destinations.",
      "Resolve and validate DNS/IP at connect time and limit redirects.",
      "Route outbound fetches through monitored egress where possible.",
    ],
    evidence: [
      "URL fetch code path and input source.",
      "Allowlist and IP-range validation logic.",
      "Redirect, timeout, method, and response-size controls.",
    ],
    safeValidation: [
      "Do not target internal services or metadata endpoints.",
      "Use local test fixtures or static review for proof.",
    ],
    defensiveActions: [
      "Implement scheme/host allowlists and IP-range deny checks.",
      "Set strict timeouts, response-size limits, and redirect limits.",
      "Use egress proxy policy for high-risk services.",
    ],
    detectionIdeas: [
      "Alert on outbound requests to private, link-local, or newly seen destinations.",
      "Track failures from URL preview, webhook, and import features.",
    ],
    standards: ["OWASP Top 10 A10", "CWE-918", "OWASP SSRF Prevention Cheat Sheet"],
  },
  {
    id: "race-logic",
    title: "Race Condition And Business Logic Review",
    triggers: ["race", "toctou", "double spend", "logic", "coupon", "checkout", "idempotency", "quota", "workflow"],
    summary: "Review state transitions, idempotency, locking, quotas, and workflow assumptions.",
    checklist: [
      "Map money, inventory, quota, permission, and booking state transitions.",
      "Confirm server-side idempotency for retries and duplicate submissions.",
      "Review transaction boundaries and lock/isolation behavior.",
      "Enforce business rules server-side at the final write point.",
      "Look for async workers that trust stale or client-provided state.",
    ],
    evidence: [
      "State transition code and database transaction scope.",
      "Idempotency key handling.",
      "Queue/worker assumptions and retry behavior.",
    ],
    safeValidation: [
      "Do not attempt high-volume race testing on live systems.",
      "Use reasoning, local tests, or a sandbox with explicit authorization.",
    ],
    defensiveActions: [
      "Use database constraints, transactions, locks, and idempotency keys.",
      "Re-check permissions and prices at commit time.",
      "Make workflows resilient to duplicate and out-of-order events.",
    ],
    detectionIdeas: [
      "Alert on duplicate orders, repeated idempotency keys, and unusual retry clusters.",
      "Track negative inventory, quota underflow, and inconsistent state repairs.",
    ],
    standards: ["OWASP ASVS V1", "CWE-362", "CWE-840"],
  },
  {
    id: "ai-security",
    title: "AI Agent, RAG, And Tool-Use Security Review",
    triggers: ["ai", "llm", "prompt", "prompt injection", "rag", "retrieval", "vector", "embedding", "agent", "tool use", "memory", "model"],
    summary: "Review untrusted content boundaries, tool permissions, retrieval provenance, memory safety, and output handling in AI systems.",
    checklist: [
      "Separate trusted system/developer instructions from untrusted user, web, file, and retrieval content.",
      "Constrain tools with explicit schemas, risk metadata, consent gates, and per-task allowlists.",
      "Track retrieval provenance and avoid treating retrieved text as instructions.",
      "Protect long-term memory from untrusted writes and poisoning.",
      "Validate model outputs before using them in code, shell, browser, network, or file operations.",
    ],
    evidence: [
      "Prompt assembly and message-role boundaries.",
      "Tool registry metadata and validation path.",
      "RAG source provenance and memory write controls.",
      "Approval logs for high-risk actions.",
    ],
    safeValidation: [
      "Use benign prompt-injection fixtures in local tests.",
      "Do not generate malware, credential theft, evasion, or destructive instructions.",
      "Prefer defensive evaluations and policy tests.",
    ],
    defensiveActions: [
      "Add instruction hierarchy tests and prompt-injection regression fixtures.",
      "Require typed tool inputs, output sanitization, and explicit consent for irreversible actions.",
      "Scope memory and tools to the current run unless intentionally persisted.",
    ],
    detectionIdeas: [
      "Log tool calls with risk, source, consent status, and model rationale.",
      "Alert on repeated blocked tool attempts or attempts to override system policy.",
      "Track retrieval sources that frequently trigger unsafe model behavior.",
    ],
    standards: ["OWASP Top 10 for LLM Applications", "MITRE ATLAS", "NIST AI RMF"],
  },
];

export function createSecurityTools(ctx: SecurityToolContext) {
  return {
    security_readiness: tool({
      description: "Report Cyber Security Agent capabilities and safety limits.",
      inputSchema: z.object({}),
      execute: async () => [
        "Cyber Security readiness: ready",
        "Modes: Offensive, Defensive, Hybrid.",
        `Safe playbooks: ${SECURITY_PLAYBOOKS.map((playbook) => playbook.id).join(", ")}.`,
        "Allowed: explicit-target reconnaissance, safe header/TLS checks, endpoint inventory, local static scans, dependency/config/log analysis, class-specific playbooks, structured reports.",
        "Blocked by design: destructive actions, broad port scans, credential use, persistence, exploit deployment, data exfiltration.",
      ].join("\n"),
    }),

    security_scope_check: tool({
      description: "Validate that a target is explicit and suitable for safe security analysis.",
      inputSchema: z.object({
        target: z.string().describe("User-provided target such as a URL, hostname, API base URL, or local path."),
      }),
      execute: async (input: { target: string }) => {
        const target = input.target.trim();
        if (!target) return "Scope status: blocked\nReason: no explicit target was provided.";
        if (/[*?[\]{}]/.test(target)) {
          return "Scope status: blocked\nReason: wildcard/range targets are not allowed in this safe agent slice.";
        }
        if (/^https?:\/\//i.test(target)) {
          const url = parseHttpUrl(target);
          return [
            "Scope status: ok",
            `Type: web`,
            `Origin: ${url.origin}`,
            `Path: ${url.pathname}`,
          ].join("\n");
        }
        const path = resolve(ctx.cwd, target);
        if (existsSync(path)) {
          return [
            "Scope status: ok",
            "Type: local path",
            `Path: ${path}`,
          ].join("\n");
        }
        return [
          "Scope status: review",
          "The target is explicit, but Servus cannot classify it as an http(s) URL or existing local path.",
          "Proceed only if the user clearly authorized this exact hostname/service.",
          `Target: ${target}`,
        ].join("\n");
      },
    }),

    security_http_probe: tool({
      description: "Safely fetch one explicit http(s) URL and summarize status, redirects, headers, and optional body preview.",
      inputSchema: targetUrlSchema,
      execute: async (input: z.infer<typeof targetUrlSchema>) => {
        const url = parseHttpUrl(input.url);
        const response = await fetchWithTimeout(url, input.maxBytes ?? MAX_BODY_BYTES);
        const headers = selectedHeaders(response.headers);
        const lines = [
          `URL: ${url.href}`,
          `Status: ${response.status} ${response.statusText}`,
          `Final URL: ${response.url}`,
          "",
          "Headers:",
          ...Object.entries(headers).map(([key, value]) => `- ${key}: ${value}`),
        ];
        if (input.includeBody) {
          const text = await limitedText(response, input.maxBytes ?? 8_000);
          lines.push("", "Body preview:", clamp(text, input.maxBytes ?? 8_000));
        } else {
          try {
            response.body?.cancel();
          } catch {
            // ignore stream cleanup failures
          }
        }
        return lines.join("\n");
      },
    }),

    security_header_audit: tool({
      description: "Audit common web security headers on one explicit http(s) URL.",
      inputSchema: z.object({ url: z.string() }),
      execute: async (input: { url: string }) => {
        const url = parseHttpUrl(input.url);
        const response = await fetchWithTimeout(url, 8_000);
        const headers = response.headers;
        const findings = [
          headerFinding(headers, "strict-transport-security", "High", "Missing HSTS can allow HTTPS downgrade risk."),
          headerFinding(headers, "content-security-policy", "Medium", "Missing CSP increases XSS blast radius."),
          headerFinding(headers, "x-frame-options", "Medium", "Missing frame policy can allow clickjacking."),
          headerFinding(headers, "x-content-type-options", "Low", "Missing nosniff can allow MIME confusion."),
          headerFinding(headers, "referrer-policy", "Low", "Missing referrer policy can leak URLs to third parties."),
          headerFinding(headers, "permissions-policy", "Low", "Missing permissions policy leaves browser features unrestricted."),
        ];
        return [
          `URL: ${url.href}`,
          `Status: ${response.status}`,
          "",
          "Header findings:",
          ...findings.map((finding) => `- [${finding.severity}] ${finding.name}: ${finding.status} - ${finding.detail}`),
        ].join("\n");
      },
    }),

    security_tls_summary: tool({
      description: "Summarize TLS certificate and protocol information for one explicit host.",
      inputSchema: tlsSchema,
      execute: async (input: z.infer<typeof tlsSchema>) => tlsSummary(input.host, input.port ?? 443),
    }),

    security_static_secrets_scan: tool({
      description: "Scan local project files for likely secrets. Values are masked and never printed in full.",
      inputSchema: secretsScanSchema,
      execute: async (input: z.infer<typeof secretsScanSchema>) => {
        const root = resolveLocalPath(ctx.cwd, input.path ?? ".");
        if (!existsSync(root)) return `Error: path not found - ${root}`;
        if (isOutside(ctx.cwd, root)) return `Error: refusing to scan outside cwd in this safe mode - ${root}`;

        const files = collectFiles(root, input.maxFiles ?? MAX_SCAN_FILES);
        const matches: string[] = [];
        for (const file of files) {
          const stat = statSync(file);
          if (stat.size > MAX_FILE_BYTES || looksBinary(file)) continue;
          const text = readFileSync(file, "utf-8");
          const rel = relative(ctx.cwd, file);
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            for (const item of SECRET_PATTERNS) {
              const line = lines[i];
              item.pattern.lastIndex = 0;
              const found = line.match(item.pattern);
              if (!found) continue;
              matches.push(`${rel}:${i + 1} ${item.label} ${found.map(maskSecret).join(", ")}`);
            }
          }
        }

        return [
          `Scanned files: ${files.length}`,
          `Findings: ${matches.length}`,
          "",
          ...(matches.length ? matches.slice(0, 100) : ["No likely secrets found by built-in patterns."]),
          matches.length > 100 ? `... truncated ${matches.length - 100} additional match(es)` : "",
        ].filter(Boolean).join("\n");
      },
    }),

    security_mode_plan: tool({
      description: "Explain whether the task should run in Offensive, Defensive, or Hybrid mode.",
      inputSchema: modePlanSchema,
      execute: async (input: z.infer<typeof modePlanSchema>) => {
        const mode = inferSecurityMode(input.task);
        return [
          `Mode Used: ${mode}`,
          `Reasoning: ${modeReason(input.task, mode)}`,
          mode === "Hybrid"
            ? "Execution: run Offensive validation first, then Defensive remediation/prevention for each finding."
            : mode === "Defensive"
              ? "Execution: prioritize fixes, hardening, detection, monitoring, and prevention."
              : "Execution: prioritize safe attack surface discovery, validation, and attack-chain reasoning.",
        ].join("\n");
      },
    }),

    security_playbook: tool({
      description: "Select safe, non-payload security playbooks for a vulnerability class or target type.",
      inputSchema: playbookSchema,
      execute: async (input: z.infer<typeof playbookSchema>) => {
        const topic = [input.topic, input.targetType].filter(Boolean).join(" ");
        const mode = input.mode ?? "Hybrid";
        const selected = selectPlaybooks(topic);
        return [
          `Mode Used: ${mode}`,
          `Requested topic: ${topic.trim() || "general"}`,
          `Playbooks selected: ${selected.map((playbook) => playbook.id).join(", ")}`,
          "",
          "Safety: these playbooks provide methodology, evidence requirements, remediation, and detection ideas only. They intentionally omit exploit payloads, evasion steps, and destructive validation.",
          "",
          ...selected.flatMap((playbook) => renderPlaybook(playbook, mode)),
        ].join("\n");
      },
    }),

    security_attack_surface_map: tool({
      description: "Safely inventory one explicit URL or local path for endpoints, forms, scripts, and route-like strings.",
      inputSchema: attackSurfaceSchema,
      execute: async (input: z.infer<typeof attackSurfaceSchema>) => {
        if (/^https?:\/\//i.test(input.target)) {
          const url = parseHttpUrl(input.target);
          const response = await fetchWithTimeout(url, input.maxBytes ?? MAX_BODY_BYTES);
          const body = await limitedText(response, input.maxBytes ?? 40_000);
          const links = [...extractMatches(body, /\b(?:href|src|action)\s*=\s*["']([^"']+)["']/gi)]
            .map((value) => resolveUrl(url, value))
            .filter(Boolean)
            .slice(0, 120);
          const forms = [...extractMatches(body, /<form\b[\s\S]*?<\/form>/gi)].slice(0, 20);
          const inputs = [...extractMatches(body, /\b(?:name|id|placeholder)\s*=\s*["']([^"']+)["']/gi)]
            .slice(0, 120);
          return [
            `Target: ${url.href}`,
            `Status: ${response.status}`,
            "",
            "Attack Surface Overview",
            `Links/scripts/actions: ${links.length}`,
            ...links.map((item) => `- ${item}`),
            "",
            `Forms: ${forms.length}`,
            ...forms.map((form, index) => `- form ${index + 1}: ${summarizeForm(form)}`),
            "",
            `Inputs/identifiers: ${inputs.length}`,
            ...inputs.map((item) => `- ${item}`),
          ].join("\n");
        }

        const root = resolveLocalPath(ctx.cwd, input.target);
        if (!existsSync(root)) return `Error: target path not found - ${root}`;
        if (isOutside(ctx.cwd, root)) return `Error: refusing to map outside cwd in this safe mode - ${root}`;
        const files = collectFiles(root, input.maxFiles ?? MAX_SCAN_FILES);
        const routes = new Set<string>();
        const securityHints = new Set<string>();
        for (const file of files) {
          const stat = statSync(file);
          if (stat.size > MAX_FILE_BYTES || looksBinary(file)) continue;
          const text = readFileSync(file, "utf-8");
          for (const route of extractRouteStrings(text)) routes.add(`${relative(ctx.cwd, file)} -> ${route}`);
          for (const hint of extractSecurityHints(text)) securityHints.add(`${relative(ctx.cwd, file)} -> ${hint}`);
        }
        return [
          `Target: ${root}`,
          `Files inspected: ${files.length}`,
          "",
          "Attack Surface Overview",
          `Route-like entries: ${routes.size}`,
          ...[...routes].slice(0, 160).map((item) => `- ${item}`),
          "",
          `Security-relevant hints: ${securityHints.size}`,
          ...[...securityHints].slice(0, 120).map((item) => `- ${item}`),
        ].join("\n");
      },
    }),

    security_static_code_scan: tool({
      description: "Scan local code for common risky security patterns and developer remediation hints.",
      inputSchema: staticCodeScanSchema,
      execute: async (input: z.infer<typeof staticCodeScanSchema>) => {
        const root = resolveLocalPath(ctx.cwd, input.path ?? ".");
        if (!existsSync(root)) return `Error: path not found - ${root}`;
        if (isOutside(ctx.cwd, root)) return `Error: refusing to scan outside cwd in this safe mode - ${root}`;
        const files = collectFiles(root, input.maxFiles ?? MAX_SCAN_FILES);
        const findings: string[] = [];
        for (const file of files) {
          const stat = statSync(file);
          if (stat.size > MAX_FILE_BYTES || looksBinary(file) || !looksLikeCode(file)) continue;
          const text = readFileSync(file, "utf-8");
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            for (const item of CODE_PATTERNS) {
              item.pattern.lastIndex = 0;
              if (!item.pattern.test(lines[i])) continue;
              findings.push([
                `${relative(ctx.cwd, file)}:${i + 1}`,
                `[${item.severity}] ${item.label}`,
                lines[i].trim().slice(0, 180),
                `Fix: ${item.guidance}`,
              ].join(" | "));
            }
          }
        }
        return [
          `Scanned files: ${files.length}`,
          `Findings: ${findings.length}`,
          "",
          ...(findings.length ? findings.slice(0, 160) : ["No risky code patterns found by built-in heuristics."]),
          findings.length > 160 ? `... truncated ${findings.length - 160} additional finding(s)` : "",
        ].filter(Boolean).join("\n");
      },
    }),

    security_dependency_audit: tool({
      description: "Audit local dependency manifests for security hygiene without network calls.",
      inputSchema: dependencyAuditSchema,
      execute: async (input: z.infer<typeof dependencyAuditSchema>) => {
        const root = resolveLocalPath(ctx.cwd, input.path ?? ".");
        if (!existsSync(root)) return `Error: path not found - ${root}`;
        if (isOutside(ctx.cwd, root)) return `Error: refusing to audit outside cwd in this safe mode - ${root}`;
        const findings = auditDependencyManifests(root, ctx.cwd);
        return [
          `Target: ${root}`,
          "Dependency audit mode: offline manifest review",
          `Findings: ${findings.length}`,
          "",
          ...(findings.length ? findings : ["No dependency hygiene findings found in supported manifests."]),
          "",
          "Note: run your package manager's official audit command in CI for CVE-accurate results.",
        ].join("\n");
      },
    }),

    security_config_audit: tool({
      description: "Audit local configuration files for common insecure settings and hardening opportunities.",
      inputSchema: configAuditSchema,
      execute: async (input: z.infer<typeof configAuditSchema>) => {
        const root = resolveLocalPath(ctx.cwd, input.path ?? ".");
        if (!existsSync(root)) return `Error: path not found - ${root}`;
        if (isOutside(ctx.cwd, root)) return `Error: refusing to audit outside cwd in this safe mode - ${root}`;
        const files = collectFiles(root, input.maxFiles ?? MAX_SCAN_FILES)
          .filter((file) => looksLikeConfig(file));
        const findings: string[] = [];
        for (const file of files) {
          const stat = statSync(file);
          if (stat.size > MAX_FILE_BYTES || looksBinary(file)) continue;
          const lines = readFileSync(file, "utf-8").split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            for (const item of CONFIG_PATTERNS) {
              item.pattern.lastIndex = 0;
              if (!item.pattern.test(lines[i])) continue;
              findings.push([
                `${relative(ctx.cwd, file)}:${i + 1}`,
                `[${item.severity}] ${item.label}`,
                lines[i].trim().slice(0, 180),
                `Hardening: ${item.guidance}`,
              ].join(" | "));
            }
          }
        }
        return [
          `Config files inspected: ${files.length}`,
          `Findings: ${findings.length}`,
          "",
          ...(findings.length ? findings.slice(0, 160) : ["No insecure config patterns found by built-in heuristics."]),
          findings.length > 160 ? `... truncated ${findings.length - 160} additional finding(s)` : "",
        ].filter(Boolean).join("\n");
      },
    }),

    security_log_analysis: tool({
      description: "Analyze one local log file for suspicious patterns and suggest detection/monitoring logic.",
      inputSchema: logAnalysisSchema,
      execute: async (input: z.infer<typeof logAnalysisSchema>) => {
        const path = resolveLocalPath(ctx.cwd, input.path);
        if (!existsSync(path)) return `Error: log path not found - ${path}`;
        if (isOutside(ctx.cwd, path)) return `Error: refusing to analyze logs outside cwd in this safe mode - ${path}`;
        if (statSync(path).isDirectory()) return `Error: expected a log file, got directory - ${path}`;
        const lines = readFileSync(path, "utf-8")
          .split(/\r?\n/)
          .slice(-(input.maxLines ?? 10_000));
        const analysis = analyzeLogLines(lines);
        return [
          `Log: ${path}`,
          `Lines analyzed: ${lines.length}`,
          "",
          "Suspicious pattern summary:",
          ...analysis.summary.map((item) => `- ${item}`),
          "",
          "Detection ideas:",
          ...analysis.detections.map((item) => `- ${item}`),
          "",
          "Examples:",
          ...analysis.examples.slice(0, 30).map((item) => `- ${item}`),
        ].join("\n");
      },
    }),

    security_create_report: tool({
      description: "Write a professional markdown security report artifact.",
      inputSchema: reportSchema,
      execute: async (input: z.infer<typeof reportSchema>) => {
        const outputPath = resolveReportPath(ctx.cwd, input.outputPath);
        const blocked = await guardWrite(ctx, "security_create_report", outputPath, input.overwrite);
        if (blocked) return blocked;
        const markdown = renderReport(input);
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, markdown, "utf-8");
        return `Created security report: ${outputPath}\nFindings: ${input.findings.length}`;
      },
    }),
  };
}

function selectPlaybooks(topic: string): SecurityPlaybook[] {
  const query = topic.toLowerCase().trim();
  if (!query) {
    return [
      findPlaybook("rapid-triage"),
      findPlaybook("auth-session"),
      findPlaybook("injection"),
      findPlaybook("ai-security"),
    ];
  }

  const scored = SECURITY_PLAYBOOKS
    .map((playbook) => {
      const haystack = [playbook.id, playbook.title, ...playbook.triggers].join(" ").toLowerCase();
      const score = query
        .split(/\s+/)
        .filter(Boolean)
        .reduce((total, token) => total + (haystack.includes(token) ? 1 : 0), 0);
      return { playbook, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.playbook.id.localeCompare(b.playbook.id));

  if (!scored.length) {
    return [
      findPlaybook("rapid-triage"),
      findPlaybook("auth-session"),
      findPlaybook("injection"),
    ];
  }

  const selected = scored.slice(0, 4).map((item) => item.playbook);
  if (!selected.some((playbook) => playbook.id === "rapid-triage")) {
    selected.unshift(findPlaybook("rapid-triage"));
  }
  return selected.slice(0, 4);
}

function findPlaybook(id: string): SecurityPlaybook {
  const playbook = SECURITY_PLAYBOOKS.find((item) => item.id === id);
  if (!playbook) throw new Error(`Missing security playbook: ${id}`);
  return playbook;
}

function renderPlaybook(playbook: SecurityPlaybook, mode: z.infer<typeof securityModeSchema>): string[] {
  const lines = [
    `## ${playbook.title}`,
    "",
    `Id: ${playbook.id}`,
    `Mode fit: ${mode}`,
    `Summary: ${playbook.summary}`,
    `Standards: ${playbook.standards.join(", ")}`,
    "",
    "Checklist:",
    ...playbook.checklist.map((item) => `- ${item}`),
    "",
    "Evidence To Collect:",
    ...playbook.evidence.map((item) => `- ${item}`),
    "",
    "Safe Validation:",
    ...playbook.safeValidation.map((item) => `- ${item}`),
  ];

  if (mode === "Defensive" || mode === "Hybrid") {
    lines.push(
      "",
      "Defensive Actions:",
      ...playbook.defensiveActions.map((item) => `- ${item}`),
      "",
      "Detection Ideas:",
      ...playbook.detectionIdeas.map((item) => `- ${item}`),
    );
  }

  return [...lines, ""];
}

function parseHttpUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http(s) URLs are supported by safe security web tools.");
  }
  if (/[*!]/.test(url.hostname)) {
    throw new Error("Wildcard targets are not allowed.");
  }
  return url;
}

async function fetchWithTimeout(url: URL, maxBytes: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    return await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "Servus-Security-Agent/1.0 safe-audit",
        accept: "text/html,application/json,text/plain,*/*;q=0.8",
        range: `bytes=0-${Math.max(0, maxBytes - 1)}`,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function limitedText(response: Response, maxBytes: number): Promise<string> {
  const text = await response.text();
  return clamp(text, maxBytes);
}

function selectedHeaders(headers: Headers): Record<string, string> {
  const selected = [
    "server",
    "content-type",
    "location",
    "strict-transport-security",
    "content-security-policy",
    "x-frame-options",
    "x-content-type-options",
    "referrer-policy",
    "permissions-policy",
    "set-cookie",
  ];
  const result: Record<string, string> = {};
  for (const key of selected) {
    const value = headers.get(key);
    if (value) result[key] = key === "set-cookie" ? maskCookie(value) : value;
  }
  return result;
}

function headerFinding(headers: Headers, name: string, severity: string, detail: string) {
  const value = headers.get(name);
  return {
    name,
    severity,
    status: value ? "present" : "missing",
    detail: value ? clamp(value, 200) : detail,
  };
}

function tlsSummary(host: string, port: number): Promise<string> {
  if (!/^[a-z0-9.-]+$/i.test(host)) {
    return Promise.resolve("Error: host must be an explicit hostname, not a wildcard, URL, or range.");
  }
  return new Promise((resolve) => {
    const socket = connect({ host, port, servername: host, rejectUnauthorized: false, timeout: 15_000 }, () => {
      const cert = socket.getPeerCertificate();
      const lines = [
        `Host: ${host}:${port}`,
        `Authorized: ${socket.authorized}`,
        `Authorization error: ${socket.authorizationError ?? "none"}`,
        `Protocol: ${socket.getProtocol() ?? "unknown"}`,
        `Cipher: ${socket.getCipher().name}`,
        `Issuer: ${cert && "issuer" in cert ? formatCertName(cert.issuer) : "unknown"}`,
        `Subject: ${cert && "subject" in cert ? formatCertName(cert.subject) : "unknown"}`,
        `Valid from: ${cert && "valid_from" in cert ? cert.valid_from : "unknown"}`,
        `Valid to: ${cert && "valid_to" in cert ? cert.valid_to : "unknown"}`,
      ];
      socket.end();
      resolve(lines.join("\n"));
    });
    socket.on("timeout", () => {
      socket.destroy();
      resolve(`Error: TLS connection timed out for ${host}:${port}`);
    });
    socket.on("error", (err) => resolve(`Error: ${err.message}`));
  });
}

function formatCertName(value: unknown): string {
  if (!value || typeof value !== "object") return "unknown";
  return Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => `${key}=${String(item)}`)
    .join(", ");
}

function collectFiles(root: string, maxFiles: number): string[] {
  const files: string[] = [];
  const stack = [root];
  while (stack.length && files.length < maxFiles) {
    const current = stack.pop()!;
    const stat = statSync(current);
    if (stat.isFile()) {
      files.push(current);
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if ([".git", "node_modules", "dist", "build", ".next", "coverage"].includes(entry.name)) continue;
      stack.push(join(current, entry.name));
    }
  }
  return files;
}

function looksBinary(path: string): boolean {
  return [
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf",
    ".zip", ".gz", ".tar", ".mp4", ".mp3", ".mov", ".woff", ".woff2",
  ].includes(extname(path).toLowerCase());
}

function maskSecret(value: string): string {
  const clean = value.trim();
  if (clean.length <= 10) return "***";
  return `${clean.slice(0, 4)}...${clean.slice(-4)}`;
}

function maskCookie(value: string): string {
  return value
    .split(";")
    .map((part, index) => {
      if (index > 0) return part.trim();
      const eq = part.indexOf("=");
      if (eq <= 0) return "cookie=***";
      return `${part.slice(0, eq)}=${maskSecret(part.slice(eq + 1))}`;
    })
    .join("; ");
}

function inferSecurityMode(task: string): "Offensive" | "Defensive" | "Hybrid" {
  const text = task.toLowerCase();
  const offensive =
    /\b(find|test|attack|attacker|red\s*team|pentest|penetration|exploit|validate|bypass|enumerate|recon|surface|vulnerabilit|owasp|xss|sqli|idor|csrf)\b/.test(text);
  const defensive =
    /\b(fix|secure|prevent|defend|blue\s*team|harden|patch|remediate|monitor|detect|alert|logging|siem|compliance|mitigate|protect)\b/.test(text);
  if (offensive && defensive) return "Hybrid";
  if (defensive) return "Defensive";
  return "Offensive";
}

function modeReason(task: string, mode: "Offensive" | "Defensive" | "Hybrid"): string {
  if (mode === "Hybrid") {
    return "The task includes both attacker-style discovery/testing and defender-style remediation/prevention intent.";
  }
  if (mode === "Defensive") {
    return "The task emphasizes fixing, hardening, preventing, detecting, or monitoring security issues.";
  }
  return "The task emphasizes finding, testing, validating, enumerating, or reasoning about vulnerabilities.";
}

function* extractMatches(text: string, pattern: RegExp): Iterable<string> {
  let match: RegExpExecArray | null;
  pattern.lastIndex = 0;
  while ((match = pattern.exec(text)) != null) {
    yield (match[1] ?? match[0]).trim();
    if (match[0].length === 0) pattern.lastIndex++;
  }
}

function resolveUrl(base: URL, value: string): string {
  try {
    if (value.startsWith("javascript:") || value.startsWith("data:")) return "";
    return new URL(value, base).href;
  } catch {
    return value;
  }
}

function summarizeForm(form: string): string {
  const action = form.match(/\baction\s*=\s*["']([^"']+)["']/i)?.[1] ?? "(current URL)";
  const method = form.match(/\bmethod\s*=\s*["']([^"']+)["']/i)?.[1] ?? "GET";
  const names = [...extractMatches(form, /\bname\s*=\s*["']([^"']+)["']/gi)].slice(0, 12);
  return `${method.toUpperCase()} ${action} inputs=[${names.join(", ") || "none named"}]`;
}

function extractRouteStrings(text: string): string[] {
  const routes = new Set<string>();
  const patterns = [
    /\b(?:app|router)\.(?:get|post|put|patch|delete|use)\s*\(\s*["'`]([^"'`]+)["'`]/gi,
    /\b(?:GET|POST|PUT|PATCH|DELETE)\s+([/][A-Za-z0-9_./:{-]+)/g,
    /\bpath\s*:\s*["'`]([^"'`]+)["'`]/gi,
    /\burl\s*:\s*["'`]([^"'`]+)["'`]/gi,
    /["'`]((?:\/api|\/auth|\/admin|\/users|\/login|\/logout)[A-Za-z0-9_./:{-]*)["'`]/gi,
  ];
  for (const pattern of patterns) {
    for (const value of extractMatches(text, pattern)) {
      if (value.length <= 200) routes.add(value);
    }
  }
  return [...routes];
}

function extractSecurityHints(text: string): string[] {
  const hints = new Set<string>();
  const patterns = [
    /\b(?:jwt|bearer|session|cookie|csrf|oauth|saml|oidc|apikey|api[_-]?key)\b/gi,
    /\b(?:isAdmin|isAuthenticated|requireAuth|authorize|permission|role)\b/gi,
    /\b(?:graphql|graphiql|apollo|hasura|introspection|mutation|subscription|resolver)\b/gi,
    /\b(?:upload|multer|busboy|formidable|attachment|avatar|archive|originalname)\b/gi,
    /\b(?:ssrf|webhook|callbackUrl|redirectUrl|url\s*fetch|metadata)\b/gi,
    /\b(?:openai|anthropic|langchain|llm|prompt|embedding|vector|retrieval|rag|tool_call|toolCall)\b/gi,
    /\b(?:idempotency|transaction|lock|race|quota|rateLimit|rate_limit)\b/gi,
  ];
  for (const pattern of patterns) {
    for (const value of extractMatches(text, pattern)) hints.add(value);
  }
  return [...hints];
}

function looksLikeCode(path: string): boolean {
  return [
    ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py", ".rb", ".php",
    ".java", ".kt", ".go", ".rs", ".cs", ".c", ".cpp", ".h", ".swift",
  ].includes(extname(path).toLowerCase());
}

function looksLikeConfig(path: string): boolean {
  const ext = extname(path).toLowerCase();
  const lower = path.toLowerCase();
  return [
    ".json", ".yaml", ".yml", ".toml", ".ini", ".env", ".conf", ".config", ".properties",
  ].includes(ext) || /(?:config|settings|dockerfile|compose|nginx|apache|caddy|server|auth|security)/i.test(lower);
}

function auditDependencyManifests(root: string, cwd: string): string[] {
  const findings: string[] = [];
  const packageJson = join(root, "package.json");
  if (existsSync(packageJson)) {
    try {
      const parsed = JSON.parse(readFileSync(packageJson, "utf-8")) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        scripts?: Record<string, string>;
        engines?: Record<string, string>;
      };
      const deps = {
        ...(parsed.dependencies ?? {}),
        ...(parsed.devDependencies ?? {}),
      };
      if (!existsSync(join(root, "package-lock.json")) && !existsSync(join(root, "pnpm-lock.yaml")) && !existsSync(join(root, "yarn.lock"))) {
        findings.push(`${relative(cwd, packageJson)} | [Medium] Missing lockfile | Add and commit a lockfile for reproducible dependency resolution.`);
      }
      if (!parsed.engines?.node) {
        findings.push(`${relative(cwd, packageJson)} | [Low] Missing Node engine pin | Add engines.node to document supported runtime versions.`);
      }
      for (const [name, version] of Object.entries(deps)) {
        if (version === "*" || version === "latest") {
          findings.push(`${relative(cwd, packageJson)} | [Medium] Unpinned dependency ${name}@${version} | Pin semver ranges and rely on lockfile updates.`);
        }
        if (["request", "node-sass", "bower", "gulp-util", "event-stream"].includes(name)) {
          findings.push(`${relative(cwd, packageJson)} | [Medium] Legacy dependency ${name} | Review maintenance status and replace if possible.`);
        }
      }
      for (const [name, script] of Object.entries(parsed.scripts ?? {})) {
        if (/\bcurl\b.*\|\s*(ba)?sh\b|\bwget\b.*\|\s*(ba)?sh\b/.test(script)) {
          findings.push(`${relative(cwd, packageJson)} | [High] Script ${name} pipes remote content to shell | Replace with pinned, verified installer steps.`);
        }
      }
    } catch (err) {
      findings.push(`${relative(cwd, packageJson)} | [Low] Could not parse package.json | ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const requirements = join(root, "requirements.txt");
  if (existsSync(requirements)) {
    const lines = readFileSync(requirements, "utf-8").split(/\r?\n/);
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return;
      if (!/[=~<>!]=/.test(trimmed)) {
        findings.push(`${relative(cwd, requirements)}:${index + 1} | [Medium] Unpinned Python dependency | Pin versions or ranges and use a lock tool.`);
      }
    });
  }

  return findings;
}

function analyzeLogLines(lines: string[]): { summary: string[]; detections: string[]; examples: string[] } {
  const counters = {
    authFailures: 0,
    forbidden: 0,
    rateLimited: 0,
    serverErrors: 0,
    injectionProbes: 0,
    traversalProbes: 0,
    adminProbes: 0,
  };
  const examples: string[] = [];

  for (const raw of lines) {
    const line = raw.slice(0, 500);
    const lower = line.toLowerCase();
    let suspicious = false;
    if (/\b(401|failed login|invalid password|authentication failed)\b/i.test(line)) {
      counters.authFailures++;
      suspicious = true;
    }
    if (/\b403\b|forbidden|unauthorized/i.test(line)) {
      counters.forbidden++;
      suspicious = true;
    }
    if (/\b429\b|rate limit/i.test(line)) {
      counters.rateLimited++;
      suspicious = true;
    }
    if (/\b5\d\d\b|exception|stack trace|traceback/i.test(line)) {
      counters.serverErrors++;
      suspicious = true;
    }
    if (/union\s+select|sleep\s*\(|benchmark\s*\(|<script|onerror=|javascript:/i.test(lower)) {
      counters.injectionProbes++;
      suspicious = true;
    }
    if (/\.\.\/|%2e%2e|etc\/passwd|win\.ini/i.test(lower)) {
      counters.traversalProbes++;
      suspicious = true;
    }
    if (/\/admin|\/wp-admin|\/phpmyadmin|\/actuator|\/debug/i.test(lower)) {
      counters.adminProbes++;
      suspicious = true;
    }
    if (suspicious && examples.length < 30) examples.push(line);
  }

  const summary = Object.entries(counters).map(([key, value]) => `${key}: ${value}`);
  const detections = [
    "Alert on repeated 401/403 responses per source IP, account, or session in a short window.",
    "Alert on SQLi/XSS/traversal probe strings in URLs, query params, user agents, and request bodies.",
    "Alert on spikes in 5xx responses after suspicious inputs.",
    "Dashboard rate-limit events and blocked admin-path probes by source and user agent.",
    "Correlate authentication failures followed by successful logins or privileged endpoint access.",
  ];
  return { summary, detections, examples: examples.length ? examples : ["No suspicious examples matched built-in patterns."] };
}

async function guardWrite(
  ctx: SecurityToolContext,
  action: string,
  outputPath: string,
  overwrite?: boolean,
): Promise<string | null> {
  if (existsSync(outputPath) && !overwrite) {
    return `Error: output exists - ${outputPath}. Set overwrite=true to replace it.`;
  }
  const outside = isOutside(ctx.cwd, outputPath);
  if (!outside && !existsSync(outputPath)) return null;
  const detail = [
    `Output: ${outputPath}`,
    existsSync(outputPath) ? "This will overwrite an existing report." : "",
    outside ? `This writes outside cwd: ${ctx.cwd}` : "",
  ].filter(Boolean).join("\n");
  const assessed = assessRisk(`${action}\n${detail}`);
  const risk = outside || existsSync(outputPath) ? "high" : assessed.risk === "low" ? "medium" : assessed.risk;
  const approved = ctx.onConsent
    ? await ctx.onConsent(action, detail)
    : await requestConsent({ action, detail, risk, engine: "security" });
  return approved ? null : `Action blocked by consent gate: ${action}`;
}

function resolveLocalPath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function resolveReportPath(cwd: string, outputPath?: string): string {
  if (outputPath) return resolveLocalPath(cwd, outputPath);
  return resolve(cwd, ".servus-security-reports", `${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
}

function isOutside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel.startsWith("..") || rel === ".." || isAbsolute(rel);
}

function renderReport(input: z.infer<typeof reportSchema>): string {
  return [
    `# ${input.title}`,
    "",
    "## Mode Used",
    "",
    input.modeUsed ?? "Hybrid",
    "",
    "## Target Summary",
    "",
    input.targetSummary,
    "",
    "## Attack Surface Overview",
    "",
    input.attackSurfaceOverview ?? "Not provided.",
    "",
    "## Findings",
    "",
    ...input.findings.flatMap((finding, index) => [
      `### ${index + 1}. ${finding.title}`,
      "",
      `Severity: ${finding.severity}`,
      `Confidence: ${finding.confidence}`,
      "",
      "#### Technical Details",
      finding.details,
      "",
      "#### Exploit Validation (safe)",
      finding.exploitValidation ?? finding.proofOfConcept ?? "Not validated beyond safe evidence collection.",
      "",
      "#### Attack Chain",
      finding.attackChain ?? "No multi-step attack chain identified.",
      "",
      "#### Impact",
      finding.impact,
      "",
      "#### Remediation Steps",
      finding.remediation,
      "",
      "#### Prevention Strategies",
      finding.preventionStrategies ?? "Add regression tests, monitoring, secure defaults, and review gates for this class of issue.",
      "",
    ]),
  ].join("\n").trimEnd() + "\n";
}

function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[... truncated ${text.length - max} characters ...]`;
}
