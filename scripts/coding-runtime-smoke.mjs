import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { modelMessageSchema } from "ai";
import { loadCodingAgents } from "../dist/coding-agents.js";
import { loadCustomCodingCommands, parseCodingCommand, stripCodingCommand } from "../dist/coding-commands.js";
import { loadCodingInstructions } from "../dist/coding-instructions.js";
import { loadCodingSettings, matchesServusRule, runCodingHooks } from "../dist/coding-settings.js";
import { findCodingOutputStyle, loadCodingOutputStyles } from "../dist/coding-output-styles.js";
import { formatCodingAttachments, resolveCodingMentions } from "../dist/coding-attachments.js";
import { resolveCodingTargetWorkspace } from "../dist/coding-project.js";
import { getFinalization } from "../dist/completion-validator.js";
import { loadCodingSessionReplay } from "../dist/coding-session.js";
import {
  clearCodingUserMessages,
  drainCodingUserMessages,
  queueCodingUserMessage,
  queuedCodingUserMessageCount,
} from "../dist/coding-message-queue.js";
import { CodingRuntime } from "../dist/coding-runtime.js";
import { detectCodingVerificationCommand } from "../dist/coding-runtime.js";
import { CodingToolCatalog } from "../dist/coding-tool-catalog.js";
import { loadSkills, selectSkillsForTask } from "../dist/skills.js";
import { createTools } from "../dist/tools.js";
import { createSession, findSessionIndex, updateSession } from "../dist/session-store.js";
import {
  callMcpTool,
  closeAllMcpClients,
  listMcpResources,
  listMcpServerStatuses,
  listMcpTools,
  readMcpResource,
} from "../dist/mcp-client.js";
import {
  readProjectMemory,
  rememberProjectMemoryFact,
  updateProjectMemoryFromCodingRun,
} from "../dist/project-memory.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const servusDir = process.env.SERVUS_DIR ?? join(homedir(), ".servus");
const root = mkdtempSync(join(tmpdir(), "servus-coding-runtime-"));
const smokeSessionId = `coding-runtime-smoke-${Date.now().toString(36)}`;
mkdirSync(join(root, "src"), { recursive: true });
mkdirSync(join(root, "src/nested"), { recursive: true });
mkdirSync(join(root, ".servus-proofs"), { recursive: true });
mkdirSync(join(root, ".servus"), { recursive: true });
mkdirSync(join(root, ".servus/agents/security"), { recursive: true });
mkdirSync(join(root, ".servus/commands"), { recursive: true });
mkdirSync(join(root, ".servus/commands/frontend"), { recursive: true });
mkdirSync(join(root, ".servus/skills/frontend"), { recursive: true });
mkdirSync(join(root, ".servus/plugins/hook-pack"), { recursive: true });
mkdirSync(join(root, ".servus/output-styles"), { recursive: true });
mkdirSync(join(root, "packages/app/src"), { recursive: true });

