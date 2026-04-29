import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Stream } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  UnauthorizedError,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Progress } from "@modelcontextprotocol/sdk/types.js";
import { bus } from "./events.js";
import { loadConfig, SERVUS_DIR, type ServusConfig } from "./config.js";
import { findServusProjectRoot } from "./coding-project.js";
import { loadPlugins } from "./plugins.js";

export type McpTransport = "stdio" | "streamable-http" | "sse" | "auto";
export type McpAuthState = "none" | "configured" | "authorized" | "required" | "error";

export interface McpAuthConfig {
  type?: "none" | "bearer" | "header" | "oauth" | "client_credentials";
  tokenEnv?: string;
  headerName?: string;
  clientIdEnv?: string;
  clientSecretEnv?: string;
  scopes?: string[];
  redirectUrl?: string;
}

export interface McpServerConfig {
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  timeoutMs?: number;
  toolFilter?: string[];
  resourceFilter?: string[];
  transport?: McpTransport | "http";
  auth?: McpAuthConfig;
  disabled?: boolean;
}

export interface McpServerDefinition {
  name: string;
  config: McpServerConfig;
  source: "config" | "user" | "project" | "plugin";
  transport: McpTransport;
  pluginId?: string;
  configPath?: string;
}

export type ResolvedMcpServer = McpServerDefinition;

export interface McpResource {
  uri: string;
  name?: string;
  mimeType?: string;
  description?: string;
  server: string;
}

export interface McpPromptInfo {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
  server: string;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
  readOnly?: boolean;
  server: string;
}

export interface McpServerStatus {
  name: string;
  status: "ready" | "configured" | "error" | "disabled" | "auth_required" | "connecting";
  transport: McpTransport;
  activeTransport?: Exclude<McpTransport, "auto">;
  source: McpServerDefinition["source"];
  tools: number;
  resources: number;
  prompts?: number;
  authState?: McpAuthState;
  instructions?: string;
  lastConnectedAt?: number;
  lastProgress?: string;
  lastError?: string;
  stderrTail?: string;
}

export interface McpPermissionTarget {
  server: string;
  tool?: string;
  risk: "low" | "medium" | "high";
  readOnly: boolean;
}

export interface McpTestResult {
  server: string;
  ok: boolean;
  status: McpServerStatus;
  tools: McpToolInfo[];
  resources: McpResource[];
  prompts: McpPromptInfo[];
}

interface McpConfigFile {
  mcpServers?: Record<string, McpServerConfig>;
  servers?: Record<string, McpServerConfig>;
}

interface McpConnection {
  key: string;
  server: McpServerDefinition;
  client: Client;
  transport: Transport;
  activeTransport: Exclude<McpTransport, "auto">;
  status: McpServerStatus["status"];
  authState: McpAuthState;
  lastConnectedAt?: number;
  lastProgress?: string;
  lastError?: string;
  stderr: string[];
  instructions?: string;
  authUrl?: string;
}

const USER_MCP_PATH = join(SERVUS_DIR, "mcp.json");
const CONNECTIONS = new Map<string, McpConnection>();

export function resolveMcpServers(cwd: string): ResolvedMcpServer[] {
  const config = loadConfig();
  const servers: ResolvedMcpServer[] = [];

  addServersFromRecord(servers, config.mcpServers as Record<string, McpServerConfig> | undefined, "config");
  addServersFromFile(servers, USER_MCP_PATH, "user");
  addServersFromFile(servers, projectMcpPath(cwd), "project");

  if (config.plugins?.enabled !== false) {
    for (const plugin of loadPlugins({ cwd, extraDirs: config.plugins?.dirs, disabled: config.plugins?.disabled })) {
      for (const [name, server] of Object.entries(plugin.mcpServers ?? {})) {
        addOneServer(servers, `${plugin.id}:${name}`, server as McpServerConfig, "plugin", undefined, plugin.id);
      }
    }
  }

  const seen = new Set<string>();
  return servers.filter((server) => {
    if (seen.has(server.name)) return false;
    seen.add(server.name);
    if (server.config.disabled) return true;
    return !!server.config.command || !!server.config.url;
  });
}

