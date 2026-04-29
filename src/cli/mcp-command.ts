import {
  addMcpServer,
  beginMcpAuth,
  clearMcpAuth,
  getMcpInstructions,
  getMcpServer,
  listMcpPrompts,
  listMcpResources,
  listMcpServerStatuses,
  listMcpTools,
  mcpAuthStatus,
  mcpStatusSummary,
  removeMcpServer,
  summarizeMcpServers,
  testMcpServer,
  type McpServerConfig,
} from "../mcp-client.js";

export async function runTuiMcpCommand(line: string, cwd: string): Promise<string> {
  const tokens = tokenize(line);
  if (tokens[0] === "/mcp") tokens.shift();
  if (tokens[0] === "mcp") tokens.shift();
  const command = (tokens.shift() ?? "status").toLowerCase();

  if (command === "list") return summarizeMcpServers(cwd);
  if (command === "status" || command === "debug") {
    return await mcpStatusSummary(cwd);
  }
  if (command === "auth" || command === "auth-status") {
    const sub = command === "auth-status" ? "status" : (tokens.shift() ?? "status").toLowerCase();
    const server = tokens[0];
    if (sub === "status") return mcpAuthStatus(cwd, server);
    if (sub === "login") {
      if (!server) return "Usage: /mcp auth login <server>";
      return beginMcpAuth(cwd, server);
    }
    if (sub === "logout") {
      if (!server) return "Usage: /mcp auth logout <server>";
      return clearMcpAuth(cwd, server);
    }
    return "Usage: /mcp auth status [server] | /mcp auth login <server> | /mcp auth logout <server>";
  }
  if (command === "test") {
    const server = tokens[0];
    if (!server) return "Usage: /mcp test <server>";
    const result = await testMcpServer(cwd, server);
    return [
      `${result.ok ? "MCP test passed" : "MCP test failed"} for ${result.server}`,
      `Status: ${result.status.status} via ${result.status.activeTransport ?? result.status.transport}`,
      `Auth: ${result.status.authState ?? "none"}`,
      `Tools: ${result.tools.length}`,
      `Resources: ${result.resources.length}`,
      `Prompts: ${result.prompts.length}`,
      result.status.instructions ? `Instructions: ${result.status.instructions}` : undefined,
      result.status.lastError ? `Error: ${result.status.lastError}` : undefined,
      result.status.stderrTail ? `stderr:\n${result.status.stderrTail}` : undefined,
    ].filter(Boolean).join("\n");
  }
  if (command === "tools") {
    const server = tokens[0];
    const tools = await listMcpTools(cwd, server);
    if (tools.length === 0) return server ? `No MCP tools found for ${server}.` : "No MCP tools found.";
    return [
      `MCP tools${server ? ` for ${server}` : ""}:`,
      "",
      ...tools.map((tool) => `- ${tool.server}/${tool.name}${tool.description ? `: ${tool.description}` : ""}`),
    ].join("\n");
  }
  if (command === "resources") {
    const server = tokens[0];
    const resources = await listMcpResources(cwd, server);
    if (resources.length === 0) return server ? `No MCP resources found for ${server}.` : "No MCP resources found.";
    return [
      `MCP resources${server ? ` for ${server}` : ""}:`,
      "",
      ...resources.map((resource) => `- ${resource.server}: ${resource.uri}${resource.name ? ` (${resource.name})` : ""}`),
    ].join("\n");
  }
  if (command === "prompts") {
    const server = tokens[0];
    const prompts = await listMcpPrompts(cwd, server);
    if (prompts.length === 0) return server ? `No MCP prompts found for ${server}.` : "No MCP prompts found.";
    return [
      `MCP prompts${server ? ` for ${server}` : ""}:`,
      "",
      ...prompts.map((prompt) => `- ${prompt.server}/${prompt.name}${prompt.description ? `: ${prompt.description}` : ""}`),
    ].join("\n");
  }
  if (command === "instructions") {
    const server = tokens[0];
    if (!server) return "Usage: /mcp instructions <server>";
    return await getMcpInstructions(cwd, server);
  }
  if (command === "get") {
    const name = tokens[0];
    if (!name) return "Usage: /mcp get <name>";
    const server = getMcpServer(cwd, name);
    return server
      ? JSON.stringify(server, null, 2)
      : `MCP server "${name}" not found.`;
  }
  if (command === "remove") {
    const name = tokens[0];
    if (!name) return "Usage: /mcp remove <name> [--scope user|project]";
    const scope = parseScope(tokens);
    const result = removeMcpServer(cwd, name, scope);
    return result.removed
      ? `Removed MCP server ${name} from ${result.path}.`
      : `MCP server ${name} was not present in ${result.path}.`;
  }
  if (command === "add") {
    const parsed = parseAdd(tokens);
    if (!parsed.ok) return parsed.message;
    const result = addMcpServer(cwd, parsed.name, parsed.config, parsed.scope);
    return [
      `Added MCP server ${result.server.name} to ${result.path}.`,
      `Transport: ${result.server.transport}`,
      "External MCP tools require approval by default.",
    ].join("\n");
  }

  return [
    `Unknown MCP command: ${command}`,
    "",
    "Usage:",
    "- /mcp list",
    "- /mcp status",
    "- /mcp tools [server]",
    "- /mcp resources [server]",
    "- /mcp prompts [server]",
    "- /mcp instructions <server>",
    "- /mcp test <server>",
    "- /mcp auth status [server]",
    "- /mcp auth login <server>",
    "- /mcp auth logout <server>",
    "- /mcp get <name>",
    "- /mcp add <name> --url <url> [--transport auto|streamable-http|sse] [--auth bearer|header|oauth|client_credentials] [--scope user|project]",
    "- /mcp add <name> -- <command> [args...]",
    "- /mcp remove <name> [--scope user|project]",
  ].join("\n");
}