writeFileSync(
  join(root, "src/app.js"),
  [
    "export function greet(name) {",
    "  return `Hello, ${name}`;",
    "}",
    "",
    "export const label = 'World';",
    "",
  ].join("\n"),
);
writeFileSync(join(root, ".servus-proofs/noise.js"), "shouldNotAppear\n");
writeFileSync(join(root, "UNSUPPORTED_INSTRUCTIONS.md"), "This non-Servus instruction file should not load.\n");
writeFileSync(join(root, "README.md"), "# Fixture App\n\nA tiny project used to verify Servus project overview behavior.\n");
writeFileSync(join(root, "Makefile"), "build:\n\tprintf build-only\\n\ndeps:\n\tnpm install\n");
writeFileSync(join(root, "packages/app/src/index.js"), "export const nested = true;\n");
writeFileSync(
  join(root, "packages/app/package.json"),
  JSON.stringify({ scripts: { build: "vite build" } }, null, 2),
);
writeFileSync(join(root, ".servus/SERVUS.md"), "Always keep fixture edits small.\n");
writeFileSync(
  join(root, ".servus/agents/security/reviewer.md"),
  [
    "---",
    "description: Review security-sensitive fixture code",
    "tools: [Read, Grep, LS]",
    "read-only: true",
    "---",
    "Review the requested files for security-sensitive behavior using repo evidence only.",
    "",
  ].join("\n"),
);
writeFileSync(
  join(root, ".servus/commands/audit.md"),
  [
    "---",
    "description: Audit a focused area",
    "argument-hint: <area>",
    "mode: review",
    "allowed-tools: [Read, Grep, LS]",
    "model: gpt-4o-mini",
    "---",
    "Review this area with repo evidence: $ARGUMENTS",
    "",
  ].join("\n"),
);
writeFileSync(
  join(root, ".servus/commands/frontend/polish.md"),
  [
    "---",
    "description: Polish a frontend surface",
    "mode: build",
    "allowed-tools: [Read, Edit, Grep]",
    "---",
    "Improve the requested frontend surface without broad rewrites: {{args}}",
    "",
  ].join("\n"),
);
writeFileSync(
  join(root, ".servus/settings.json"),
  JSON.stringify({
    permissions: {
      allow: ["Read(*)"],
      ask: ["Write(src/*)"],
      deny: ["Bash(rm -rf*)"],
    },
    hooks: {
      PreToolUse: [{ matcher: "Write(src/*)", hooks: [{ type: "command", command: "node -e 'process.exit(0)'", once: true }] }],
      PostToolUse: [{ matcher: "Read(*)", hooks: [{ type: "prompt", prompt: "Review read result: $ARGUMENTS", model: "gpt-4o-mini" }] }],
      Stop: [{ hooks: [{ type: "command", command: "node -e 'process.exit(2)'", blocking: true }] }],
    },
  }, null, 2),
);
writeFileSync(
  join(root, ".servus/skills/frontend/SKILL.md"),
  [
    "---",
    "name: frontend-fixture",
    "description: Frontend fixture skill for React UI edits",
    "when_to_use: react frontend app component styling",
    "allowed_tools: [Read, Edit, Grep]",
    "paths: [src/**/*.js]",
    "---",
    "Use existing component patterns and keep the fixture small.",
    "",
  ].join("\n"),
);
writeFileSync(
  join(root, ".servus/plugins/hook-pack/servus.plugin.json"),
  JSON.stringify({
    id: "hook-pack",
    version: "0.1.0",
    name: "Hook Pack",
    description: "Fixture plugin that contributes a Servus hook.",
    activation: { domains: ["coding"], triggers: ["fixture"] },
    hooks: {
      Notification: [{ matcher: "*", hooks: [{ type: "command", command: "node -e 'process.exit(0)'", once: true }] }],
    },
  }, null, 2),
);
writeFileSync(
  join(root, ".servus/output-styles/concise.md"),
  [
    "---",
    "name: concise",
    "description: Keep coding summaries concise",
    "keep-coding-instructions: true",
    "---",
    "Answer with short, evidence-backed coding summaries.",
    "",
  ].join("\n"),
);
writeFileSync(
  join(root, "mcp-fixture-server.mjs"),
  [
    "let buffer = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => {",
    "  buffer += chunk;",
    "  let newline = buffer.indexOf('\\n');",
    "  while (newline >= 0) {",
    "    const line = buffer.slice(0, newline).trim();",
    "    buffer = buffer.slice(newline + 1);",
    "    if (line) handle(JSON.parse(line));",
    "    newline = buffer.indexOf('\\n');",
    "  }",
    "});",
    "function reply(id, result) { console.log(JSON.stringify({ jsonrpc: '2.0', id, result })); }",
    "function handle(request) {",
    "  if (request.id === undefined || request.id === null) return;",
    "  if (request.method === 'initialize') return reply(request.id, { protocolVersion: '2025-06-18', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'servus-fixture', version: '0.1.0' } });",
    "  if (request.method === 'tools/list') return reply(request.id, { tools: [{ name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] });",
    "  if (request.method === 'tools/call') return reply(request.id, { content: [{ type: 'text', text: `echo:${request.params?.arguments?.text ?? ''}` }] });",
    "  if (request.method === 'resources/list') return reply(request.id, { resources: [{ uri: 'servus://fixture/readme', name: 'Fixture README', mimeType: 'text/plain' }] });",
    "  if (request.method === 'resources/read') return reply(request.id, { contents: [{ uri: request.params?.uri, mimeType: 'text/plain', text: 'fixture resource body' }] });",
    "  reply(request.id, {});",
    "}",
    "",
  ].join("\n"),
);
writeFileSync(
  join(root, ".servus/mcp.json"),
  JSON.stringify({
    mcpServers: {
      fixture: {
        command: process.execPath,
        args: [join(root, "mcp-fixture-server.mjs")],
        timeoutMs: 5000,
      },
    },
  }, null, 2),
);

const tools = createTools(root, { sessionId: smokeSessionId, agentName: "CodingAgent" });

