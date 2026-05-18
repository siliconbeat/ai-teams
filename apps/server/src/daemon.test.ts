import { createServer } from "node:net";
import { describe, it, expect, afterEach } from "vitest";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getDaemonStatus, stopDaemon } from "@ai-teams/shared/daemon";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "ai-teams-server-daemon-"));

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("Failed to get port")));
      }
    });
    server.on("error", reject);
  });
}

describe("server daemon lifecycle", { timeout: 30_000 }, () => {
  const dirs: string[] = [];
  const pids: number[] = [];

  afterEach(async () => {
    for (const pid of pids) {
      try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    }
    if (pids.length > 0) await new Promise((r) => setTimeout(r, 1000));
    for (const d of dirs) {
      fs.rmSync(d, { recursive: true, force: true });
    }
    dirs.length = 0;
    pids.length = 0;
  });

  it("start → status → stop lifecycle", async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const pidFile = path.join(dir, ".ai-teams-server.pid");
    const serverScript = path.resolve(import.meta.dirname, "../dist/index.js");
    const port = await findFreePort();

    // Start
    execSync(
      `node ${serverScript} start --token test-daemon-token --data-dir ${dir} --port ${port}`,
      { timeout: 10_000, stdio: "pipe" },
    );

    // Wait for daemon watchdog to spawn worker and write PID
    await new Promise((r) => setTimeout(r, 3000));

    // Check status
    const status = getDaemonStatus(pidFile);
    expect(status.running).toBe(true);
    expect(status.pid).not.toBeNull();
    if (status.pid) pids.push(status.pid);

    // Stop
    await stopDaemon(pidFile);
    await new Promise((r) => setTimeout(r, 500));
    const statusAfter = getDaemonStatus(pidFile);
    expect(statusAfter.running).toBe(false);
  });
});
