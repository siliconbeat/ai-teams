# Daemon Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `start/stop/restart/status` sub-commands to `ai-teams-server` and `ai-teams-agent` CLI, enabling background daemon mode with PID file management and auto-restart on crash.

**Architecture:** A shared `daemon.ts` module in `@ai-teams/shared` provides daemonize (fork-to-background), PID file helpers, and a watchdog loop. Server and agent CLI entry points parse sub-commands and delegate to the shared module.

**Tech Stack:** Node.js `child_process`, `fs`, `process` APIs. No external dependencies.

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `packages/shared/src/daemon.ts` | Daemonize, PID file, watchdog, status helpers |
| Modify | `packages/shared/src/index.ts` | Re-export daemon utilities |
| Create | `packages/shared/src/daemon.test.ts` | Tests for PID file helpers and daemonize logic |
| Modify | `apps/server/src/index.ts` | Add sub-command parsing (start/stop/restart/status) |
| Modify | `apps/agent/src/index.ts` | Add sub-command parsing (start/stop/restart/status) |

---

### Task 1: PID File Helpers in shared

**Files:**
- Create: `packages/shared/src/daemon.ts`
- Create: `packages/shared/src/daemon.test.ts`

- [ ] **Step 1: Write tests for PID file helpers**

Create `packages/shared/src/daemon.test.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, it, expect, afterEach } from "vitest";
import { readPidFile, writePidFile, removePidFile, isProcessRunning } from "./daemon.js";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "ai-teams-daemon-test-"));

describe("readPidFile / writePidFile / removePidFile", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("returns null when file does not exist", () => {
    const dir = tmpDir();
    dirs.push(dir);
    expect(readPidFile(path.join(dir, "no.pid"))).toBeNull();
  });

  it("writes and reads back a PID", () => {
    const dir = tmpDir();
    dirs.push(dir);
    const pidFile = path.join(dir, "test.pid");
    writePidFile(pidFile, 12345);
    expect(readPidFile(pidFile)).toBe(12345);
  });

  it("removePidFile deletes the file", () => {
    const dir = tmpDir();
    dirs.push(dir);
    const pidFile = path.join(dir, "test.pid");
    writePidFile(pidFile, 12345);
    removePidFile(pidFile);
    expect(readPidFile(pidFile)).toBeNull();
  });

  it("writePidFile creates parent directories", () => {
    const dir = tmpDir();
    dirs.push(dir);
    const pidFile = path.join(dir, "nested", "dir", "test.pid");
    writePidFile(pidFile, 999);
    expect(readPidFile(pidFile)).toBe(999);
  });
});

describe("isProcessRunning", () => {
  it("returns true for current process", () => {
    expect(isProcessRunning(process.pid)).toBe(true);
  });

  it("returns false for a PID that is not running", () => {
    // Use a very high PID that won't exist
    expect(isProcessRunning(9999999)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run packages/shared/src/daemon.test.ts`
Expected: FAIL — `daemon.js` module not found.

- [ ] **Step 3: Implement PID file helpers**

Create `packages/shared/src/daemon.ts`:

```ts
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

// --- Daemonize ---

export type DaemonOptions = {
  name: string;
  pidFile: string;
  logFile: string;
  run: () => Promise<void>;
};

/**
 * Fork the current process into a daemon. The parent exits after spawning
 * the child. The child spawns a worker and watches it, respawning on crash.
 *
 * The "run" function is what the worker executes.
 */
export function daemonize(opts: DaemonOptions): Promise<void> {
  // Detect if we are the worker (re-invoked with env flag)
  if (process.env.__AI_TEAMS_DAEMON_WORKER === "1") {
    return opts.run();
  }

  // We are the parent / launcher — spawn the daemon process
  fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });

  const logStream = fs.openSync(opts.logFile, "a");

  const child = spawn(process.execPath, [process.argv[1]!, ...process.argv.slice(2)], {
    detached: true,
    stdio: ["ignore", logStream, logStream],
    env: {
      ...process.env,
      __AI_TEAMS_DAEMON_WORKER: "1",
    },
  });
  child.unref();
  fs.closeSync(logStream);

  console.log(`${opts.name} started (PID ${child.pid})`);
  process.exit(0);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/shared/src/daemon.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/daemon.ts packages/shared/src/daemon.test.ts
git commit -m "feat(shared): add daemon PID file helpers and daemonize function"
```

---

### Task 2: Watchdog — auto-restart on crash

