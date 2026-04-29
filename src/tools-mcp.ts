import { tool } from "ai";
import { z } from "zod";
import { bus } from "./events.js";
import { loadConfig } from "./config.js";
import {
  callMcpTool,
  getMcpInstructions,
  listMcpPrompts,
  listMcpResources,
  listMcpTools,
  readMcpResource,
  summarizeMcpServers,
  testMcpServer,
} from "./mcp-client.js";

const serverSchema = z.object({
  server: z.string().optional().describe("Optional MCP server name."),
});

const readResourceSchema = z.object({
  server: z.string().describe("MCP server name."),
  uri: z.string().describe("Resource URI to read."),
});

const callToolSchema = z.object({
  server: z.string().describe("MCP server name."),
  tool: z.string().describe("Tool name exposed by the MCP server."),
  arguments: z.record(z.string(), z.unknown()).optional().default({}).describe("Arguments to pass to the MCP tool."),
  reason: z.string().optional().describe("Why this MCP tool call is needed."),
});

const MAX_MCP_OUTPUT = 60_000;

export function createMcpTools(cwd: string) {
  return {
    mcp_list_servers: tool({
      description: "List configured MCP servers from ~/.servus/mcp.json, project .servus/mcp.json, Servus config, and active Servus plugins.",
      inputSchema: z.object({}),
      execute: async () => summarizeMcpServers(cwd),
    }),

    McpListTools: tool({
      description: "List tools exposed by configured MCP servers.",
      inputSchema: serverSchema,
      execute: async (input: z.infer<typeof serverSchema>) => {
        try {
          const tools = await listMcpTools(cwd, input.server);
          if (tools.length === 0) return "No MCP tools found.";
          return clampJson(tools);
        } catch (err) {
          return `Error listing MCP tools: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    McpCallTool: tool({
      description: [
        "Call a tool exposed by a configured MCP server.",
        "Use only after listing tools and understanding the arguments.",
        "External MCP tools may mutate remote state, so Servus asks for approval before calling.",
      ].join("\n"),
      inputSchema: callToolSchema,
      execute: async (input: z.infer<typeof callToolSchema>) => {
        try {
          const permission = await mcpToolPermission(cwd, input.server, input.tool);
          if (permission === "deny") return `Error: MCP tool ${input.server}/${input.tool} is denied by Servus permissions.`;
          if (permission !== "allow") {
            const approved = await bus.requestApproval({
              action: "Call MCP tool",
              detail: [
                `Server: ${input.server}`,
                `Tool: ${input.tool}`,
                input.reason ? `Reason: ${input.reason}` : undefined,
                `Arguments: ${JSON.stringify(input.arguments ?? {})}`,
              ].filter(Boolean).join("\n"),
              risk: "medium",
              engine: "MCP",
            });
            if (!approved) return "Error: MCP tool call requires explicit approval.";
          }
          const result = await callMcpTool(cwd, input.server, input.tool, input.arguments ?? {});
          return formatMcpResult(result);
        } catch (err) {
          return `Error calling MCP tool: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    ListMcpResourcesTool: tool({
      description: "Servus tool for listing resources from configured MCP servers.",
      inputSchema: serverSchema,
      execute: async (input: z.infer<typeof serverSchema>) => {
        try {
          const resources = await listMcpResources(cwd, input.server);
          if (resources.length === 0) {
            return "No MCP resources found. MCP servers may still provide tools even if they have no resources.";
          }
          return clampJson(resources);
        } catch (err) {
          return `Error listing MCP resources: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    ListMcpPromptsTool: tool({
      description: "List prompts exposed by configured MCP servers.",
      inputSchema: serverSchema,
      execute: async (input: z.infer<typeof serverSchema>) => {
        try {
          const prompts = await listMcpPrompts(cwd, input.server);
          if (prompts.length === 0) return "No MCP prompts found.";
          return clampJson(prompts);
        } catch (err) {
          return `Error listing MCP prompts: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    GetMcpInstructionsTool: tool({
      description: "Read server-level instructions from one configured MCP server.",
      inputSchema: z.object({
        server: z.string().describe("MCP server name."),
      }),
      execute: async (input: { server: string }) => {
        try {
          return clamp(await getMcpInstructions(cwd, input.server));
        } catch (err) {
          return `Error reading MCP instructions: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    TestMcpServerTool: tool({
      description: "Test an MCP server connection and report its tools, resources, prompts, instructions, auth status, and errors.",
      inputSchema: z.object({
        server: z.string().describe("MCP server name."),
      }),
      execute: async (input: { server: string }) => {
        try {
          return clampJson(await testMcpServer(cwd, input.server));
        } catch (err) {
          return `Error testing MCP server: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    ReadMcpResourceTool: tool({
      description: "Servus tool for reading one MCP resource by server and URI.",
      inputSchema: readResourceSchema,
      execute: async (input: z.infer<typeof readResourceSchema>) => {
        try {
          const result = await readMcpResource(cwd, input.server, input.uri);
          return formatMcpResult(result);
        } catch (err) {
          return `Error reading MCP resource: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),
  };
}

async function mcpToolPermission(cwd: string, server: string, toolName: string): Promise<"allow" | "ask" | "deny"> {
  const permissions = loadConfig().permissions?.mcp;
  const target = `${server}/${toolName}`;
  if (matchesAny(target, permissions?.deny)) return "deny";
  if (matchesAny(target, permissions?.allow)) return "allow";
  const tools = await listMcpTools(cwd, server).catch(() => []);
  const toolInfo = tools.find((tool) => tool.name === toolName);
  if (toolInfo?.readOnly && matchesAny(target, permissions?.ask) === false && matchesAny(`${server}/*`, permissions?.allow)) {
    return "allow";
  }
  return "ask";
}

function matchesAny(target: string, patterns: string[] | undefined): boolean {
  return (patterns ?? []).some((pattern) => {
    if (pattern === "*" || pattern === target) return true;
    if (pattern.endsWith("/*")) return target.startsWith(pattern.slice(0, -1));
    return false;
  });
}

function formatMcpResult(result: unknown): string {
  if (typeof result === "string") return clamp(result);
  if (Array.isArray(result)) return clampJson(result);
  const record = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const content = record.content;
  if (Array.isArray(content)) {
    const text = content.map((item) => {
      if (item && typeof item === "object" && "text" in item) return String((item as { text?: unknown }).text ?? "");
      return JSON.stringify(item);
    }).filter(Boolean).join("\n");
    if (text.trim()) return clamp(text);
  }
  return clampJson(result);
}

function clampJson(value: unknown): string {
  return clamp(JSON.stringify(value, null, 2));
}

function clamp(value: string): string {
  if (value.length <= MAX_MCP_OUTPUT) return value;
  return `${value.slice(0, MAX_MCP_OUTPUT)}\n\n[… truncated ${value.length - MAX_MCP_OUTPUT} chars …]`;
}
