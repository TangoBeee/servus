import { spawn, execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, relative, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { registerChild, unregisterChild } from "./child-registry.js";
import { loadConfig } from "./config.js";
import { loadPlugins } from "./plugins.js";

export type LspOperation =
  | "goToDefinition"
  | "findReferences"
  | "hover"
  | "documentSymbol"
  | "workspaceSymbol"
  | "goToImplementation"
  | "prepareCallHierarchy"
  | "incomingCalls"
  | "outgoingCalls";

export interface LspInput {
  operation: LspOperation;
  filePath: string;
  line: number;
  character: number;
}

interface LspServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  extensions?: string[];
  languages?: Record<string, string>;
  languageId?: string;
  initializationOptions?: unknown;
}

interface ResolvedLspServer {
  name: string;
  config: LspServerConfig;
  source: "config" | "project" | "user" | "plugin" | "auto";
}

const MAX_LSP_FILE_SIZE = 10 * 1024 * 1024;

const DEFAULT_LANGUAGE_IDS: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".css": "css",
  ".scss": "scss",
  ".html": "html",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
};

const AUTO_SERVERS: LspServerConfig[] = [
  {
    command: "typescript-language-server",
    args: ["--stdio"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
    languages: {
      ".ts": "typescript",
      ".tsx": "typescriptreact",
      ".js": "javascript",
      ".jsx": "javascriptreact",
      ".mjs": "javascript",
      ".cjs": "javascript",
    },
  },
  { command: "pyright-langserver", args: ["--stdio"], extensions: [".py"], languageId: "python" },
  { command: "rust-analyzer", extensions: [".rs"], languageId: "rust" },
  { command: "gopls", extensions: [".go"], languageId: "go" },
  { command: "vscode-json-language-server", args: ["--stdio"], extensions: [".json"], languageId: "json" },
  { command: "vscode-css-language-server", args: ["--stdio"], extensions: [".css", ".scss"], languageId: "css" },
  { command: "vscode-html-language-server", args: ["--stdio"], extensions: [".html"], languageId: "html" },
];

export async function tryRealLsp(cwd: string, input: LspInput): Promise<string | null> {
  const abs = resolve(cwd, input.filePath);
  if (!existsSync(abs) || !statSync(abs).isFile()) return null;
  if (statSync(abs).size > MAX_LSP_FILE_SIZE) return null;
  const server = selectLspServer(cwd, abs);
  if (!server) return null;
  try {
    const result = await runLspRequest(cwd, abs, input, server);
    if (!result.trim()) return null;
    return result;
  } catch {
    return null;
  }
}

export function summarizeLspAvailability(cwd: string): string {
  const servers = resolveLspServers(cwd);
  if (servers.length === 0) {
    return "No LSP servers configured or detected. Add .servus/lsp.json, .lsp.json, ~/.servus/lsp.json, plugin lspServers, or install language servers such as typescript-language-server.";
  }
  return [
    `Available LSP server candidates: ${servers.length}`,
    "",
    ...servers.map((server) => `- ${server.name} (${server.source}): ${server.config.command} ${(server.config.args ?? []).join(" ")} [${(server.config.extensions ?? []).join(", ") || "extensions unspecified"}]`),
  ].join("\n");
}

function selectLspServer(cwd: string, filePath: string): ResolvedLspServer | null {
  const ext = extname(filePath).toLowerCase();
  return resolveLspServers(cwd).find((server) => (server.config.extensions ?? []).includes(ext)) ?? null;
}

function resolveLspServers(cwd: string): ResolvedLspServer[] {
  const servers: ResolvedLspServer[] = [];
  const config = loadConfig();
  for (const [name, server] of Object.entries((config as { lspServers?: Record<string, LspServerConfig> }).lspServers ?? {})) {
    if (server.command) servers.push({ name, config: server, source: "config" });
  }
  for (const [source, path] of [
    ["project", resolve(cwd, ".servus", "lsp.json")],
    ["project", resolve(cwd, ".lsp.json")],
    ["user", join(process.env.HOME || homedir(), ".servus", "lsp.json")],
  ] as const) {
    for (const [name, server] of Object.entries(readLspConfigFile(path))) {
      if (server.command) servers.push({ name, config: server, source });
    }
  }
  for (const plugin of loadPlugins({ cwd, extraDirs: config.plugins?.dirs, disabled: config.plugins?.disabled })) {
    const lspServers = (plugin as { lspServers?: Record<string, LspServerConfig> }).lspServers ?? {};
    for (const [name, server] of Object.entries(lspServers)) {
      if (server.command) servers.push({ name: `${plugin.id}:${name}`, config: server, source: "plugin" });
    }
  }
  for (const server of AUTO_SERVERS) {
    if (commandExists(server.command)) {
      servers.push({ name: `auto:${server.command}`, config: server, source: "auto" });
    }
  }
  const seen = new Set<string>();
  return servers.filter((server) => {
    const key = `${server.config.command}:${(server.config.args ?? []).join(" ")}:${(server.config.extensions ?? []).join(",")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function readLspConfigFile(path: string): Record<string, LspServerConfig> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    const record = asRecord(parsed);
    const servers = asRecord(record.servers ?? parsed);
    const result: Record<string, LspServerConfig> = {};
    for (const [name, value] of Object.entries(servers)) {
      const server = asRecord(value);
      if (typeof server.command !== "string") continue;
      result[name] = {
        command: server.command,
        args: Array.isArray(server.args) ? server.args.map(String) : [],
        env: isStringRecord(server.env) ? server.env : undefined,
        extensions: Array.isArray(server.extensions) ? server.extensions.map((item) => normalizeExt(String(item))) : [],
        languages: isStringRecord(server.languages) ? server.languages : undefined,
        languageId: typeof server.languageId === "string" ? server.languageId : undefined,
        initializationOptions: server.initializationOptions,
      };
    }
    return result;
  } catch {
    return {};
  }
}

async function runLspRequest(
  cwd: string,
  filePath: string,
  input: LspInput,
  server: ResolvedLspServer,
): Promise<string> {
  const child = spawn(server.config.command, server.config.args ?? [], {
    cwd,
    env: { ...process.env, ...(server.config.env ?? {}) },
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  if (child.pid) registerChild(child.pid, { processGroup: process.platform !== "win32" });
  const stderr: Buffer[] = [];
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
  const connection = createLspConnection(child.stdout!);

  try {
    let id = 1;
    await sendRequest(child, connection, id++, "initialize", {
      processId: null,
      rootPath: cwd,
      rootUri: pathToFileURL(cwd).toString(),
      workspaceFolders: [{ uri: pathToFileURL(cwd).toString(), name: cwd.split(/[\\/]/).pop() || "workspace" }],
      capabilities: {
        textDocument: {
          definition: { linkSupport: true },
          implementation: { linkSupport: true },
          hover: { contentFormat: ["markdown", "plaintext"] },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          references: {},
          callHierarchy: {},
        },
        workspace: { symbol: {} },
      },
      initializationOptions: server.config.initializationOptions,
      clientInfo: { name: "servus", version: "0.1.0" },
    });
    sendNotification(child, "initialized", {});

    const text = readFileSync(filePath, "utf-8");
    const uri = pathToFileURL(filePath).toString();
    sendNotification(child, "textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: languageIdFor(server.config, filePath),
        version: 1,
        text,
      },
    });

    const { method, params, needsPrepare } = lspMethodAndParams(input, filePath, uri);
    let result: unknown;
    if (needsPrepare) {
      const prepared = await sendRequest(child, connection, id++, "textDocument/prepareCallHierarchy", params);
      const first = Array.isArray(prepared) ? prepared[0] : prepared;
      if (!first) return `Real LSP (${server.name}) returned no call hierarchy item.`;
      result = await sendRequest(child, connection, id++, method, { item: first });
    } else {
      result = await sendRequest(child, connection, id++, method, params);
    }

    sendNotification(child, "textDocument/didClose", { textDocument: { uri } });
    return [
      `Real LSP (${server.name}) ${input.operation} result:`,
      "",
      formatLspResult(input.operation, result, cwd),
    ].join("\n");
  } catch (err) {
    const errText = Buffer.concat(stderr).toString("utf-8").trim();
    throw new Error([
      err instanceof Error ? err.message : String(err),
      errText ? `stderr: ${errText.slice(0, 1500)}` : "",
    ].filter(Boolean).join("\n"));
  } finally {
    try {
      sendNotification(child, "exit", {});
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch {
      // already exited
    }
    if (child.pid) unregisterChild(child.pid);
  }
}

function lspMethodAndParams(input: LspInput, filePath: string, uri: string): { method: string; params: unknown; needsPrepare?: boolean } {
  const position = { line: input.line - 1, character: input.character - 1 };
  const textDocument = { uri };
  if (input.operation === "documentSymbol") return { method: "textDocument/documentSymbol", params: { textDocument } };
  if (input.operation === "workspaceSymbol") return { method: "workspace/symbol", params: { query: "" } };
  if (input.operation === "goToDefinition") return { method: "textDocument/definition", params: { textDocument, position } };
  if (input.operation === "goToImplementation") return { method: "textDocument/implementation", params: { textDocument, position } };
  if (input.operation === "hover") return { method: "textDocument/hover", params: { textDocument, position } };
  if (input.operation === "findReferences") return { method: "textDocument/references", params: { textDocument, position, context: { includeDeclaration: true } } };
  if (input.operation === "prepareCallHierarchy") return { method: "textDocument/prepareCallHierarchy", params: { textDocument, position } };
  if (input.operation === "incomingCalls") return { method: "callHierarchy/incomingCalls", params: { textDocument, position }, needsPrepare: true };
  if (input.operation === "outgoingCalls") return { method: "callHierarchy/outgoingCalls", params: { textDocument, position }, needsPrepare: true };
  return { method: "textDocument/definition", params: { textDocument: { uri: pathToFileURL(filePath).toString() }, position } };
}

function createLspConnection(stream: NodeJS.ReadableStream): () => Promise<unknown> {
  let buffer = Buffer.alloc(0);
  const messages: unknown[] = [];
  const waiters: Array<(value: unknown) => void> = [];
  stream.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = buffer.slice(0, headerEnd).toString("utf-8");
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match?.[1]) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (buffer.length < bodyEnd) return;
      const body = buffer.slice(bodyStart, bodyEnd).toString("utf-8");
      buffer = buffer.slice(bodyEnd);
      try {
        const message = JSON.parse(body);
        const waiter = waiters.shift();
        if (waiter) waiter(message);
        else messages.push(message);
      } catch {
        // Ignore malformed server output.
      }
    }
  });
  return () => new Promise((resolve) => {
    const existing = messages.shift();
    if (existing) resolve(existing);
    else waiters.push(resolve);
  });
}

async function sendRequest(
  child: ReturnType<typeof spawn>,
  readMessage: () => Promise<unknown>,
  id: number,
  method: string,
  params: unknown,
): Promise<unknown> {
  writeLsp(child, { jsonrpc: "2.0", id, method, params });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const message = await withTimeout(readMessage(), Math.max(1, deadline - Date.now()), `LSP request timed out: ${method}`);
    const record = asRecord(message);
    if (record.id !== id) continue;
    if (record.error) {
      const error = asRecord(record.error);
      throw new Error(String(error.message ?? JSON.stringify(error)));
    }
    return record.result;
  }
  throw new Error(`LSP request timed out: ${method}`);
}

function sendNotification(child: ReturnType<typeof spawn>, method: string, params: unknown): void {
  writeLsp(child, { jsonrpc: "2.0", method, params });
}

function writeLsp(child: ReturnType<typeof spawn>, message: unknown): void {
  const body = JSON.stringify(message);
  child.stdin?.write(`Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}`);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function formatLspResult(operation: LspOperation, result: unknown, cwd: string): string {
  if (result === null || result === undefined) return `No ${operation} result returned.`;
  if (operation === "hover") return formatHover(result);
  if (operation === "documentSymbol") return formatSymbols(result, cwd);
  if (operation === "workspaceSymbol") return formatWorkspaceSymbols(result, cwd);
  if (operation === "prepareCallHierarchy" || operation === "incomingCalls" || operation === "outgoingCalls") {
    return formatCallHierarchy(result, cwd);
  }
  return formatLocations(result, cwd);
}

function formatHover(result: unknown): string {
  const contents = asRecord(result).contents;
  if (typeof contents === "string") return contents || "No hover information.";
  if (Array.isArray(contents)) return contents.map(formatMarkedString).filter(Boolean).join("\n") || "No hover information.";
  const record = asRecord(contents);
  return String(record.value ?? record.language ?? JSON.stringify(contents));
}

function formatMarkedString(value: unknown): string {
  if (typeof value === "string") return value;
  const record = asRecord(value);
  return String(record.value ?? "");
}

function formatSymbols(result: unknown, cwd: string): string {
  const lines: string[] = [];
  for (const item of Array.isArray(result) ? result : []) appendSymbol(lines, item, cwd, 0);
  return lines.length ? lines.slice(0, 160).join("\n") : "No document symbols found.";
}

function appendSymbol(lines: string[], item: unknown, cwd: string, depth: number): void {
  const record = asRecord(item);
  const name = String(record.name ?? "(anonymous)");
  const location = record.location ? formatLocation(record.location, cwd) : formatRange(record.range);
  lines.push(`${"  ".repeat(depth)}- ${name}${location ? ` @ ${location}` : ""}`);
  const children = Array.isArray(record.children) ? record.children : [];
  for (const child of children) appendSymbol(lines, child, cwd, depth + 1);
}

function formatWorkspaceSymbols(result: unknown, cwd: string): string {
  const items = Array.isArray(result) ? result : [];
  if (items.length === 0) return "No workspace symbols found.";
  return items.slice(0, 120).map((item) => {
    const record = asRecord(item);
    return `- ${String(record.name ?? "(anonymous)")} @ ${formatLocation(record.location, cwd)}`;
  }).join("\n");
}

function formatCallHierarchy(result: unknown, cwd: string): string {
  const items = Array.isArray(result) ? result : [];
  if (items.length === 0) return "No call hierarchy items found.";
  return items.slice(0, 120).map((item) => {
    const record = asRecord(item);
    const target = asRecord(record.from ?? record.to ?? item);
    return `- ${String(target.name ?? "(anonymous)")} @ ${formatRange(target.range ?? target.selectionRange)}${target.uri ? ` (${formatUri(String(target.uri), cwd)})` : ""}`;
  }).join("\n");
}

function formatLocations(result: unknown, cwd: string): string {
  const items = Array.isArray(result) ? result : [result];
  const lines = items.map((item) => formatLocation(item, cwd)).filter(Boolean);
  return lines.length ? lines.slice(0, 120).join("\n") : "No locations found.";
}

function formatLocation(value: unknown, cwd: string): string {
  const record = asRecord(value);
  const uri = String(record.uri ?? asRecord(record.targetUri).uri ?? "");
  const range = record.range ?? record.targetSelectionRange ?? record.targetRange;
  return [uri ? formatUri(uri, cwd) : "", formatRange(range)].filter(Boolean).join(":");
}

function formatRange(value: unknown): string {
  const range = asRecord(value);
  const start = asRecord(range.start);
  if (typeof start.line !== "number") return "";
  return `${start.line + 1}:${typeof start.character === "number" ? start.character + 1 : 1}`;
}

function formatUri(uri: string, cwd: string): string {
  try {
    const path = fileURLToPath(uri);
    const rel = relative(cwd, path);
    return rel && !rel.startsWith("..") ? rel : path;
  } catch {
    return uri;
  }
}

function languageIdFor(config: LspServerConfig, filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return config.languages?.[ext] ?? config.languageId ?? DEFAULT_LANGUAGE_IDS[ext] ?? ext.replace(/^\./, "");
}

function commandExists(command: string): boolean {
  try {
    execFileSync("/usr/bin/env", ["bash", "-lc", `command -v ${JSON.stringify(command)}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function normalizeExt(value: string): string {
  const ext = value.trim().toLowerCase();
  return ext.startsWith(".") ? ext : `.${ext}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return value !== null &&
    typeof value === "object" &&
    Object.values(value).every((item) => typeof item === "string");
}