export function summarizeMcpServers(cwd: string): string {
  const servers = resolveMcpServers(cwd);
  if (servers.length === 0) {
    return "No MCP servers configured. Add servers with /mcp add, ~/.servus/mcp.json, .servus/mcp.json, config.mcpServers, or plugin mcpServers.";
  }
  return [
    `Configured MCP servers: ${servers.length}`,
    "",
    ...servers.map(formatServerLine),
  ].join("\n");
}

export async function mcpStatusSummary(cwd: string): Promise<string> {
  const statuses = await listMcpServerStatuses(cwd);
  if (statuses.length === 0) return summarizeMcpServers(cwd);
  return [
    `MCP server status: ${statuses.length}`,
    "",
    ...statuses.map((status) => [
      `- ${status.name}: ${status.status} (${status.activeTransport ?? status.transport}, ${status.source})`,
      `  Auth: ${status.authState ?? "none"} | Tools: ${status.tools} | Resources: ${status.resources} | Prompts: ${status.prompts ?? 0}`,
      status.instructions ? `  Instructions: ${truncate(status.instructions, 160)}` : undefined,
      status.lastProgress ? `  Progress: ${status.lastProgress}` : undefined,
      status.lastConnectedAt ? `  Last connected: ${new Date(status.lastConnectedAt).toISOString()}` : undefined,
      status.lastError ? `  Error: ${status.lastError}` : undefined,
      status.stderrTail ? `  stderr: ${truncate(status.stderrTail, 240)}` : undefined,
    ].filter(Boolean).join("\n")),
  ].join("\n");
}

export async function listMcpServerStatuses(cwd: string): Promise<McpServerStatus[]> {
  const servers = resolveMcpServers(cwd);
  return await Promise.all(servers.map(async (server) => {
    if (server.config.disabled) {
      return {
        name: server.name,
        status: "disabled" as const,
        transport: server.transport,
        source: server.source,
        tools: 0,
        resources: 0,
        prompts: 0,
        authState: "none" as const,
      };
    }

    try {
      const connection = await defaultMcpManager.connect(server);
      const [tools, resources, prompts] = await Promise.all([
        defaultMcpManager.listTools(server).catch(() => []),
        defaultMcpManager.listResources(server).catch(() => []),
        defaultMcpManager.listPrompts(server).catch(() => []),
      ]);
      return statusFromConnection(connection, {
        tools: tools.length,
        resources: resources.length,
        prompts: prompts.length,
      });
    } catch (err) {
      const connection = defaultMcpManager.peek(server);
      const message = err instanceof Error ? err.message : String(err);
      return {
        name: server.name,
        status: err instanceof UnauthorizedError ? "auth_required" : "error",
        transport: server.transport,
        activeTransport: connection?.activeTransport,
        source: server.source,
        tools: 0,
        resources: 0,
        prompts: 0,
        authState: err instanceof UnauthorizedError ? "required" : connection?.authState ?? authStateForConfig(server.config),
        instructions: connection?.instructions,
        lastConnectedAt: connection?.lastConnectedAt,
        lastProgress: connection?.lastProgress,
        lastError: message,
        stderrTail: connection ? stderrTail(connection) : undefined,
      };
    }
  }));
}

export async function listMcpTools(cwd: string, serverName?: string): Promise<McpToolInfo[]> {
  const servers = selectServers(cwd, serverName);
  const results = await Promise.all(servers.map((server) => defaultMcpManager.listTools(server).catch(() => [])));
  return results.flat();
}

export async function callMcpTool(cwd: string, serverName: string, toolName: string, args: unknown): Promise<unknown> {
  const server = selectOneServer(cwd, serverName);
  if (server.config.disabled) throw new Error(`MCP server ${server.name} is disabled.`);
  if (server.config.toolFilter?.length && !server.config.toolFilter.includes(toolName)) {
    throw new Error(`MCP tool ${toolName} is not allowed by ${server.name}.toolFilter.`);
  }
  const input = args && typeof args === "object" && !Array.isArray(args)
    ? args as Record<string, unknown>
    : {};
  return await defaultMcpManager.callTool(server, toolName, input);
}

