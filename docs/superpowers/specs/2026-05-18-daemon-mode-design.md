# Daemon Mode Design

## Goal

Allow `ai-teams-server` and `ai-teams-agent` to run as background daemon processes with sub-command control (start/stop/restart/status), PID file management, and automatic restart on crash.

## Sub-command Structure

```
ai-teams-server start [options]    # Start daemon
ai-teams-server stop               # Stop daemon
ai-teams-server restart [options]  # Restart daemon
ai-teams-server status             # Show PID, uptime, status
ai-teams-server [options]          # Foreground run (unchanged)
```

Same pattern for `ai-teams-agent`.

No sub-command = current foreground behavior, fully backward compatible.

## Process Model

Two-layer architecture:

```
shell → start command (parent process)
         ↓ spawn { detached: true }
       daemon process (PID file owner, watchdog)
         ↓ spawn
       worker child process (runs actual server/agent logic)
```

- **Daemon process**: writes PID file, monitors worker, respawns worker on crash (3s delay).
- **Worker child process**: executes existing `startServer()` / `connect()` logic.
- Daemon receives SIGTERM/SIGINT → kills worker → cleans PID file → exits.

## PID File

**Server**: `{data-dir}/.ai-teams-server.pid`
**Agent**: `{workspace}/.ai-teams/agents/{id}/agent.pid`

Content: single line with numeric PID.

Pre-operation check: PID file exists → read PID → `kill(pid, 0)` check liveness → clean stale file if process dead.

## Auto-restart

- Daemon listens on worker `exit` event.
- Non-zero exit code or signal → wait 3 seconds → respawn.
- Rate limit: max 10 restarts per minute. Exceeding → daemon exits with error log.
- Clean exit (code=0) → daemon exits, cleans PID file.

## Log Handling

When `start` is used without `--log-dir`:
- Default log directory: `{data-dir}/logs/` (server) or `{workspace}/.ai-teams/agents/{id}/logs/` (agent).
- `server.log` / `agent.log` — stdout + stderr redirected.
- No terminal output when daemonized.

`status` command displays log file path.

## Code Organization

Extract shared daemon logic to `packages/shared/src/daemon.ts`:

```ts
export type DaemonOptions = {
  name: string;
  pidFile: string;
  logDir: string;
  run: () => Promise<void>;
};

// Called from CLI: daemonize() forks to background then runs `run()` in worker.
export function daemonize(opts: DaemonOptions): Promise<void>;

// Helpers for start/stop/restart/status sub-commands.
export function readPidFile(pidFile: string): number | null;
export function isProcessRunning(pid: number): boolean;
export function stopDaemon(pidFile: string): Promise<void>;
export function getDaemonStatus(pidFile: string): DaemonStatus;
```

CLI entry points parse sub-commands, then call shared functions or `daemonize()`.

## Implementation Scope

1. Add `packages/shared/src/daemon.ts` with daemonize, PID, status logic.
2. Update `apps/server/src/index.ts` CLI section to parse sub-commands.
3. Update `apps/agent/src/index.ts` CLI section to parse sub-commands.
4. Both apps import daemon utilities from `@ai-teams/shared`.
