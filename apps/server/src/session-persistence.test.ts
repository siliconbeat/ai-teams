import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { TaskRecord } from "@ai-teams/shared";
import { hydrateState, initDb, persistTask, SqliteDatabase } from "./db.js";
import { createInMemoryStateStore } from "./state-store.js";

const task: TaskRecord = {
  id: "task", leaderCommandId: "command", employeeId: "alice", sessionId: "local-session",
  sessionEmployeeId: "alice", targetMode: "queue", prompt: "test", workspace: "/workspace",
  timeoutSec: 30, cliConfig: null, priority: 1, requiredLabels: null, status: "queued",
  retryCount: 8, reconnectCount: 2, attempt: 4, createdAt: "2026-09-21T00:00:00Z",
  startedAt: null, finishedAt: null, exitCode: null, summary: null, error: "earlier model error",
  durationMs: null, durationApiMs: null, numTurns: null, totalCostUsd: null,
  usageInputTokens: null, usageOutputTokens: null, usageCacheReadTokens: null, usageCacheCreationTokens: null,
};

describe("durable session owner and reconnect budget", () => {
  it("migrates old tasks without treating model retries as reconnects, then preserves new metadata", async () => {
    const raw = new DatabaseSync(":memory:");
    const db = new SqliteDatabase(raw);
    try {
      await initDb(db);
      await persistTask(db, task);
      await persistTask(db, { ...task, id: "orphan", employeeId: null, sessionEmployeeId: null });
      // Recreate the 0.9.0 task shape while retaining real stored task data.
      raw.exec("ALTER TABLE tasks DROP COLUMN session_employee_id");
      raw.exec("ALTER TABLE tasks DROP COLUMN reconnect_count");
      await initDb(db);
      await initDb(db); // migration is idempotent
      const migrated = createInMemoryStateStore();
      await hydrateState(db, migrated, 30);
      expect(migrated.tasks.get("task")).toMatchObject({ sessionEmployeeId: "alice", retryCount: 8, reconnectCount: 0 });
      expect(migrated.tasks.get("orphan")).toMatchObject({ sessionEmployeeId: null, sessionId: "local-session", reconnectCount: 0 });
      await persistTask(db, { ...task, employeeId: null });
      const restarted = createInMemoryStateStore();
      await hydrateState(db, restarted, 30);
      expect(restarted.tasks.get("task")).toMatchObject({ sessionEmployeeId: "alice", employeeId: null, retryCount: 8, reconnectCount: 2, sessionId: "local-session" });
      expect(restarted.sharedTaskQueue).toEqual(expect.arrayContaining(["task", "orphan"]));
    } finally { await db.close(); }
  });
});