export async function listMcpResources(cwd: string, serverName?: string): Promise<McpResource[]> {
  const servers = selectServers(cwd, serverName);
  const results = await Promise.all(servers.map((server) => defaultMcpManager.listResources(server).catch(() => [])));
  return results.flat();
}

export async function readMcpResource(cwd: string, serverName: string, uri: string): Promise<unknown> {
  const server = selectOneServer(cwd, serverName);
  if (server.config.disabled) throw new Error(`MCP server ${server.name} is disabled.`);
  return await defaultMcpManager.readResource(server, uri);
}

export async function listMcpPrompts(cwd: string, serverName?: string): Promise<McpPromptInfo[]> {
  const servers = selectServers(cwd, serverName);
  const results = await Promise.all(servers.map((server) => defaultMcpManager.listPrompts(server).catch(() => [])));
  return results.flat();
}

export async function getMcpInstructions(cwd: string, serverName: string): Promise<string> {
  const server = selectOneServer(cwd, serverName);
  const connection = await defaultMcpManager.connect(server);
  return connection.instructions ?? "No MCP server instructions provided.";
}

export async function testMcpServer(cwd: string, serverName: string): Promise<McpTestResult> {
  const server = selectOneServer(cwd, serverName);
  const connection = await defaultMcpManager.connect(server, { forceReconnect: true });
  const [tools, resources, prompts] = await Promise.all([
    defaultMcpManager.listTools(server).catch(() => []),
    defaultMcpManager.listResources(server).catch(() => []),
    defaultMcpManager.listPrompts(server).catch(() => []),
  ]);
  const status = statusFromConnection(connection, {
    tools: tools.length,
    resources: resources.length,
    prompts: prompts.length,
  });
  bus.push({
    type: "mcp:test_result",
    agent: "MCP",
    message: `${server.name}: ${status.status}, ${tools.length} tool(s), ${resources.length} resource(s), ${prompts.length} prompt(s)`,
    metadata: { server: server.name, ok: status.status === "ready", status },
  });
  return { server: server.name, ok: status.status === "ready", status, tools, resources, prompts };
}

export function mcpAuthStatus(cwd: string, serverName?: string): string {
  const servers = selectServers(cwd, serverName);
  if (servers.length === 0) return "No MCP servers configured.";
  return [
    "MCP auth status:",
    "",
    ...servers.map((server) => {
      const connection = defaultMcpManager.peek(server);
      const authState = connection?.authState ?? authStateForConfig(server.config);
      const authUrl = connection?.authUrl;
      return [
        `- ${server.name}: ${authState}`,
        authUrl ? `  Authorization URL: ${authUrl}` : undefined,
        server.config.auth?.tokenEnv ? `  Token env: ${server.config.auth.tokenEnv}${process.env[server.config.auth.tokenEnv] ? " (set)" : " (missing)"}` : undefined,
        server.config.auth?.clientIdEnv ? `  Client id env: ${server.config.auth.clientIdEnv}${process.env[server.config.auth.clientIdEnv] ? " (set)" : " (missing)"}` : undefined,
      ].filter(Boolean).join("\n");
    }),
  ].join("\n");
}

export function clearMcpAuth(cwd: string, serverName: string): string {
  const server = selectOneServer(cwd, serverName);
  void defaultMcpManager.close(server.name);
  return `Cleared in-memory MCP auth/session state for ${server.name}. Remove token env/header config manually if needed.`;
}

export function beginMcpAuth(cwd: string, serverName: string): string {
  const server = selectOneServer(cwd, serverName);
  const state = authStateForConfig(server.config);
  if (state === "none") return `${server.name} does not have auth configured.`;
  if (server.config.auth?.type === "bearer" || server.config.auth?.type === "header") {
    return `${server.name} uses static header auth. Configure ${server.config.auth.tokenEnv ?? "tokenEnv"} in the environment and run /mcp test ${server.name}.`;
  }
  return `${server.name} uses OAuth/client credentials. Run /mcp test ${server.name}; if interactive authorization is required, Servus will report the authorization URL in /mcp auth status ${server.name}.`;
}

