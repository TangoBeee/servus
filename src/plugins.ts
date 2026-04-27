import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { SERVUS_DIR } from "./config.js";
import type { TaskDomain } from "./engine.js";
import type { PluginManifest } from "./runtime.js";

const PLUGIN_FILE = "servus.plugin.json";
const MAX_PLUGIN_MANIFEST_BYTES = 256_000;

const PluginManifestSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  tools: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  mcpServers: z.record(z.string(), z.object({
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    url: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
  })).optional(),
  configSchema: z.unknown().optional(),
  activation: z.object({
    always: z.boolean().optional(),
    triggers: z.array(z.string()).optional(),
    domains: z.array(z.enum(["coding", "desktop", "browser", "media", "data", "extension", "security", "general"])).optional(),
    capabilities: z.array(z.string()).optional(),
  }).optional(),
});

export interface LoadPluginsOptions {
  cwd: string;
  extraDirs?: string[];
  disabled?: string[];
}

export function loadPlugins(options: LoadPluginsOptions): PluginManifest[] {
  const disabled = new Set(options.disabled ?? []);
  const files = pluginManifestFiles(options.cwd, options.extraDirs ?? []);
  const plugins: PluginManifest[] = [];

  for (const file of files) {
    const plugin = readPlugin(file);
    if (!plugin || disabled.has(plugin.id)) continue;
    plugins.push(plugin);
  }

  return dedupePlugins(plugins);
}

export function selectPluginsForTask(
  task: string,
  domain: TaskDomain,
  plugins: PluginManifest[],
): PluginManifest[] {
  const normalizedTask = task.toLowerCase();

  return plugins.filter((plugin) => {
    const activation = plugin.activation;
    if (!activation) return false;
    if (activation.always) return true;
    if (activation.domains?.includes(domain)) return true;
    if (activation.triggers?.some((trigger) => normalizedTask.includes(trigger.toLowerCase()))) {
      return true;
    }
    if (activation.capabilities?.some((capability) => normalizedTask.includes(capability.toLowerCase()))) {
      return true;
    }
    return false;
  });
}

function pluginManifestFiles(cwd: string, extraDirs: string[]): string[] {
  const roots = [
    resolve(cwd, PLUGIN_FILE),
    resolve(cwd, ".servus", "plugins"),
    join(SERVUS_DIR, "plugins"),
    ...extraDirs.map((dir) => resolve(cwd, dir)),
  ];

  const files: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const stat = statSync(root);
    if (stat.isFile() && root.endsWith(PLUGIN_FILE)) {
      files.push(root);
      continue;
    }
    if (!stat.isDirectory()) continue;

    const realRoot = safeRealpath(root);
    if (!realRoot) continue;
    for (const entry of readdirSync(realRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(realRoot, entry.name, PLUGIN_FILE);
      const realManifest = safeRealpath(manifestPath);
      if (realManifest && isInside(realRoot, realManifest)) files.push(realManifest);
    }
  }

  return files.sort();
}

function readPlugin(path: string): PluginManifest | null {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_PLUGIN_MANIFEST_BYTES) return null;
    const parsed = PluginManifestSchema.safeParse(JSON.parse(readFileSync(path, "utf-8")));
    if (!parsed.success) return null;
    return { ...parsed.data, path };
  } catch {
    return null;
  }
}

function dedupePlugins(plugins: PluginManifest[]): PluginManifest[] {
  const seen = new Set<string>();
  const result: PluginManifest[] = [];
  for (const plugin of plugins) {
    if (seen.has(plugin.id)) continue;
    seen.add(plugin.id);
    result.push(plugin);
  }
  return result;
}

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function isInside(root: string, child: string): boolean {
  const rel = relative(root, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}