function tokenize(line: string): string[] {
  return (line.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [])
    .map((token) => token.replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

function parseScope(tokens: string[]): "user" | "project" {
  const index = tokens.indexOf("--scope");
  const value = index >= 0 ? tokens[index + 1] : undefined;
  return value === "project" ? "project" : "user";
}

function parseAdd(tokens: string[]): {
  ok: true;
  name: string;
  config: McpServerConfig;
  scope: "user" | "project";
} | { ok: false; message: string } {
  const name = tokens.shift();
  if (!name) {
    return {
      ok: false,
      message: "Usage: /mcp add <name> --url <url> [--scope user|project] OR /mcp add <name> -- <command> [args...]",
    };
  }
  const scope = parseScope(tokens);
  const transport = parseFlag(tokens, "--transport");
  const timeout = parseFlag(tokens, "--timeout") ?? parseFlag(tokens, "--timeout-ms");
  const authType = parseFlag(tokens, "--auth");
  const toolFilter = parseCommaFlag(tokens, "--tool-filter");
  const resourceFilter = parseCommaFlag(tokens, "--resource-filter");
  const tokenEnv = parseFlag(tokens, "--token-env");
  const headerName = parseFlag(tokens, "--header-name");
  const clientIdEnv = parseFlag(tokens, "--client-id-env");
  const clientSecretEnv = parseFlag(tokens, "--client-secret-env");
  const redirectUrl = parseFlag(tokens, "--redirect-url");
  const scopes = parseMultiFlag(tokens, "--auth-scope").concat(parseCommaFlag(tokens, "--auth-scopes"));
  const env = parseKeyValueFlags(tokens, "--env");
  const headers = parseKeyValueFlags(tokens, "--header");

  const baseConfig: Partial<McpServerConfig> = {
    ...(transport ? { transport: transport as McpServerConfig["transport"] } : {}),
    ...(timeout ? { timeoutMs: Number(timeout) } : {}),
    ...(Object.keys(env).length ? { env } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(toolFilter.length ? { toolFilter } : {}),
    ...(resourceFilter.length ? { resourceFilter } : {}),
    ...(authType ? {
      auth: {
        type: authType as NonNullable<McpServerConfig["auth"]>["type"],
        ...(tokenEnv ? { tokenEnv } : {}),
        ...(headerName ? { headerName } : {}),
        ...(clientIdEnv ? { clientIdEnv } : {}),
        ...(clientSecretEnv ? { clientSecretEnv } : {}),
        ...(redirectUrl ? { redirectUrl } : {}),
        ...(scopes.length ? { scopes } : {}),
      },
    } : {}),
  };
  const urlIndex = tokens.indexOf("--url");
  if (urlIndex >= 0 && tokens[urlIndex + 1]) {
    return {
      ok: true,
      name,
      scope,
      config: { ...baseConfig, url: tokens[urlIndex + 1] },
    };
  }
  const sep = tokens.indexOf("--");
  const commandParts = sep >= 0
    ? tokens.slice(sep + 1)
    : tokens.filter((token, index) => !isConsumedOption(tokens, index));
  const [command, ...args] = commandParts;
  if (!command) {
    return {
      ok: false,
      message: "Missing MCP stdio command. Example: /mcp add local -- node ./server.js",
    };
  }
  return {
    ok: true,
    name,
    scope,
    config: { ...baseConfig, command, args },
  };
}

function parseFlag(tokens: string[], flag: string): string | undefined {
  const index = tokens.indexOf(flag);
  return index >= 0 ? tokens[index + 1] : undefined;
}

function parseMultiFlag(tokens: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === flag && tokens[i + 1]) values.push(tokens[i + 1]!);
  }
  return values;
}

function parseCommaFlag(tokens: string[], flag: string): string[] {
  return (parseFlag(tokens, flag) ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseKeyValueFlags(tokens: string[], flag: string): Record<string, string> {
  const record: Record<string, string> = {};
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== flag) continue;
    const [key, ...rest] = (tokens[i + 1] ?? "").split("=");
    if (key && rest.length) record[key] = rest.join("=");
  }
  return record;
}

function isConsumedOption(tokens: string[], index: number): boolean {
  const token = tokens[index];
  if (!token) return true;
  const valueOptions = new Set([
    "--scope",
    "--transport",
    "--timeout",
    "--timeout-ms",
    "--auth",
    "--tool-filter",
    "--resource-filter",
    "--token-env",
    "--header-name",
    "--client-id-env",
    "--client-secret-env",
    "--redirect-url",
    "--auth-scope",
    "--auth-scopes",
    "--env",
    "--header",
    "--url",
  ]);
  if (valueOptions.has(token)) return true;
  if (index > 0 && valueOptions.has(tokens[index - 1]!)) return true;
  return false;
}