export function addMcpServer(
  cwd: string,
  name: string,
  config: McpServerConfig,
  scope: "user" | "project" = "user",
): { path: string; server: ResolvedMcpServer } {
  const path = scope === "project" ? projectMcpPath(cwd) : USER_MCP_PATH;
  const file = readMcpConfigFile(path);
  const mcpServers = { ...(file.mcpServers ?? file.servers ?? {}) };
  mcpServers[name] = normalizeServerConfig(config);
  writeMcpConfigFile(path, { mcpServers });
  const server = resolveMcpServers(cwd).find((item) => item.name === name);
  return {
    path,
    server: server ?? {
      name,
      source: scope,
      config: mcpServers[name]!,
      transport: normalizedTransport(mcpServers[name]!),
      configPath: path,
    },
  };
}

export function removeMcpServer(
  cwd: string,
  name: string,
  scope: "user" | "project" = "user",
): { path: string; removed: boolean } {
  const path = scope === "project" ? projectMcpPath(cwd) : USER_MCP_PATH;
  const file = readMcpConfigFile(path);
  const mcpServers = { ...(file.mcpServers ?? file.servers ?? {}) };
  const removed = Object.prototype.hasOwnProperty.call(mcpServers, name);
  delete mcpServers[name];
  writeMcpConfigFile(path, { mcpServers });
  void defaultMcpManager.close(name);
  return { path, removed };
}

export function getMcpServer(cwd: string, name: string): ResolvedMcpServer | undefined {
  return resolveMcpServers(cwd).find((server) => server.name === name);
}

export async function closeAllMcpClients(): Promise<void> {
  await defaultMcpManager.closeAll();
}

class McpManager {
  async connect(server: McpServerDefinition, options: { forceReconnect?: boolean } = {}): Promise<McpConnection> {
    if (server.config.disabled) throw new Error(`MCP server ${server.name} is disabled.`);
    const key = clientKey(server);
    const existing = CONNECTIONS.get(key);
    if (existing && existing.status === "ready" && !options.forceReconnect) return existing;
    if (existing) await this.stop(key, existing);

    const transports = transportOrder(server);
    let lastErr: unknown;
    for (const transportName of transports) {
      try {
        const connection = await this.createConnection(server, transportName);
        CONNECTIONS.set(key, connection);
        return connection;
      } catch (err) {
        lastErr = err;
        if (err instanceof UnauthorizedError) throw err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? "MCP connection failed"));
  }

  peek(server: McpServerDefinition): McpConnection | undefined {
    return CONNECTIONS.get(clientKey(server));
  }

  async listTools(server: McpServerDefinition): Promise<McpToolInfo[]> {
    const connection = await this.connect(server);
    const response = await connection.client.listTools(undefined, this.requestOptions(connection, "tools/list"));
    const filter = new Set(server.config.toolFilter ?? []);
    return response.tools
      .map((item) => ({
        name: item.name,
        description: item.description,
        inputSchema: item.inputSchema,
        readOnly: item.annotations?.readOnlyHint,
        server: server.name,
      }))
      .filter((tool) => tool.name && (filter.size === 0 || filter.has(tool.name)));
  }

  async callTool(server: McpServerDefinition, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const connection = await this.connect(server);
    return await connection.client.callTool(
      { name: toolName, arguments: args },
      undefined,
      this.requestOptions(connection, `tools/call:${toolName}`),
    );
  }

  async listResources(server: McpServerDefinition): Promise<McpResource[]> {
    const connection = await this.connect(server);
    const response = await connection.client.listResources(undefined, this.requestOptions(connection, "resources/list"));
    const filter = new Set(server.config.resourceFilter ?? []);
    return response.resources
      .map((item) => ({
        uri: item.uri,
        name: item.name,
        description: item.description,
        mimeType: item.mimeType,
        server: server.name,
      }))
      .filter((resource) => resource.uri && (filter.size === 0 || filter.has(resource.uri) || filter.has(resource.name ?? "")));
  }

  async readResource(server: McpServerDefinition, uri: string): Promise<unknown> {
    const connection = await this.connect(server);
    return await connection.client.readResource({ uri }, this.requestOptions(connection, `resources/read:${uri}`));
  }

  async listPrompts(server: McpServerDefinition): Promise<McpPromptInfo[]> {
    const connection = await this.connect(server);
    const response = await connection.client.listPrompts(undefined, this.requestOptions(connection, "prompts/list"));
    return response.prompts.map((item) => ({
      name: item.name,
      description: item.description,
      arguments: item.arguments,
      server: server.name,
    }));
  }

