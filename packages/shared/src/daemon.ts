import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

// --- PID file helpers ---

export function readPidFile(pidFile: string): number | null {
  try {
    const content = fs.readFileSync(pidFile, "utf-8").trim();
    const pid = content.startsWith("{") ? Number(JSON.parse(content).pid) : Number(content);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function writePidFile(pidFile: string, pid: number): void {
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  const previous = readPidFile(pidFile);
  if (previous && isProcessRunning(previous)) throw new Error(`PID file already owned by live process ${previous}`);
  if (previous) {
    const record = fs.readFileSync(pidFile, "utf8");
    if (readPidFile(pidFile) !== previous || isProcessRunning(previous)) throw new Error("PID ownership changed.");
    removeOwnedPidFile(pidFile, record);
  }
  fs.writeFileSync(pidFile, JSON.stringify({ pid, identity: processIdentity(pid), nonce: randomUUID() }), { flag: "wx", mode: 0o600 });
}

function processIdentity(pid: number): string | null {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "args="], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch { return null; }
}

function verifiedPidRecord(pidFile: string, pid: number) {
  const raw = fs.readFileSync(pidFile, "utf8");
  let identity: string | null = null;
  try { identity = JSON.parse(raw).identity; } catch { /* legacy numeric PID */ }
  if (!identity || identity !== processIdentity(pid)) {
    throw new Error(`Refusing to signal unverified PID ${pid}. Inspect the process and legacy/stale PID file ${pidFile} manually.`);
  }
  return raw;
}

function removeOwnedPidFile(pidFile: string, record: string) {
  try { if (fs.readFileSync(pidFile, "utf8") === record) fs.unlinkSync(pidFile); } catch { /* changed or gone */ }
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
export function spawnWorker(script: string, args: string[], logFile: string): ChildProcess {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const child = spawn(process.execPath, [script, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      __AI_TEAMS_DAEMON_WORKER: "1",
      __AI_TEAMS_DAEMON_WATCHDOG: undefined,
    },
  });
  let logFailed = false;
  const append = (chunk: Buffer) => {
    if (logFailed) return;
    try {
      if (fs.existsSync(logFile) && fs.statSync(logFile).size >= 8 * 1024 * 1024) {
        for (let n = 2; n >= 0; n--) {
          const source = n ? `${logFile}.${n}` : logFile;
          if (fs.existsSync(source)) fs.renameSync(source, `${logFile}.${n + 1}`);
        }
      }
      fs.appendFileSync(logFile, chunk.subarray(0, 256 * 1024));
    } catch (error) { logFailed = true; console.error(`Daemon log unavailable: ${String(error)}`); }
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
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
  logFile: string;
  workerScript: string;
  workerArgs: string[];
}): Promise<void> {
  const { name, pidFile, logFile, workerScript, workerArgs } = opts;

  writePidFile(pidFile, process.pid);
  const ownedRecord = fs.readFileSync(pidFile, "utf8");

  let restartTimestamps: number[] = [];

  function cleanupAndExit(code: number): never {
    removeOwnedPidFile(pidFile, ownedRecord);
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
      worker = spawnWorker(workerScript, workerArgs, logFile);

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

// --- Stop / Status helpers ---

export type DaemonStatus = {
  running: boolean;
  pid: number | null;
};

export function getDaemonStatus(pidFile: string): DaemonStatus {
  const pid = readPidFile(pidFile);
  if (pid === null) {
    return { running: false, pid: null };
  }
  if (isProcessRunning(pid)) {
    verifiedPidRecord(pidFile, pid);
    return { running: true, pid };
  }
  // Stale PID file — clean it up
  removePidFile(pidFile);
  return { running: false, pid: null };
}

export async function stopDaemon(pidFile: string): Promise<void> {
  const pid = readPidFile(pidFile);
  if (pid === null) {
    console.log("Not running (no PID file found).");
    return;
  }
  if (!isProcessRunning(pid)) {
    removePidFile(pidFile);
    console.log("Not running (stale PID file cleaned).");
    return;
  }

  const ownedRecord = verifiedPidRecord(pidFile, pid);
  process.kill(pid, "SIGTERM");

  // Wait up to 10 seconds for process to exit
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (!isProcessRunning(pid)) {
      removeOwnedPidFile(pidFile, ownedRecord);
      console.log(`Stopped (PID ${pid}).`);
      return;
    }
  }

  // Force kill
  if (fs.readFileSync(pidFile, "utf8") !== ownedRecord) throw new Error("Daemon ownership changed while stopping.");
  verifiedPidRecord(pidFile, pid);
  process.kill(pid, "SIGKILL");
  for (let i = 0; i < 20 && isProcessRunning(pid); i++) await new Promise(resolve => setTimeout(resolve, 100));
  if (isProcessRunning(pid)) throw new Error(`PID ${pid} did not exit; refusing overlapping restart.`);
  removeOwnedPidFile(pidFile, ownedRecord);
  console.log(`Force killed (PID ${pid}).`);
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
      logFile: opts.logFile,
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
