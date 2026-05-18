import fs from "node:fs";
import path from "node:path";

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