const mcpStatuses = await listMcpServerStatuses(root);
assert(mcpStatuses.some((status) => status.name === "fixture" && status.status === "ready"), "Fixture MCP server did not report ready status");
const mcpTools = await listMcpTools(root, "fixture");
assert(mcpTools.some((tool) => tool.name === "echo"), "Fixture MCP tool was not listed");
const mcpToolResult = await callMcpTool(root, "fixture", "echo", { text: "hello" });
assert(JSON.stringify(mcpToolResult).includes("echo:hello"), "Fixture MCP tool call did not return expected content");
const mcpResources = await listMcpResources(root, "fixture");
assert(mcpResources.some((resource) => resource.uri === "servus://fixture/readme"), "Fixture MCP resource was not listed");
const mcpResourceResult = await readMcpResource(root, "fixture", "servus://fixture/readme");
assert(JSON.stringify(mcpResourceResult).includes("fixture resource body"), "Fixture MCP resource read did not return expected content");

const indexedSession = createSession("summarize session-index fixture", "gpt-4o-mini", "custom", root, { domain: "coding", targetCwd: root });
updateSession(indexedSession.id, { status: "completed", runtimeStatus: "completed", finalSummary: "Session index fixture complete.", endTime: Date.now() });
assert(findSessionIndex("session-index fixture").some((entry) => entry.id === indexedSession.id), "Append-only Servus session index did not record searchable session metadata");

assert(
  detectCodingVerificationCommand(root) === undefined,
  "Root Makefile without a test target should not be treated as make test verification",
);
assert(
  detectCodingVerificationCommand(root, undefined, ["packages/app/src/index.js"]) === "cd 'packages/app' && npm run build",
  "Changed-file verification did not resolve the nearest nested package build command",
);

const resolvedWorkspace = resolveCodingTargetWorkspace(`give me a project summary for \`${root}\``, process.cwd());
assert(resolvedWorkspace.targetCwd === root, "Explicit coding target workspace was not resolved from the user task");

const summaryRuntime = new CodingRuntime({
  task: `give me a project summary for \`${root}\``,
  cwd: root,
  model: "gpt-4o-mini",
  backend: "custom",
  maxConsecutiveFailures: 1,
  sessionId: `${smokeSessionId}-summary`,
});
await summaryRuntime.initialize();
assert(summaryRuntime.state.intentContract?.kind === "analysis", "Project summary request was not classified as read-only analysis");
assert(summaryRuntime.state.todos.length <= 1, "Read-only project summary created implementation-style todos");
const skippedVerification = await summaryRuntime.verify("project");
assert(skippedVerification.status === "skipped", "Missing verification command should produce a skipped verification attempt");
assert(
  summaryRuntime.state.evidence.some((item) => item.type === "verification_skipped"),
  "Skipped verification did not record explicit evidence",
);

const learnedMemory = updateProjectMemoryFromCodingRun({
  cwd: root,
  sessionId: smokeSessionId,
  task: "Improve fixture project",
  summary: "Fixture run completed.",
  success: true,
  repo: {
    packageManager: "npm",
    projectType: ["node"],
    scripts: { build: "vite build", test: "vitest" },
    entrypoints: ["src/app.js"],
    configFiles: ["Makefile"],
  },
  checkpoints: [{ changedFiles: ["src/app.js"] }],
  verificationAttempts: [{ command: "npm test", status: "passed" }],
});
assert(learnedMemory.updated, "Project memory update did not record durable candidates");
assert(existsSync(learnedMemory.memoryPath), "Project MEMORY.md was not written");
const learnedMemoryText = readFileSync(learnedMemory.memoryPath, "utf-8");
assert(learnedMemoryText.includes("Package manager: npm"), "Project memory did not store package manager");
assert(learnedMemoryText.includes("Known passing verification command: npm test"), "Project memory did not store passing verification command");
const explicitMemory = rememberProjectMemoryFact({
  cwd: root,
  sessionId: smokeSessionId,
  text: "Fixture convention: src/app.js owns the greeting helper used by tests.",
  category: "architecture",
  source: "smoke",
  reason: "Future fixture edits should inspect the greeting helper first.",
  confidence: "high",
});
assert(explicitMemory.updated, "Explicit project memory fact was not written");
const memoryRead = readProjectMemory(root, 10_000);
assert(memoryRead.text.includes("Fixture convention: src/app.js owns the greeting helper"), "Project memory read did not include explicit memory fact");

const hiddenGrep = await tools.Grep.execute({
  pattern: "shouldNotAppear",
  path: ".",
  output_mode: "content",
});
assert(!String(hiddenGrep).includes(".servus-proofs"), "Servus proof path leaked into Grep output");

const hiddenGlob = await tools.Glob.execute({
  pattern: "**/*.js",
  path: ".",
  limit: 50,
});
assert(!String(hiddenGlob).includes(".servus-proofs"), "Servus proof path leaked into Glob output");

