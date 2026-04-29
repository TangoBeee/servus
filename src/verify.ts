import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { log } from "./log.js";
import { registerChild, unregisterChild } from "./child-registry.js";

// ─── Plan Types ─────────────────────────────────────────────────────────────

export interface PlanTask {
  id: string;
  description: string;
  target_files?: string[];
  status: string;
  verification?: string;
  failure_reason?: string;
}

export interface PlanPhase {
  id: number;
  name: string;
  status: string;
  tasks: PlanTask[];
}

export interface Plan {
  task: string;
  phases: PlanPhase[];
  verification?: {
    lint_command?: string;
    typecheck_command?: string;
    test_command?: string;
    build_command?: string;
  };
  [key: string]: unknown;
}

// ─── Plan I/O ───────────────────────────────────────────────────────────────

export function readPlan(cwd: string): Plan | null {
  const planPath = resolve(cwd, "servus-plan.json");
  if (!existsSync(planPath)) return null;
  try {
    return JSON.parse(readFileSync(planPath, "utf-8")) as Plan;
  } catch {
    return null;
  }
}

export function writePlan(cwd: string, plan: Plan): void {
  writeFileSync(
    resolve(cwd, "servus-plan.json"),
    JSON.stringify(plan, null, 2) + "\n",
  );
}

export function findNextPendingTask(
  plan: Plan,
): { phase: PlanPhase; task: PlanTask } | null {
  for (const phase of plan.phases) {
    for (const task of phase.tasks) {
      if (task.status === "pending" || task.status === "in_progress") {
        return { phase, task };
      }
    }
  }
  return null;
}

export function countTasks(plan: Plan): {
  total: number;
  completed: number;
  pending: number;
  failed: number;
} {
  let total = 0;
  let completed = 0;
  let pending = 0;
  let failed = 0;
  for (const phase of plan.phases) {
    for (const task of phase.tasks) {
      total++;
      if (task.status === "completed") completed++;
      else if (task.status === "failed") failed++;
      else pending++;
    }
  }
  return { total, completed, pending, failed };
}

// ─── Verification Pipeline ──────────────────────────────────────────────────

export interface VerificationResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  command: string;
}

function detectVerificationCommand(cwd: string): string {
  const pkgPath = resolve(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const scripts = pkg.scripts ?? {};
      const packageManager = inferPackageManager(cwd);
      const parts: string[] = [];
      if (scripts.typecheck) parts.push(packageRunCommand(packageManager, "typecheck"));
      if (scripts.lint) parts.push(packageRunCommand(packageManager, "lint"));
      if (scripts.test) parts.push(packageRunCommand(packageManager, "test"));
      if (scripts.build) parts.push(packageRunCommand(packageManager, "build"));
      if (parts.length > 0) return parts.join(" && ");
    } catch {
      /* fall through */
    }
  }

  if (existsSync(resolve(cwd, "Makefile"))) return "make test";
  if (existsSync(resolve(cwd, "Cargo.toml"))) return "cargo test";
  if (existsSync(resolve(cwd, "go.mod"))) return "go test ./...";
  if (existsSync(resolve(cwd, "pyproject.toml"))) return "python -m pytest";

  return 'echo "No verification command detected — treating as pass"';
}

function inferPackageManager(cwd: string): string {
  if (existsSync(resolve(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(resolve(cwd, "yarn.lock"))) return "yarn";
  if (existsSync(resolve(cwd, "bun.lockb"))) return "bun";
  return "npm";
}

function packageRunCommand(packageManager: string, script: string): string {
  if (packageManager === "yarn") return `yarn ${script}`;
  if (packageManager === "pnpm") return `pnpm run ${script}`;
  if (packageManager === "bun") return `bun run ${script}`;
  return `npm run ${script}`;
}

export async function runVerification(
  cwd: string,
  customCommand?: string,
): Promise<VerificationResult> {
  const command = customCommand ?? detectVerificationCommand(cwd);
  log.info(`Verification: ${command}`);

  const isWin = process.platform === "win32";
  const [shell, args] = isWin
    ? [process.env.COMSPEC ?? "cmd.exe", ["/c", command]]
    : ["/bin/bash", ["-c", command]];

  return new Promise<VerificationResult>((resolve) => {
    const child = spawn(shell, args, {
      cwd,
      env: { ...process.env, CI: "true", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: !isWin,
    });
    registerChild(child.pid!, { processGroup: !isWin });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (d: Buffer) => out.push(d));
    child.stderr?.on("data", (d: Buffer) => err.push(d));
    let settled = false;
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      unregisterChild(child.pid!);
      const stdout = Buffer.concat(out).toString("utf-8");
      const stderr = Buffer.concat(err).toString("utf-8");
      resolve({
        ok: code === 0,
        stdout,
        stderr,
        command,
      });
    });
    const t = setTimeout(() => {
      try {
        if (!isWin) process.kill(-child.pid!, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
    }, 600_000);
    child.on("close", () => clearTimeout(t));
  });
}
