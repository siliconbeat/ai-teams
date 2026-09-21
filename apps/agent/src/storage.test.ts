import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it, vi } from "vitest";

const config = vi.hoisted(() => ({ DAILY_RECORDS_DIR: "", STATE_FILE: "", LEGACY_STATE_FILE: "", EMPLOYEE_NAME: "test" }));
vi.mock("./config.js", () => config);
const dirs: string[] = [];
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-teams-storage-")); dirs.push(dir);
  config.DAILY_RECORDS_DIR = path.join(dir, "daily");
  config.STATE_FILE = path.join(dir, "state.json");
  return dir;
}
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

it("daily log EISDIR is best effort, not a task lifecycle exception", async () => {
  fixture();
  const { appendDailyRecord } = await import("./records.js");
  fs.mkdirSync(path.join(config.DAILY_RECORDS_DIR, `${new Date().toISOString().slice(0, 10)}.md`), { recursive: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
  expect(() => appendDailyRecord("start / completed")).not.toThrow();
  expect(console.error).toHaveBeenCalled();
});

it("state writes are atomic and failures preserve the previous state", async () => {
  const dir = fixture();
  const state = await import("./state.js");
  expect(state.persistState({ claudeSessionId: "old", sessionReady: true })).toBe(true);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(fs, "renameSync").mockImplementation(() => { throw new Error("ENOSPC"); });
  expect(state.persistState({ claudeSessionId: "new", sessionReady: true })).toBe(false);
  expect(state.stateStorageHealthy).toBe(false);
  expect(JSON.parse(fs.readFileSync(config.STATE_FILE, "utf8")).claudeSessionId).toBe("old");
  expect(fs.readdirSync(dir)).toEqual(["state.json"]);
});

it("terminal outbox survives module reload and rejects corruption", async () => {
  fixture(); vi.resetModules();
  const outbox = await import("./outbox.js");
  const terminal = { type: "task.completed" as const, taskId: "offline", attempt: 1, exitCode: 0 };
  outbox.saveTerminalOutbox([terminal]);
  vi.resetModules();
  const restarted = await import("./outbox.js");
  expect(restarted.loadTerminalOutbox()).toEqual([terminal]);
  fs.writeFileSync(`${config.STATE_FILE}.outbox.json`, "corrupt");
  expect(() => restarted.loadTerminalOutbox()).toThrow();
});
