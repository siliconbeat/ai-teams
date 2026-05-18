import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import pg from "pg";
import type { EmployeeSnapshot, TaskOutputChunk, TaskRecord, TaskCliConfig } from "@ai-teams/shared";
import type { StateStore } from "./state-store.js";

// ---------------------------------------------------------------------------
// Database abstraction
// ---------------------------------------------------------------------------

export interface Database {
  run(sql: string, params?: unknown[]): Promise<void>;
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// SQLite implementation (wraps synchronous node:sqlite)
// ---------------------------------------------------------------------------

export class SqliteDatabase implements Database {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  private static toSqlite(sql: string, params?: unknown[]): { sql: string; params: SQLInputValue[] } {
    let idx = 0;
    const converted = sql.replace(/\$\d+/g, () => {
      idx += 1;
      return "?";
    });
    return { sql: converted, params: (params ?? []) as SQLInputValue[] };
  }

  async run(sql: string, params?: unknown[]): Promise<void> {
    const { sql: q, params: p } = SqliteDatabase.toSqlite(sql, params);
    this.db.prepare(q).run(...p);
  }
  async get<T>(sql: string, params?: unknown[]): Promise<T | undefined> {
    const { sql: q, params: p } = SqliteDatabase.toSqlite(sql, params);
    return this.db.prepare(q).get(...p) as T | undefined;
  }
  async all<T>(sql: string, params?: unknown[]): Promise<T[]> {
    const { sql: q, params: p } = SqliteDatabase.toSqlite(sql, params);
    return this.db.prepare(q).all(...p) as T[];
  }
  async close(): Promise<void> {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL implementation (wraps pg driver)
// ---------------------------------------------------------------------------

export class PostgresDatabase implements Database {
  private pool: pg.Pool;
  constructor(pool: pg.Pool) {
    this.pool = pool;
  }
  async run(sql: string, params?: unknown[]): Promise<void> {
    await this.pool.query(sql, params ?? []);
  }
  async get<T>(sql: string, params?: unknown[]): Promise<T | undefined> {
    const result = await this.pool.query(sql, params ?? []);
    return (result.rows[0] as T | undefined) ?? undefined;
  }
  async all<T>(sql: string, params?: unknown[]): Promise<T[]> {
    const result = await this.pool.query(sql, params ?? []);
    return result.rows as T[];
  }
  async close(): Promise<void> {
    await this.pool.end();
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function createDatabaseFromEnv(env: NodeJS.ProcessEnv): Promise<Database> {
  const databaseUrl = env.DATABASE_URL;
  if (databaseUrl) {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    return new PostgresDatabase(pool);
  }
  const dataDir = env.DATA_DIR ?? process.cwd();
  const dbPath = env.DB_PATH ?? `${dataDir}/ai-teams.db`;
  const { mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  return new SqliteDatabase(db);
}

// Re-export StateStore for convenience
export type { StateStore } from "./state-store.js";

// ---------------------------------------------------------------------------
// Table creation (PostgreSQL-compatible, also works with SQLite)
// ---------------------------------------------------------------------------

export async function initDb(db: Database) {
  await db.run(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  await db.run(`
    INSERT INTO schema_meta (key, value)
    VALUES ('version', '2')
    ON CONFLICT(key) DO UPDATE SET value = '2'
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS employees (
      id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL
    )
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id                          TEXT PRIMARY KEY,
      leader_command_id           TEXT NOT NULL,
      employee_id                 TEXT,
      session_id                  TEXT,
      target_mode                 TEXT NOT NULL DEFAULT 'queue',
      prompt                      TEXT NOT NULL,
      workspace                   TEXT,
      status                      TEXT NOT NULL DEFAULT 'queued',
      timeout_sec                 INTEGER NOT NULL DEFAULT 1800,
      cli_config                  TEXT,
      priority                    INTEGER NOT NULL DEFAULT 1,
      required_labels             TEXT,
      created_at                  TEXT NOT NULL,
      started_at                  TEXT,
      finished_at                 TEXT,
      exit_code                   INTEGER,
      summary                     TEXT,
      error                       TEXT,
      duration_ms                 INTEGER,
      duration_api_ms             INTEGER,
      num_turns                   INTEGER,
      total_cost_usd              REAL,
      usage_input_tokens          INTEGER,
      usage_output_tokens         INTEGER,
      usage_cache_read_tokens     INTEGER,
      usage_cache_creation_tokens INTEGER
    )
  `);
  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)
  `);
  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_tasks_employee ON tasks(employee_id)
  `);
  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_tasks_leader_cmd ON tasks(leader_command_id)
  `);
  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id)
  `);
  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at)
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS task_logs (
      task_id       TEXT NOT NULL,
      seq           INTEGER NOT NULL,
      payload_json  TEXT NOT NULL,
      PRIMARY KEY (task_id, seq)
    )
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS task_webhooks (
      task_id      TEXT PRIMARY KEY,
      webhook_url  TEXT NOT NULL
    )
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS schedules (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      cron_expr       TEXT NOT NULL,
      enabled         INTEGER NOT NULL DEFAULT 1,
      target_mode     TEXT NOT NULL DEFAULT 'queue',
      target_agents   TEXT NOT NULL DEFAULT '[]',
      prompt          TEXT NOT NULL,
      workspace       TEXT,
      timeout_sec     INTEGER,
      priority        INTEGER NOT NULL DEFAULT 0,
      required_labels TEXT DEFAULT '[]',
      last_run_at     TEXT,
      next_run_at     TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    )
  `);
}

// ---------------------------------------------------------------------------
// Hydrate state from database
// ---------------------------------------------------------------------------

export async function hydrateState(db: Database, state: StateStore, defaultTimeoutSec: number, maxLogChunksPerTask: number) {
  const employeeRows = await db.all<{ payload_json: string }>("SELECT payload_json FROM employees");
  for (const row of employeeRows) {
    const employee = JSON.parse(row.payload_json) as EmployeeSnapshot;
    employee.status = "offline";
    state.employees.set(employee.id, employee);
  }

  const taskRows = await db.all<DbTaskRow>("SELECT * FROM tasks");
  for (const row of taskRows) {
    const task = dbRowToTask(row, defaultTimeoutSec);
    state.tasks.set(task.id, task);
    if (task.status === "queued") {
      if (task.targetMode === "queue" || !task.employeeId) {
        state.sharedTaskQueue.push(task.id);
      } else {
        const queue = state.taskQueues.get(task.employeeId!) ?? [];
        queue.push(task.id);
        state.taskQueues.set(task.employeeId!, queue);
      }
    }
  }

  const logRows = await db.all<{ payload_json: string }>(
    `SELECT payload_json FROM (
      SELECT task_id, seq, payload_json,
      ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY seq DESC) AS rn
      FROM task_logs
    ) sub
    WHERE rn <= $1
    ORDER BY task_id ASC, seq ASC`,
    [maxLogChunksPerTask],
  );
  for (const row of logRows) {
    const chunk = JSON.parse(row.payload_json) as TaskOutputChunk;
    const history = state.taskLogs.get(chunk.taskId) ?? [];
    history.push(chunk);
    state.taskLogs.set(chunk.taskId, history);
  }

  const webhookRows = await db.all<{ task_id: string; webhook_url: string }>("SELECT task_id, webhook_url FROM task_webhooks");
  for (const row of webhookRows) {
    state.taskWebhooks.set(row.task_id, row.webhook_url);
  }

  const cursorRow = await db.get<{ value: string }>("SELECT value FROM schema_meta WHERE key = 'sharedQueueCursor'");
  if (cursorRow) {
    state.sharedQueueCursor = Number(cursorRow.value) || 0;
  }
}

// ---------------------------------------------------------------------------
// Persist functions
// ---------------------------------------------------------------------------

export async function persistEmployee(db: Database, employee: EmployeeSnapshot) {
  await db.run(
    `INSERT INTO employees (id, payload_json)
     VALUES ($1, $2)
     ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json`,
    [employee.id, JSON.stringify(employee)],
  );
}

const TASK_COLUMNS = [
  "id", "leader_command_id", "employee_id", "session_id", "target_mode",
  "prompt", "workspace", "status", "timeout_sec", "cli_config", "priority", "required_labels",
  "created_at", "started_at", "finished_at", "exit_code", "summary", "error",
  "duration_ms", "duration_api_ms", "num_turns", "total_cost_usd",
  "usage_input_tokens", "usage_output_tokens", "usage_cache_read_tokens", "usage_cache_creation_tokens",
] as const;

const TASK_PLACEHOLDERS = TASK_COLUMNS.map((_, i) => `$${i + 1}`).join(", ");
const TASK_UPDATE_SET = TASK_COLUMNS.slice(1).map((col) => `${col} = excluded.${col}`).join(", ");

export async function persistTask(db: Database, task: TaskRecord) {
  const values = taskToDbValues(task);
  await db.run(
    `INSERT INTO tasks (${TASK_COLUMNS.join(", ")})
     VALUES (${TASK_PLACEHOLDERS})
     ON CONFLICT(id) DO UPDATE SET ${TASK_UPDATE_SET}`,
    values,
  );
}

export async function persistTaskWebhook(db: Database, taskId: string, webhookUrl: string) {
  await db.run(
    `INSERT INTO task_webhooks (task_id, webhook_url)
     VALUES ($1, $2)
     ON CONFLICT(task_id) DO UPDATE SET webhook_url = excluded.webhook_url`,
    [taskId, webhookUrl],
  );
}

export async function persistSharedQueueCursor(db: Database, cursor: number) {
  await db.run(
    `INSERT INTO schema_meta (key, value)
     VALUES ('sharedQueueCursor', $1)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [String(cursor)],
  );
}

export async function persistTaskLog(db: Database, chunk: TaskOutputChunk, maxLogChunksPerTask: number) {
  await db.run(
    `INSERT INTO task_logs (task_id, seq, payload_json)
     VALUES ($1, $2, $3)
     ON CONFLICT(task_id, seq) DO UPDATE SET payload_json = excluded.payload_json`,
    [chunk.taskId, chunk.seq, JSON.stringify(chunk)],
  );
  await db.run(
    `DELETE FROM task_logs
     WHERE task_id = $1
       AND seq NOT IN (
         SELECT seq FROM task_logs
         WHERE task_id = $2
         ORDER BY seq DESC
         LIMIT $3
       )`,
    [chunk.taskId, chunk.taskId, maxLogChunksPerTask],
  );
}

// ---------------------------------------------------------------------------
// Task query helpers (for CRUD routes)
// ---------------------------------------------------------------------------

export async function queryTasks(
  db: Database,
  filters: { status?: string; employeeId?: string; limit?: number; offset?: number },
): Promise<DbTaskRow[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIdx = 1;

  if (filters.status) {
    conditions.push(`status = $${paramIdx++}`);
    params.push(filters.status);
  }
  if (filters.employeeId) {
    conditions.push(`employee_id = $${paramIdx++}`);
    params.push(filters.employeeId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filters.limit ?? 50;
  const offset = filters.offset ?? 0;
  params.push(limit, offset);

  return db.all<DbTaskRow>(
    `SELECT * FROM tasks ${where} ORDER BY created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
    params,
  );
}

export async function getTaskById(db: Database, taskId: string): Promise<DbTaskRow | undefined> {
  return db.get<DbTaskRow>("SELECT * FROM tasks WHERE id = $1", [taskId]);
}

export async function deleteTask(db: Database, taskId: string): Promise<boolean> {
  const row = await db.get<{ status: string }>("SELECT status FROM tasks WHERE id = $1", [taskId]);
  if (!row) return false;
  if (!["completed", "failed", "cancelled", "timeout"].includes(row.status)) return false;
  await db.run("DELETE FROM task_logs WHERE task_id = $1", [taskId]);
  await db.run("DELETE FROM task_webhooks WHERE task_id = $1", [taskId]);
  await db.run("DELETE FROM tasks WHERE id = $1", [taskId]);
  return true;
}

export async function updateTaskFields(db: Database, taskId: string, fields: Record<string, unknown>): Promise<DbTaskRow | undefined> {
  const entries = Object.entries(fields);
  if (entries.length === 0) return getTaskById(db, taskId);

  const setClauses = entries.map(([key], i) => `${toSnakeCase(key)} = $${i + 2}`).join(", ");
  const values = entries.map(([, val]) => val);
  await db.run(
    `UPDATE tasks SET ${setClauses} WHERE id = $1`,
    [taskId, ...values],
  );
  return getTaskById(db, taskId);
}

// ---------------------------------------------------------------------------
// Row <-> TaskRecord conversion
// ---------------------------------------------------------------------------

export type DbTaskRow = {
  id: string;
  leader_command_id: string;
  employee_id: string | null;
  session_id: string | null;
  target_mode: string;
  prompt: string;
  workspace: string | null;
  status: string;
  timeout_sec: number;
  cli_config: string | null;
  priority: number;
  required_labels: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  summary: string | null;
  error: string | null;
  duration_ms: number | null;
  duration_api_ms: number | null;
  num_turns: number | null;
  total_cost_usd: number | null;
  usage_input_tokens: number | null;
  usage_output_tokens: number | null;
  usage_cache_read_tokens: number | null;
  usage_cache_creation_tokens: number | null;
};

export function dbRowToTask(row: DbTaskRow, defaultTimeoutSec: number): TaskRecord {
  return {
    id: row.id,
    leaderCommandId: row.leader_command_id,
    employeeId: row.employee_id,
    sessionId: row.session_id,
    targetMode: (row.target_mode || (row.employee_id ? "direct" : "queue")) as TaskRecord["targetMode"],
    prompt: row.prompt,
    workspace: row.workspace,
    timeoutSec: row.timeout_sec ?? defaultTimeoutSec,
    cliConfig: row.cli_config ? (JSON.parse(row.cli_config) as TaskCliConfig) : null,
    priority: row.priority ?? 1,
    requiredLabels: row.required_labels ? JSON.parse(row.required_labels) : null,
    status: (row.status || "queued") as TaskRecord["status"],
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    exitCode: row.exit_code,
    summary: row.summary,
    error: row.error,
    durationMs: row.duration_ms,
    durationApiMs: row.duration_api_ms,
    numTurns: row.num_turns,
    totalCostUsd: row.total_cost_usd,
    usageInputTokens: row.usage_input_tokens,
    usageOutputTokens: row.usage_output_tokens,
    usageCacheReadTokens: row.usage_cache_read_tokens,
    usageCacheCreationTokens: row.usage_cache_creation_tokens,
  };
}

function taskToDbValues(task: TaskRecord): unknown[] {
  return [
    task.id,
    task.leaderCommandId,
    task.employeeId,
    task.sessionId,
    task.targetMode,
    task.prompt,
    task.workspace,
    task.status,
    task.timeoutSec,
    task.cliConfig ? JSON.stringify(task.cliConfig) : null,
    task.priority,
    task.requiredLabels ? JSON.stringify(task.requiredLabels) : null,
    task.createdAt,
    task.startedAt,
    task.finishedAt,
    task.exitCode,
    task.summary,
    task.error,
    task.durationMs,
    task.durationApiMs,
    task.numTurns,
    task.totalCostUsd,
    task.usageInputTokens,
    task.usageOutputTokens,
    task.usageCacheReadTokens,
    task.usageCacheCreationTokens,
  ];
}

function toSnakeCase(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

// ---------------------------------------------------------------------------
// Schedule CRUD
// ---------------------------------------------------------------------------

export interface ScheduleRecord {
  id: string;
  name: string;
  cronExpr: string;
  enabled: boolean;
  targetMode: "queue" | "direct" | "broadcast";
  targetAgents: string[];
  prompt: string;
  workspace: string | null;
  timeoutSec: number | null;
  priority: number;
  requiredLabels: string[] | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

type DbScheduleRow = {
  id: string;
  name: string;
  cron_expr: string;
  enabled: number;
  target_mode: string;
  target_agents: string;
  prompt: string;
  workspace: string | null;
  timeout_sec: number | null;
  priority: number;
  required_labels: string | null;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
};

const SCHEDULE_COLUMNS = [
  "id", "name", "cron_expr", "enabled", "target_mode", "target_agents",
  "prompt", "workspace", "timeout_sec", "priority", "required_labels",
  "last_run_at", "next_run_at", "created_at", "updated_at",
] as const;

const SCHEDULE_PLACEHOLDERS = SCHEDULE_COLUMNS.map((_, i) => `$${i + 1}`).join(", ");
const SCHEDULE_UPDATE_SET = SCHEDULE_COLUMNS.slice(1).map((col) => `${col} = excluded.${col}`).join(", ");

function dbRowToSchedule(row: DbScheduleRow): ScheduleRecord {
  return {
    id: row.id,
    name: row.name,
    cronExpr: row.cron_expr,
    enabled: row.enabled === 1,
    targetMode: row.target_mode as ScheduleRecord["targetMode"],
    targetAgents: JSON.parse(row.target_agents || "[]"),
    prompt: row.prompt,
    workspace: row.workspace,
    timeoutSec: row.timeout_sec,
    priority: row.priority,
    requiredLabels: row.required_labels ? JSON.parse(row.required_labels) : null,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function scheduleToDbValues(s: ScheduleRecord): unknown[] {
  return [
    s.id, s.name, s.cronExpr, s.enabled ? 1 : 0, s.targetMode,
    JSON.stringify(s.targetAgents), s.prompt, s.workspace, s.timeoutSec,
    s.priority, s.requiredLabels ? JSON.stringify(s.requiredLabels) : null,
    s.lastRunAt, s.nextRunAt, s.createdAt, s.updatedAt,
  ];
}

export async function upsertSchedule(db: Database, schedule: ScheduleRecord): Promise<void> {
  await db.run(
    `INSERT INTO schedules (${SCHEDULE_COLUMNS.join(", ")}) VALUES (${SCHEDULE_PLACEHOLDERS}) ON CONFLICT(id) DO UPDATE SET ${SCHEDULE_UPDATE_SET}`,
    scheduleToDbValues(schedule),
  );
}

export async function getAllSchedules(db: Database): Promise<ScheduleRecord[]> {
  const rows = await db.all<DbScheduleRow>("SELECT * FROM schedules ORDER BY created_at");
  return rows.map(dbRowToSchedule);
}

export async function getScheduleById(db: Database, id: string): Promise<ScheduleRecord | undefined> {
  const row = await db.get<DbScheduleRow>("SELECT * FROM schedules WHERE id = $1", [id]);
  return row ? dbRowToSchedule(row) : undefined;
}

export async function deleteScheduleRow(db: Database, id: string): Promise<boolean> {
  const row = await db.get<{ id: string }>("SELECT id FROM schedules WHERE id = $1", [id]);
  if (!row) return false;
  await db.run("DELETE FROM schedules WHERE id = $1", [id]);
  return true;
}

export async function updateScheduleFields(db: Database, id: string, fields: Record<string, unknown>): Promise<ScheduleRecord | undefined> {
  const existing = await getScheduleById(db, id);
  if (!existing) return undefined;
  const updated = { ...existing, ...fields, updatedAt: new Date().toISOString() };
  await upsertSchedule(db, updated);
  return updated;
}
