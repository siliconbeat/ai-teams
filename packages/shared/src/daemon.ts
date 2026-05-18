import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

// --- PID file helpers ---

export function readPidFile(pidFile: string): number | null {
  try {
    const content = fs.readFileSync(pidFile, "utf-8").trim();
    const pid = Number(content);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function writePidFile(pidFile: string, pid: number): void {
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, String(pid), "utf-8");
}

export function removePidFile(pidFile: string): void {
  try {
    fs.unlinkSync(pidFile);
  } catch {
    // already gone
  }
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// --- Worker spawning ---

/**
 * Spawn a worker child process with stdout/stderr redirected to a log file.
 */
export function spawnWorker(script: string, args: string[], logDir: string): ChildProcess {
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, "worker.log");
  const logStream = fs.openSync(logFile, "a");

  const child = spawn(process.execPath, [script, ...args], {
    stdio: ["ignore", logStream, logStream],
    env: {
      ...process.env,
      __AI_TEAMS_DAEMON_WORKER: "1",
      __AI_TEAMS_DAEMON_WATCHDOG: undefined,
    },
  });
  fs.closeSync(logStream);
  return child;
}

const MAX_RESTARTS_PER_MINUTE = 10;
const RESTART_DELAY_MS = 3000;

/**
 * Run the watchdog loop: spawn a worker, respawn on crash.
 * Returns only when the worker exits cleanly or restart limit is exceeded.
 */
export async function runWatchdog(opts: {
  name: string;
  pidFile: string;
  logDir: string;
  workerScript: string;
  workerArgs: string[];
}): Promise<void> {
  const { name, pidFile, logDir, workerScript, workerArgs } = opts;

  writePidFile(pidFile, process.pid);

  let restartTimestamps: number[] = [];

  function cleanupAndExit(code: number): never {
    removePidFile(pidFile);
    process.exit(code);
  }

  let worker: ChildProcess | null = null;
  let shuttingDown = false;

  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    if (worker) worker.kill("SIGTERM");
  }

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Main watchdog loop
  while (!shuttingDown) {
    await new Promise<void>((resolve) => {
      worker = spawnWorker(workerScript, workerArgs, logDir);

      worker.on("exit", (code, signal) => {
        worker = null;

        if (shuttingDown) {
          cleanupAndExit(0);
        }

        if (code === 0) {
          // Clean exit — daemon should stop too
          console.log(`${name}: worker exited cleanly, daemon stopping.`);
          cleanupAndExit(0);
        }

        // Crash — check restart rate
        const now = Date.now();
        restartTimestamps = restartTimestamps.filter((t) => now - t < 60_000);
        restartTimestamps.push(now);

        if (restartTimestamps.length > MAX_RESTARTS_PER_MINUTE) {
          console.error(`${name}: exceeded ${MAX_RESTARTS_PER_MINUTE} restarts/minute, daemon stopping.`);
          cleanupAndExit(1);
        }

        console.log(`${name}: worker crashed (code=${code}, signal=${signal}), restarting in ${RESTART_DELAY_MS}ms...`);
        setTimeout(resolve, RESTART_DELAY_MS);
      });
    });
  }

  cleanupAndExit(0);
}

// --- Daemonization ---

export type DaemonOptions = {
  name: string;
  pidFile: string;
  logFile: string;
  run: () => Promise<void>;
};

/**
 * Fork the current process into a daemon. The parent exits after spawning
 * the child. The child becomes a watchdog that spawns a worker and monitors it.
 *
 * The "run" function is what the worker executes.
 */
export function daemonize(opts: DaemonOptions): Promise<void> {
  // Worker: just run the business logic
  if (process.env.__AI_TEAMS_DAEMON_WORKER === "1") {
    return opts.run();
  }

  // Daemon process: already spawned, run watchdog
  if (process.env.__AI_TEAMS_DAEMON_WATCHDOG === "1") {
    return runWatchdog({
      name: opts.name,
      pidFile: opts.pidFile,
      logDir: path.dirname(opts.logFile),
      workerScript: process.argv[1]!,
      workerArgs: process.argv.slice(2),
    });
  }

  // Parent / launcher: spawn the daemon (watchdog) process
  fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });

  const child = spawn(
    process.execPath,
    [process.argv[1]!, ...process.argv.slice(2)],
    {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
      env: {
        ...process.env,
        __AI_TEAMS_DAEMON_WATCHDOG: "1",
      },
    }
  );
  child.unref();

  // Give the daemon a moment to write the PID file
  return new Promise((resolve) => {
    setTimeout(() => {
      const pid = readPidFile(opts.pidFile);
      if (pid) {
        console.log(`${opts.name} started (PID ${pid})`);
      } else {
        console.error(`${opts.name}: failed to start — PID file not found.`);
      }
      resolve();
      process.exit(pid ? 0 : 1);
    }, 500);
  });
}