const workspaceMap = await tools.WorkspaceMap.execute({
  path: ".",
  max_depth: 2,
  limit: 80,
});
assert(String(workspaceMap).includes("Workspace map:"), "WorkspaceMap did not return a project map");
assert(String(workspaceMap).includes("src/") || String(workspaceMap).includes("src"), "WorkspaceMap did not include visible source folder");
assert(!String(workspaceMap).includes(".servus-proofs"), "Servus proof path leaked into WorkspaceMap output");

const projectOverview = await tools.ProjectOverview.execute({
  path: ".",
  max_depth: 2,
  excerpt_chars: 800,
});
assert(String(projectOverview).includes("Project overview:"), "ProjectOverview did not return a project overview");
assert(String(projectOverview).includes("README.md"), "ProjectOverview did not inspect root docs");
assert(String(projectOverview).includes("src/app.js"), "ProjectOverview did not include likely source entrypoint");
assert(!String(projectOverview).includes(".servus-proofs"), "Servus proof path leaked into ProjectOverview output");

const pagedLs = await tools.LS.execute({ path: "src", limit: 1 });
assert(String(pagedLs).includes("truncated=yes"), "LS pagination did not report truncation metadata");

const missingMakeTarget = await tools.Bash.execute({
  command: "make test",
  description: "missing Makefile target smoke",
});
assert(String(missingMakeTarget).includes("Makefile target \"test\" was not found"), "Bash did not block missing make target");
const makeTargetWithInstall = await tools.Bash.execute({
  command: "make deps",
  description: "make target approval smoke",
});
assert(String(makeTargetWithInstall).includes("requires explicit user approval"), "Bash did not require approval for mutating Makefile target");
const noisyShell = await tools.Bash.execute({
  command: "node -e \"const p=String.fromCharCode(60)+'s'+String.fromCharCode(62)+' [webpack.Progress] '; console.log(p+'1% setup'); console.log(p+'2% build'); console.log('compiled successfully')\"",
  description: "collapse noisy progress output",
});
assert(String(noisyShell).includes("omitted 2 repetitive progress lines"), "Bash output policy did not collapse progress spam");
assert(String(noisyShell).includes("compiled successfully"), "Bash output policy removed useful terminal output");

const backgroundBash = await tools.Bash.execute({
  command: "node -e \"setInterval(function(){ console.log('servus-bg-tick') }, 200)\"",
  description: "background BashOutput smoke",
  run_in_background: true,
  timeout: 5_000,
});
const backgroundTaskId = String(backgroundBash).match(/shell-[a-z0-9-]+/)?.[0];
assert(backgroundTaskId, `Background Bash did not return a task id: ${backgroundBash}`);
await new Promise((resolve) => setTimeout(resolve, 450));
const backgroundOutput = await tools.BashOutput.execute({ task_id: backgroundTaskId, limit: 2000 });
assert(String(backgroundOutput).includes("servus-bg-tick"), "BashOutput did not return background task output");
const killedBackground = await tools.KillBash.execute({ task_id: backgroundTaskId });
assert(String(killedBackground).includes("was stopped"), "KillBash did not stop the background task");

const editBeforeRead = await tools.Edit.execute({
  file_path: "src/app.js",
  old_string: "Hello",
  new_string: "Hi",
});
assert(String(editBeforeRead).includes("read-before-edit"), "Edit did not enforce read-before-edit");

const readResult = await tools.Read.execute({ file_path: "src/app.js" });
assert(String(readResult).includes("Read session:"), "Read did not accept Servus-style file_path input");
const appBeforeStaleCheck = readFileSync(join(root, "src/app.js"), "utf-8");
writeFileSync(join(root, "src/app.js"), appBeforeStaleCheck.replace("Hello", "Hello there"));
const staleEdit = await tools.Edit.execute({
  file_path: "src/app.js",
  old_string: "Hello",
  new_string: "Hi",
});
assert(String(staleEdit).includes("stale read"), "Edit did not block after the file changed outside the read state");
writeFileSync(join(root, "src/app.js"), appBeforeStaleCheck);
await tools.Read.execute({ file_path: "src/app.js" });

const multiEdit = await tools.MultiEdit.execute({
  file_path: "src/app.js",
  edits: [
    { old_string: "Hello", new_string: "Hi" },
    { old_string: "World", new_string: "Servus" },
  ],
});
assert(String(multiEdit).includes("MultiEdit applied"), `MultiEdit failed: ${multiEdit}`);

const edited = readFileSync(join(root, "src/app.js"), "utf-8");
assert(edited.includes("Hi, ${name}") && edited.includes("'Servus'"), "MultiEdit did not write expected content");

