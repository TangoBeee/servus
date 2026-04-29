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
import { spawnSync } from "node:child_process";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { assessRisk, requestConsent } from "./consent.js";
import type { EngineContext } from "./engine.js";

const MAX_BODY_BYTES = 80_000;
const MAX_SCAN_FILES = 600;
const MAX_FILE_BYTES = 1_000_000;
const MAX_CLI_OUTPUT_BYTES = 80_000;
const MAX_REQUEST_HISTORY = 100;

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

interface SecurityContextPlaybook {
  id: string;
  category: "framework" | "protocol" | "cloud" | "technology";
  title: string;
  triggers: string[];
  reviewFocus: string[];
  evidence: string[];
  safeValidation: string[];
  remediation: string[];
  detection: string[];
}

interface SecurityRequestHistoryItem {
  id: string;
  timestamp: string;
  method: z.infer<typeof httpRequestSchema>["method"];
  url: string;
  headers?: Record<string, string>;
  body?: string;
  purpose?: string;
  responseStatus?: number;
  responseSummary?: string;
}

const securityModeSchema = z.enum(["Offensive", "Defensive", "Hybrid"]);
const vulnerabilityClassSchema = z.enum(["injection", "xss", "auth", "authz", "ssrf"]);
const validationVerdictSchema = z.enum([
  "EXPLOITED",
  "BLOCKED_BY_SECURITY",
  "OUT_OF_SCOPE_INTERNAL",
  "FALSE_POSITIVE",
  "POTENTIAL",
  "NOT_TESTED",
]);

type VulnerabilityClass = z.infer<typeof vulnerabilityClassSchema>;
type ValidationVerdict = z.infer<typeof validationVerdictSchema>;

const targetUrlSchema = z.object({
  url: z.string().describe("Explicit http(s) target URL provided by the user."),
  includeBody: z.boolean().optional().describe("Include a small text preview of the response body."),
  maxBytes: z.number().int().positive().max(MAX_BODY_BYTES).optional(),
});

const httpRequestSchema = z.object({
  method: z.enum(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]).optional(),
  url: z.string().describe("Explicit http(s) URL in authorized scope."),
  headers: z.record(z.string(), z.string()).optional(),
  query: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
  contentType: z.string().optional(),
  followRedirects: z.boolean().optional(),
  includeBody: z.boolean().optional(),
  maxBytes: z.number().int().positive().max(MAX_BODY_BYTES).optional(),
  purpose: z.string().optional().describe("Short reason this request is safe and in scope."),
});

const requestHistorySchema = z.object({
  limit: z.number().int().positive().max(MAX_REQUEST_HISTORY).optional(),
});

