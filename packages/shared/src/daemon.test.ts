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