const writeResult = await tools.Write.execute({
  file_path: "src/generated.js",
  content: "export const generated = true;\n",
  explicitUserRequest: true,
});
assert(String(writeResult).includes("Created src/generated.js"), "Write did not create the requested file");
const writeThenEdit = await tools.Edit.execute({
  file_path: "src/generated.js",
  old_string: "true",
  new_string: "false",
});
assert(!String(writeThenEdit).includes("read-before-edit"), "Write did not update same-session read state for follow-up edits");

const resumedTools = createTools(root, { sessionId: smokeSessionId, agentName: "CodingAgent" });
const resumedEdit = await resumedTools.Edit.execute({
  file_path: "src/app.js",
  old_string: "Hi, ${name}",
  new_string: "Hey, ${name}",
});
assert(!String(resumedEdit).includes("read-before-edit"), "Persisted Servus read state did not allow same-session resumed edit");

const nativePatchText = [
  "--- a/src/app.js",
  "+++ b/src/app.js",
  "@@ -1,6 +1,6 @@",
  " export function greet(name) {",
  "-  return `Hey, ${name}`;",
  "+  return `Welcome, ${name}`;",
  " }",
  " ",
  " export const label = 'Servus';",
  "",
].join("\n");
const patchResult = await resumedTools.patch.execute({ patchText: nativePatchText });
assert(String(patchResult).includes("Patch applied natively by Servus"), `Native patch did not apply: ${patchResult}`);
assert(readFileSync(join(root, "src/app.js"), "utf-8").includes("Welcome, ${name}"), "Native patch did not update expected content");
const preMutationSnapshotLog = join(servusDir, "sessions", smokeSessionId, "coding", "snapshots", "pre-mutation.jsonl");
assert(existsSync(preMutationSnapshotLog), "Pre-mutation snapshot log was not written for mutating coding tools");

const snapshotRuntime = new CodingRuntime({
  task: "snapshot fallback smoke",
  cwd: root,
  model: "gpt-4o-mini",
  backend: "custom",
  maxConsecutiveFailures: 1,
  sessionId: smokeSessionId,
});
await snapshotRuntime.initialize();
const snapshotCheckpoint = await snapshotRuntime.createCheckpoint({
  text: "native patch checkpoint smoke",
  cost: 0,
  turns: 1,
  subtype: "success",
  toolEvents: [{
    type: "call",
    toolName: "patch",
    toolCallId: "call-native-patch",
    input: { patchText: nativePatchText },
    timestamp: Date.now(),
  }],
});
assert(snapshotCheckpoint.snapshotArtifact, "Non-git checkpoint did not capture a snapshot artifact");
const snapshotRevert = await snapshotRuntime.revertCheckpoint(snapshotCheckpoint.id);
assert(snapshotRevert.ok, `Snapshot checkpoint revert failed: ${snapshotRevert.summary}`);
assert(readFileSync(join(root, "src/app.js"), "utf-8").includes("Hello, ${name}"), "Snapshot checkpoint revert did not restore pre-mutation content");

const applyPatchResult = await resumedTools.patch.execute({
  patchText: [
    "*** Begin Patch",
    "*** Update File: src/app.js",
    "@@ -1,6 +1,6 @@",
    " export function greet(name) {",
    "-  return `Hello, ${name}`;",
    "+  return `Hola, ${name}`;",
    " }",
    " ",
    " export const label = 'World';",
    "*** Add File: src/apply-added.js",
    "+export const addedByApplyPatch = true;",
    "*** Delete File: src/generated.js",
    "*** End Patch",
    "",
  ].join("\n"),
});
assert(String(applyPatchResult).includes("Patch applied natively by Servus"), `Servus apply-patch block did not apply: ${applyPatchResult}`);
assert(readFileSync(join(root, "src/app.js"), "utf-8").includes("Hola, ${name}"), "Servus apply-patch update did not modify expected content");
assert(readFileSync(join(root, "src/apply-added.js"), "utf-8").includes("addedByApplyPatch"), "Servus apply-patch add did not create expected file");
assert(!existsSync(join(root, "src/generated.js")), "Servus apply-patch delete did not remove expected file");

const instructions = loadCodingInstructions(root);
assert(instructions.some((source) => source.label === ".servus/SERVUS.md"), "Servus project instruction file was not loaded");
assert(
  !instructions.some((source) => source.label === "UNSUPPORTED_INSTRUCTIONS.md"),
  "Servus loaded a non-Servus instruction file instead of only Servus-branded instruction paths",
);
const nestedInstructions = loadCodingInstructions(join(root, "src/nested"));
assert(nestedInstructions.some((source) => source.label === ".servus/SERVUS.md"), "Nested runs did not load root Servus instructions");

