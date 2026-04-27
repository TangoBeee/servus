/**
 * Tracks child process PIDs spawned by Servus (e.g. from bash tool, verify).
 * When the user quits (e.g. "q" on dashboard), we kill only these processes
 * so we never touch anything the user started outside Servus.
 */

const registry: Array<{ pid: number; killGroup: boolean }> = [];

function isUnix(): boolean {
  return process.platform !== "win32";
}

export function registerChild(pid: number, options?: { processGroup?: boolean }): void {
  const killGroup = options?.processGroup ?? (isUnix() && true);
  registry.push({ pid, killGroup });
}

export function unregisterChild(pid: number): void {
  const i = registry.findIndex((e) => e.pid === pid);
  if (i !== -1) registry.splice(i, 1);
}

export function killAllServusChildren(): Promise<void> {
  const toKill = [...registry];
  registry.length = 0;

  for (const { pid, killGroup } of toKill) {
    try {
      if (killGroup && isUnix()) {
        process.kill(-pid, "SIGTERM");
      } else {
        process.kill(pid, "SIGTERM");
      }
    } catch {
      // Process may already be dead
    }
  }

  if (toKill.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    setTimeout(() => {
      for (const { pid, killGroup } of toKill) {
        try {
          if (killGroup && isUnix()) {
            process.kill(-pid, "SIGKILL");
          } else {
            process.kill(pid, "SIGKILL");
          }
        } catch {
          /* already dead */
        }
      }
      resolve();
    }, 500);
  });
}