const repeatRequestSchema = z.object({
  id: z.string().describe("Request id from security_request_history."),
  method: z.enum(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
  purpose: z.string().optional(),
  includeBody: z.boolean().optional(),
  maxBytes: z.number().int().positive().max(MAX_BODY_BYTES).optional(),
});

const scanModeSchema = z.enum(["auto", "quick", "standard", "deep"]);

const scanModePlanSchema = z.object({
  task: z.string().describe("The user security task."),
  mode: scanModeSchema.optional(),
  targetType: z.string().optional(),
  sourceAvailable: z.boolean().optional(),
  authenticated: z.boolean().optional(),
  timeBoxMinutes: z.number().int().positive().max(24 * 60).optional(),
});

const contextPlaybookSchema = z.object({
  context: z.string().describe("Framework, protocol, cloud, platform, or technology context to select playbooks for."),
  categories: z.array(z.enum(["framework", "protocol", "cloud", "technology"])).optional(),
});

const cliToolRunSchema = z.object({
  toolName: z.enum(["curl", "dig", "openssl", "nmap", "nuclei", "ffuf", "httpx", "subfinder", "amass", "nikto", "wpscan", "sqlmap"]),
  target: z.string().describe("One explicit URL, hostname, domain, or host:port in authorized scope. No wildcards/ranges/CIDR."),
  args: z.array(z.string()).optional().describe("Extra tool arguments. Servus blocks dangerous flags and shell syntax."),
  purpose: z.string().describe("Why this external tool run is safe, authorized, and necessary."),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
});

const endpointExtractSchema = z.object({
  source: z.enum(["url", "path", "text"]),
  value: z.string().describe("URL, local path, or raw text to extract from."),
  maxBytes: z.number().int().positive().max(MAX_BODY_BYTES).optional(),
  maxFiles: z.number().int().positive().max(2_000).optional(),
});

const corsAuditSchema = z.object({
  url: z.string(),
  origin: z.string().optional().describe("Origin to test. Defaults to https://evil.example."),
});

const cookieAuditSchema = z.object({
  url: z.string().optional().describe("Optional URL to request and inspect Set-Cookie headers."),
  setCookie: z.string().optional().describe("Optional raw Set-Cookie header value to audit."),
});

const externalToolReadinessSchema = z.object({
  tools: z.array(z.string()).optional().describe("Optional tool names. Defaults to common security CLIs."),
});

const cvssScoreSchema = z.object({
  attackVector: z.enum(["N", "A", "L", "P"]),
  attackComplexity: z.enum(["L", "H"]),
  privilegesRequired: z.enum(["N", "L", "H"]),
  userInteraction: z.enum(["N", "R"]),
  scope: z.enum(["U", "C"]),
  confidentiality: z.enum(["N", "L", "H"]),
  integrity: z.enum(["N", "L", "H"]),
  availability: z.enum(["N", "L", "H"]),
});

const findingBuilderSchema = z.object({
  title: z.string(),
  vulnerabilityClass: z.string(),
  severity: z.enum(["Low", "Medium", "High", "Critical"]),
  confidence: z.enum(["Low", "Medium", "High"]),
  verdict: validationVerdictSchema,
  target: z.string(),
  affectedEndpoints: z.array(z.string()).optional(),
  affectedFiles: z.array(z.string()).optional(),
  evidence: z.array(z.string()),
  safeReproduction: z.array(z.string()).optional(),
  impact: z.string(),
  remediation: z.array(z.string()),
  prevention: z.array(z.string()).optional(),
  detection: z.array(z.string()).optional(),
  cwe: z.string().optional(),
  owasp: z.string().optional(),
  cvssVector: z.string().optional(),
  cvssScore: z.number().optional(),
});

const tlsSchema = z.object({
  host: z.string().describe("Explicit hostname to inspect. No wildcards or ranges."),
  port: z.number().int().min(1).max(65535).optional(),
});

const secretsScanSchema = z.object({
  path: z.string().optional().describe("Project-relative path to scan. Defaults to cwd."),
  maxFiles: z.number().int().positive().max(2_000).optional(),
});

const modePlanSchema = z.object({
  task: z.string().describe("The user's security task."),
});

const playbookSchema = z.object({
  topic: z.string().optional().describe("Security topic or vulnerability class, such as jwt, graphql, upload, idor, ssrf, xss, ai security, or rapid triage."),
  mode: securityModeSchema.optional(),
  targetType: z.string().optional().describe("Optional context such as web app, API, local repo, mobile backend, AI agent, or cloud config."),
});

const securityRuleSchema = z.object({
  description: z.string(),
  type: z.enum(["url_path", "subdomain", "domain", "method", "header", "parameter", "code_path"]),
  value: z.string(),
});

const preflightSchema = z.object({
  target: z.string().optional().describe("Explicit URL/host/path in scope."),
  repoPath: z.string().optional().describe("Optional local repository path for white-box review."),
  rules: z.object({
    avoid: z.array(securityRuleSchema).optional(),
    focus: z.array(securityRuleSchema).optional(),
  }).optional(),
  vulnClasses: z.array(vulnerabilityClassSchema).optional(),
  exploit: z.boolean().optional().describe("Whether safe validation/exploitation simulation is requested."),
});

const pipelinePlanSchema = z.object({
  target: z.string().optional(),
  repoPath: z.string().optional(),
  task: z.string(),
  mode: securityModeSchema.optional(),
  vulnClasses: z.array(vulnerabilityClassSchema).optional(),
  exploit: z.boolean().optional(),
});

const preReconCodeSchema = z.object({
  path: z.string().optional().describe("Project-relative path to inspect. Defaults to cwd."),
  focus: z.array(z.string()).optional().describe("Optional route, file, or feature keywords to prioritize."),
  avoid: z.array(z.string()).optional().describe("Optional file/path keywords to avoid."),
  maxFiles: z.number().int().positive().max(2_000).optional(),
});

const classPlanSchema = z.object({
  classes: z.array(vulnerabilityClassSchema).optional(),
  mode: securityModeSchema.optional(),
  targetType: z.string().optional(),
});

const validationQueueSchema = z.object({
  candidates: z.array(z.object({
    vulnerabilityClass: vulnerabilityClassSchema,
    title: z.string(),
    location: z.string().optional(),
    evidence: z.string().optional(),
    confidence: z.enum(["Low", "Medium", "High"]).optional(),
    externallyExploitable: z.boolean().optional(),
    notes: z.string().optional(),
  })),
});

const exploitationDecisionSchema = z.object({
  exploitRequested: z.boolean().optional().describe("Whether the user requested safe validation/exploitation simulation."),
  candidates: z.array(z.object({
    id: z.string().optional(),
    vulnerabilityClass: vulnerabilityClassSchema,
    title: z.string(),
    externallyExploitable: z.boolean().optional(),
    confidence: z.enum(["Low", "Medium", "High"]).optional(),
    evidence: z.string().optional(),
    requiresCredentials: z.boolean().optional(),
    potentiallyDestructive: z.boolean().optional(),
    outOfScope: z.boolean().optional(),
    notes: z.string().optional(),
  })),
});

const verdictSchema = z.object({
  vulnerabilityClass: vulnerabilityClassSchema,
  evidence: z.string(),
  result: z.string(),
  reachedSensitiveEffect: z.boolean().optional(),
  securityControlBlocked: z.boolean().optional(),
  attemptedInternalTarget: z.boolean().optional(),
  safeValidationOnly: z.boolean().optional(),
  confidence: z.enum(["Low", "Medium", "High"]).optional(),
});

const reportFilterSchema = z.object({
  findings: z.array(z.object({
    id: z.string().optional(),
    title: z.string(),
    severity: z.enum(["Low", "Medium", "High", "Critical"]),
    confidence: z.enum(["Low", "Medium", "High"]),
    verdict: validationVerdictSchema.optional(),
    evidence: z.string().optional(),
    remediation: z.string().optional(),
  })),
  minSeverity: z.enum(["Low", "Medium", "High", "Critical"]).optional(),
  minConfidence: z.enum(["Low", "Medium", "High"]).optional(),
  includePotential: z.boolean().optional(),
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
  executiveSummary: z.string().optional(),
  methodology: z.string().optional(),
  targetSummary: z.string(),
  attackSurfaceOverview: z.string().optional(),
  findings: z.array(z.object({
    title: z.string(),
    severity: z.enum(["Low", "Medium", "High", "Critical"]),
    verdict: validationVerdictSchema.optional(),
    vulnerabilityClass: vulnerabilityClassSchema.optional(),
    details: z.string(),
    proofOfConcept: z.string().optional(),
    exploitValidation: z.string().optional(),
    attackChain: z.string().optional(),
    impact: z.string(),
    remediation: z.string(),
    preventionStrategies: z.string().optional(),
    confidence: z.enum(["Low", "Medium", "High"]),
  })),
  recommendations: z.string().optional(),
  outputPath: z.string().optional().describe("Optional markdown path. Defaults to .servus-security-reports/<timestamp>.md."),
  writeStructuredArtifacts: z.boolean().optional().describe("Also write findings.json and findings.csv next to the markdown report. Defaults to true."),
  overwrite: z.boolean().optional(),
});

const SECURITY_REQUEST_HISTORY: SecurityRequestHistoryItem[] = [];

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
    label: "Possible IDOR object lookup by user-controlled id",
    severity: "High",
    pattern: /\b(findById|findUnique|findOne|getOne|find|where)\s*\([^)\n]*(req\.params|params\.id|request\.params|query\.id|body\.id|input\.id)/gi,
    guidance: "Resolve objects with owner/tenant/role constraints in the same query and add negative authorization tests.",
  },
  {
    label: "Possible mass assignment or over-posting",
    severity: "High",
    pattern: /\b(update|create|save|assign|merge|set)\s*\([^)\n]*(req\.body|request\.body|body|payload|input)\b|Object\.assign\s*\([^)\n]*(req\.body|request\.body)|\.\.\.\s*(req\.body|request\.body)/gi,
    guidance: "Use explicit writable-field allowlists/DTOs and reject role, owner, tenant, status, price, and permission fields from clients.",
  },
  {
    label: "Possible open redirect",
    severity: "Medium",
    pattern: /\b(redirect|location\.href|location\.assign|res\.location)\s*\([^)\n]*(req\.|request\.|params|query|body|returnUrl|nextUrl|redirectUrl)/gi,
    guidance: "Allowlist redirect destinations and normalize URLs before redirecting.",
  },
  {
    label: "Possible path traversal sink",
    severity: "High",
    pattern: /\b(readFile|writeFile|createReadStream|createWriteStream|sendFile|download|path\.join|path\.resolve)\s*\([^)\n]*(req\.|request\.|params|query|body|filename|filepath|path)/gi,
    guidance: "Normalize paths, enforce resolved-path containment, and avoid using user input as filesystem paths.",
  },
  {
    label: "Possible NoSQL injection through raw request object",
    severity: "High",
    pattern: /\b(findOne|find|updateOne|deleteOne|aggregate)\s*\(\s*(req\.body|request\.body|body|query)\b/gi,
    guidance: "Validate input schemas, reject operator keys such as $ne/$gt/$where, and build explicit query objects.",
  },
  {
    label: "Potential arbitrary origin CORS reflection",
    severity: "Medium",
    pattern: /\b(access-control-allow-origin|Access-Control-Allow-Origin)\b[^;\n]*(req\.headers\.origin|request\.headers\.origin|\borigin\b)/gi,
    guidance: "Use a strict origin allowlist, include Vary: Origin, and avoid credentials with arbitrary origins.",
  },
  {
    label: "Possible unsafe deserialization/parser use",
    severity: "High",
    pattern: /\b(pickle\.loads|yaml\.load|deserialize|unserialize|ObjectInputStream|readObject|js-yaml)\b/gi,
    guidance: "Avoid deserializing untrusted data; use safe parsers, signed payloads, and allowlisted types.",
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

const ALL_VULN_CLASSES: VulnerabilityClass[] = ["injection", "xss", "auth", "authz", "ssrf"];

const CLASS_METHODOLOGIES: Record<VulnerabilityClass, {
  title: string;
  analysisSteps: string[];
  queueFields: string[];
  safeValidation: string[];
  falsePositiveChecks: string[];
  remediation: string[];
  detection: string[];
}> = {
  injection: {
    title: "Injection Source-To-Sink Review",
    analysisSteps: [
      "Inventory interpreter sinks: SQL, shell, template, LDAP, NoSQL, search DSL, expression evaluators.",
      "Trace untrusted sources into each sink and identify the exact slot type: value, identifier, operator, command, path, or template body.",
      "Check whether parameterization, allowlists, shell argument arrays, or escaping happen in the same path before the sink.",
      "Treat concatenation near interpreter calls as high risk unless a safe API boundary is proven.",
    ],
    queueFields: ["source", "combined_sources", "path", "sink_call", "slot_type", "sanitization_observed", "verdict", "mismatch_reason"],
    safeValidation: [
      "Use code evidence and local harmless fixtures only.",
      "Do not use destructive, timing, data-extracting, or resource-exhaustion payloads.",
      "For command execution, validate by proving user input reaches a shell boundary, not by executing attacker commands.",
    ],
    falsePositiveChecks: [
      "Input is converted to a typed value before reaching the sink.",
      "Identifier/operator values are selected from a finite allowlist.",
      "The sink API is parameterized and no dynamic query fragments include untrusted data.",
    ],
    remediation: [
      "Use bind parameters or typed query builders for data values.",
      "Use allowlists for fields, operators, sort keys, command names, and template names.",
      "Use execFile/spawn argument arrays and avoid shell strings.",
    ],
    detection: [
      "Alert on interpreter errors after unusual parameters.",
      "Track rejected operator/field values and shell execution failures.",
    ],
  },
  xss: {
    title: "XSS Render-Context Review",
    analysisSteps: [
      "Start at render sinks such as innerHTML, dangerouslySetInnerHTML, document.write, markdown/rich-text renderers, and template escape bypasses.",
      "Trace each sink backward to user, CMS, URL, API, or stored database sources.",
      "Classify render context: HTML text, attribute, URL, script, CSS, markdown, or rich HTML.",
      "Confirm sanitizer and encoder match the exact context; a generic sanitizer is not enough for script/URL/CSS contexts.",
      "For stored content, verify both write path and read/render path before claiming exploitability.",
    ],
    queueFields: ["source", "source_detail", "path", "sink_function", "render_context", "encoding_observed", "verdict", "mismatch_reason"],
    safeValidation: [
      "Use harmless inert marker strings in local/dev fixtures only.",
      "Do not inject active scripts into live systems.",
      "Use CSP/header evidence as blast-radius context, not as proof the sink is safe.",
    ],
    falsePositiveChecks: [
      "Framework escaping is still active at the sink.",
      "Sanitizer allowlist removes event handlers, script URLs, SVG/script-capable tags, and unsafe attributes.",
      "The source is trusted server-controlled content, not user/CMS/external input.",
    ],
    remediation: [
      "Render untrusted text through text nodes/framework escaping.",
      "Use a maintained sanitizer for intentional rich HTML and narrowly configure tags/attributes.",
      "Add contextual encoding tests and tighten CSP.",
    ],
    detection: [
      "Collect CSP reports and sanitizer-drop events.",
      "Monitor script-error bursts tied to specific routes or content ids.",
    ],
  },
  auth: {
    title: "Authentication And Session Review",
    analysisSteps: [
      "Map login, signup, reset, MFA, token refresh, logout, session rotation, and account lifecycle flows.",
      "Identify the exact credential, session, token, or OTP validation point for each flow.",
      "Check brute-force/rate-limit posture, reset token entropy/lifetime, MFA bypass paths, and session revocation.",
      "Look for trust in decoded tokens, client-side role claims, weak cookie defaults, and missing re-auth for sensitive actions.",
    ],
    queueFields: ["source_endpoint", "vulnerable_code_location", "missing_defense", "exploitation_hypothesis", "suggested_validation"],
    safeValidation: [
      "Use only test accounts explicitly provided by the user.",
      "Do not brute force, credential stuff, bypass MFA, or replay tokens against live users.",
      "If credentials are unavailable, report code/config evidence with confidence and uncertainty.",
    ],
    falsePositiveChecks: [
      "A shared middleware enforces the defense before all sensitive handlers.",
      "Session/token validation includes expiry, revocation, issuer/audience/scope where applicable.",
      "A rate-limit/control exists at the server-side decision point, not only client-side.",
    ],
    remediation: [
      "Centralize auth checks and deny by default.",
      "Rotate sessions after login/privilege changes and revoke on logout/reset.",
      "Add rate limits, lockouts, MFA verification, and lifecycle tests.",
    ],
    detection: [
      "Alert on repeated failures, reset storms, MFA failures, and successful login after anomaly bursts.",
      "Log session/token rejection reasons without sensitive values.",
    ],
  },
  authz: {
    title: "Authorization And Object Boundary Review",
    analysisSteps: [
      "Map every object id, tenant id, account id, role, permission, bulk endpoint, export path, and admin-only action.",
      "Trace the data access path and prove ownership/tenant/role checks happen server-side before reads and writes.",
      "Check list/detail/update/delete/export paths separately; passing one does not prove the others are safe.",
      "Review mass assignment, hidden role fields, function-level permissions, background jobs, and cross-tenant joins.",
    ],
    queueFields: ["endpoint", "vulnerable_code_location", "role_context", "guard_evidence", "side_effect", "minimal_witness"],
    safeValidation: [
      "Use explicit test accounts only and never access real third-party data.",
      "Prefer code proof when a second account or tenant is unavailable.",
      "Use minimal non-sensitive object ids in sandbox/dev environments only.",
    ],
    falsePositiveChecks: [
      "The object query includes user/tenant/role constraints in the same database operation.",
      "Policy middleware runs before route handlers and workers for all methods.",
      "Bulk/list/export paths apply the same checks as detail paths.",
    ],
    remediation: [
      "Resolve objects by both id and owner/tenant in one query.",
      "Use policy helpers and regression tests for every role and tenant boundary.",
      "Block mass assignment of role/owner/security fields.",
    ],
    detection: [
      "Alert on repeated 403s across object ids, cross-tenant attempts, and denied admin/export actions.",
      "Log authorization denials with object type and decision reason.",
    ],
  },
  ssrf: {
    title: "SSRF And Egress Review",
    analysisSteps: [
      "Inventory server-side URL fetchers: webhooks, previews, imports, callbacks, file processors, metadata fetchers, and integrations.",
      "Trace user/external URL input into fetch libraries, redirects, DNS resolution, proxy usage, and response handling.",
      "Check scheme/host allowlists, private/link-local/metadata IP blocking, redirect limits, DNS rebinding controls, timeout and size caps.",
      "Treat validation before redirects/DNS resolution as insufficient unless connect-time checks are proven.",
    ],
    queueFields: ["source_endpoint", "vulnerable_parameter", "vulnerable_code_location", "missing_defense", "exploitation_hypothesis"],
    safeValidation: [
      "Do not request internal, metadata, link-local, or third-party targets.",
      "Use local fixture URLs or code/config evidence.",
      "Do not exfiltrate fetched response bodies; prove boundary weakness from control evidence.",
    ],
    falsePositiveChecks: [
      "Destination is selected from a finite business allowlist.",
      "Private/link-local/metadata IP ranges are blocked after DNS resolution and after redirects.",
      "Outbound requests use an egress proxy/policy that enforces destination constraints.",
    ],
    remediation: [
      "Use scheme/host allowlists and connect-time IP range checks.",
      "Set short timeouts, response-size caps, and redirect limits.",
      "Route outbound fetches through monitored egress controls.",
    ],
    detection: [
      "Alert on outbound requests to private/link-local/new destinations.",
      "Track URL preview/webhook/import failures and unusual redirect chains.",
    ],
  },
};

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
  {
    id: "csrf-cors",
    title: "CSRF, CORS, And Browser Trust Boundary Review",
    triggers: ["csrf", "cors", "origin", "referer", "samesite", "cross-site", "preflight"],
    summary: "Review state-changing browser requests, token/origin defenses, cookie posture, and CORS trust boundaries.",
    checklist: [
      "Inventory state-changing GET/POST/PUT/PATCH/DELETE endpoints, GraphQL mutations, upload actions, and logout/login flows.",
      "Check CSRF tokens, Origin/Referer validation, SameSite cookie attributes, custom header requirements, and CORS allowlists.",
      "Test method override, simple content types, JSON CSRF, credentialed CORS, and origin reflection as separate cases.",
    ],
    evidence: [
      "Endpoint/method reference for each state-changing action.",
      "Cookie attributes and CORS response headers.",
      "Server-side CSRF/origin validation code or safe request evidence.",
    ],
    safeValidation: [
      "Use non-destructive state-changing endpoints or local/staging fixtures only.",
      "Do not perform purchases, bookings, destructive mutations, or account changes without explicit approval.",
    ],
    defensiveActions: [
      "Require CSRF tokens or robust Origin checks for browser-authenticated state changes.",
      "Use SameSite=Lax/Strict where possible and strict CORS allowlists for credentialed APIs.",
      "Add negative tests for simple content types, missing tokens, and untrusted origins.",
    ],
    detectionIdeas: [
      "Log rejected Origin/Referer mismatches and missing CSRF tokens.",
      "Alert on credentialed CORS requests from unexpected origins.",
    ],
    standards: ["OWASP CSRF Prevention Cheat Sheet", "OWASP ASVS V3", "CWE-352"],
  },
  {
    id: "mass-assignment",
    title: "Mass Assignment And Over-Posting Review",
    triggers: ["mass assignment", "overposting", "over-posting", "bind", "serializer", "dto", "role field", "isAdmin"],
    summary: "Review object binding and update paths where client-supplied fields can modify sensitive server-side state.",
    checklist: [
      "Map create/update/bulk endpoints, GraphQL input objects, JSON merge/patch handlers, and ORM relation writes.",
      "Identify sensitive fields: role, owner, tenant, price, quota, status, feature gates, emailVerified, permissions.",
      "Confirm allowlisted DTOs/schemas strip unknown and sensitive fields before persistence.",
    ],
    evidence: [
      "Request body schema and controller/model binding reference.",
      "Sensitive field handling and persistence code.",
      "Negative test or code proof that over-posted fields are rejected.",
    ],
    safeValidation: [
      "Use harmless fields or local fixtures; never escalate real accounts or alter production billing/roles.",
    ],
    defensiveActions: [
      "Use explicit allowlists/DTOs for writable fields.",
      "Separate public input models from persistence models.",
      "Add regression tests for over-posted sensitive fields.",
    ],
    detectionIdeas: [
      "Log rejected unknown fields and attempts to write role/owner/tenant/status fields.",
    ],
    standards: ["OWASP API Top 10 API3/API6", "CWE-915"],
  },
  {
    id: "redirect-traversal-xxe",
    title: "Redirect, Path Traversal, LFI/RFI, And XXE Review",
    triggers: ["open redirect", "redirect", "path traversal", "lfi", "rfi", "xxe", "xml", "zip slip", "archive"],
    summary: "Review file/path/XML/redirect sinks that can cross trust boundaries or expose server-side resources.",
    checklist: [
      "Inventory redirect parameters, file download/view/import paths, archive extraction, XML/SOAP/SAML/SVG/Office parsers.",
      "Check URL canonicalization, scheme/host allowlists, path normalization, base-directory containment, and parser entity settings.",
      "For archives and uploads, verify extracted paths cannot escape the intended directory.",
    ],
    evidence: [
      "Parameter/source and redirect/path/XML parser sink.",
      "Normalization and containment code.",
      "Parser configuration disabling external entities where applicable.",
    ],
    safeValidation: [
      "Use benign local fixture files and safe redirect targets only.",
      "Do not read sensitive system files, internal URLs, or third-party resources.",
    ],
    defensiveActions: [
      "Use destination allowlists for redirects.",
      "Normalize paths and enforce resolved-path containment.",
      "Disable XML external entities and dangerous parser features.",
    ],
    detectionIdeas: [
      "Alert on traversal sequences, unusual wrappers/schemes, and denied redirect destinations.",
    ],
    standards: ["CWE-22", "CWE-611", "CWE-601", "OWASP WSTG"],
  },
  {
    id: "protocol-apis",
    title: "GraphQL, gRPC, WebSocket, And OAuth Review",
    triggers: ["graphql", "grpc", "websocket", "socket.io", "oauth", "oidc", "pkce", "jwks", "subscription", "federation"],
    summary: "Review modern API protocols for auth gaps, introspection/debug exposure, batching, message authorization, and OAuth flow weaknesses.",
    checklist: [
      "GraphQL: check schema exposure, field/object auth, batching/aliases, complexity limits, file uploads, persisted queries, subscriptions.",
      "gRPC: check reflection, health/channelz exposure, metadata auth, gateway/transcoding differences, message-field IDOR.",
      "WebSocket: check handshake auth, CSWSH, room/channel authorization, message schema validation, replay and rate controls.",
      "OAuth/OIDC: check redirect URI strictness, PKCE, state/nonce, client secret leakage, scope escalation, JWKS trust.",
    ],
    evidence: [
      "Protocol endpoint inventory and auth boundary.",
      "Request/response or code evidence for controls.",
      "Per-protocol limitation and false-positive checks.",
    ],
    safeValidation: [
      "Use sandbox/test accounts only for protocol mutations.",
      "Do not run resource-exhaustion GraphQL/gRPC/WebSocket tests against live systems.",
    ],
    defensiveActions: [
      "Centralize authz at resolver/method/message boundaries.",
      "Disable public debug/reflection/introspection unless explicitly required and protected.",
      "Enforce complexity/rate limits and strict OAuth redirect/PKCE/state validation.",
    ],
    detectionIdeas: [
      "Alert on introspection/debug access, high query complexity, websocket room denial bursts, and OAuth state/redirect failures.",
    ],
    standards: ["OWASP API Top 10", "OAuth 2.0 Security BCP", "OWASP GraphQL Cheat Sheet"],
  },
  {
    id: "cloud-kubernetes",
    title: "Cloud, Container, And Kubernetes Security Review",
    triggers: ["aws", "azure", "gcp", "kubernetes", "k8s", "container", "docker", "iam", "s3", "bucket", "metadata", "secrets"],
    summary: "Review cloud/container posture, IAM boundaries, exposed metadata, secrets, storage policies, and Kubernetes configuration.",
    checklist: [
      "Inventory cloud SDKs/config, IAM policy-like files, bucket/storage settings, container images, Dockerfiles, compose, Helm, and Kubernetes manifests.",
      "Check public exposure, overbroad IAM, privileged containers, hostPath mounts, secret handling, metadata service protections, and network egress.",
      "Map application SSRF risk to cloud metadata and workload identity impact.",
    ],
    evidence: [
      "Config/manifest file references and exact risky setting.",
      "IAM/resource policy or workload identity evidence.",
      "Container/Kubernetes hardening controls and gaps.",
    ],
    safeValidation: [
      "Do not access cloud metadata, buckets, or control-plane APIs unless explicitly authorized.",
      "Prefer local config/static evidence when credentials are unavailable.",
    ],
    defensiveActions: [
      "Apply least-privilege IAM and workload identities.",
      "Block metadata access where not needed and enforce IMDSv2/metadata protections.",
      "Use non-root containers, read-only filesystems, dropped capabilities, and network policies.",
    ],
    detectionIdeas: [
      "Alert on metadata access, unusual cloud API calls, public policy changes, privileged pod creation, and secret reads.",
    ],
    standards: ["CIS Benchmarks", "Kubernetes Security Checklist", "CWE-250"],
  },
];

const SECURITY_CONTEXT_PLAYBOOKS: SecurityContextPlaybook[] = [
  {
    id: "express-node",
    category: "framework",
    title: "Express/Fastify/Node API Review",
    triggers: ["express", "fastify", "koa", "hono", "node", "npm", "middleware"],
    reviewFocus: [
      "Middleware order: auth, validation, rate limits, CORS, helmet/security headers, body limits, and error handlers.",
      "Route-level authorization and object ownership checks near database queries.",
      "User-controlled input reaching shell, SQL/NoSQL, template, redirect, file path, or outbound fetch sinks.",
      "Cookie/session/JWT configuration, proxy trust settings, and request body parser limits.",
    ],
    evidence: [
      "App/server entrypoint, route registrations, middleware order, auth middleware, and data-access files.",
      "package.json scripts/dependencies, lockfile presence, and production config defaults.",
    ],
    safeValidation: [
      "Use local/static code evidence first; use one explicit URL request only when the target is in scope.",
      "Avoid broad route fuzzing unless the user provides a staging target and explicit approval.",
    ],
    remediation: [
      "Centralize validation and authorization middleware, then test every route family.",
      "Use parameterized data access, allowlisted redirects/fields, safe shell argument arrays, and short body/time limits.",
    ],
    detection: [
      "Log authz denials, validator rejects, rate-limit events, and interpreter errors by route.",
    ],
  },
  {
    id: "nextjs-react",
    category: "framework",
    title: "Next.js/React Full-Stack Review",
    triggers: ["next", "next.js", "react", "app router", "pages/api", "server actions", "rsc"],
    reviewFocus: [
      "API routes, server actions, route handlers, middleware, and edge runtime differences.",
      "Server/client boundary: secrets in client bundles, unsafe environment exposure, and trusted-vs-untrusted rendering.",
      "Auth gating for app routes, API routes, data loaders, and server actions.",
      "XSS risks from dangerouslySetInnerHTML, markdown, rich text, and URL/redirect handling.",
    ],
    evidence: [
      "app/api, pages/api, middleware, auth helpers, env usage, and render sinks.",
      "next.config, deployment config, cache/revalidation behavior, and public env variables.",
    ],
    safeValidation: [
      "Prefer local build/source evidence and single route checks; do not mutate server actions without consent.",
    ],
    remediation: [
      "Keep secrets server-only, enforce auth in every server route/action, validate inputs with schemas, and sanitize intentional rich HTML.",
    ],
    detection: [
      "Monitor server action failures, denied route access, CSP reports, and unexpected public env usage.",
    ],
  },
  {
    id: "django-fastapi",
    category: "framework",
    title: "Django/FastAPI/Python API Review",
    triggers: ["django", "fastapi", "flask", "python", "pydantic", "jinja"],
    reviewFocus: [
      "Route/view decorators, dependency-based auth, serializers/schemas, template escaping, and ORM query construction.",
      "Django settings: DEBUG, ALLOWED_HOSTS, CSRF, CORS, cookies, static/media storage, and secret handling.",
      "FastAPI dependencies, Pydantic model trust boundaries, file upload handling, and OpenAPI exposure.",
    ],
    evidence: [
      "urls/routes/views, dependencies/middleware, settings/config, serializers/schemas, requirements/pyproject.",
    ],
    safeValidation: [
      "Use static review and harmless local fixtures; do not use real credentials or brute-force auth endpoints.",
    ],
    remediation: [
      "Disable DEBUG, enforce ALLOWED_HOSTS, keep CSRF/session defaults, use ORM parameters, and add per-object permissions.",
    ],
    detection: [
      "Log permission denials, suspicious query parameters, upload rejects, and debug/error exposure.",
    ],
  },
  {
    id: "rails-spring",
    category: "framework",
    title: "Rails/Spring Enterprise Review",
    triggers: ["rails", "ruby", "spring", "spring boot", "java", "jpa", "hibernate"],
    reviewFocus: [
      "Mass assignment/strong parameters or DTO binding, object authorization, CSRF/session posture, and admin endpoints.",
      "SQL/JPQL construction, template escaping, deserialization, actuator/debug endpoints, and secure defaults.",
    ],
    evidence: [
      "Controllers, policies/guards, model scopes/repositories, config files, routes, Gemfile/pom/gradle manifests.",
    ],
    safeValidation: [
      "Use source evidence and test fixtures; avoid production mutations and actuator probing outside explicit scope.",
    ],
    remediation: [
      "Use strong parameter/DTO allowlists, policy guards, parameterized queries, and protected management endpoints.",
    ],
    detection: [
      "Alert on access denied bursts, management endpoint access, deserialization errors, and suspicious parameter keys.",
    ],
  },
  {
    id: "graphql-grpc-websocket",
    category: "protocol",
    title: "GraphQL/gRPC/WebSocket Review",
    triggers: ["graphql", "grpc", "websocket", "socket.io", "subscription", "reflection", "introspection"],
    reviewFocus: [
      "GraphQL field/object auth, complexity/depth, batching, aliases, introspection, uploads, and subscriptions.",
      "gRPC reflection/channelz/health exposure, metadata auth, gateway differences, and message-field authorization.",
      "WebSocket handshake auth, CSWSH, per-message authorization, room/channel boundaries, replay, and rate limits.",
    ],
    evidence: [
      "Schema/proto/message definitions, resolver/service handlers, auth middleware, gateway config, and connection handlers.",
    ],
    safeValidation: [
      "Do not run expensive query/message floods; use schema/source review and single harmless requests in authorized staging only.",
    ],
    remediation: [
      "Centralize per-field/method/message authorization, disable public debug exposure, and enforce cost/rate limits.",
    ],
    detection: [
      "Monitor introspection/reflection access, high query complexity, denied room joins, and abnormal connection churn.",
    ],
  },
  {
    id: "oauth-oidc",
    category: "protocol",
    title: "OAuth/OIDC/SAML Review",
    triggers: ["oauth", "oidc", "saml", "pkce", "jwks", "redirect uri", "state", "nonce"],
    reviewFocus: [
      "Redirect URI exact matching, PKCE for public clients, state/nonce validation, scope/audience enforcement, and token storage.",
      "JWKS trust, key rotation, issuer/audience checks, SAML signature validation, and account-linking edge cases.",
    ],
    evidence: [
      "Provider/client config, callback handlers, token verification code, session creation, and account-linking logic.",
    ],
    safeValidation: [
      "Do not forge or replay tokens against live systems; use config/code evidence unless the user provides a sandbox.",
    ],
    remediation: [
      "Use strict redirect allowlists, PKCE, state/nonce, verified tokens, and least-privilege scopes.",
    ],
    detection: [
      "Log redirect mismatch, state/nonce failure, token verification failure, and unusual account linking.",
    ],
  },
  {
    id: "aws-azure-gcp",
    category: "cloud",
    title: "AWS/Azure/GCP Cloud Posture Review",
    triggers: ["aws", "azure", "gcp", "iam", "s3", "bucket", "lambda", "cloud run", "metadata", "secrets manager"],
    reviewFocus: [
      "IAM least privilege, public storage policies, secret handling, metadata protections, workload identity, and audit logging.",
      "Serverless/API gateway auth, object storage access, egress paths, and SSRF-to-cloud blast radius.",
    ],
    evidence: [
      "Terraform/CloudFormation/Bicep/ARM/KRM files, IAM/storage policies, SDK config, deployment manifests.",
    ],
    safeValidation: [
      "Do not call cloud control-plane APIs or metadata endpoints unless explicitly authorized; use local IaC/config evidence.",
    ],
    remediation: [
      "Apply least-privilege IAM, block public storage by default, protect metadata, rotate secrets, and enable audit trails.",
    ],
    detection: [
      "Alert on public policy changes, unusual cloud API calls, metadata access, and secret reads.",
    ],
  },
  {
    id: "kubernetes-containers",
    category: "cloud",
    title: "Kubernetes/Container Review",
    triggers: ["kubernetes", "k8s", "container", "docker", "helm", "pod", "deployment", "ingress"],
    reviewFocus: [
      "Privileged containers, hostPath mounts, root users, dropped capabilities, read-only filesystem, secret mounts, ingress/TLS, and network policies.",
      "Image provenance, Dockerfile hardening, resource limits, service accounts, RBAC, and admission controls.",
    ],
    evidence: [
      "Dockerfiles, compose, Helm charts, Kubernetes manifests, RBAC/service account config, ingress/service definitions.",
    ],
    safeValidation: [
      "Use manifest/static evidence; do not deploy or modify cluster resources without explicit approval.",
    ],
    remediation: [
      "Run as non-root, drop capabilities, avoid hostPath/privileged, set resource limits, use network policies and scoped service accounts.",
    ],
    detection: [
      "Alert on privileged pod creation, hostPath mounts, secret reads, image drift, and anomalous service account activity.",
    ],
  },
  {
    id: "firebase-supabase",
    category: "technology",
    title: "Firebase/Firestore/Supabase Review",
    triggers: ["firebase", "firestore", "supabase", "rls", "row level security", "storage rules"],
    reviewFocus: [
      "Firestore/storage rules, Supabase RLS policies, service-role key exposure, public anon key usage, and object ownership checks.",
      "Client-side trust boundaries and hidden admin/owner fields.",
    ],
    evidence: [
      "Rules/policy files, client/server key usage, database policy definitions, storage access paths, and auth helper code.",
    ],
    safeValidation: [
      "Do not access real user data; use static policy review or provided test tenants/accounts only.",
    ],
    remediation: [
      "Enforce RLS/rules by user and tenant, keep service keys server-side, and add policy tests for every table/bucket.",
    ],
    detection: [
      "Log denied policy/rule decisions, unexpected service-role use, and cross-tenant object attempts.",
    ],
  },
];

export function createSecurityTools(ctx: SecurityToolContext) {
  return {
    security_preflight: tool({
      description: "Run cheap scope/config checks before security work: target, local repo, focus/avoid rules, class selection, and safe validation mode.",
      inputSchema: preflightSchema,
      execute: async (input: z.infer<typeof preflightSchema>) => {
        const selectedClasses = normalizeVulnClasses(input.vulnClasses);
        const target = input.target?.trim();
        const repo = input.repoPath ? resolveLocalPath(ctx.cwd, input.repoPath) : undefined;
        const errors: string[] = [];
        const warnings: string[] = [];
        const matchedRules: string[] = [];
        let targetType = "unspecified";

        if (target) {
          if (/[*?[\]{}]/.test(target)) {
            errors.push("Wildcard/range targets are not allowed in this safe security agent.");
          } else if (/^https?:\/\//i.test(target)) {
            const url = parseHttpUrl(target);
            targetType = "web";
            if (["127.0.0.1", "localhost", "::1", "0.0.0.0"].includes(url.hostname)) {
              warnings.push("Target is loopback/local. Treat findings as local-dev evidence only unless the user says otherwise.");
            }
          } else {
            targetType = "host-or-service";
            warnings.push("Target is explicit but is not an http(s) URL. Avoid network probing beyond the exact user-provided scope.");
          }
        }

        if (repo) {
          if (!existsSync(repo)) {
            errors.push(`Repository/path not found: ${repo}`);
          } else if (!statSync(repo).isDirectory()) {
            errors.push(`Repository/path is not a directory: ${repo}`);
          } else {
            targetType = target ? `${targetType}+local-repo` : "local-repo";
            if (!existsSync(join(repo, ".git"))) {
              warnings.push("Local path does not contain .git. Continuing is fine, but treat it as a source directory rather than a git repository.");
            }
            const ruleChecks = validateCodePathRules(repo, input.rules);
            matchedRules.push(...ruleChecks.matched);
            errors.push(...ruleChecks.errors);
            warnings.push(...ruleChecks.warnings);
          }
        }

        if (!target && !repo) {
          errors.push("No explicit URL/host/path or repoPath was provided.");
        }

        return renderJsonSection("Security Preflight", {
          status: errors.length ? "blocked" : warnings.length ? "review" : "ok",
          targetType,
          selectedClasses,
          exploit: input.exploit ?? true,
          target: target ?? null,
          repoPath: repo ?? null,
          matchedRules,
          warnings,
          errors,
          next: errors.length
            ? "Ask the user for corrected scope before testing."
            : "Proceed to security_pipeline_plan, then collect evidence with recon/code tools.",
        });
      },
    }),

    security_pipeline_plan: tool({
      description: "Create a safe security pipeline: pre-recon, recon, parallel class analysis, safe validation, and reporting.",
      inputSchema: pipelinePlanSchema,
      execute: async (input: z.infer<typeof pipelinePlanSchema>) => {
        const mode = input.mode ?? inferSecurityMode(input.task);
        const classes = normalizeVulnClasses(input.vulnClasses);
        const exploit = input.exploit ?? mode !== "Defensive";
        return renderJsonSection("Security Pipeline Plan", {
          mode,
          target: input.target ?? null,
          repoPath: input.repoPath ?? null,
          exploit,
          selectedClasses: classes,
          phases: [
            {
              id: "pre_recon",
              goal: "Validate scope, rules, auth assumptions, and local source availability before spending time on deeper analysis.",
              requiredEvidence: ["explicit scope", "target type", "focus/avoid rules", "selected vulnerability classes"],
            },
            {
              id: "recon",
              goal: "Map public and source-code attack surface with safe single-target probes and local file inspection.",
              requiredEvidence: ["routes/endpoints", "auth flows", "inputs", "security controls", "technology hints"],
            },
            {
              id: "vulnerability_analysis",
              goal: "Analyze each selected class independently and create structured candidate queues.",
              lanes: classes.map((cls) => `${cls}-analysis`),
              requiredEvidence: ["source-to-sink or guard evidence", "confidence", "false-positive checks"],
            },
            {
              id: "safe_validation",
              goal: exploit
                ? "Classify every candidate with safe non-destructive validation verdicts."
                : "Skip live exploitation and label findings as static-analysis evidence.",
              verdicts: ["EXPLOITED", "BLOCKED_BY_SECURITY", "OUT_OF_SCOPE_INTERNAL", "FALSE_POSITIVE", "POTENTIAL", "NOT_TESTED"],
            },
            {
              id: "reporting",
              goal: "Report only evidence-backed findings, with remediation, prevention, detection, and confidence.",
              requiredEvidence: ["verdict", "impact", "safe proof", "developer fix", "monitoring strategy"],
            },
          ],
          rules: [
            "Do not report a hypothesis as confirmed.",
            "Do not run destructive payloads, brute force, persistence, evasion, or exfiltration.",
            "If scope/auth/test accounts are missing, keep validation static and mark confidence honestly.",
          ],
        });
      },
    }),

    security_scan_mode_plan: tool({
      description: "Choose quick, standard, or deep security scan mode and return coverage, work lanes, evidence, and stop rules.",
      inputSchema: scanModePlanSchema,
      execute: async (input: z.infer<typeof scanModePlanSchema>) => {
        const mode = input.mode && input.mode !== "auto" ? input.mode : inferScanMode(input.task, input.timeBoxMinutes);
        return renderJsonSection("Security Scan Mode Plan", buildScanModePlan({
          mode,
          task: input.task,
          targetType: input.targetType ?? "unknown",
          sourceAvailable: input.sourceAvailable ?? false,
          authenticated: input.authenticated ?? false,
          timeBoxMinutes: input.timeBoxMinutes,
        }));
      },
    }),

    security_context_playbook: tool({
      description: "Select framework, protocol, cloud, or technology-specific security playbooks and evidence requirements.",
      inputSchema: contextPlaybookSchema,
      execute: async (input: z.infer<typeof contextPlaybookSchema>) => {
        const selected = selectContextPlaybooks(input.context, input.categories);
        return renderJsonSection("Security Context Playbooks", {
          context: input.context,
          selected: selected.map((item) => ({
            id: item.id,
            category: item.category,
            title: item.title,
            reviewFocus: item.reviewFocus,
            evidence: item.evidence,
            safeValidation: item.safeValidation,
            remediation: item.remediation,
            detection: item.detection,
          })),
          next: selected.length
            ? "Use these context playbooks with security_pre_recon_code_map and class-specific validation queues."
            : "No direct context playbook matched. Use rapid triage plus vulnerability class playbooks.",
        });
      },
    }),

    security_pre_recon_code_map: tool({
      description: "White-box pre-recon: inspect a local project for routes, auth flows, sinks, security controls, and vulnerability-class hotspots.",
      inputSchema: preReconCodeSchema,
      execute: async (input: z.infer<typeof preReconCodeSchema>) => {
        const root = resolveLocalPath(ctx.cwd, input.path ?? ".");
        if (!existsSync(root)) return `Error: path not found - ${root}`;
        if (isOutside(ctx.cwd, root)) return `Error: refusing to inspect outside cwd in this safe mode - ${root}`;
        const files = collectFiles(root, input.maxFiles ?? MAX_SCAN_FILES)
          .filter((file) => shouldInspectForPreRecon(file, input.focus, input.avoid));
        const map = buildPreReconMap(files, ctx.cwd);
        return renderJsonSection("White-Box Pre-Recon Code Map", {
          target: root,
          filesInspected: files.length,
          technologies: map.technologies,
          entrypoints: map.entrypoints.slice(0, 80),
          authAndSession: map.authAndSession.slice(0, 80),
          dataStores: map.dataStores.slice(0, 60),
          sinksByClass: Object.fromEntries(
            Object.entries(map.sinksByClass).map(([key, value]) => [key, value.slice(0, 80)]),
          ),
          controls: map.controls.slice(0, 80),
          notes: [
            "Use this as reconnaissance evidence, not as proof of exploitability.",
            "For each candidate, run a class methodology and false-positive checks before reporting.",
          ],
        });
      },
    }),

    security_vulnerability_class_plan: tool({
      description: "Return class-specific security methodology, evidence schema, safe validation rules, false-positive checks, remediation, and detection ideas.",
      inputSchema: classPlanSchema,
      execute: async (input: z.infer<typeof classPlanSchema>) => {
        const classes = normalizeVulnClasses(input.classes);
        const mode = input.mode ?? "Hybrid";
        return renderJsonSection("Vulnerability Class Methodology", {
          mode,
          targetType: input.targetType ?? "unknown",
          classes: classes.map((cls) => ({
            id: cls,
            ...CLASS_METHODOLOGIES[cls],
          })),
        });
      },
    }),

    security_create_validation_queue: tool({
      description: "Normalize candidate vulnerabilities into an evidence queue with IDs, required proof, and safe validation steps.",
      inputSchema: validationQueueSchema,
      execute: async (input: z.infer<typeof validationQueueSchema>) => {
        const counters = new Map<VulnerabilityClass, number>();
        const queue = input.candidates.map((candidate) => {
          const next = (counters.get(candidate.vulnerabilityClass) ?? 0) + 1;
          counters.set(candidate.vulnerabilityClass, next);
          const id = `${candidate.vulnerabilityClass.toUpperCase()}-${String(next).padStart(3, "0")}`;
          const methodology = CLASS_METHODOLOGIES[candidate.vulnerabilityClass];
          return {
            id,
            vulnerabilityClass: candidate.vulnerabilityClass,
            title: candidate.title,
            location: candidate.location ?? null,
            evidence: candidate.evidence ?? null,
            externallyExploitable: candidate.externallyExploitable ?? false,
            confidence: candidate.confidence ?? "Medium",
            requiredFields: methodology.queueFields,
            safeValidation: methodology.safeValidation,
            falsePositiveChecks: methodology.falsePositiveChecks,
            notes: candidate.notes ?? null,
            reportingRule: "Report as confirmed only after security_classify_validation_result returns EXPLOITED or BLOCKED_BY_SECURITY with supporting evidence. POTENTIAL findings must be labeled as unconfirmed.",
          };
        });
        return renderJsonSection("Security Validation Queue", {
          candidates: queue.length,
          queue,
        });
      },
    }),

    security_exploitation_decision: tool({
      description: "Decide whether safe validation should run for candidate vulnerabilities, or whether to keep them as static findings/follow-up.",
      inputSchema: exploitationDecisionSchema,
      execute: async (input: z.infer<typeof exploitationDecisionSchema>) => {
        const exploitRequested = input.exploitRequested ?? true;
        const decisions = input.candidates.map((candidate, index) => {
          const id = candidate.id ?? `${candidate.vulnerabilityClass.toUpperCase()}-${String(index + 1).padStart(3, "0")}`;
          const blockers = [
            candidate.outOfScope ? "out_of_scope" : "",
            candidate.potentiallyDestructive ? "potentially_destructive" : "",
            candidate.requiresCredentials ? "requires_credentials_or_test_account" : "",
            !candidate.externallyExploitable ? "not_externally_exploitable" : "",
            candidate.confidence === "Low" ? "low_confidence" : "",
            !candidate.evidence ? "missing_evidence" : "",
          ].filter(Boolean);
          const shouldRun = exploitRequested && blockers.length === 0;
          return {
            id,
            vulnerabilityClass: candidate.vulnerabilityClass,
            title: candidate.title,
            confidence: candidate.confidence ?? "Medium",
            shouldRunSafeValidation: shouldRun,
            decision: shouldRun ? "READY_FOR_SAFE_VALIDATION" : "KEEP_AS_STATIC_OR_FOLLOW_UP",
            blockers,
            next: shouldRun
              ? "Use only non-destructive validation and classify the result with security_classify_validation_result."
              : "Do not run exploit validation. Gather missing evidence, ask for scope/credentials, or label as POTENTIAL/NOT_TESTED.",
          };
        });
        return renderJsonSection("Safe Validation Decision", {
          exploitRequested,
          readyCount: decisions.filter((item) => item.shouldRunSafeValidation).length,
          blockedCount: decisions.filter((item) => !item.shouldRunSafeValidation).length,
          decisions,
          rule: "Servus never runs destructive exploitation. This decision only gates safe, explicit-scope validation.",
        });
      },
    }),

    security_classify_validation_result: tool({
      description: "Classify a candidate validation outcome using safe verdicts and reporting eligibility.",
      inputSchema: verdictSchema,
      execute: async (input: z.infer<typeof verdictSchema>) => {
        const verdict = classifyValidationVerdict(input);
        const methodology = CLASS_METHODOLOGIES[input.vulnerabilityClass];
        return renderJsonSection("Security Validation Verdict", {
          vulnerabilityClass: input.vulnerabilityClass,
          verdict,
          confidence: input.confidence ?? (verdict === "POTENTIAL" ? "Low" : "Medium"),
          reportingEligibility: verdict === "EXPLOITED" || verdict === "BLOCKED_BY_SECURITY"
            ? "confirmed_or_actionable"
            : verdict === "POTENTIAL"
              ? "hypothesis_only"
              : "do_not_report_as_finding",
          evidence: input.evidence,
          result: input.result,
          safeValidationOnly: input.safeValidationOnly ?? true,
          remediation: methodology.remediation,
          detection: methodology.detection,
          remainingChecks: verdict === "POTENTIAL" ? methodology.falsePositiveChecks : [],
        });
      },
    }),

    security_report_filter: tool({
      description: "Filter and order security findings by severity, confidence, and validation verdict before report writing.",
      inputSchema: reportFilterSchema,
      execute: async (input: z.infer<typeof reportFilterSchema>) => {
        const minSeverity = input.minSeverity ?? "Low";
        const minConfidence = input.minConfidence ?? "Low";
        const includePotential = input.includePotential ?? false;
        const accepted = input.findings
          .filter((finding) => severityRank(finding.severity) >= severityRank(minSeverity))
          .filter((finding) => confidenceRank(finding.confidence) >= confidenceRank(minConfidence))
          .filter((finding) => includePotential || finding.verdict !== "POTENTIAL")
          .filter((finding) => finding.verdict !== "FALSE_POSITIVE" && finding.verdict !== "OUT_OF_SCOPE_INTERNAL")
          .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || confidenceRank(b.confidence) - confidenceRank(a.confidence));
        const rejected = input.findings.length - accepted.length;
        return renderJsonSection("Security Report Filter", {
          minSeverity,
          minConfidence,
          includePotential,
          acceptedCount: accepted.length,
          rejectedCount: rejected,
          accepted,
          note: "Use accepted findings for the final report. Mention rejected/POTENTIAL items only as limitations or follow-up work, not confirmed vulnerabilities.",
        });
      },
    }),

    security_readiness: tool({
      description: "Report Cyber Security Agent capabilities and safety limits.",
      inputSchema: z.object({}),
      execute: async () => [
        "Cyber Security readiness: ready",
        "Modes: Offensive, Defensive, Hybrid.",
        "Pipeline: preflight -> scan-mode plan -> context playbooks -> white-box pre-recon/recon -> class analysis -> safe validation verdicts -> report.",
        "Class lanes: injection, xss, auth, authz, ssrf.",
        `Safe playbooks: ${SECURITY_PLAYBOOKS.map((playbook) => playbook.id).join(", ")}.`,
        `Context playbooks: ${SECURITY_CONTEXT_PLAYBOOKS.map((playbook) => playbook.id).join(", ")}.`,
        "Allowed: explicit-target reconnaissance, bounded/replayable HTTP requests, header/TLS/CORS/cookie checks, endpoint inventory, local static scans, dependency/config/log analysis, context/class playbooks, validation queues, safe-validation decisions, CVSS/finding builders, structured reports.",
        "External CLI support: readiness checks and guarded allowlisted tool runs with explicit approval, exact target validation, blocked dangerous flags, timeouts, and output limits.",
        "Blocked by design: destructive actions, broad port scans, credential attacks, persistence, exploit deployment, data exfiltration, unsafe scanner flags, and out-of-scope targets.",
      ].join("\n"),
    }),

    security_http_request: tool({
      description: "Send a bounded, explicit-scope HTTP request for security testing. Non-GET/HEAD/OPTIONS requests require approval.",
      inputSchema: httpRequestSchema,
      execute: async (input: z.infer<typeof httpRequestSchema>) => {
        const method = input.method ?? (input.body ? "POST" : "GET");
        const url = parseHttpUrl(addQueryParams(input.url, input.query));
        const stateChanging = !["GET", "HEAD", "OPTIONS"].includes(method) || Boolean(input.body);
        if (stateChanging) {
          const detail = [
            `Method: ${method}`,
            `URL: ${url.href}`,
            input.purpose ? `Purpose: ${input.purpose}` : undefined,
            "This may change server-side state. Only approve if this target/action is authorized and safe.",
          ].filter(Boolean).join("\n");
          const approved = ctx.onConsent
            ? await ctx.onConsent("security_http_request", detail)
            : await requestConsent({ action: "security_http_request", detail, risk: "medium", engine: "security" });
          if (!approved) return "Action blocked by consent gate: security_http_request";
        }
        const response = await requestWithTimeout(url, {
          method,
          headers: {
            ...(input.contentType ? { "content-type": input.contentType } : {}),
            ...(input.headers ?? {}),
          },
          body: input.body,
          followRedirects: input.followRedirects ?? true,
          includeBody: input.includeBody ?? true,
          maxBytes: input.maxBytes ?? MAX_BODY_BYTES,
        });
        rememberSecurityRequest({
          method,
          url: url.href,
          headers: input.headers,
          body: input.body,
          purpose: input.purpose,
          responseStatus: Number((response.response as Record<string, unknown>).status),
          responseSummary: `${method} ${url.href} -> ${(response.response as Record<string, unknown>).status}`,
        });
        return renderJsonSection("HTTP Request Result", response);
      },
    }),

    security_request_history: tool({
      description: "List bounded HTTP requests made by this Servus security process for replay and reporting.",
      inputSchema: requestHistorySchema,
      execute: async (input: z.infer<typeof requestHistorySchema>) => renderJsonSection("Security Request History", {
        count: SECURITY_REQUEST_HISTORY.length,
        requests: SECURITY_REQUEST_HISTORY.slice(-(input.limit ?? 20)).map((item) => ({
          id: item.id,
          timestamp: item.timestamp,
          method: item.method,
          url: item.url,
          purpose: item.purpose ?? null,
          responseStatus: item.responseStatus ?? null,
          responseSummary: item.responseSummary ?? null,
          hasBody: Boolean(item.body),
        })),
      }),
    }),

    security_repeat_request: tool({
      description: "Repeat a prior security_http_request with optional safe modifications. State-changing repeats require approval.",
      inputSchema: repeatRequestSchema,
      execute: async (input: z.infer<typeof repeatRequestSchema>) => {
        const previous = SECURITY_REQUEST_HISTORY.find((item) => item.id === input.id);
        if (!previous) return `Error: request not found in history - ${input.id}`;
        const method = input.method ?? previous.method ?? (input.body ?? previous.body ? "POST" : "GET");
        const url = parseHttpUrl(previous.url);
        const body = input.body ?? previous.body;
        const stateChanging = !["GET", "HEAD", "OPTIONS"].includes(method) || Boolean(body);
        if (stateChanging) {
          const detail = [
            `Repeating request: ${previous.id}`,
            `Method: ${method}`,
            `URL: ${url.href}`,
            `Purpose: ${input.purpose ?? previous.purpose ?? "not provided"}`,
            "This may change server-side state. Only approve if this target/action is authorized and safe.",
          ].join("\n");
          const approved = ctx.onConsent
            ? await ctx.onConsent("security_repeat_request", detail)
            : await requestConsent({ action: "security_repeat_request", detail, risk: "medium", engine: "security" });
          if (!approved) return "Action blocked by consent gate: security_repeat_request";
        }
        const response = await requestWithTimeout(url, {
          method,
          headers: { ...(previous.headers ?? {}), ...(input.headers ?? {}) },
          body,
          followRedirects: true,
          includeBody: input.includeBody ?? true,
          maxBytes: input.maxBytes ?? MAX_BODY_BYTES,
        });
        rememberSecurityRequest({
          method,
          url: url.href,
          headers: { ...(previous.headers ?? {}), ...(input.headers ?? {}) },
          body,
          purpose: input.purpose ?? previous.purpose,
          responseStatus: Number((response.response as Record<string, unknown>).status),
          responseSummary: `${method} ${url.href} -> ${(response.response as Record<string, unknown>).status}`,
        });
        return renderJsonSection("Repeated HTTP Request Result", response);
      },
    }),

    security_extract_endpoints: tool({
      description: "Extract endpoints, forms, parameters, JavaScript routes, URLs, and request candidates from a URL, local path, or text.",
      inputSchema: endpointExtractSchema,
      execute: async (input: z.infer<typeof endpointExtractSchema>) => {
        let text = "";
        const files: string[] = [];
        let sourceLabel = input.value;
        if (input.source === "url") {
          const url = parseHttpUrl(input.value);
          const response = await fetchWithTimeout(url, input.maxBytes ?? MAX_BODY_BYTES);
          text = await limitedText(response, input.maxBytes ?? 40_000);
          sourceLabel = response.url;
        } else if (input.source === "path") {
          const root = resolveLocalPath(ctx.cwd, input.value);
          if (!existsSync(root)) return `Error: path not found - ${root}`;
          if (isOutside(ctx.cwd, root)) return `Error: refusing to extract outside cwd in this safe mode - ${root}`;
          const candidates = collectFiles(root, input.maxFiles ?? MAX_SCAN_FILES);
          for (const file of candidates) {
            if (looksBinary(file) || statSync(file).size > MAX_FILE_BYTES) continue;
            files.push(file);
            text += `\n/* ${relative(ctx.cwd, file)} */\n${safeReadText(file).slice(0, input.maxBytes ?? 60_000)}`;
            if (text.length > (input.maxBytes ?? MAX_BODY_BYTES)) break;
          }
          sourceLabel = root;
        } else {
          text = input.value;
        }
        const extracted = extractEndpointInventory(text, ctx.cwd);
        return renderJsonSection("Endpoint And Parameter Inventory", {
          source: sourceLabel,
          filesInspected: files.length || undefined,
          endpoints: extracted.endpoints.slice(0, 200),
          absoluteUrls: extracted.absoluteUrls.slice(0, 120),
          parameters: extracted.parameters.slice(0, 160),
          forms: extracted.forms.slice(0, 40),
          javascriptRoutes: extracted.javascriptRoutes.slice(0, 160),
          interestingHeaders: extracted.headers.slice(0, 80),
          notes: [
            "Treat this as recon evidence. Validate authorization, input handling, and state changes before reporting findings.",
            "For state-changing requests, use security_http_request with explicit consent.",
          ],
        });
      },
    }),

    security_cors_audit: tool({
      description: "Audit CORS behavior for one explicit URL using a supplied Origin header.",
      inputSchema: corsAuditSchema,
      execute: async (input: z.infer<typeof corsAuditSchema>) => {
        const url = parseHttpUrl(input.url);
        const origin = input.origin ?? "https://evil.example";
        const response = await fetchWithTimeout(url, 8_000, {
          method: "OPTIONS",
          headers: {
            origin,
            "access-control-request-method": "POST",
            "access-control-request-headers": "authorization,content-type",
          },
        });
        const headers = response.headers;
        const cors = {
          status: response.status,
          originTested: origin,
          allowOrigin: headers.get("access-control-allow-origin"),
          allowCredentials: headers.get("access-control-allow-credentials"),
          allowMethods: headers.get("access-control-allow-methods"),
          allowHeaders: headers.get("access-control-allow-headers"),
          vary: headers.get("vary"),
        };
        const findings = auditCorsHeaders(cors);
        return renderJsonSection("CORS Audit", { url: url.href, cors, findings });
      },
    }),

    security_cookie_audit: tool({
      description: "Audit Set-Cookie attributes from a URL response or supplied Set-Cookie header.",
      inputSchema: cookieAuditSchema,
      execute: async (input: z.infer<typeof cookieAuditSchema>) => {
        const headers: string[] = [];
        if (input.setCookie) headers.push(input.setCookie);
        if (input.url) {
          const response = await fetchWithTimeout(parseHttpUrl(input.url), 8_000);
          const setCookie = response.headers.get("set-cookie");
          if (setCookie) headers.push(setCookie);
        }
        if (!headers.length) return "No Set-Cookie header supplied or observed.";
        const cookies = headers.flatMap(splitSetCookieHeader).map(auditCookie);
        return renderJsonSection("Cookie Security Audit", {
          cookies,
          findings: cookies.flatMap((cookie) => cookie.findings.map((finding) => `${cookie.name}: ${finding}`)),
        });
      },
    }),

    security_external_tool_readiness: tool({
      description: "Check local availability of common security CLIs without running scans.",
      inputSchema: externalToolReadinessSchema,
      execute: async (input: z.infer<typeof externalToolReadinessSchema>) => {
        const tools = input.tools?.length ? input.tools : [
          "curl", "jq", "nmap", "nuclei", "ffuf", "httpx", "subfinder", "amass", "sqlmap", "nikto", "wpscan", "dig", "openssl",
        ];
        const status = tools.map((name) => {
          const found = spawnSync("which", [name], { encoding: "utf-8" });
          const path = found.status === 0 ? found.stdout.trim().split(/\r?\n/)[0] : "";
          let version = "";
          if (path) {
            const result = spawnSync(name, ["--version"], { encoding: "utf-8", timeout: 2_000 });
            version = (result.stdout || result.stderr || "").split(/\r?\n/)[0]?.slice(0, 120) ?? "";
          }
          return {
            name,
            installed: Boolean(path),
            path: path || null,
            version: version || null,
            note: securityToolSafetyNote(name),
          };
        });
        return renderJsonSection("Security Tool Readiness", {
          installed: status.filter((item) => item.installed).length,
          missing: status.filter((item) => !item.installed).map((item) => item.name),
          tools: status,
          safety: "This tool only checks availability. Servus still requires explicit scope and approval before running external scanners or state-changing tests.",
        });
      },
    }),

    security_run_cli_tool: tool({
      description: "Run an approved external security CLI against one explicit target with strict flag validation, timeout, output limits, and user consent.",
      inputSchema: cliToolRunSchema,
      execute: async (input: z.infer<typeof cliToolRunSchema>) => {
        const command = buildSecurityCliCommand(input.toolName, input.target, input.args ?? []);
        const validation = validateSecurityCliCommand(input.toolName, input.target, command.args);
        if (!validation.allowed) {
          return renderJsonSection("Security CLI Blocked", {
            tool: input.toolName,
            target: input.target,
            command: [input.toolName, ...command.args].join(" "),
            reasons: validation.reasons,
            saferAlternative: validation.saferAlternative,
          });
        }
        const detail = [
          `Tool: ${input.toolName}`,
          `Command: ${input.toolName} ${command.args.join(" ")}`,
          `Target: ${input.target}`,
          `Purpose: ${input.purpose}`,
          "External security tools can generate traffic or expose data. Approve only for authorized targets.",
        ].join("\n");
        const approved = ctx.onConsent
          ? await ctx.onConsent("security_run_cli_tool", detail)
          : await requestConsent({ action: "security_run_cli_tool", detail, risk: validation.risk, engine: "security" });
        if (!approved) return "Action blocked by consent gate: security_run_cli_tool";

        const started = Date.now();
        const result = spawnSync(input.toolName, command.args, {
          encoding: "utf-8",
          timeout: input.timeoutMs ?? command.timeoutMs,
          maxBuffer: MAX_CLI_OUTPUT_BYTES * 2,
        });
        const stdout = clamp(result.stdout ?? "", MAX_CLI_OUTPUT_BYTES);
        const stderr = clamp(result.stderr ?? "", 16_000);
        return renderJsonSection("Security CLI Result", {
          tool: input.toolName,
          target: input.target,
          command: [input.toolName, ...command.args],
          status: result.status,
          signal: result.signal,
          timedOut: Boolean(result.error && /timed out/i.test(result.error.message)),
          durationMs: Date.now() - started,
          stdout,
          stderr,
          error: result.error?.message ?? null,
          evidence: [
            `${input.toolName} executed against explicit target ${input.target}`,
            `exit=${result.status ?? "signal"} durationMs=${Date.now() - started}`,
          ],
          note: "Interpret external scanner output as evidence candidates. Do not report findings until validated and classified with security_classify_validation_result.",
        });
      },
    }),

    security_cvss_score: tool({
      description: "Calculate a CVSS v3.1 base score and severity from base metrics.",
      inputSchema: cvssScoreSchema,
      execute: async (input: z.infer<typeof cvssScoreSchema>) => renderJsonSection("CVSS v3.1 Base Score", calculateCvss(input)),
    }),

    security_create_finding: tool({
      description: "Build a complete evidence-backed security finding object for reports.",
      inputSchema: findingBuilderSchema,
      execute: async (input: z.infer<typeof findingBuilderSchema>) => {
        const reportable = input.verdict === "EXPLOITED" || input.verdict === "BLOCKED_BY_SECURITY";
        return renderJsonSection("Structured Security Finding", {
          ...input,
          reportable,
          reportGuidance: reportable
            ? "Can be included as an evidence-backed finding."
            : "Do not report as confirmed. Put this in limitations/follow-up unless additional evidence changes the verdict.",
          requiredSections: [
            "Target Summary",
            "Finding Description",
            "Evidence",
            "Safe Proof of Concept",
            "Impact",
            "Attack Chain",
            "Remediation",
            "Prevention",
            "Detection",
            "Confidence",
          ],
        });
      },
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
        const artifacts = [outputPath];
        if (input.writeStructuredArtifacts ?? true) {
          const base = outputPath.replace(/\.md$/i, "");
          const jsonPath = `${base}.findings.json`;
          const csvPath = `${base}.findings.csv`;
          writeFileSync(jsonPath, JSON.stringify(renderFindingArtifacts(input), null, 2) + "\n", "utf-8");
          writeFileSync(csvPath, renderFindingsCsv(input), "utf-8");
          artifacts.push(jsonPath, csvPath);
        }
        return renderJsonSection("Security Report Created", {
          report: outputPath,
          findings: input.findings.length,
          artifacts,
          note: "Markdown is the human report; JSON/CSV are structured deliverables for triage, tickets, and dashboards.",
        });
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

function inferScanMode(task: string, timeBoxMinutes?: number): "quick" | "standard" | "deep" {
  const text = task.toLowerCase();
  if (/\b(deep|exhaustive|full|thorough|complete|from\s+0\s+to\s+100|all endpoints|all routes)\b/.test(text)) return "deep";
  if (/\b(quick|fast|triage|smoke|brief|first pass)\b/.test(text)) return "quick";
  if (timeBoxMinutes && timeBoxMinutes <= 45) return "quick";
  if (timeBoxMinutes && timeBoxMinutes >= 240) return "deep";
  return "standard";
}

function buildScanModePlan(input: {
  mode: "quick" | "standard" | "deep";
  task: string;
  targetType: string;
  sourceAvailable: boolean;
  authenticated: boolean;
  timeBoxMinutes?: number;
}): Record<string, unknown> {
  const commonStopRules = [
    "Stop and ask if explicit scope, target, auth permission, or destructive-action consent is missing.",
    "Stop before purchases, bookings, account changes, posting/sending messages, credential entry, deletion, or broad scans.",
    "Stop if captcha, anti-bot, WAF block, or rate-limit behavior prevents reliable safe validation.",
  ];
  const plans = {
    quick: {
      objective: "Rapidly identify obvious high-risk surfaces and produce a short evidence-backed triage.",
      coverage: [
        "Scope confirmation and target classification.",
        "Headers/TLS/CORS/cookies for one explicit URL when web target is provided.",
        "Local pre-recon, secrets scan, config audit, dependency manifest review when source is available.",
        "High-signal vulnerability lanes: auth/authz, injection, SSRF, exposed secrets/debug surfaces.",
      ],
      lanes: ["scope", "attack-surface", "authz", "injection", "config/secrets"],
      evidenceRequired: ["scope proof", "entrypoint inventory", "tool outputs", "candidate verdicts", "limitations"],
      recommendedToolOrder: [
        "security_preflight",
        "security_scan_mode_plan",
        input.sourceAvailable ? "security_pre_recon_code_map" : "security_attack_surface_map",
        "security_playbook",
        "security_create_validation_queue",
        "security_classify_validation_result",
      ],
      timeGuidance: input.timeBoxMinutes ?? 30,
    },
    standard: {
      objective: "Systematically map attack surface, analyze major vulnerability classes, validate safely, and report developer fixes.",
      coverage: [
        "Full route/API/input inventory within configured file/request limits.",
        "Framework/protocol/cloud context playbooks when detected.",
        "Class lanes for injection, XSS, auth, authz, SSRF, CSRF/CORS, file upload, business logic, and secrets/config.",
        "Confirmed, blocked, false-positive, potential, and not-tested verdict separation.",
      ],
      lanes: ["recon", "framework/protocol context", "auth/session", "authz/IDOR", "injection", "xss", "ssrf", "business logic", "defensive remediation"],
      evidenceRequired: ["scope proof", "source/request evidence", "false-positive checks", "safe validation verdicts", "structured findings", "report limitations"],
      recommendedToolOrder: [
        "security_preflight",
        "security_pipeline_plan",
        "security_context_playbook",
        "security_pre_recon_code_map / security_attack_surface_map",
        "security_vulnerability_class_plan",
        "security_create_validation_queue",
        "security_classify_validation_result",
        "security_report_filter",
        "security_create_report",
      ],
      timeGuidance: input.timeBoxMinutes ?? 120,
    },
    deep: {
      objective: "Exhaustive but safe review with state-machine/business-logic reasoning, protocol/cloud context, and attack-chain analysis.",
      coverage: [
        "Every discovered route, parameter, role boundary, storage path, background job, and integration within explicit scope.",
        "Framework/protocol/cloud-specific checks plus class-by-class methodology.",
        "Business logic, workflow transitions, race/idempotency reasoning, supply chain, AI/tool-use risks where relevant.",
        "Attack-chain construction only from evidence-backed findings and explicit limitations for untested areas.",
      ],
      lanes: ["complete recon", "context playbooks", "class-specific queues", "business workflows", "cloud/container posture", "detection engineering", "final retest plan"],
      evidenceRequired: [
        "endpoint/file inventory with coverage notes",
        "per-class queue and verdicts",
        "attack-chain evidence",
        "remediation and prevention plan",
        "detection/monitoring recommendations",
      ],
      recommendedToolOrder: [
        "security_preflight",
        "security_scan_mode_plan",
        "security_pipeline_plan",
        "security_context_playbook",
        "security_pre_recon_code_map",
        "security_extract_endpoints",
        "security_vulnerability_class_plan",
        "security_create_validation_queue",
        "security_classify_validation_result",
        "security_cvss_score",
        "security_create_finding",
        "security_report_filter",
        "security_create_report",
      ],
      timeGuidance: input.timeBoxMinutes ?? 360,
    },
  };
  return {
    mode: input.mode,
    task: input.task,
    targetType: input.targetType,
    sourceAvailable: input.sourceAvailable,
    authenticated: input.authenticated,
    ...plans[input.mode],
    stopRules: commonStopRules,
    safety: "This is an orchestration plan. It does not authorize broad scanning, destructive payloads, credential attacks, persistence, or data exfiltration.",
  };
}

function selectContextPlaybooks(context: string, categories?: SecurityContextPlaybook["category"][]): SecurityContextPlaybook[] {
  const query = context.toLowerCase();
  const allowed = categories?.length ? new Set(categories) : null;
  const scored = SECURITY_CONTEXT_PLAYBOOKS
    .filter((item) => !allowed || allowed.has(item.category))
    .map((item) => {
      const haystack = [item.id, item.title, item.category, ...item.triggers].join(" ").toLowerCase();
      const score = query
        .split(/\s+/)
        .filter(Boolean)
        .reduce((total, token) => total + (haystack.includes(token) ? 1 : 0), 0);
      return { item, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
  return scored.slice(0, 5).map(({ item }) => item);
}

function rememberSecurityRequest(item: Omit<SecurityRequestHistoryItem, "id" | "timestamp">): void {
  const next: SecurityRequestHistoryItem = {
    id: `REQ-${String(SECURITY_REQUEST_HISTORY.length + 1).padStart(4, "0")}`,
    timestamp: new Date().toISOString(),
    ...item,
  };
  SECURITY_REQUEST_HISTORY.push(next);
  while (SECURITY_REQUEST_HISTORY.length > MAX_REQUEST_HISTORY) SECURITY_REQUEST_HISTORY.shift();
}

function buildSecurityCliCommand(
  toolName: z.infer<typeof cliToolRunSchema>["toolName"],
  target: string,
  args: string[],
): { args: string[]; timeoutMs: number } {
  const hasTarget = args.some((arg) => arg === target || arg.includes(target));
  switch (toolName) {
    case "curl":
      return { args: hasTarget ? args : ["-i", "-L", "--max-time", "20", target, ...args], timeoutMs: 30_000 };
    case "dig":
      return { args: hasTarget ? args : [target, ...args], timeoutMs: 20_000 };
    case "openssl": {
      const host = target.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
      const [hostname, port = "443"] = host.split(":");
      return { args: args.length ? args : ["s_client", "-connect", `${hostname}:${port}`, "-servername", hostname, "-brief"], timeoutMs: 25_000 };
    }
    case "nmap":
      return { args: hasTarget ? args : ["-sT", "-sV", "--top-ports", "20", "-Pn", target, ...args], timeoutMs: 90_000 };
    case "nuclei":
      return { args: args.some((arg) => arg === "-u" || arg === "-target") ? args : ["-u", target, "-severity", "low,medium,high,critical", "-silent", ...args], timeoutMs: 90_000 };
    case "ffuf":
      return { args: hasTarget ? args : ["-u", target, ...args], timeoutMs: 90_000 };
    case "httpx":
      return { args: hasTarget ? args : ["-u", target, "-silent", "-status-code", "-title", "-tech-detect", ...args], timeoutMs: 60_000 };
    case "subfinder":
    case "amass":
      return { args: hasTarget ? args : ["-d", target, ...args], timeoutMs: 90_000 };
    case "nikto":
      return { args: hasTarget ? args : ["-h", target, ...args], timeoutMs: 120_000 };
    case "wpscan":
      return { args: hasTarget ? args : ["--url", target, "--no-update", ...args], timeoutMs: 120_000 };
    case "sqlmap":
      return { args: hasTarget ? args : ["-u", target, "--batch", "--crawl=0", ...args], timeoutMs: 120_000 };
  }
}

function validateSecurityCliCommand(
  toolName: z.infer<typeof cliToolRunSchema>["toolName"],
  target: string,
  args: string[],
): { allowed: boolean; risk: "medium" | "high"; reasons: string[]; saferAlternative: string } {
  const reasons: string[] = [];
  const targetCheck = validateExplicitCliTarget(target);
  reasons.push(...targetCheck.reasons);
  if (args.length > 40) reasons.push("Too many arguments for a bounded security tool run.");
  for (const arg of args) {
    if (/[\0\r\n]/.test(arg)) reasons.push(`Argument contains control characters: ${arg}`);
    if (/[;&|`$<>]/.test(arg)) reasons.push(`Shell metacharacters are not allowed in arguments: ${arg}`);
  }
  const lowerArgs = args.map((arg) => arg.toLowerCase());
  const hasAny = (patterns: RegExp[]) => lowerArgs.some((arg) => patterns.some((pattern) => pattern.test(arg)));
  const riskyByTool: Partial<Record<z.infer<typeof cliToolRunSchema>["toolName"], RegExp[]>> = {
    nmap: [/^-[a-z]*a[a-z]*$/i, /^-su$/i, /^--script\b/i, /vuln|exploit|brute|dos/i],
    nuclei: [/^-dast$/i, /^-headless$/i, /fuzz|brute|exposures\/tokens/i],
    ffuf: [/^-x$/i, /^-replay-proxy$/i],
    sqlmap: [/--os-shell|--os-pwn|--file-read|--file-write|--dump|--dump-all|--passwords|--priv-esc|--udf-inject|--tamper/i, /--risk=3|--level=5/i],
    wpscan: [/--password|--wordlist|--usernames|--enumerate\s*u/i],
    amass: [/intel|track|db/i],
  };
  const blockedPatterns = riskyByTool[toolName] ?? [];
  if (blockedPatterns.length && hasAny(blockedPatterns)) {
    reasons.push(`Blocked high-risk ${toolName} flags. Servus only permits bounded, non-destructive usage.`);
  }
  if (["subfinder", "amass"].includes(toolName) && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(target)) {
    reasons.push(`${toolName} requires a single explicit domain, not a URL/path/range.`);
  }
  if (toolName === "ffuf" && !lowerArgs.includes("-w")) {
    reasons.push("ffuf requires an explicit wordlist with -w and user approval.");
  }
  return {
    allowed: reasons.length === 0,
    risk: ["nmap", "nuclei", "ffuf", "sqlmap", "nikto", "wpscan", "amass", "subfinder"].includes(toolName) ? "high" : "medium",
    reasons,
    saferAlternative: "Use built-in security_http_request, security_extract_endpoints, security_header_audit, security_pre_recon_code_map, and validation queues first.",
  };
}

function validateExplicitCliTarget(target: string): { reasons: string[] } {
  const reasons: string[] = [];
  const value = target.trim();
  if (!value) reasons.push("Missing target.");
  if (/[*?\[\]{}]/.test(value)) reasons.push("Wildcards are not allowed.");
  if (/\b\d{1,3}(?:\.\d{1,3}){3}\s*[-/]\s*\d/.test(value) || /\/\d{1,2}$/.test(value)) {
    reasons.push("CIDR/range targets are not allowed.");
  }
  if (/^https?:\/\//i.test(value)) {
    try {
      parseHttpUrl(value);
    } catch (err) {
      reasons.push(err instanceof Error ? err.message : String(err));
    }
  } else if (!/^[a-z0-9.-]+(?::\d{1,5})?$/i.test(value)) {
    reasons.push("Target must be an explicit URL, hostname, domain, or host:port.");
  }
  return { reasons };
}

function normalizeVulnClasses(classes?: VulnerabilityClass[]): VulnerabilityClass[] {
  return classes?.length ? [...new Set(classes)] : ALL_VULN_CLASSES;
}

function renderJsonSection(title: string, value: unknown): string {
  return [`## ${title}`, "", JSON.stringify(value, null, 2)].join("\n");
}

function addQueryParams(rawUrl: string, query?: Record<string, string>): string {
  if (!query || Object.keys(query).length === 0) return rawUrl;
  const url = parseHttpUrl(rawUrl);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.href;
}

async function requestWithTimeout(
  url: URL,
  options: {
    method: string;
    headers?: Record<string, string>;
    body?: string;
    followRedirects: boolean;
    includeBody: boolean;
    maxBytes: number;
  },
): Promise<Record<string, unknown>> {
  const response = await fetchWithTimeout(url, options.maxBytes, {
    method: options.method,
    redirect: options.followRedirects ? "follow" : "manual",
    headers: options.headers,
    body: options.body,
  });
  const headers = selectedHeaders(response.headers);
  const body = options.method === "HEAD" || !options.includeBody ? "" : await limitedText(response, options.maxBytes);
  if (!options.includeBody && options.method !== "HEAD") {
    try {
      response.body?.cancel();
    } catch {
      // ignore stream cleanup failures
    }
  }
  return {
    request: {
      method: options.method,
      url: url.href,
      bodyBytes: options.body ? Buffer.byteLength(options.body, "utf-8") : 0,
    },
    response: {
      status: response.status,
      statusText: response.statusText,
      finalUrl: response.url,
      redirected: response.redirected,
      headers,
      bodyPreview: body,
      bodyBytes: Buffer.byteLength(body, "utf-8"),
    },
    evidence: [
      `${options.method} ${url.href} -> ${response.status}`,
      response.redirected ? `Redirected to ${response.url}` : "No redirect followed",
    ],
  };
}

function extractEndpointInventory(text: string, cwd: string): {
  endpoints: string[];
  absoluteUrls: string[];
  parameters: string[];
  forms: string[];
  javascriptRoutes: string[];
  headers: string[];
} {
  const endpoints = new Set<string>();
  const absoluteUrls = new Set<string>();
  const parameters = new Set<string>();
  const forms: string[] = [];
  const javascriptRoutes = new Set<string>();
  const headers = new Set<string>();
  for (const route of extractRouteStrings(text)) endpoints.add(route);
  for (const value of extractMatches(text, /\bhttps?:\/\/[^\s"'<>\\)]+/gi)) absoluteUrls.add(value);
  for (const value of extractMatches(text, /[?&]([A-Za-z0-9_.:-]{2,80})=/g)) parameters.add(value);
  for (const value of extractMatches(text, /\b(?:name|id|placeholder)\s*=\s*["']([^"']+)["']/gi)) parameters.add(value);
  for (const value of extractMatches(text, /\b(?:fetch|axios\.(?:get|post|put|patch|delete|request)|XMLHttpRequest|open)\s*\(\s*["'`]([^"'`]+)["'`]/gi)) javascriptRoutes.add(value);
  for (const value of extractMatches(text, /["'`]((?:\/api|\/graphql|\/auth|\/admin|\/users|\/v\d+|\/internal)[A-Za-z0-9_./:{?&=%-]*)["'`]/gi)) javascriptRoutes.add(value);
  for (const form of extractMatches(text, /<form\b[\s\S]*?<\/form>/gi)) forms.push(summarizeForm(form));
  for (const value of extractMatches(text, /\b(x-[a-z0-9-]+|authorization|cookie|csrf-token|x-csrf-token|x-api-key|x-forwarded-[a-z-]+)\b/gi)) headers.add(value.toLowerCase());
  return {
    endpoints: [...endpoints].sort(),
    absoluteUrls: [...absoluteUrls].sort(),
    parameters: [...parameters].sort(),
    forms,
    javascriptRoutes: [...javascriptRoutes].sort(),
    headers: [...headers].sort(),
  };
}

function auditCorsHeaders(cors: {
  allowOrigin: string | null;
  allowCredentials: string | null;
  vary: string | null;
  originTested: string;
}): string[] {
  const findings: string[] = [];
  if (!cors.allowOrigin) {
    findings.push("No Access-Control-Allow-Origin observed for the tested preflight.");
  } else if (cors.allowOrigin === "*") {
    findings.push("Wildcard Access-Control-Allow-Origin. This is risky for sensitive APIs and incompatible with credentials.");
  } else if (cors.allowOrigin === cors.originTested) {
    findings.push("Origin reflection observed. Verify this is constrained by an allowlist and not arbitrary reflection.");
  }
  if (/true/i.test(cors.allowCredentials ?? "") && (cors.allowOrigin === "*" || cors.allowOrigin === cors.originTested)) {
    findings.push("Credentialed CORS is enabled. Confirm strict origin allowlisting and CSRF protections.");
  }
  if (cors.allowOrigin && !/\borigin\b/i.test(cors.vary ?? "")) {
    findings.push("Missing Vary: Origin may cause cache confusion for CORS responses.");
  }
  return findings.length ? findings : ["No high-risk CORS behavior detected by this single preflight check."];
}

function splitSetCookieHeader(header: string): string[] {
  return header.split(/,(?=\s*[A-Za-z0-9_.-]+=)/g).map((item) => item.trim()).filter(Boolean);
}

function auditCookie(header: string): { name: string; attributes: string[]; findings: string[] } {
  const parts = header.split(";").map((part) => part.trim());
  const [nameValue, ...attrs] = parts;
  const name = nameValue?.split("=")[0] ?? "cookie";
  const lower = attrs.map((attr) => attr.toLowerCase());
  const findings: string[] = [];
  if (!lower.includes("httponly")) findings.push("Missing HttpOnly.");
  if (!lower.includes("secure")) findings.push("Missing Secure.");
  if (!lower.some((attr) => attr.startsWith("samesite"))) findings.push("Missing SameSite.");
  if (lower.some((attr) => attr === "samesite=none") && !lower.includes("secure")) {
    findings.push("SameSite=None without Secure.");
  }
  if (!lower.some((attr) => attr.startsWith("path="))) findings.push("No explicit Path.");
  return { name, attributes: attrs, findings: findings.length ? findings : ["Cookie has common defensive attributes."] };
}

function securityToolSafetyNote(name: string): string {
  const lower = name.toLowerCase();
  if (["nmap", "masscan", "amass", "subfinder", "ffuf", "nuclei", "sqlmap", "nikto", "wpscan"].includes(lower)) {
    return "External scanner. Require explicit target scope, rate limits, and user approval before execution.";
  }
  if (["curl", "httpx", "jq", "dig", "openssl"].includes(lower)) {
    return "Read-only utility when used against explicit scope.";
  }
  return "Review command behavior before use.";
}

function calculateCvss(input: z.infer<typeof cvssScoreSchema>): {
  vector: string;
  score: number;
  severity: "None" | "Low" | "Medium" | "High" | "Critical";
  impactSubScore: number;
  exploitabilitySubScore: number;
} {
  const av = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }[input.attackVector];
  const ac = { L: 0.77, H: 0.44 }[input.attackComplexity];
  const pr = input.scope === "U"
    ? { N: 0.85, L: 0.62, H: 0.27 }[input.privilegesRequired]
    : { N: 0.85, L: 0.68, H: 0.5 }[input.privilegesRequired];
  const ui = { N: 0.85, R: 0.62 }[input.userInteraction];
  const c = { H: 0.56, L: 0.22, N: 0 }[input.confidentiality];
  const i = { H: 0.56, L: 0.22, N: 0 }[input.integrity];
  const a = { H: 0.56, L: 0.22, N: 0 }[input.availability];
  const iscBase = 1 - ((1 - c) * (1 - i) * (1 - a));
  const impact = input.scope === "U"
    ? 6.42 * iscBase
    : 7.52 * (iscBase - 0.029) - 3.25 * Math.pow(iscBase - 0.02, 15);
  const exploitability = 8.22 * av * ac * pr * ui;
  const rawScore = impact <= 0
    ? 0
    : input.scope === "U"
      ? roundUp1(Math.min(impact + exploitability, 10))
      : roundUp1(Math.min(1.08 * (impact + exploitability), 10));
  return {
    vector: `CVSS:3.1/AV:${input.attackVector}/AC:${input.attackComplexity}/PR:${input.privilegesRequired}/UI:${input.userInteraction}/S:${input.scope}/C:${input.confidentiality}/I:${input.integrity}/A:${input.availability}`,
    score: rawScore,
    severity: cvssSeverity(rawScore),
    impactSubScore: Number(impact.toFixed(2)),
    exploitabilitySubScore: Number(exploitability.toFixed(2)),
  };
}

function roundUp1(value: number): number {
  return Math.ceil(value * 10) / 10;
}

function cvssSeverity(score: number): "None" | "Low" | "Medium" | "High" | "Critical" {
  if (score === 0) return "None";
  if (score < 4) return "Low";
  if (score < 7) return "Medium";
  if (score < 9) return "High";
  return "Critical";
}

function validateCodePathRules(
  repo: string,
  rules?: z.infer<typeof preflightSchema>["rules"],
): { matched: string[]; warnings: string[]; errors: string[] } {
  const matched: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const allRules = [
    ...(rules?.avoid ?? []).map((rule) => ({ kind: "avoid", rule })),
    ...(rules?.focus ?? []).map((rule) => ({ kind: "focus", rule })),
  ];
  for (const { kind, rule } of allRules) {
    if (rule.type !== "code_path") continue;
    const didMatch = codePathRuleMatches(repo, rule.value);
    if (didMatch) {
      matched.push(`${kind}:${rule.value} - ${rule.description}`);
    } else {
      errors.push(`code_path rule did not match any file or directory: ${kind}:${rule.value} (${rule.description})`);
    }
  }
  if (!allRules.length) warnings.push("No focus/avoid rules were provided. Proceed with a broad but bounded safe review.");
  return { matched, warnings, errors };
}

function codePathRuleMatches(repo: string, pattern: string): boolean {
  const regex = globLikeToRegExp(pattern);
  const stack = [repo];
  while (stack.length) {
    const current = stack.pop()!;
    const rel = relative(repo, current) || ".";
    if (regex.test(rel)) return true;
    const stat = statSync(current);
    if (!stat.isDirectory()) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if ([".git", ".servus", ".servus-proofs", "node_modules", "dist", "build", ".next", "coverage"].includes(entry.name)) continue;
      stack.push(join(current, entry.name));
    }
  }
  return false;
}

function globLikeToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/\*\*/g, "__SERVUS_DOUBLE_STAR__")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, ".")
    .replace(/__SERVUS_DOUBLE_STAR__/g, ".*");
  return new RegExp(`^(?:${escaped})(?:/.*)?$`);
}

interface PreReconMap {
  technologies: string[];
  entrypoints: string[];
  authAndSession: string[];
  dataStores: string[];
  sinksByClass: Record<VulnerabilityClass, string[]>;
  controls: string[];
}

function buildPreReconMap(files: string[], cwd: string): PreReconMap {
  const map: PreReconMap = {
    technologies: [],
    entrypoints: [],
    authAndSession: [],
    dataStores: [],
    sinksByClass: {
      injection: [],
      xss: [],
      auth: [],
      authz: [],
      ssrf: [],
    },
    controls: [],
  };
  const technologies = new Set<string>();
  const controls = new Set<string>();
  for (const file of files) {
    const stat = statSync(file);
    if (stat.size > MAX_FILE_BYTES || looksBinary(file)) continue;
    const rel = relative(cwd, file);
    const text = safeReadText(file);
    if (!text) continue;
    classifyTechnology(file, text).forEach((item) => technologies.add(item));
    for (const route of extractRouteStrings(text).slice(0, 30)) {
      map.entrypoints.push(`${rel} -> ${route}`);
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const location = `${rel}:${i + 1}`;
      const trimmed = line.trim().slice(0, 220);
      if (!trimmed) continue;
      if (/\b(jwt|session|cookie|passport|oauth|saml|oidc|mfa|totp|login|logout|password|refresh[_-]?token|bcrypt|argon2)\b/i.test(line)) {
        map.authAndSession.push(`${location} ${trimmed}`);
      }
      if (/\b(prisma|sequelize|mongoose|typeorm|knex|pg\.|mysql|redis|mongodb|dynamo|firestore|supabase|database|db\.)\b/i.test(line)) {
        map.dataStores.push(`${location} ${trimmed}`);
      }
      if (/\b(validate|schema|zod|joi|yup|csrf|rateLimit|helmet|cors|sanitize|escape|authorize|permission|policy)\b/i.test(line)) {
        controls.add(`${location} ${trimmed}`);
      }
      collectClassSink(map, "injection", location, trimmed, line, /\b(exec|spawn|execSync|spawnSync|query|execute|raw|eval|new Function)\b/i);
      collectClassSink(map, "xss", location, trimmed, line, /\b(innerHTML|outerHTML|dangerouslySetInnerHTML|document\.write|sanitize|markdown|html)\b/i);
      collectClassSink(map, "auth", location, trimmed, line, /\b(login|logout|signup|reset|mfa|session|jwt|token|password|cookie)\b/i);
      collectClassSink(map, "authz", location, trimmed, line, /\b(authorize|permission|role|tenant|owner|isAdmin|admin|policy|acl|rbac)\b/i);
      collectClassSink(map, "ssrf", location, trimmed, line, /\b(fetch|axios|got|request|urlopen|requests\.get|http\.get|webhook|callbackUrl|redirectUrl)\b/i);
    }
  }
  map.technologies = [...technologies].sort();
  map.controls = [...controls].slice(0, 120);
  for (const cls of ALL_VULN_CLASSES) {
    map.sinksByClass[cls] = [...new Set(map.sinksByClass[cls])];
  }
  map.entrypoints = [...new Set(map.entrypoints)];
  map.authAndSession = [...new Set(map.authAndSession)];
  map.dataStores = [...new Set(map.dataStores)];
  return map;
}

function collectClassSink(
  map: PreReconMap,
  cls: VulnerabilityClass,
  location: string,
  trimmed: string,
  line: string,
  pattern: RegExp,
): void {
  if (pattern.test(line)) map.sinksByClass[cls].push(`${location} ${trimmed}`);
}

function classifyTechnology(file: string, text: string): string[] {
  const ext = extname(file).toLowerCase();
  const tech = new Set<string>();
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) tech.add("JavaScript/TypeScript");
  if (ext === ".py") tech.add("Python");
  if (ext === ".go") tech.add("Go");
  if (ext === ".rb") tech.add("Ruby");
  if (ext === ".php") tech.add("PHP");
  if (/\b(express|fastify|koa|hono)\b/i.test(text)) tech.add("Node web API");
  if (/\b(next|next\/server|pages\/api|app\/api)\b/i.test(text)) tech.add("Next.js");
  if (/\b(react|vue|svelte|angular)\b/i.test(text)) tech.add("Frontend framework");
  if (/\b(fastapi|flask|django)\b/i.test(text)) tech.add("Python web API");
  if (/\b(spring|RequestMapping|GetMapping|PostMapping)\b/i.test(text)) tech.add("Java/Spring");
  if (/\b(graphql|apollo|resolver|mutation|query)\b/i.test(text)) tech.add("GraphQL");
  if (/\b(prisma|sequelize|typeorm|mongoose|knex)\b/i.test(text)) tech.add("ORM/data layer");
  return [...tech];
}

function shouldInspectForPreRecon(file: string, focus?: string[], avoid?: string[]): boolean {
  if (!looksLikeCode(file) && !looksLikeConfig(file) && !/\b(routes?|controllers?|middleware|auth|security|server|api)\b/i.test(file)) {
    return false;
  }
  const lower = file.toLowerCase();
  if (avoid?.some((item) => lower.includes(item.toLowerCase()))) return false;
  if (focus?.length) {
    return focus.some((item) => lower.includes(item.toLowerCase()));
  }
  return true;
}

function safeReadText(file: string): string {
  try {
    return readFileSync(file, "utf-8");
  } catch {
    return "";
  }
}

function classifyValidationVerdict(input: z.infer<typeof verdictSchema>): ValidationVerdict {
  if (input.attemptedInternalTarget) return "OUT_OF_SCOPE_INTERNAL";
  if (input.securityControlBlocked) return "BLOCKED_BY_SECURITY";
  if (input.reachedSensitiveEffect) return "EXPLOITED";
  const text = `${input.result}\n${input.evidence}`.toLowerCase();
  if (/\b(false positive|not exploitable|safe because|guarded|sanitized|parameterized|allowlist)\b/.test(text)) return "FALSE_POSITIVE";
  if (/\b(not tested|no credentials|no sandbox|needs account|needs scope|unable to validate)\b/.test(text)) return "NOT_TESTED";
  return "POTENTIAL";
}

function severityRank(value: "Low" | "Medium" | "High" | "Critical"): number {
  return { Low: 1, Medium: 2, High: 3, Critical: 4 }[value];
}

function confidenceRank(value: "Low" | "Medium" | "High"): number {
  return { Low: 1, Medium: 2, High: 3 }[value];
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

async function fetchWithTimeout(url: URL, maxBytes: number, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    return await fetch(url, {
      method: "GET",
      redirect: "follow",
      ...init,
      signal: controller.signal,
      headers: {
        "user-agent": "Servus-Security-Agent/1.0 safe-audit",
        accept: "text/html,application/json,text/plain,*/*;q=0.8",
        range: `bytes=0-${Math.max(0, maxBytes - 1)}`,
        ...(init.headers ?? {}),
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
      if ([".git", ".servus", ".servus-proofs", ".servus-security-reports", "node_modules", "dist", "build", ".next", "coverage"].includes(entry.name)) continue;
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
  if (/\b(audit|assessment|assess|review|pentest report|security report)\b/.test(text)) return "Hybrid";
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
    "## Executive Summary",
    "",
    input.executiveSummary ?? summarizeReportExecutive(input),
    "",
    "## Methodology",
    "",
    input.methodology ?? "The assessment used safe, explicit-scope evidence collection aligned to OWASP WSTG, OWASP ASVS, OWASP API Security Top 10, and class-specific validation checks. Findings are separated from hypotheses and include confidence and safe validation status.",
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
      finding.vulnerabilityClass ? `Class: ${finding.vulnerabilityClass}` : "",
      `Severity: ${finding.severity}`,
      finding.verdict ? `Validation Verdict: ${finding.verdict}` : "",
      `Confidence: ${finding.confidence}`,
      "",
      "#### Technical Details",
      finding.details,
      "",
      "#### Evidence",
      finding.proofOfConcept ?? finding.exploitValidation ?? "Evidence is summarized in the technical details and validation sections.",
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
    "## Prioritized Recommendations",
    "",
    input.recommendations ?? summarizeReportRecommendations(input),
  ].join("\n").trimEnd() + "\n";
}

function renderFindingArtifacts(input: z.infer<typeof reportSchema>): Record<string, unknown> {
  return {
    title: input.title,
    modeUsed: input.modeUsed ?? "Hybrid",
    targetSummary: input.targetSummary,
    attackSurfaceOverview: input.attackSurfaceOverview ?? null,
    executiveSummary: input.executiveSummary ?? summarizeReportExecutive(input),
    findings: input.findings.map((finding, index) => ({
      id: `FIND-${String(index + 1).padStart(3, "0")}`,
      title: finding.title,
      severity: finding.severity,
      verdict: finding.verdict ?? null,
      vulnerabilityClass: finding.vulnerabilityClass ?? null,
      confidence: finding.confidence,
      details: finding.details,
      evidence: finding.proofOfConcept ?? finding.exploitValidation ?? null,
      exploitValidation: finding.exploitValidation ?? null,
      attackChain: finding.attackChain ?? null,
      impact: finding.impact,
      remediation: finding.remediation,
      preventionStrategies: finding.preventionStrategies ?? null,
    })),
    recommendations: input.recommendations ?? summarizeReportRecommendations(input),
    generatedAt: new Date().toISOString(),
  };
}

function renderFindingsCsv(input: z.infer<typeof reportSchema>): string {
  const rows = [
    [
      "id",
      "title",
      "severity",
      "verdict",
      "vulnerability_class",
      "confidence",
      "impact",
      "remediation",
      "evidence",
    ],
    ...input.findings.map((finding, index) => [
      `FIND-${String(index + 1).padStart(3, "0")}`,
      finding.title,
      finding.severity,
      finding.verdict ?? "",
      finding.vulnerabilityClass ?? "",
      finding.confidence,
      finding.impact,
      finding.remediation,
      finding.proofOfConcept ?? finding.exploitValidation ?? "",
    ]),
  ];
  return rows.map((row) => row.map(csvEscape).join(",")).join("\n") + "\n";
}

function csvEscape(value: string): string {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function summarizeReportExecutive(input: z.infer<typeof reportSchema>): string {
  const critical = input.findings.filter((finding) => finding.severity === "Critical").length;
  const high = input.findings.filter((finding) => finding.severity === "High").length;
  const total = input.findings.length;
  if (total === 0) {
    return "No confirmed findings were included in this report. Continue monitoring, keep security controls tested, and retest when scope or application behavior changes.";
  }
  return [
    `The assessment identified ${total} finding(s), including ${critical} Critical and ${high} High severity issue(s).`,
    "The most important remediation theme is to address confirmed exploitable paths first, then add regression tests and monitoring around the affected trust boundaries.",
  ].join(" ");
}

function summarizeReportRecommendations(input: z.infer<typeof reportSchema>): string {
  if (!input.findings.length) {
    return "Keep secure defaults enabled, maintain dependency/config hygiene, and schedule a retest when new functionality or scope is added.";
  }
  const immediate = input.findings
    .filter((finding) => finding.severity === "Critical" || finding.severity === "High")
    .map((finding) => `- ${finding.title}: ${finding.remediation}`)
    .slice(0, 8);
  const remaining = input.findings
    .filter((finding) => finding.severity === "Medium" || finding.severity === "Low")
    .map((finding) => `- ${finding.title}: ${finding.remediation}`)
    .slice(0, 8);
  return [
    "Immediate:",
    ...(immediate.length ? immediate : ["- No Critical/High findings in this report."]),
    "",
    "Short-term:",
    ...(remaining.length ? remaining : ["- Add regression tests, monitoring, and secure-default review gates for the assessed surfaces."]),
    "",
    "Retest:",
    "- Re-run focused validation after remediation and confirm each finding is blocked or no longer reachable.",
  ].join("\n");
}

function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[... truncated ${text.length - max} characters ...]`;
}
