import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import pg from "pg";
import { randomUUID } from "node:crypto";
import type {
  AgentRegistrationRecord,
  AgentRegistrationStatus,
  EmployeeSnapshot,
  MissionApprovalPolicy,
  MissionApprovalRecord,
  MissionApprovalStatus,
  MissionEventRecord,
  MissionRecord,
  MissionStatus,
  MissionSubtaskRecord,
  TaskOutputChunk,
  TaskRecord,
  TaskCliConfig,
} from "@ai-teams/shared";
import { TERMINAL_STATUSES } from "@ai-teams/shared";
import type { StateStore } from "./state-store.js";

// ---------------------------------------------------------------------------
// Database abstraction
// ---------------------------------------------------------------------------

export interface Database {
  run(sql: string, params?: unknown[]): Promise<void>;
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
  clearTaskData(): Promise<TaskCleanupResult>;
}

export type TaskCleanupResult = { tasks: number; missions: number; generation: string };
const TASK_DATA_TABLES = ["mission_approvals", "mission_subtasks", "mission_events", "missions", "task_logs", "task_webhooks", "tasks"];

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

  async clearTaskData(): Promise<TaskCleanupResult> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const tasks = (this.db.prepare("SELECT COUNT(*) AS count FROM tasks").get() as { count: number }).count;
      const missions = (this.db.prepare("SELECT COUNT(*) AS count FROM missions").get() as { count: number }).count;
      for (const table of TASK_DATA_TABLES) this.db.exec(`DELETE FROM ${table}`);
      const generation = randomUUID();
      this.db.prepare("INSERT INTO schema_meta (key, value) VALUES ('task_data_generation', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(generation);
      this.db.exec("COMMIT");
      return { tasks, missions, generation };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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

  async clearTaskData(): Promise<TaskCleanupResult> {
    // A transaction must use one checked-out connection, never pool.query.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const tasks = Number((await client.query("SELECT COUNT(*) AS count FROM tasks")).rows[0].count);
      const missions = Number((await client.query("SELECT COUNT(*) AS count FROM missions")).rows[0].count);
      for (const table of TASK_DATA_TABLES) await client.query(`DELETE FROM ${table}`);
      const generation = randomUUID();
      await client.query("INSERT INTO schema_meta (key, value) VALUES ('task_data_generation', $1) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [generation]);
      await client.query("COMMIT");
      return { tasks, missions, generation };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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
    VALUES ('version', '3')
    ON CONFLICT(key) DO UPDATE SET value = '3'
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
      usage_cache_creation_tokens INTEGER,
      retry_count                 INTEGER NOT NULL DEFAULT 0,
      attempt                     INTEGER NOT NULL DEFAULT 0
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
    CREATE TABLE IF NOT EXISTS agent_registrations (
      employee_id  TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      machine_id   TEXT,
      hostname     TEXT,
      labels_json  TEXT NOT NULL DEFAULT '[]',
      token_hash   TEXT,
      status       TEXT NOT NULL DEFAULT 'pending',
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      approved_at  TEXT,
      last_seen_at TEXT
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
  await db.run(`
    CREATE TABLE IF NOT EXISTS missions (
      id                TEXT PRIMARY KEY,
      objective         TEXT NOT NULL,
      workspace         TEXT,
      status            TEXT NOT NULL,
      approval_policy   TEXT NOT NULL DEFAULT 'ask_on_risky_change',
      max_iterations    INTEGER NOT NULL DEFAULT 6,
      max_tasks         INTEGER NOT NULL DEFAULT 20,
      current_iteration INTEGER NOT NULL DEFAULT 0,
      timeout_sec       INTEGER,
      result            TEXT,
      error             TEXT,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL,
      completed_at      TEXT
    )
  `);
  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_missions_status ON missions(status)
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS mission_events (
      id           TEXT PRIMARY KEY,
      mission_id   TEXT NOT NULL,
      type         TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at   TEXT NOT NULL
    )
  `);
  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_mission_events_mission ON mission_events(mission_id, created_at)
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS mission_subtasks (
      mission_id TEXT NOT NULL,
      task_id    TEXT NOT NULL,
      iteration  INTEGER NOT NULL,
      role       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (mission_id, task_id)
    )
  `);
  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_mission_subtasks_task ON mission_subtasks(task_id)
  `);
  await db.run(`
    CREATE TABLE IF NOT EXISTS mission_approvals (
      id          TEXT PRIMARY KEY,
      mission_id  TEXT NOT NULL,
      status      TEXT NOT NULL,
      question    TEXT NOT NULL,
      options_json TEXT NOT NULL,
      response    TEXT,
      created_at  TEXT NOT NULL,
      resolved_at TEXT
    )
  `);
  await db.run(`
    CREATE INDEX IF NOT EXISTS idx_mission_approvals_mission ON mission_approvals(mission_id, status)
  `);

  // Migration: add retry_count column
  try {
    await db.run("ALTER TABLE tasks ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err ?? "");
    if (!msg.includes("duplicate column") && !msg.includes("already exists")) {
      console.warn("Migration retry_count failed:", msg);
    }
  }
  try {
    await db.run("ALTER TABLE tasks ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err ?? "");
    if (!msg.includes("duplicate column") && !msg.includes("already exists")) {
      console.warn("Migration attempt failed:", msg);
    }
  }
}

// ---------------------------------------------------------------------------
// Hydrate state from database
// ---------------------------------------------------------------------------

export async function hydrateState(db: Database, state: StateStore, defaultTimeoutSec: number, maxLogChunksPerTask = 400, maxHydratedTasks = 200) {
  const employeeRows = await db.all<{ payload_json: string }>("SELECT payload_json FROM employees");
  for (const row of employeeRows) {
    const employee = JSON.parse(row.payload_json) as EmployeeSnapshot;
    employee.status = "offline";
    employee.consecutiveQueueFailures = employee.consecutiveQueueFailures ?? 0;
    employee.weight = employee.weight ?? 1;
    state.employees.set(employee.id, employee);
    if (employee.consecutiveQueueFailures > 0) {
      state.consecutiveQueueFailures.set(employee.id, employee.consecutiveQueueFailures);
    }
    if (employee.queuePaused) {
      state.queuePausedSet.add(employee.id);
    }
  }

  // Load all non-terminal (active) tasks
  const activeRows = await db.all<DbTaskRow>(
    `SELECT * FROM tasks
     WHERE status NOT IN ('completed','failed','cancelled','timeout')
     ORDER BY
       CASE WHEN target_mode = 'queue' THEN priority ELSE 0 END DESC,
       created_at ASC`,
  );

  // Load recent N terminal tasks
  const terminalRows = await db.all<DbTaskRow>(
    `SELECT * FROM tasks
     WHERE status IN ('completed','failed','cancelled','timeout')
     ORDER BY created_at DESC
     LIMIT $1`,
    [maxHydratedTasks],
  );

  const hydratedIds = new Set<string>();
  const allTaskRows = [...activeRows, ...terminalRows];
  for (const row of allTaskRows) {
    const task = dbRowToTask(row, defaultTimeoutSec);
    state.tasks.set(task.id, task);
    hydratedIds.add(task.id);
    if (task.status === "queued") {
      if (task.targetMode === "queue" || !task.employeeId) {
        state.sharedTaskQueue.push(task.id);
      } else {
        const queue = state.mainTaskQueues.get(task.employeeId!) ?? [];
        queue.push(task.id);
        state.mainTaskQueues.set(task.employeeId!, queue);
      }
    } else if (task.employeeId && !TERMINAL_STATUSES.has(task.status)) {
      task.status = "queued";
      await persistTask(db, task);
      if (task.targetMode === "queue" || !state.employees.has(task.employeeId)) {
        state.sharedTaskQueue.push(task.id);
      } else {
        const queue = state.mainTaskQueues.get(task.employeeId) ?? [];
        queue.push(task.id);
        state.mainTaskQueues.set(task.employeeId, queue);
      }
    }
  }

  for (const employee of state.employees.values()) {
    let changed = false;
    const mainTask = employee.mainTaskId ? state.tasks.get(employee.mainTaskId) : null;
    if (employee.mainTaskId && (!mainTask || TERMINAL_STATUSES.has(mainTask.status) || mainTask.status === "queued")) {
      employee.mainTaskId = null;
      employee.mainTaskPrompt = null;
      changed = true;
    }

    const queueTask = employee.queueTaskId ? state.tasks.get(employee.queueTaskId) : null;
    if (employee.queueTaskId && (!queueTask || TERMINAL_STATUSES.has(queueTask.status) || queueTask.status === "queued")) {
      employee.queueTaskId = null;
      employee.queueTaskPrompt = null;
      changed = true;
    }

    if (changed) {
      await persistEmployee(db, employee);
    }
  }

  // Only load logs for hydrated tasks
  if (hydratedIds.size > 0) {
    const idList = [...hydratedIds];
    const placeholders = idList.map((_, i) => `$${i + 1}`).join(", ");
    const logRows = await db.all<{ payload_json: string }>(
      `SELECT payload_json FROM (
         SELECT task_id, seq, payload_json,
                ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY seq DESC) AS rn
         FROM task_logs
         WHERE task_id IN (${placeholders})
       ) ranked
       WHERE rn <= $${idList.length + 1}
       ORDER BY task_id ASC, seq ASC`,
      [...idList, maxLogChunksPerTask],
    );
    for (const row of logRows) {
      const chunk = JSON.parse(row.payload_json) as TaskOutputChunk;
      const history = state.taskLogs.get(chunk.taskId) ?? [];
      history.push(chunk);
      state.taskLogs.set(chunk.taskId, history);
    }
  }

  const webhookRows = await db.all<{ task_id: string; webhook_url: string }>("SELECT task_id, webhook_url FROM task_webhooks");
  for (const row of webhookRows) {
    state.taskWebhooks.set(row.task_id, row.webhook_url);
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

export async function deleteEmployee(db: Database, employeeId: string) {
  await db.run("DELETE FROM employees WHERE id = $1", [employeeId]);
}

const TASK_COLUMNS = [
  "id", "leader_command_id", "employee_id", "session_id", "target_mode",
  "prompt", "workspace", "status", "timeout_sec", "cli_config", "priority", "required_labels",
  "retry_count", "attempt",
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


export async function persistTaskLog(db: Database, chunk: TaskOutputChunk) {
  await db.run(
    `INSERT INTO task_logs (task_id, seq, payload_json)
     VALUES ($1, $2, $3)
     ON CONFLICT(task_id, seq) DO UPDATE SET payload_json = excluded.payload_json`,
    [chunk.taskId, chunk.seq, JSON.stringify(chunk)],
  );
}

export async function deleteTaskLogsThroughSeq(db: Database, taskId: string, seq: number) {
  await db.run("DELETE FROM task_logs WHERE task_id = $1 AND seq <= $2", [taskId, seq]);
}

// ---------------------------------------------------------------------------
// Agent registration helpers
// ---------------------------------------------------------------------------

export type DbAgentRegistrationRow = {
  employee_id: string;
  name: string;
  machine_id: string | null;
  hostname: string | null;
  labels_json: string;
  token_hash: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
  last_seen_at: string | null;
};

function dbRowToAgentRegistration(row: DbAgentRegistrationRow): AgentRegistrationRecord & { tokenHash: string | null } {
  return {
    employeeId: row.employee_id,
    name: row.name,
    machineId: row.machine_id,
    hostname: row.hostname,
    labels: JSON.parse(row.labels_json || "[]") as string[],
    tokenHash: row.token_hash,
    status: row.status as AgentRegistrationStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    approvedAt: row.approved_at,
    lastSeenAt: row.last_seen_at,
  };
}

export type AgentRegistrationUpsert = {
  employeeId: string;
  name: string;
  machineId?: string | null;
  hostname?: string | null;
  labels?: string[];
  tokenHash?: string | null;
  status: AgentRegistrationStatus;
  approvedAt?: string | null;
  lastSeenAt?: string | null;
};

export async function upsertAgentRegistration(db: Database, registration: AgentRegistrationUpsert) {
  const now = new Date().toISOString();
  const existing = await getAgentRegistration(db, registration.employeeId);
  await db.run(
    `INSERT INTO agent_registrations
       (employee_id, name, machine_id, hostname, labels_json, token_hash, status, created_at, updated_at, approved_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT(employee_id) DO UPDATE SET
       name = excluded.name,
       machine_id = excluded.machine_id,
       hostname = excluded.hostname,
       labels_json = excluded.labels_json,
       token_hash = COALESCE(excluded.token_hash, agent_registrations.token_hash),
       status = excluded.status,
       updated_at = excluded.updated_at,
       approved_at = excluded.approved_at,
       last_seen_at = excluded.last_seen_at`,
    [
      registration.employeeId,
      registration.name,
      registration.machineId ?? existing?.machineId ?? null,
      registration.hostname ?? existing?.hostname ?? null,
      JSON.stringify(registration.labels ?? existing?.labels ?? []),
      registration.tokenHash ?? null,
      registration.status,
      existing?.createdAt ?? now,
      now,
      registration.approvedAt ?? existing?.approvedAt ?? null,
      registration.lastSeenAt ?? existing?.lastSeenAt ?? null,
    ],
  );
}

export async function getAgentRegistration(db: Database, employeeId: string) {
  const row = await db.get<DbAgentRegistrationRow>("SELECT * FROM agent_registrations WHERE employee_id = $1", [employeeId]);
  return row ? dbRowToAgentRegistration(row) : undefined;
}

export async function listAgentRegistrations(db: Database): Promise<Array<AgentRegistrationRecord & { tokenHash: string | null }>> {
  const rows = await db.all<DbAgentRegistrationRow>("SELECT * FROM agent_registrations ORDER BY status ASC, updated_at DESC");
  return rows.map(dbRowToAgentRegistration);
}

export async function deleteAgentRegistration(db: Database, employeeId: string): Promise<boolean> {
  const row = await getAgentRegistration(db, employeeId);
  if (!row) return false;
  await db.run("DELETE FROM agent_registrations WHERE employee_id = $1", [employeeId]);
  return true;
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

export async function getTaskLogsByTaskId(db: Database, taskId: string): Promise<TaskOutputChunk[]> {
  const rows = await db.all<{ payload_json: string }>(
    "SELECT payload_json FROM task_logs WHERE task_id = $1 ORDER BY seq ASC",
    [taskId],
  );
  return rows.map((row) => JSON.parse(row.payload_json) as TaskOutputChunk);
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

const UPDATABLE_TASK_FIELDS = new Set([
  "status", "timeoutSec", "cliConfig", "priority", "requiredLabels",
  "prompt", "workspace", "employeeId", "sessionId",
  "exitCode", "summary", "error", "durationMs", "durationApiMs",
  "numTurns", "totalCostUsd", "usageInputTokens", "usageOutputTokens",
  "usageCacheReadTokens", "usageCacheCreationTokens",
]);

export async function updateTaskFields(db: Database, taskId: string, fields: Record<string, unknown>): Promise<DbTaskRow | undefined> {
  const entries = Object.entries(fields).filter(([key]) => UPDATABLE_TASK_FIELDS.has(key));
  if (entries.length === 0) return getTaskById(db, taskId);

  const setClauses = entries.map(([key], i) => `${toSnakeCase(key)} = $${i + 2}`).join(", ");
  const values = entries.map(([key, val]) => {
    if ((key === "cliConfig" || key === "requiredLabels") && val != null) {
      return JSON.stringify(val);
    }
    return val;
  });
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
  retry_count: number;
  attempt: number;
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
    retryCount: row.retry_count ?? 0,
    attempt: row.attempt ?? 0,
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
    task.retryCount,
    task.attempt,
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
// Mission CRUD
// ---------------------------------------------------------------------------

export type MissionCreateInput = {
  id: string;
  objective: string;
  workspace: string | null;
  approvalPolicy: MissionApprovalPolicy;
  maxIterations: number;
  maxTasks: number;
  timeoutSec: number | null;
  createdAt: string;
};

type DbMissionRow = {
  id: string;
  objective: string;
  workspace: string | null;
  status: string;
  approval_policy: string;
  max_iterations: number;
  max_tasks: number;
  current_iteration: number;
  timeout_sec: number | null;
  result: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type DbMissionEventRow = {
  id: string;
  mission_id: string;
  type: string;
  payload_json: string;
  created_at: string;
};

type DbMissionSubtaskRow = {
  mission_id: string;
  task_id: string;
  iteration: number;
  role: string;
  created_at: string;
};

type DbMissionApprovalRow = {
  id: string;
  mission_id: string;
  status: string;
  question: string;
  options_json: string;
  response: string | null;
  created_at: string;
  resolved_at: string | null;
};

const MISSION_COLUMNS = [
  "id", "objective", "workspace", "status", "approval_policy", "max_iterations",
  "max_tasks", "current_iteration", "timeout_sec", "result", "error",
  "created_at", "updated_at", "completed_at",
] as const;

const MISSION_PLACEHOLDERS = MISSION_COLUMNS.map((_, i) => `$${i + 1}`).join(", ");
const MISSION_UPDATE_SET = MISSION_COLUMNS.slice(1).map((col) => `${col} = excluded.${col}`).join(", ");

function dbRowToMission(row: DbMissionRow): MissionRecord {
  return {
    id: row.id,
    objective: row.objective,
    workspace: row.workspace,
    status: row.status as MissionStatus,
    approvalPolicy: row.approval_policy as MissionApprovalPolicy,
    maxIterations: row.max_iterations,
    maxTasks: row.max_tasks,
    currentIteration: row.current_iteration,
    timeoutSec: row.timeout_sec,
    result: row.result,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function missionToDbValues(mission: MissionRecord): unknown[] {
  return [
    mission.id,
    mission.objective,
    mission.workspace,
    mission.status,
    mission.approvalPolicy,
    mission.maxIterations,
    mission.maxTasks,
    mission.currentIteration,
    mission.timeoutSec,
    mission.result,
    mission.error,
    mission.createdAt,
    mission.updatedAt,
    mission.completedAt,
  ];
}

export async function createMission(db: Database, input: MissionCreateInput): Promise<MissionRecord> {
  const mission: MissionRecord = {
    id: input.id,
    objective: input.objective,
    workspace: input.workspace,
    status: "created",
    approvalPolicy: input.approvalPolicy,
    maxIterations: input.maxIterations,
    maxTasks: input.maxTasks,
    currentIteration: 0,
    timeoutSec: input.timeoutSec,
    result: null,
    error: null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    completedAt: null,
  };
  await persistMission(db, mission);
  return mission;
}

export async function persistMission(db: Database, mission: MissionRecord): Promise<void> {
  await db.run(
    `INSERT INTO missions (${MISSION_COLUMNS.join(", ")})
     VALUES (${MISSION_PLACEHOLDERS})
     ON CONFLICT(id) DO UPDATE SET ${MISSION_UPDATE_SET}`,
    missionToDbValues(mission),
  );
}

export async function getMissionById(db: Database, missionId: string): Promise<MissionRecord | undefined> {
  const row = await db.get<DbMissionRow>("SELECT * FROM missions WHERE id = $1", [missionId]);
  return row ? dbRowToMission(row) : undefined;
}

export async function listMissions(db: Database, limit = 50): Promise<MissionRecord[]> {
  const rows = await db.all<DbMissionRow>("SELECT * FROM missions ORDER BY created_at DESC LIMIT $1", [limit]);
  return rows.map(dbRowToMission);
}

export async function listActiveMissions(db: Database): Promise<MissionRecord[]> {
  const rows = await db.all<DbMissionRow>(
    `SELECT * FROM missions
     WHERE status NOT IN ('completed', 'failed', 'cancelled', 'waiting_human')
     ORDER BY created_at ASC`,
  );
  return rows.map(dbRowToMission);
}

export async function updateMissionFields(db: Database, missionId: string, fields: Partial<MissionRecord>): Promise<MissionRecord | undefined> {
  const existing = await getMissionById(db, missionId);
  if (!existing) return undefined;
  const updated: MissionRecord = { ...existing, ...fields, updatedAt: fields.updatedAt ?? new Date().toISOString() };
  await persistMission(db, updated);
  return updated;
}

function dbRowToMissionEvent(row: DbMissionEventRow): MissionEventRecord {
  return {
    id: row.id,
    missionId: row.mission_id,
    type: row.type,
    payload: JSON.parse(row.payload_json || "{}") as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

export async function appendMissionEvent(db: Database, event: MissionEventRecord): Promise<void> {
  await db.run(
    `INSERT INTO mission_events (id, mission_id, type, payload_json, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [event.id, event.missionId, event.type, JSON.stringify(event.payload), event.createdAt],
  );
}

export async function listMissionEvents(db: Database, missionId: string): Promise<MissionEventRecord[]> {
  const rows = await db.all<DbMissionEventRow>(
    "SELECT * FROM mission_events WHERE mission_id = $1 ORDER BY created_at ASC",
    [missionId],
  );
  return rows.map(dbRowToMissionEvent);
}

function dbRowToMissionSubtask(row: DbMissionSubtaskRow): MissionSubtaskRecord {
  return {
    missionId: row.mission_id,
    taskId: row.task_id,
    iteration: row.iteration,
    role: row.role,
    createdAt: row.created_at,
  };
}

export async function addMissionSubtask(db: Database, subtask: MissionSubtaskRecord): Promise<void> {
  await db.run(
    `INSERT INTO mission_subtasks (mission_id, task_id, iteration, role, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT(mission_id, task_id) DO UPDATE SET
       iteration = excluded.iteration,
       role = excluded.role`,
    [subtask.missionId, subtask.taskId, subtask.iteration, subtask.role, subtask.createdAt],
  );
}

export async function listMissionSubtasks(db: Database, missionId: string): Promise<MissionSubtaskRecord[]> {
  const rows = await db.all<DbMissionSubtaskRow>(
    "SELECT * FROM mission_subtasks WHERE mission_id = $1 ORDER BY iteration ASC, created_at ASC",
    [missionId],
  );
  return rows.map(dbRowToMissionSubtask);
}

export async function countMissionSubtasks(db: Database, missionId: string): Promise<number> {
  const row = await db.get<{ count: number }>("SELECT COUNT(*) AS count FROM mission_subtasks WHERE mission_id = $1", [missionId]);
  return Number(row?.count ?? 0);
}

function dbRowToMissionApproval(row: DbMissionApprovalRow): MissionApprovalRecord {
  return {
    id: row.id,
    missionId: row.mission_id,
    status: row.status as MissionApprovalStatus,
    question: row.question,
    options: JSON.parse(row.options_json || "[]") as string[],
    response: row.response,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export async function createMissionApproval(db: Database, approval: MissionApprovalRecord): Promise<void> {
  await db.run(
    `INSERT INTO mission_approvals (id, mission_id, status, question, options_json, response, created_at, resolved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      approval.id,
      approval.missionId,
      approval.status,
      approval.question,
      JSON.stringify(approval.options),
      approval.response,
      approval.createdAt,
      approval.resolvedAt,
    ],
  );
}

export async function listMissionApprovals(db: Database, missionId: string): Promise<MissionApprovalRecord[]> {
  const rows = await db.all<DbMissionApprovalRow>(
    "SELECT * FROM mission_approvals WHERE mission_id = $1 ORDER BY created_at ASC",
    [missionId],
  );
  return rows.map(dbRowToMissionApproval);
}

export async function getMissionApprovalById(db: Database, approvalId: string): Promise<MissionApprovalRecord | undefined> {
  const row = await db.get<DbMissionApprovalRow>("SELECT * FROM mission_approvals WHERE id = $1", [approvalId]);
  return row ? dbRowToMissionApproval(row) : undefined;
}

export async function resolveMissionApproval(db: Database, approvalId: string, status: MissionApprovalStatus, response: string | null, resolvedAt: string): Promise<MissionApprovalRecord | undefined> {
  await db.run(
    "UPDATE mission_approvals SET status = $1, response = $2, resolved_at = $3 WHERE id = $4",
    [status, response, resolvedAt, approvalId],
  );
  return getMissionApprovalById(db, approvalId);
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