**Files:**
- Modify: `packages/shared/src/daemon.ts`
- Modify: `packages/shared/src/daemon.test.ts`

- [ ] **Step 1: Write test for watchdog spawn + respawn**

Add to `packages/shared/src/daemon.test.ts`:

```ts
import { spawnWorker } from "./daemon.js";

describe("spawnWorker", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("spawns a worker process that runs and exits cleanly", async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const readyFile = path.join(dir, "ready");

    // A simple "worker" script that touches a file and exits 0
    const workerScript = path.join(dir, "worker.mjs");
    fs.writeFileSync(
      workerScript,
      `import fs from "node:fs"; fs.writeFileSync("${readyFile}", "ok"); process.exit(0);`
    );

    const child = spawnWorker(workerScript, [], dir);
    const exitCode = await new Promise<number>((resolve) => child.on("exit", resolve));
    expect(exitCode).toBe(0);
    expect(fs.existsSync(readyFile)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/shared/src/daemon.test.ts`
Expected: FAIL — `spawnWorker` not exported.

- [ ] **Step 3: Implement spawnWorker and watchdog loop**

Append to `packages/shared/src/daemon.ts`:

```ts
/**
 * Spawn a worker child process with stdout/stderr redirected to a log file.
 */
export function spawnWorker(script: string, args: string[], logDir: string): ChildProcess {
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, "worker.log");
  const logStream = fs.openSync(logFile, "a");

  const child = spawn(process.execPath, [script, ...args], {
    stdio: ["ignore", logStream, logStream],
    env: { ...process.env },
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

  // Handle signals to the daemon
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
```

Now update the `daemonize` function to use `runWatchdog` when invoked as the daemon process (not the worker). Replace the existing `daemonize` function:

```ts
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
  setTimeout(() => {
    const pid = readPidFile(opts.pidFile);
    if (pid) {
      console.log(`${opts.name} started (PID ${pid})`);
    } else {
      console.error(`${opts.name}: failed to start — PID file not found.`);
      process.exit(1);
    }
    process.exit(0);
  }, 500);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/shared/src/daemon.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/daemon.ts packages/shared/src/daemon.test.ts
git commit -m "feat(shared): add watchdog with auto-restart for daemon mode"
```

---

### Task 3: Stop / Status helpers

**Files:**
- Modify: `packages/shared/src/daemon.ts`
- Modify: `packages/shared/src/daemon.test.ts`

- [ ] **Step 1: Write tests for stopDaemon and getDaemonStatus**

Add to `packages/shared/src/daemon.test.ts`:

```ts
import { stopDaemon, getDaemonStatus } from "./daemon.js";

describe("getDaemonStatus", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });

  it("returns stopped when PID file does not exist", () => {
    const dir = tmpDir();
    dirs.push(dir);
    const status = getDaemonStatus(path.join(dir, "no.pid"));
    expect(status.running).toBe(false);
    expect(status.pid).toBeNull();
  });

  it("returns running when PID file points to a live process", () => {
    const dir = tmpDir();
    dirs.push(dir);
    const pidFile = path.join(dir, "test.pid");
    writePidFile(pidFile, process.pid);
    const status = getDaemonStatus(pidFile);
    expect(status.running).toBe(true);
    expect(status.pid).toBe(process.pid);
  });

  it("returns stopped and cleans stale PID when process is dead", () => {
    const dir = tmpDir();
    dirs.push(dir);
    const pidFile = path.join(dir, "test.pid");
    writePidFile(pidFile, 9999999);
    const status = getDaemonStatus(pidFile);
    expect(status.running).toBe(false);
    expect(status.pid).toBeNull();
    // stale PID file should be removed
    expect(fs.existsSync(pidFile)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run packages/shared/src/daemon.test.ts`
Expected: FAIL — `getDaemonStatus` / `stopDaemon` not exported.

- [ ] **Step 3: Implement stopDaemon and getDaemonStatus**

Append to `packages/shared/src/daemon.ts`:

```ts
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

  process.kill(pid, "SIGTERM");

  // Wait up to 10 seconds for process to exit
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (!isProcessRunning(pid)) {
      removePidFile(pidFile);
      console.log(`Stopped (PID ${pid}).`);
      return;
    }
  }

  // Force kill
  process.kill(pid, "SIGKILL");
  removePidFile(pidFile);
  console.log(`Force killed (PID ${pid}).`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run packages/shared/src/daemon.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/daemon.ts packages/shared/src/daemon.test.ts
git commit -m "feat(shared): add stopDaemon and getDaemonStatus helpers"
```