  async close(name: string): Promise<void> {
    const stops: Array<Promise<void>> = [];
    for (const [key, connection] of CONNECTIONS) {
      if (connection.server.name !== name) continue;
      stops.push(this.stop(key, connection));
    }
    await Promise.all(stops);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...CONNECTIONS].map(([key, connection]) => this.stop(key, connection)));
  }

  private async createConnection(server: McpServerDefinition, transportName: Exclude<McpTransport, "auto">): Promise<McpConnection> {
    const stderr: string[] = [];
    const client = new Client(
      { name: "servus", version: "0.1.0" },
      { capabilities: {}, enforceStrictCapabilities: false },
    );
    const authProvider = createAuthProvider(server);
    const transport = createTransport(server, transportName, authProvider, stderr);
    const connection: McpConnection = {
      key: clientKey(server),
      server,
      client,
      transport,
      activeTransport: transportName,
      status: "connecting",
      authState: authStateForConfig(server.config),
      stderr,
    };
    transport.onerror = (error) => {
      connection.status = "error";
      connection.lastError = error.message;
      bus.push({
        type: "mcp:status",
        agent: "MCP",
        message: `${server.name} transport error: ${error.message}`,
        metadata: { server: server.name, transport: transportName, status: "error" },
      });
    };
    transport.onclose = () => {
      if (connection.status !== "error") connection.status = "configured";
      bus.push({
        type: "mcp:status",
        agent: "MCP",
        message: `${server.name} connection closed`,
        metadata: { server: server.name, transport: transportName, status: "closed" },
      });
    };

    try {
      await client.connect(transport, { timeout: server.config.timeoutMs ?? 30_000 });
      connection.status = "ready";
      connection.authState = connection.authState === "configured" ? "authorized" : connection.authState;
      connection.lastConnectedAt = Date.now();
      connection.instructions = client.getInstructions();
      bus.push({
        type: "mcp:status",
        agent: "MCP",
        message: `${server.name} connected via ${transportName}`,
        metadata: { server: server.name, transport: transportName, status: "ready" },
      });
      return connection;
    } catch (err) {
      connection.lastError = err instanceof Error ? err.message : String(err);
      if (err instanceof UnauthorizedError) {
        connection.status = "auth_required";
        connection.authState = "required";
        if (authProvider instanceof ServusOAuthProvider) connection.authUrl = authProvider.lastAuthorizationUrl;
        CONNECTIONS.set(connection.key, connection);
        bus.push({
          type: "mcp:auth_required",
          agent: "MCP",
          message: `${server.name} requires authentication${connection.authUrl ? `: ${connection.authUrl}` : ""}`,
          metadata: { server: server.name, transport: transportName, authUrl: connection.authUrl },
        });
      }
      await safeClose(transport);
      throw err;
    }
  }

  private requestOptions(connection: McpConnection, label: string): RequestOptions {
    return {
      timeout: connection.server.config.timeoutMs ?? 60_000,
      resetTimeoutOnProgress: true,
      onprogress: (progress: Progress) => {
        const text = formatProgress(progress, label);
        connection.lastProgress = text;
        bus.push({
          type: "mcp:progress",
          agent: "MCP",
          message: text,
          metadata: { server: connection.server.name, label, progress },
        });
      },
    };
  }

  private async stop(key: string, connection: McpConnection): Promise<void> {
    CONNECTIONS.delete(key);
    await safeClose(connection.transport);
  }
}

const defaultMcpManager = new McpManager();