const codingAgents = loadCodingAgents(root);
assert(codingAgents.some((agent) => agent.id === "security:reviewer"), "Namespaced Servus coding subagent was not loaded");
assert(codingAgents.find((agent) => agent.id === "security:reviewer")?.readOnly, "Namespaced Servus coding subagent did not preserve read-only default");

const customCommands = loadCustomCodingCommands(root);
assert(customCommands.some((command) => command.id === "audit"), "Custom .servus command was not loaded");
assert(customCommands.some((command) => command.id === "frontend:polish"), "Namespaced Servus command was not loaded");
const auditCommand = customCommands.find((command) => command.id === "audit");
assert(auditCommand?.allowedTools?.includes("Grep"), "Custom .servus command allowed tools were not parsed");
assert(auditCommand?.model === "gpt-4o-mini", "Custom .servus command model was not parsed");
const parsedCommand = parseCodingCommand("/audit auth flow", join(root, "src/nested"));
assert(parsedCommand?.custom?.id === "audit", "Custom .servus slash command was not parsed");
const expandedCommand = stripCodingCommand("/audit auth flow", parsedCommand);
assert(expandedCommand.includes("Review this area with repo evidence: auth flow"), "Custom .servus command arguments were not rendered");
const nestedCommand = parseCodingCommand("/frontend:polish hero layout", root);
assert(nestedCommand?.custom?.id === "frontend:polish", "Namespaced Servus command did not parse");
assert(stripCodingCommand("/frontend:polish hero layout", nestedCommand).includes("hero layout"), "Namespaced Servus command did not render arguments");
assert(parseCodingCommand("/init", root)?.immediate, "Built-in /init command was not parsed");
assert(parseCodingCommand("/help", root)?.immediate, "Built-in /help command was not parsed");
assert(parseCodingCommand("/tools", root)?.immediate, "Built-in /tools command was not parsed");
assert(parseCodingCommand("/model", root)?.immediate, "Built-in /model command was not parsed");
assert(parseCodingCommand("/coordinate refactor auth", root)?.mode === "coordinate", "Built-in /coordinate command was not parsed");
assert(parseCodingCommand("/sessions runtime", root)?.immediate, "Built-in /sessions command was not parsed");
assert(parseCodingCommand("/search runtime", root)?.immediate, "Built-in /search command was not parsed");
assert(parseCodingCommand("/commands", root)?.immediate, "Built-in /commands command was not parsed");
assert(parseCodingCommand("/settings", root)?.immediate, "Built-in /settings command was not parsed");
assert(parseCodingCommand("/skills", root)?.immediate, "Built-in /skills command was not parsed");
assert(parseCodingCommand("/transcript 20", root)?.immediate, "Built-in /transcript command was not parsed");
assert(parseCodingCommand("/output-style concise", root)?.immediate, "Built-in /output-style command was not parsed");
assert(parseCodingCommand("/doctor", root)?.immediate, "Built-in /doctor command was not parsed");

const settings = loadCodingSettings(root);
assert(settings.permissions.deny.some((rule) => rule.rule === "Bash(rm -rf*)"), "Servus coding settings permissions were not loaded");
assert(settings.hooks.PreToolUse?.length === 1, "Servus coding hooks were not loaded");
assert(settings.hooks.PreToolUse?.[0]?.hooks[0]?.once === true, "Servus once hook option was not loaded");
assert(settings.hooks.PostToolUse?.[0]?.hooks[0]?.type === "prompt", "Servus prompt hooks were not loaded");
assert(settings.hooks.Stop?.length === 1, "Servus Stop hooks were not loaded");
assert(settings.hooks.Notification?.some((matcher) => matcher.source === "plugin"), "Plugin-contributed hooks were not loaded");
assert(matchesServusRule("Write(src/*)", "Write", { file_path: "src/app.js" }), "Servus rule matcher did not match tool/input");
assert(!matchesServusRule("Write(src/*)", "Read", { file_path: "src/app.js" }), "Servus rule matcher matched the wrong tool");
const allowedPreHook = await runCodingHooks(settings, "PreToolUse", {
  event: "PreToolUse",
  cwd: root,
  agentName: "Smoke",
  toolName: "Write",
  toolInput: { file_path: "src/app.js" },
});
assert(allowedPreHook.length === 1, "PreToolUse hook did not run");
assert(!allowedPreHook[0].blocked, "Successful PreToolUse hook should not block");
const blockedStopHook = await runCodingHooks(settings, "Stop", {
  event: "Stop",
  cwd: root,
  agentName: "Smoke",
  toolOutput: "done",
});
assert(blockedStopHook.some((result) => result.blocked), "Blocking Stop hook with non-zero exit did not block");