---

### Task 4: Export daemon utilities from shared package

**Files:**
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Add re-exports**

Append to `packages/shared/src/index.ts`:

```ts
export {
  readPidFile,
  writePidFile,
  removePidFile,
  isProcessRunning,
  daemonize,
  spawnWorker,
  runWatchdog,
  stopDaemon,
  getDaemonStatus,
  type DaemonOptions,
  type DaemonStatus,
} from "./daemon.js";
```

- [ ] **Step 2: Build shared package**

Run: `pnpm --filter @ai-teams/shared build`
Expected: Build succeeds with no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/index.ts
git commit -m "feat(shared): export daemon utilities from package entry point"
```

---

### Task 5: Server CLI sub-commands

**Files:**
- Modify: `apps/server/src/index.ts`

- [ ] **Step 1: Add daemon imports**

Add to the imports at the top of `apps/server/src/index.ts`:

```ts
import { daemonize, stopDaemon, getDaemonStatus, readPidFile, removePidFile } from "@ai-teams/shared";
```

- [ ] **Step 2: Replace the isCli block with sub-command support**

Replace the entire `const isCli = ...` block at the bottom of `apps/server/src/index.ts` with:

```ts
const isCli = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const args = process.argv.slice(2);
  function getArgValue(name: string): string | undefined {
    const idx = args.indexOf(name);
    if (idx === -1) return undefined;
    return args[idx + 1];
  }

  if (args.includes("--version") || args.includes("-v")) {
    console.log(PKG_VERSION);
    process.exit(0);
  }
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`ai-teams-server — AI Teams 中央服务器

用法: ai-teams-server <command> [选项]

命令:
  start [选项]          后台启动守护进程
  stop                  停止守护进程
  restart [选项]        重启守护进程
  status                查看运行状态

选项:
  --token <token>       认证 Token (必填，或设 AI_TEAMS_AUTH_TOKEN)
  --port <port>         服务端口 (默认 3789)
  --host <host>         绑定地址 (默认 0.0.0.0)
  --data-dir <dir>      数据目录
  --database-url <url>  PostgreSQL 连接字符串 (设置后使用 PostgreSQL 而非 SQLite)
  --db-path <path>      数据库路径
  --log-level <level>   日志级别 trace/debug/info/warn/error (默认 info)
  --log-dir <dir>       日志文件目录 (不设则仅输出到 stdout)
  -v, --version         显示版本号
  -h, --help            显示帮助

不带命令直接运行时为前台模式。
`);
    process.exit(0);
  }

  // Resolve data dir for PID/log file paths
  function resolveDataDir(): string {
    return getArgValue("--data-dir") || process.env.DATA_DIR || path.join(process.cwd(), "data");
  }
  function resolvePidFile(): string {
    return path.join(resolveDataDir(), ".ai-teams-server.pid");
  }
  function resolveLogDir(): string {
    return getArgValue("--log-dir") || process.env.LOG_DIR || path.join(resolveDataDir(), "logs");
  }

  function applyCliArgsToEnv(): void {
    const cliToken = getArgValue("--token");
    const cliPort = getArgValue("--port");
    const cliHost = getArgValue("--host");
    const cliDataDir = getArgValue("--data-dir");
    const cliDatabaseUrl = getArgValue("--database-url");
    const cliDbPath = getArgValue("--db-path");
    const cliLogLevel = getArgValue("--log-level");
    const cliLogDir = getArgValue("--log-dir");
    if (cliToken) process.env.AI_TEAMS_AUTH_TOKEN = cliToken;
    if (cliPort) process.env.AI_TEAMS_SERVER_PORT = cliPort;
    if (cliHost) process.env.HOST = cliHost;
    if (cliDataDir) process.env.DATA_DIR = cliDataDir;
    if (cliDatabaseUrl) process.env.DATABASE_URL = cliDatabaseUrl;
    if (cliDbPath) process.env.DB_PATH = cliDbPath;
    if (cliLogLevel) process.env.LOG_LEVEL = cliLogLevel;
    if (cliLogDir) process.env.LOG_DIR = cliLogDir;
  }

  const subcommand = args[0];
  if (subcommand === "start" || subcommand === "restart") {
    // For restart, stop first
    if (subcommand === "restart") {
      const pidFile = resolvePidFile();
      const status = getDaemonStatus(pidFile);
      if (status.running) {
        await stopDaemon(pidFile);
      }
    }

    applyCliArgsToEnv();
    if (!process.env.AI_TEAMS_AUTH_TOKEN) {
      console.error("错误: 需要认证 Token。使用 --token <token> 或设置 AI_TEAMS_AUTH_TOKEN 环境变量。");
      process.exit(1);
    }
    // Ensure log-dir is set for daemon mode
    if (!process.env.LOG_DIR) {
      process.env.LOG_DIR = resolveLogDir();
    }

    await daemonize({
      name: "ai-teams-server",
      pidFile: resolvePidFile(),
      logFile: path.join(resolveLogDir(), "server.log"),
      run: async () => {
        const server = await startServer(readOptionsFromEnv());
        // Keep process alive — Fastify listen keeps it running
      },
    });
  } else if (subcommand === "stop") {
    await stopDaemon(resolvePidFile());
  } else if (subcommand === "status") {
    const status = getDaemonStatus(resolvePidFile());
    if (status.running) {
      console.log(`ai-teams-server is running (PID ${status.pid})`);
      console.log(`Log: ${path.join(resolveLogDir(), "server.log")}`);
    } else {
      console.log("ai-teams-server is not running.");
    }
  } else {
    // No sub-command — foreground mode (existing behavior)
    applyCliArgsToEnv();
    const options = readOptionsFromEnv();
    if (!options.authToken) {
      console.error("错误: 需要认证 Token。使用 --token <token> 或设置 AI_TEAMS_AUTH_TOKEN 环境变量。");
      process.exit(1);
    }
    startServer(options).catch((error) => {
      console.error(error);
      process.exit(1);
    });
  }
}
```

- [ ] **Step 3: Build and verify**

Run: `pnpm build && pnpm typecheck`
Expected: Both succeed.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/index.ts
git commit -m "feat(server): add start/stop/restart/status sub-commands"
```