function createTransport(
  server: McpServerDefinition,
  transportName: Exclude<McpTransport, "auto">,
  authProvider: OAuthClientProvider | undefined,
  stderr: string[],
): Transport {
  if (transportName === "stdio") {
    if (!server.config.command) throw new Error(`MCP server ${server.name} is missing command.`);
    const transport = new StdioClientTransport({
      command: server.config.command,
      args: server.config.args ?? [],
      env: stringRecord({
        ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
        ...(server.config.env ?? {}),
      }),
      stderr: "pipe",
    });
    attachStderr(transport.stderr, stderr);
    return transport;
  }

  if (!server.config.url) throw new Error(`MCP server ${server.name} is missing url.`);
  const headers = authHeaders(server.config);
  const requestInit: RequestInit = { headers };
  const url = new URL(server.config.url);

  if (transportName === "streamable-http") {
    return new StreamableHTTPClientTransport(url, {
      requestInit,
      authProvider,
      reconnectionOptions: {
        initialReconnectionDelay: 1000,
        maxReconnectionDelay: 30_000,
        reconnectionDelayGrowFactor: 1.5,
        maxRetries: 2,
      },
    });
  }

  return new SSEClientTransport(url, {
    requestInit,
    eventSourceInit: { fetch: fetchWithHeaders(headers) } as never,
    authProvider,
  });
}

function attachStderr(stream: Stream | null, chunks: string[]): void {
  stream?.on("data", (chunk: Buffer | string) => {
    chunks.push(String(chunk));
    while (chunks.length > 32) chunks.shift();
  });
}

function fetchWithHeaders(headers: HeadersInit): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, {
    ...init,
    headers: {
      ...(Object.fromEntries(new Headers(headers).entries())),
      ...(Object.fromEntries(new Headers(init?.headers).entries())),
    },
  })) as typeof fetch;
}

class ServusOAuthProvider implements OAuthClientProvider {
  private savedTokens: unknown;
  private verifier = "";
  private clientInfo: unknown;
  lastAuthorizationUrl?: string;

  constructor(private readonly server: McpServerDefinition) {}

  get redirectUrl(): string | URL | undefined {
    return this.server.config.auth?.redirectUrl;
  }

  get clientMetadata() {
    const scopes = this.server.config.auth?.scopes ?? [];
    return {
      client_name: "Servus",
      redirect_uris: this.redirectUrl ? [String(this.redirectUrl)] : [],
      grant_types: this.server.config.auth?.type === "client_credentials"
        ? ["client_credentials"]
        : ["authorization_code", "refresh_token"],
      response_types: this.server.config.auth?.type === "client_credentials" ? [] : ["code"],
      token_endpoint_auth_method: this.server.config.auth?.clientSecretEnv ? "client_secret_basic" : "none",
      scope: scopes.join(" "),
    };
  }

  clientInformation() {
    const clientId = envValue(this.server.config.auth?.clientIdEnv);
    const clientSecret = envValue(this.server.config.auth?.clientSecretEnv);
    if (clientId) {
      return {
        client_id: clientId,
        ...(clientSecret ? { client_secret: clientSecret } : {}),
      };
    }
    return this.clientInfo as never;
  }

  saveClientInformation(clientInformation: unknown) {
    this.clientInfo = clientInformation;
  }

  tokens() {
    const token = envValue(this.server.config.auth?.tokenEnv);
    if (token) return { access_token: token, token_type: "Bearer" };
    return this.savedTokens as never;
  }

  saveTokens(tokens: unknown) {
    this.savedTokens = tokens;
  }

  redirectToAuthorization(authorizationUrl: URL) {
    this.lastAuthorizationUrl = authorizationUrl.toString();
  }

  saveCodeVerifier(codeVerifier: string) {
    this.verifier = codeVerifier;
  }

  codeVerifier() {
    return this.verifier;
  }

  prepareTokenRequest(scope?: string) {
    if (this.server.config.auth?.type !== "client_credentials") return undefined;
    const params = new URLSearchParams();
    params.set("grant_type", "client_credentials");
    if (scope) params.set("scope", scope);
    else if (this.server.config.auth?.scopes?.length) params.set("scope", this.server.config.auth.scopes.join(" "));
    return params;
  }
}

function createAuthProvider(server: McpServerDefinition): OAuthClientProvider | undefined {
  const auth = server.config.auth;
  if (!auth || auth.type === "none" || auth.type === "bearer" || auth.type === "header") return undefined;
  return new ServusOAuthProvider(server);
}