const skills = loadSkills({ cwd: join(root, "src/nested") });
assert(skills.some((skill) => skill.name === "frontend-fixture"), "Nested runs did not load root Servus skills");
const selectedSkills = selectSkillsForTask("update react frontend app styling", skills);
assert(selectedSkills.some((skill) => skill.name === "frontend-fixture"), "Servus skill selector did not select matching skill");
const pathSelectedSkills = selectSkillsForTask("update behavior", skills, { paths: ["src/app.js"] });
assert(pathSelectedSkills.some((skill) => skill.name === "frontend-fixture"), "Servus path-aware skill selector did not activate matching skill");

const outputStyles = loadCodingOutputStyles(join(root, "src/nested"));
assert(outputStyles.some((style) => style.id === "concise"), "Nested runs did not load root Servus output styles");
assert(findCodingOutputStyle(outputStyles, "concise")?.description.includes("concise"), "Servus output style lookup failed");

const attachments = resolveCodingMentions("please inspect @src/app.js:1-3 and @missing.js", root);
assert(attachments.some((attachment) => attachment.path === "src/app.js" && attachment.kind === "file"), "Servus @path attachment did not resolve file");
assert(attachments.some((attachment) => attachment.requested === "@missing.js" && attachment.kind === "missing"), "Servus @path attachment did not report missing file");
assert(formatCodingAttachments(attachments).includes("User-Mentioned Context Attachments"), "Servus @path attachment prompt was not formatted");

execFileSync("git", ["init", "-q"], { cwd: root });
const runtime = new CodingRuntime({
  task: "/coordinate fix TUI",
  cwd: root,
  model: "gpt-4o-mini",
  backend: "custom",
  maxConsecutiveFailures: 1,
  sessionId: smokeSessionId,
});
await runtime.initialize();
const scheduledCatalog = new CodingToolCatalog(
  {
    task: "scheduler smoke",
    cwd: root,
    model: "gpt-4o-mini",
    backend: "custom",
    maxConsecutiveFailures: 1,
    sessionId: smokeSessionId,
  },
  runtime,
  { agentName: "SchedulerSmoke", includeTask: false },
);
const scheduledResults = await Promise.all([
  scheduledCatalog.scheduleToolCall({
    toolCallId: "schedule-read",
    toolName: "Read",
    input: { file_path: "src/app.js", limit: 4 },
  }),
  scheduledCatalog.scheduleToolCall({
    toolCallId: "schedule-ls",
    toolName: "LS",
    input: { path: "src" },
  }),
]);
assert(scheduledResults.every((result) => !result.isError), "Streaming scheduler failed for read-only tool calls");
const unavailableTool = await scheduledCatalog.executeToolCalls([{
  toolCallId: "missing-tool",
  toolName: "apply_patch",
  input: { patch: "noop" },
}]);
assert(
  unavailableTool[0]?.isError && unavailableTool[0]?.output.includes("Use one of these Servus tools instead: patch"),
  "Unavailable coding tool response did not suggest the Servus replacement tool",
);
assert(!runtime.intentQuestion(), "Short actionable coding task incorrectly triggered a shallow intent question");
assert(runtime.state.mode === "coordinate", "Coordinate mode was not initialized");
assert(runtime.buildSystemPrompt().includes("Servus Coordinator Mode"), "Coordinator prompt was not injected");
assert(runtime.state.repo?.workspaceMap?.some((item) => item === "src/"), "Repository workspace map did not include top-level source directory");
assert(runtime.state.repo?.entrypoints?.some((item) => item === "src/app.js"), "Repository context did not detect likely source entrypoint");
assert(runtime.buildInitialMessage().includes("<servus_startup_context>"), "Servus startup context block was not injected into the coding initial message");
assert(runtime.buildSessionsSummary().includes("Servus project sessions"), "Servus session summary was not built");
assert(runtime.buildHelpSummary().includes("/plan"), "Servus coding help summary was not built");
assert(runtime.buildToolsSummary().includes("Edit / MultiEdit"), "Servus coding tools summary was not built");
assert(runtime.buildToolsSummary().includes("MemoryRead / MemoryWrite"), "Servus coding memory tools summary was not built");
assert(runtime.buildContextSummary().includes("Context suggestions:"), "Servus coding context suggestions were not included in /context output");
const remembered = runtime.rememberInstruction("Use npm test as the preferred fixture verification command.");
assert(remembered.ok, "/remember did not save a project instruction");
assert(remembered.artifacts.some((artifact) => artifact.endsWith(".servus/instructions.md")), "/remember did not write repo-local Servus instructions");
const rememberedMemory = readProjectMemory(root, 12_000);
assert(rememberedMemory.text.includes("Use npm test as the preferred fixture verification command."), "/remember did not update managed Servus project memory");
const memoryReadResults = await scheduledCatalog.executeToolCalls([{
  toolCallId: "memory-read",
  toolName: "MemoryRead",
  input: { maxChars: 10_000 },
}]);
assert(!memoryReadResults[0]?.isError, "MemoryRead failed through the Servus coding tool catalog");
assert(
  memoryReadResults[0]?.output.includes("Fixture convention: src/app.js owns the greeting helper used by tests."),
  "MemoryRead did not expose durable project memory through the tool catalog",
);
const workerRequest = runtime.requestHelper("worker", "Research fixture", "Inspect src/app.js and report evidence.");
assert(workerRequest.type === "worker", "Worker helper request was not created");
const continued = runtime.requestHelperContinuation(workerRequest.id, "Continue with a focused verification report.");
assert(continued.continueFrom === undefined || continued.type === "worker", "Worker continuation was not accepted");
const stopResults = await runtime.runStopHooks("smoke completion", false);
assert(stopResults.some((result) => result.blocked), "Blocking Servus Stop hook did not produce a blocked result");