---

### Task 6: Agent CLI sub-commands

**Files:**
- Modify: `apps/agent/src/index.ts`

- [ ] **Step 1: Add daemon imports**

Add to the imports at the top of `apps/agent/src/index.ts`:

```ts
import path from "node:path";
import { daemonize, stopDaemon, getDaemonStatus } from "@ai-teams/shared";
```

Note: `path` may already be imported via `config.ts` but not directly. Add the import if not present.

- [ ] **Step 2: Replace the isCli block with sub-command support**

Replace the entire `const isCli = ...` block at the bottom of `apps/agent/src/index.ts` with:

```ts
const isCli = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const args = process.argv.slice(2);

  if (args.includes("--version") || args.includes("-v")) {
    console.log(PKG_VERSION);
    process.exit(0);
  }
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`ai-teams-agent — AI Teams 员工代理

用法: ai-teams-agent <command> [选项]

命令:
  start [选项]          后台启动守护进程
  stop                  停止守护进程
  restart [选项]        重启守护进程
  status                查看运行状态

选项:
  --server <url>        服务器地址
  --token <token>       认证 Token
  --id <id>             员工 ID
  --name <name>         员工名称
  --workspace <dir>     工作目录
  --runner <mode>       Runner 模式 (claude/fake)
  --config              重新运行配置向导
  -v, --version         显示版本号
  -h, --help            显示帮助

