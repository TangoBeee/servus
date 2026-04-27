import { exec } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const execAsync = promisify(exec);
const JOBS_DIR = join(homedir(), ".servus", "jobs");

export interface JobMeta {
  task: string;
  cwd: string;
  model?: string;
  mode?: string;
  maxFailures?: number;
  budget?: number;
  domain?: string;
  startTime: number;
}

function ensureJobsDir(): void {
  try {
    mkdirSync(JOBS_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
}

export function writeJobMeta(name: string, meta: Omit<JobMeta, "startTime">): void {
  ensureJobsDir();
  const path = join(JOBS_DIR, `${name}.json`);
  writeFileSync(path, JSON.stringify({ ...meta, startTime: Date.now() }, null, 2));
}

export function getJobMeta(name: string): JobMeta | null {
  const path = join(JOBS_DIR, `${name}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as JobMeta;
  } catch {
    return null;
  }
}

export interface PM2Job {
  pm_id: number;
  name: string;
  status: string;
  uptime: number;
  cpu: number;
  memory: number;
  restarts: number;
  pid: number;
}

async function pm2Available(): Promise<boolean> {
  try {
    await execAsync("pm2 --version", { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export async function startBackground(
  task: string,
  opts: {
    model?: string;
    mode?: string;
    cwd?: string;
    maxFailures?: number;
    budget?: number;
    verify?: string;
    domain?: string;
  },
): Promise<string> {
  if (!(await pm2Available())) {
    throw new Error("pm2 is not installed. Run: npm install -g pm2");
  }

  const scriptPath = resolve(
    import.meta.dirname ?? ".",
    "../dist/index.js",
  );

  const args = [JSON.stringify(task)];
  if (opts.model) args.push("--model", opts.model);
  if (opts.mode) args.push("--mode", opts.mode);
  if (opts.cwd) args.push("--cwd", opts.cwd);
  if (opts.maxFailures) args.push("--max-failures", String(opts.maxFailures));
  if (opts.budget) args.push("--budget", String(opts.budget));
  if (opts.verify) args.push("--verify", opts.verify);
  if (opts.domain) args.push("--domain", opts.domain);

  const name = `servus-${Date.now().toString(36)}`;

  await execAsync(
    `pm2 start ${JSON.stringify(scriptPath)} --name ${name} --no-autorestart -- ${args.join(" ")}`,
    { timeout: 15_000 },
  );

  writeJobMeta(name, {
    task,
    cwd: opts.cwd ?? process.cwd(),
    model: opts.model,
    mode: opts.mode,
    maxFailures: opts.maxFailures,
    budget: opts.budget,
    domain: opts.domain,
  });

  return name;
}

export async function listJobs(): Promise<PM2Job[]> {
  if (!(await pm2Available())) return [];
  try {
    const { stdout } = await execAsync("pm2 jlist", { timeout: 10_000 });
    const all = JSON.parse(stdout) as Array<Record<string, unknown>>;
    return all
      .filter(
        (p) =>
          typeof p.name === "string" &&
          (p.name as string).startsWith("servus-"),
      )
      .map((p) => ({
        pm_id: (p.pm_id as number) ?? 0,
        name: p.name as string,
        status: ((p.pm2_env as Record<string, unknown>)?.status as string) ?? "unknown",
        uptime: (p.pm2_env as Record<string, unknown>)?.pm_uptime
          ? Date.now() - ((p.pm2_env as Record<string, unknown>).pm_uptime as number)
          : 0,
        cpu: ((p.monit as Record<string, unknown>)?.cpu as number) ?? 0,
        memory: ((p.monit as Record<string, unknown>)?.memory as number) ?? 0,
        restarts: ((p.pm2_env as Record<string, unknown>)?.restart_time as number) ?? 0,
        pid: (p.pid as number) ?? 0,
      }));
  } catch {
    return [];
  }
}

export async function stopJob(name: string): Promise<void> {
  await execAsync(`pm2 stop ${name}`, { timeout: 10_000 });
}

export async function deleteJob(name: string): Promise<void> {
  await execAsync(`pm2 delete ${name}`, { timeout: 10_000 });
}

export async function getJobLogs(name: string, lines = 50): Promise<string> {
  try {
    const { stdout } = await execAsync(
      `pm2 logs ${name} --nostream --lines ${lines} 2>&1`,
      { timeout: 10_000 },
    );
    return stdout;
  } catch {
    return "(no logs available)";
  }
}
