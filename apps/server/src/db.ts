import { DatabaseSync } from "node:sqlite";
import type { EmployeeSnapshot, TaskOutputChunk, TaskRecord } from "@ai-teams/shared";
import WebSocket from "ws";

export type ServerState = {
  agentSockets: Map<string, WebSocket>;
  leaderSockets: Set<WebSocket>;
  employees: Map<string, EmployeeSnapshot>;
  tasks: Map<string, TaskRecord>;
  taskLogs: Map<string, TaskOutputChunk[]>;
  taskWebhooks: Map<string, string>;
  socketToEmployeeId: WeakMap<WebSocket, string>;
  taskTimeouts: Map<string, NodeJS.Timeout>;
  disconnectTimers: Map<string, NodeJS.Timeout>;
  taskQueues: Map<string, string[]>;
  mainTaskQueues: Map<string, string[]>;
  sharedTaskQueue: string[];
  sharedQueueCursor: number;
};

export function initDb(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT INTO schema_meta (key, value)
    VALUES ('version', '1')
    ON CONFLICT(key) DO NOTHING;
    CREATE TABLE IF NOT EXISTS employees (
      id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_logs (
      task_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (task_id, seq)
    );
    CREATE TABLE IF NOT EXISTS task_webhooks (
      task_id TEXT PRIMARY KEY,
      webhook_url TEXT NOT NULL
    );
  `);
}

export function hydrateState(db: DatabaseSync, state: ServerState, defaultTimeoutSec: number, maxLogChunksPerTask: number) {
  const employeeRows = db.prepare("SELECT payload_json FROM employees").all() as Array<{ payload_json: string }>;
  for (const row of employeeRows) {
    const employee = JSON.parse(row.payload_json) as EmployeeSnapshot;
    employee.status = "offline";
    state.employees.set(employee.id, employee);
  }

  const taskRows = db.prepare("SELECT payload_json FROM tasks").all() as Array<{ payload_json: string }>;
  for (const row of taskRows) {
    const task = JSON.parse(row.payload_json) as TaskRecord;
    task.sessionId = task.sessionId ?? null;
    task.timeoutSec = task.timeoutSec ?? defaultTimeoutSec;
    task.targetMode = task.targetMode ?? (task.employeeId ? "direct" : "queue");
    state.tasks.set(task.id, task);
    if (task.status === "queued") {
      if (task.targetMode === "queue" || !task.employeeId) {
        state.sharedTaskQueue.push(task.id);
      } else {
        const queue = state.taskQueues.get(task.employeeId) ?? [];
        queue.push(task.id);
        state.taskQueues.set(task.employeeId, queue);
      }
    }
  }

  const logRows = db
    .prepare(
      `
        SELECT payload_json FROM (
          SELECT task_id, seq, payload_json,
          ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY seq DESC) AS rn
          FROM task_logs
        )
        WHERE rn <= ?
        ORDER BY task_id ASC, seq ASC
      `,
    )
    .all(maxLogChunksPerTask) as Array<{ payload_json: string }>;
  for (const row of logRows) {
    const chunk = JSON.parse(row.payload_json) as TaskOutputChunk;
    const history = state.taskLogs.get(chunk.taskId) ?? [];
    history.push(chunk);
    state.taskLogs.set(chunk.taskId, history);
  }

  const webhookRows = db.prepare("SELECT task_id, webhook_url FROM task_webhooks").all() as Array<{
    task_id: string;
    webhook_url: string;
  }>;
  for (const row of webhookRows) {
    state.taskWebhooks.set(row.task_id, row.webhook_url);
  }

  const cursorRow = db.prepare("SELECT value FROM schema_meta WHERE key = 'sharedQueueCursor'").get() as { value: string } | undefined;
  if (cursorRow) {
    state.sharedQueueCursor = Number(cursorRow.value) || 0;
  }
}

export function persistEmployee(db: DatabaseSync, employee: EmployeeSnapshot) {
  db.prepare(`
    INSERT INTO employees (id, payload_json)
    VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json
  `).run(employee.id, JSON.stringify(employee));
}

export function persistTask(db: DatabaseSync, task: TaskRecord) {
  db.prepare(`
    INSERT INTO tasks (id, payload_json)
    VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json
  `).run(task.id, JSON.stringify(task));
}

export function persistTaskWebhook(db: DatabaseSync, taskId: string, webhookUrl: string) {
  db.prepare(`
    INSERT INTO task_webhooks (task_id, webhook_url)
    VALUES (?, ?)
    ON CONFLICT(task_id) DO UPDATE SET webhook_url = excluded.webhook_url
  `).run(taskId, webhookUrl);
}

export function persistSharedQueueCursor(db: DatabaseSync, cursor: number) {
  db.prepare(`
    INSERT INTO schema_meta (key, value)
    VALUES ('sharedQueueCursor', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(cursor));
}

export function persistTaskLog(db: DatabaseSync, chunk: TaskOutputChunk, maxLogChunksPerTask: number) {
  db.prepare(`
    INSERT INTO task_logs (task_id, seq, payload_json)
    VALUES (?, ?, ?)
    ON CONFLICT(task_id, seq) DO UPDATE SET payload_json = excluded.payload_json
  `).run(chunk.taskId, chunk.seq, JSON.stringify(chunk));
  db.prepare(`
    DELETE FROM task_logs
    WHERE task_id = ?
      AND seq NOT IN (
        SELECT seq FROM task_logs
        WHERE task_id = ?
        ORDER BY seq DESC
        LIMIT ?
      )
  `).run(chunk.taskId, chunk.taskId, maxLogChunksPerTask);
}