不带命令直接运行时为前台模式。
`);
    process.exit(0);
  }

  function getArgValue(name: string): string | undefined {
    const idx = args.indexOf(name);
    if (idx === -1) return undefined;
    return args[idx + 1];
  }

  // Resolve paths based on workspace
  function resolveWorkspace(): string {
    return getArgValue("--workspace") || process.env.DEFAULT_WORKSPACE || process.cwd();
  }
  function resolveAgentDir(): string {
    const ws = resolveWorkspace();
    const id = getArgValue("--id") || process.env.EMPLOYEE_ID || "emp_local";
    return path.join(ws, ".ai-teams", "agents", id);
  }
  function resolvePidFile(): string {
    return path.join(resolveAgentDir(), "agent.pid");
  }
  function resolveLogDir(): string {
    return path.join(resolveAgentDir(), "logs");
  }

  function applyCliArgsToEnv(): void {
    const cliServer = getArgValue("--server");
    const cliToken = getArgValue("--token");
    const cliId = getArgValue("--id");
    const cliName = getArgValue("--name");
    const cliWorkspace = getArgValue("--workspace");
    const cliRunner = getArgValue("--runner");
    if (cliServer) process.env.SERVER_URL = cliServer;
    if (cliToken) process.env.AI_TEAMS_AUTH_TOKEN = cliToken;
    if (cliId) process.env.EMPLOYEE_ID = cliId;
    if (cliName) process.env.EMPLOYEE_NAME = cliName;
    if (cliWorkspace) process.env.DEFAULT_WORKSPACE = cliWorkspace;
    if (cliRunner) process.env.RUNNER_MODE = cliRunner;
  }

  if (args.includes("--config")) {
    void runSetup(loadConfigFile()).then(() => {
      console.log("  ✓ 重新配置完成，请重新启动 agent。");
      process.exit(0);
    });
  } else {
    const subcommand = args[0];

    if (subcommand === "start" || subcommand === "restart") {
      if (subcommand === "restart") {
        const pidFile = resolvePidFile();
        const status = getDaemonStatus(pidFile);
        if (status.running) {
          await stopDaemon(pidFile);
        }
      }

      applyCliArgsToEnv();

      // Ensure config exists
      const fileConfig = loadConfigFile();
      const hasEnvConfig = process.env.AI_TEAMS_AUTH_TOKEN || process.env.SERVER_URL;
      if (!fileConfig && !hasEnvConfig) {
        console.log("\n  ⚠ 未找到配置文件且未设置环境变量，请先运行 --config 配置。\n");
        process.exit(1);
      }

      await daemonize({
        name: `ai-teams-agent`,
        pidFile: resolvePidFile(),
        logFile: path.join(resolveLogDir(), "agent.log"),
        run: async () => {
          console.log(`  ✓ 正在连接服务器...`);
          connect();
        },
      });
    } else if (subcommand === "stop") {
      await stopDaemon(resolvePidFile());
    } else if (subcommand === "status") {
      const status = getDaemonStatus(resolvePidFile());
      if (status.running) {
        console.log(`ai-teams-agent is running (PID ${status.pid})`);
        console.log(`Log: ${path.join(resolveLogDir(), "agent.log")}`);
      } else {
        console.log("ai-teams-agent is not running.");
      }
    } else {
      // No sub-command — foreground mode (existing behavior)
      void (async () => {
        const fileConfig = loadConfigFile();
        const hasEnvConfig = process.env.AI_TEAMS_AUTH_TOKEN || process.env.SERVER_URL;
        if (!fileConfig && !hasEnvConfig) {
          console.log("\n  ⚠ 未找到配置文件且未设置环境变量，启动配置向导...\n");
          await runSetup(null);
        }

        applyCliArgsToEnv();
        console.log(`  ✓ 正在连接服务器...`);
        connect();
      })();
    }
  }
}
```

- [ ] **Step 3: Build and verify**

Run: `pnpm build && pnpm typecheck`
Expected: Both succeed.

- [ ] **Step 4: Commit**

```bash
git add apps/agent/src/index.ts
git commit -m "feat(agent): add start/stop/restart/status sub-commands"
```

---

### Task 7: Integration test — server daemon start/stop

**Files:**
- Modify: `apps/server/src/index.test.ts` (or create a separate integration test)

- [ ] **Step 1: Write integration test for server daemon lifecycle**

Add a test to verify the daemon start → status → stop cycle works end-to-end. This test should be marked `skip` in CI environments that don't support process forking, but run locally.

Append to the server test file or create `apps/server/src/daemon.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getDaemonStatus, stopDaemon } from "@ai-teams/shared";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "ai-teams-server-daemon-"));

describe("server daemon lifecycle", { timeout: 30_000 }, () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) {
      const pidFile = path.join(d, ".ai-teams-server.pid");
      const status = getDaemonStatus(pidFile);
      if (status.running && status.pid) {
        process.kill(status.pid, "SIGTERM");
      }
      fs.rmSync(d, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it("start → status → stop lifecycle", async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const pidFile = path.join(d, ".ai-teams-server.pid");

    // Start
    execSync(
      `node ${path.resolve("dist/index.js")} start --token test-daemon-token --data-dir ${dir}`,
      { timeout: 10_000 }
    );

    // Wait for server to be ready
    await new Promise((r) => setTimeout(r, 2000));

    // Check status
    const status = getDaemonStatus(pidFile);
    expect(status.running).toBe(true);
    expect(status.pid).not.toBeNull();

    // Stop
    await stopDaemon(pidFile);
    const statusAfter = getDaemonStatus(pidFile);
    expect(statusAfter.running).toBe(false);
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `pnpm vitest run apps/server/src/daemon.test.ts`
Expected: PASS — daemon starts, status shows running, stop shuts it down.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/daemon.test.ts
git commit -m "test(server): add daemon lifecycle integration test"
```