writeFileSync(join(root, "src/new-checkpoint.js"), "export const checkpoint = true;\n");
const checkpoint = await runtime.createCheckpoint({
  text: "checkpoint smoke",
  cost: 0,
  turns: 1,
  subtype: "success",
  toolEvents: [{
    type: "call",
    toolName: "Write",
    toolCallId: "call-new-file",
    input: { file_path: "src/new-checkpoint.js" },
    timestamp: Date.now(),
  }],
});
assert(checkpoint.diffSummary.includes("src/new-checkpoint.js"), "Checkpoint summary did not include the new file");
if (checkpoint.diffArtifact) {
  assert(readFileSync(checkpoint.diffArtifact, "utf-8").includes("new file mode"), "New-file checkpoint diff did not include a reversible patch");
  const revertResult = await runtime.revertCheckpoint(checkpoint.id);
  assert(revertResult.ok, `Checkpoint revert failed: ${revertResult.summary}`);
  assert(!existsSync(join(root, "src/new-checkpoint.js")), "Checkpoint revert did not remove the new file");
}

const queuedMessage = queueCodingUserMessage({
  sessionId: smokeSessionId,
  message: "please keep this same-session edit small",
  source: "tui",
});
assert(queuedMessage?.message.includes("same-session"), "Same-session coding message was not queued");
assert(queuedCodingUserMessageCount(smokeSessionId) === 1, "Same-session coding message count was wrong");
const drainedMessages = drainCodingUserMessages(smokeSessionId);
assert(drainedMessages.length === 1, "Same-session coding message was not drained");
assert(queuedCodingUserMessageCount(smokeSessionId) === 0, "Same-session coding message queue was not emptied");
queueCodingUserMessage({
  sessionId: smokeSessionId,
  message: "this queued message should be cleared",
  source: "tui",
});
clearCodingUserMessages(smokeSessionId);
assert(queuedCodingUserMessageCount(smokeSessionId) === 0, "Cleared same-session coding message still appeared pending");

const toolMessage = {
  role: "tool",
  content: [{
    type: "tool-result",
    toolCallId: "call-smoke",
    toolName: "Read",
    output: { type: "text", value: "ok" },
  }],
};
assert(modelMessageSchema.safeParse(toolMessage).success, "Manual coding loop tool-result message is not AI SDK ModelMessage compatible");

const taggedDone = getFinalization({
  text: `<servus_done_json>${JSON.stringify({
    summary: "done",
    evidence: [{ type: "repo_evidence", source: "Read", summary: "Inspected src/app.js" }],
    satisfied_criteria: ["answered"],
    confidence: "high",
  })}</servus_done_json>`,
  cost: 0,
  turns: 1,
  subtype: "success",
});
assert(taggedDone?.kind === "done" && taggedDone.evidence?.length === 1, "Tagged servus_done_json finalization was not parsed");

const taggedQuestion = getFinalization({
  text: `<servus_need_input_json>${JSON.stringify({
    question: "Which scope should Servus use?",
    options: ["TUI only", "Coding runtime only"],
  })}</servus_need_input_json>`,
  cost: 0,
  turns: 1,
  subtype: "success",
});
assert(taggedQuestion?.kind === "need_input" && taggedQuestion.choices?.[0]?.options.length === 2, "Tagged need-input finalization was not parsed");

const replay = loadCodingSessionReplay(smokeSessionId, root);
assert(replay.readStateFiles > 0, "Coding session replay did not find persisted read state");
assert(replay.toolResultArtifacts >= 0 && replay.queuedUserMessages === 0, "Coding session replay returned invalid summary metadata");

closeAllMcpClients();
console.log("coding-runtime smoke passed");