function authHeaders(config: McpServerConfig): HeadersInit {
  const headers: Record<string, string> = { ...(config.headers ?? {}) };
  const auth = config.auth;
  if (!auth || auth.type === "none" || auth.type === "oauth" || auth.type === "client_credentials") return headers;
  const token = envValue(auth.tokenEnv);
  if (!token) return headers;
  if (auth.type === "bearer") headers.authorization = `Bearer ${token}`;
  if (auth.type === "header") headers[auth.headerName ?? "authorization"] = token;
  return headers;
}

function authStateForConfig(config: McpServerConfig): McpAuthState {
  const auth = config.auth;
  if (!auth || !auth.type || auth.type === "none") return "none";
  if ((auth.type === "bearer" || auth.type === "header") && auth.tokenEnv && !process.env[auth.tokenEnv]) return "required";
  if (auth.type === "client_credentials" && auth.clientIdEnv && !process.env[auth.clientIdEnv]) return "required";
  if (auth.type === "client_credentials" && auth.clientSecretEnv && !process.env[auth.clientSecretEnv]) return "required";
  return "configured";
}

function envValue(name: string | undefined): string | undefined {
  return name ? process.env[name] : undefined;
}

function transportOrder(server: McpServerDefinition): Array<Exclude<McpTransport, "auto">> {
  if (server.transport === "stdio") return ["stdio"];
  if (server.transport === "streamable-http") return ["streamable-http"];
  if (server.transport === "sse") return ["sse"];
  if (server.config.command && !server.config.url) return ["stdio"];
  return ["streamable-http", "sse"];
}

function addServersFromRecord(
  servers: ResolvedMcpServer[],
  record: Record<string, McpServerConfig> | undefined,
  source: McpServerDefinition["source"],
  configPath?: string,
): void {
  for (const [name, server] of Object.entries(record ?? {})) addOneServer(servers, name, server, source, configPath);
}

function addServersFromFile(
  servers: ResolvedMcpServer[],
  path: string,
  source: "user" | "project",
): void {
  const file = readMcpConfigFile(path);
  addServersFromRecord(servers, file.mcpServers ?? file.servers, source, path);
}

function addOneServer(
  servers: ResolvedMcpServer[],
  name: string,
  config: McpServerConfig,
  source: McpServerDefinition["source"],
  configPath?: string,
  pluginId?: string,
): void {
  const normalized = normalizeServerConfig(config);
  if (!normalized.command && !normalized.url) return;
  servers.push({
    name,
    source,
    config: normalized,
    transport: normalizedTransport(normalized),
    ...(pluginId ? { pluginId } : {}),
    ...(configPath ? { configPath } : {}),
  });
}

function normalizeServerConfig(config: McpServerConfig): McpServerConfig {
  return {
    ...(config.command ? { command: config.command } : {}),
    ...(Array.isArray(config.args) ? { args: config.args.map(String) } : {}),
    ...(config.url ? { url: config.url } : {}),
    ...(config.env ? { env: stringRecord(config.env) } : {}),
    ...(config.headers ? { headers: stringRecord(config.headers) } : {}),
    ...(typeof config.timeoutMs === "number" ? { timeoutMs: config.timeoutMs } : {}),
    ...(Array.isArray(config.toolFilter) ? { toolFilter: config.toolFilter.map(String) } : {}),
    ...(Array.isArray(config.resourceFilter) ? { resourceFilter: config.resourceFilter.map(String) } : {}),
    ...(config.transport ? { transport: normalizeTransportValue(config.transport) } : {}),
    ...(config.auth ? { auth: normalizeAuthConfig(config.auth) } : {}),
    ...(config.disabled !== undefined ? { disabled: config.disabled } : {}),
  };
}

function normalizeAuthConfig(auth: McpAuthConfig): McpAuthConfig {
  return {
    ...(auth.type ? { type: auth.type } : {}),
    ...(auth.tokenEnv ? { tokenEnv: auth.tokenEnv } : {}),
    ...(auth.headerName ? { headerName: auth.headerName } : {}),
    ...(auth.clientIdEnv ? { clientIdEnv: auth.clientIdEnv } : {}),
    ...(auth.clientSecretEnv ? { clientSecretEnv: auth.clientSecretEnv } : {}),
    ...(Array.isArray(auth.scopes) ? { scopes: auth.scopes.map(String) } : {}),
    ...(auth.redirectUrl ? { redirectUrl: auth.redirectUrl } : {}),
  };
}

function stringRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).map(([key, value]) => [key, String(value)]));
}

function normalizeTransportValue(value: McpServerConfig["transport"]): McpTransport {
  if (value === "http") return "streamable-http";
  if (value === "stdio" || value === "streamable-http" || value === "sse" || value === "auto") return value;
  return "auto";
}

function normalizedTransport(config: McpServerConfig): McpTransport {
  if (config.command && !config.url) return "stdio";
  return normalizeTransportValue(config.transport ?? "auto");
}

function readMcpConfigFile(path: string): McpConfigFile {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as McpConfigFile;
    return {
      mcpServers: isServerRecord(parsed.mcpServers) ? parsed.mcpServers : undefined,
      servers: isServerRecord(parsed.servers) ? parsed.servers : undefined,
    };
  } catch {
    return {};
  }
}

function writeMcpConfigFile(path: string, file: McpConfigFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2) + "\n", "utf-8");
}

function isServerRecord(value: unknown): value is Record<string, McpServerConfig> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function projectMcpPath(cwd: string): string {
  return resolve(findServusProjectRoot(cwd), ".servus", "mcp.json");
}

function formatServerLine(server: McpServerDefinition): string {
  const transport = server.transport === "stdio"
    ? `stdio ${server.config.command} ${(server.config.args ?? []).join(" ")}`.trim()
    : `${server.transport} ${server.config.url}`;
  return [
    `- ${server.name} (${server.source}${server.pluginId ? `:${server.pluginId}` : ""}): ${transport}`,
    server.config.auth?.type && server.config.auth.type !== "none" ? ` [auth:${server.config.auth.type}]` : "",
    server.config.disabled ? " [disabled]" : "",
    server.configPath ? `\n  Config: ${server.configPath}` : "",
  ].join("");
}

function selectServers(cwd: string, serverName?: string): ResolvedMcpServer[] {
  const servers = resolveMcpServers(cwd);
  if (!serverName?.trim()) return servers.filter((server) => !server.config.disabled);
  const selected = servers.filter((server) => server.name === serverName);
  if (selected.length === 0) {
    throw new Error(`MCP server "${serverName}" not found. Available servers: ${servers.map((server) => server.name).join(", ") || "none"}`);
  }
  return selected;
}

function selectOneServer(cwd: string, serverName: string): ResolvedMcpServer {
  return selectServers(cwd, serverName)[0]!;
}

function clientKey(server: McpServerDefinition): string {
  return JSON.stringify({
    name: server.name,
    transport: server.transport,
    command: server.config.command,
    args: server.config.args ?? [],
    url: server.config.url,
    env: server.config.env ?? {},
    headers: server.config.headers ?? {},
    auth: server.config.auth ?? {},
  });
}

function statusFromConnection(
  connection: McpConnection,
  counts: { tools: number; resources: number; prompts: number },
): McpServerStatus {
  return {
    name: connection.server.name,
    status: connection.status,
    transport: connection.server.transport,
    activeTransport: connection.activeTransport,
    source: connection.server.source,
    tools: counts.tools,
    resources: counts.resources,
    prompts: counts.prompts,
    authState: connection.authState,
    instructions: connection.instructions,
    lastConnectedAt: connection.lastConnectedAt,
    lastProgress: connection.lastProgress,
    lastError: connection.lastError,
    stderrTail: stderrTail(connection),
  };
}

function formatProgress(progress: Progress, label: string): string {
  const parts = [
    label,
    typeof progress.progress === "number" ? `${progress.progress}${typeof progress.total === "number" ? `/${progress.total}` : ""}` : undefined,
    typeof progress.message === "string" ? progress.message : undefined,
  ].filter(Boolean);
  return parts.join(" · ");
}

function stderrTail(connection: McpConnection): string | undefined {
  const text = connection.stderr.join("").trim();
  return text ? text.slice(-2000) : undefined;
}

async function safeClose(transport: Transport): Promise<void> {
  try {
    await transport.close?.();
  } catch {
    // ignore close errors
  }
}

function truncate(value: string, max: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, Math.max(0, max - 1))}…` : oneLine;
}

export type { ServusConfig };
