# Scheduled Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add cron-based scheduled task dispatch to the AI Teams server, with DB persistence and REST API management.

**Architecture:** New `schedules` DB table stores cron configs. A `scheduler.ts` module manages in-memory `CronJob` instances. When a cron fires, it calls the existing `dispatchLeaderCommand` to create tasks. REST API provides full CRUD.

**Tech Stack:** `cron` npm package, SQLite/PostgreSQL (existing), Fastify routes (existing pattern)

---

### Task 1: Add `cron` dependency

**Files:**
- Modify: `apps/server/package.json`

- [ ] **Step 1: Install cron**

```bash
cd /Users/junhang/workspace/agent/ai-teams && pnpm --filter @csdwd/ai-teams-server add cron
```

- [ ] **Step 2: Add `cron` to esbuild external list**

In `scripts/build-bundle.js`, add `"cron"` to the server external array:

```js
const external = pkg === "server"
  ? ["fastify", "@fastify/swagger", "@fastify/swagger-ui", "@fastify/websocket", "@fastify/static", "cron", "ws", "pg"]
  : ["ws"];
```

- [ ] **Step 3: Rebuild and verify**

```bash
pnpm build
```

Expected: builds without error.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore: add cron dependency for scheduled tasks"
```

---

### Task 2: Add `schedules` DB table and CRUD helpers

**Files:**
- Modify: `apps/server/src/db.ts`

- [ ] **Step 1: Add `ScheduleRecord` type and `DB_SCHEDULE_COLUMNS`**

After the existing type definitions in `db.ts`, add:

```typescript
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

const SCHEDULE_COLUMNS = [
  "id", "name", "cron_expr", "enabled", "target_mode", "target_agents",
  "prompt", "workspace", "timeout_sec", "priority", "required_labels",
  "last_run_at", "next_run_at", "created_at", "updated_at",
] as const;
```

- [ ] **Step 2: Add `schedules` table creation in `initDb`**

At the end of `initDb`, before the closing brace, add:

```typescript
  await db.run(`
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cron_expr TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      target_mode TEXT NOT NULL DEFAULT 'queue',
      target_agents TEXT NOT NULL DEFAULT '[]',
      prompt TEXT NOT NULL,
      workspace TEXT,
      timeout_sec INTEGER,
      priority INTEGER NOT NULL DEFAULT 0,
      required_labels TEXT DEFAULT '[]',
      last_run_at TEXT,
      next_run_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
```

- [ ] **Step 3: Add row conversion helpers**

Add `dbRowToSchedule` and `scheduleToDbValues` functions:

```typescript
interface DbScheduleRow {
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
}

function dbRowToSchedule(row: DbScheduleRow): ScheduleRecord {
  return {
    id: row.id,
    name: row.name,
    cronExpr: row.cron_expr,
    enabled: row.enabled === 1,
    targetMode: row.target_mode as "queue" | "direct" | "broadcast",
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
```

- [ ] **Step 4: Add CRUD functions**

```typescript
export async function upsertSchedule(db: Database, schedule: ScheduleRecord): Promise<void> {
  const cols = SCHEDULE_COLUMNS.join(", ");
  const placeholders = SCHEDULE_COLUMNS.map((_, i) => `$${i + 1}`).join(", ");
  const updates = SCHEDULE_COLUMNS.slice(1).map((c) => `${c} = excluded.${c}`).join(", ");
  const values = scheduleToDbValues(schedule);
  await db.run(
    `INSERT INTO schedules (${cols}) VALUES (${placeholders}) ON CONFLICT(id) DO UPDATE SET ${updates}`,
    values,
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

export async function deleteSchedule(db: Database, id: string): Promise<boolean> {
  const before = await db.get<{ count: number }>("SELECT COUNT(*) as count FROM schedules WHERE id = $1", [id]);
  if (!before || before.count === 0) return false;
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
```

- [ ] **Step 5: Build and verify**

```bash
pnpm build
```

Expected: builds without error.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: add schedules DB table and CRUD helpers"
```

---

### Task 3: Add schedule schemas

**Files:**
- Modify: `apps/server/src/schemas.ts`

- [ ] **Step 1: Add schedule types and schemas**

At the end of `schemas.ts`, add:

```typescript
// ── Schedules ──────────────────────────────────────────────────────

export type CreateScheduleRequest = {
  name: string;
  cron: string;
  enabled?: boolean;
  targetMode?: "queue" | "direct" | "broadcast";
  targetAgents?: string[];
  prompt: string;
  workspace?: string;
  timeoutSec?: number;
  priority?: number;
  requiredLabels?: string[];
};

export type UpdateScheduleRequest = Partial<CreateScheduleRequest>;

export const createScheduleRequestSchema = {
  type: "object",
  required: ["name", "cron", "prompt"],
  properties: {
    name: { type: "string", minLength: 1 },
    cron: { type: "string", minLength: 9 },
    enabled: { type: "boolean", default: true },
    targetMode: { type: "string", enum: ["queue", "direct", "broadcast"], default: "queue" },
    targetAgents: { type: "array", items: { type: "string" } },
    prompt: { type: "string", minLength: 1 },
    workspace: { type: "string" },
    timeoutSec: { type: "number", minimum: 1 },
    priority: { type: "integer", minimum: 0, maximum: 3, default: 0 },
    requiredLabels: { type: "array", items: { type: "string" } },
  },
} as const;

export const updateScheduleRequestSchema = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
    cron: { type: "string", minLength: 9 },
    enabled: { type: "boolean" },
    targetMode: { type: "string", enum: ["queue", "direct", "broadcast"] },
    targetAgents: { type: "array", items: { type: "string" } },
    prompt: { type: "string", minLength: 1 },
    workspace: { type: "string" },
    timeoutSec: { type: "number", minimum: 1 },
    priority: { type: "integer", minimum: 0, maximum: 3 },
    requiredLabels: { type: "array", items: { type: "string" } },
  },
} as const;

export const scheduleResponseSchema = {
  type: "object",
  required: ["id", "name", "cron", "enabled", "targetMode", "prompt", "createdAt", "updatedAt"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    cron: { type: "string" },
    enabled: { type: "boolean" },
    targetMode: { type: "string", enum: ["queue", "direct", "broadcast"] },
    targetAgents: { type: "array", items: { type: "string" } },
    prompt: { type: "string" },
    workspace: { type: "string" },
    timeoutSec: { type: "number" },
    priority: { type: "integer" },
    requiredLabels: { type: "array", items: { type: "string" } },
    lastRunAt: { type: "string" },
    nextRunAt: { type: "string" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
  },
} as const;

export const scheduleListResponseSchema = {
  type: "object",
  required: ["schedules"],
  properties: {
    schedules: { type: "array", items: scheduleResponseSchema },
  },
} as const;
```

- [ ] **Step 2: Build and verify**

```bash
pnpm build
```

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: add schedule request/response schemas"
```

---

### Task 4: Create scheduler module

**Files:**
- Create: `apps/server/src/scheduler.ts`
- Modify: `apps/server/src/state-store.ts`

- [ ] **Step 1: Add `scheduleJobs` to StateStore**

In `state-store.ts`, add a new field to the `StateStore` interface:

```typescript
import type { CronJob } from "cron";

// Add to StateStore interface:
  scheduleJobs: Map<string, CronJob<null, string>>;
```

In `createInMemoryStateStore()`, add initialization:

```typescript
  scheduleJobs: new Map(),
```

- [ ] **Step 2: Create `scheduler.ts`**

```typescript
import { CronJob } from "cron";
import type { ScheduleRecord } from "./db.js";
import type { DispatchContext } from "./dispatch.js";

function buildDispatchMessage(schedule: ScheduleRecord) {
  const atAgents = schedule.targetMode === "queue"
    ? "queue" as const
    : schedule.targetMode === "broadcast"
    ? "all" as const
    : schedule.targetAgents;
  return {
    type: "command.dispatch" as const,
    atAgents,
    prompt: schedule.prompt,
    workspace: schedule.workspace ?? undefined,
    timeoutSec: schedule.timeoutSec ?? undefined,
  };
}

export function startScheduleJob(
  schedule: ScheduleRecord,
  dispatchCtx: DispatchContext,
  onFire: (schedule: ScheduleRecord) => void,
): CronJob<null, string> {
  return new CronJob(
    schedule.cronExpr,
    () => {
      const { dispatchLeaderCommand } = require("./dispatch.js").createDispatch(dispatchCtx);
      const message = buildDispatchMessage(schedule);
      dispatchLeaderCommand(
        message,
        null,
        undefined,
        schedule.priority,
        schedule.requiredLabels,
      );
      onFire(schedule);
    },
    null,
    true,
    undefined,
    undefined,
    null,
    schedule.id,
  );
}

export function stopScheduleJob(state: { scheduleJobs: Map<string, CronJob<null, string>> }, scheduleId: string) {
  const job = state.scheduleJobs.get(scheduleId);
  if (job) {
    job.stop();
    state.scheduleJobs.delete(scheduleId);
  }
}
```

Note: `startScheduleJob` calls `createDispatch` inside the callback so it always gets the latest closure state.

Actually, simpler approach — pass `dispatchLeaderCommand` directly:

```typescript
import { CronJob } from "cron";
import type { ScheduleRecord } from "./db.js";
import type { StateStore } from "./state-store.js";

type DispatchFn = (
  message: Parameters<typeof import("./dispatch.js").createDispatch>[0] extends never ? never : never
) => never;

// Keep it simple — accept the dispatch function directly
export type ScheduleDispatchFn = (
  message: { type: "command.dispatch"; atAgents: "queue" | "all" | string[]; prompt: string; workspace?: string; timeoutSec?: number },
  webhookUrl?: string | null,
  cliConfig?: unknown,
  priority?: number,
  requiredLabels?: string[] | null,
) => { ok: boolean; code?: string; message?: string; tasks?: unknown[] };

export function startScheduleJob(
  schedule: ScheduleRecord,
  dispatchFn: ScheduleDispatchFn,
  state: Pick<StateStore, "scheduleJobs">,
  onFire: (id: string) => void,
): void {
  const atAgents = schedule.targetMode === "queue"
    ? ("queue" as const)
    : schedule.targetMode === "broadcast"
    ? ("all" as const)
    : schedule.targetAgents;

  const job = new CronJob(
    schedule.cronExpr,
    () => {
      dispatchFn(
        {
          type: "command.dispatch",
          atAgents,
          prompt: schedule.prompt,
          workspace: schedule.workspace ?? undefined,
          timeoutSec: schedule.timeoutSec ?? undefined,
        },
        null,
        undefined,
        schedule.priority,
        schedule.requiredLabels,
      );
      onFire(schedule.id);
    },
    null,
    true,
  );
  state.scheduleJobs.set(schedule.id, job);
}

export function stopScheduleJob(state: Pick<StateStore, "scheduleJobs">, scheduleId: string) {
  const job = state.scheduleJobs.get(scheduleId);
  if (job) {
    job.stop();
    state.scheduleJobs.delete(scheduleId);
  }
}
```

- [ ] **Step 3: Build and verify**

```bash
pnpm build
```

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: add scheduler module and scheduleJobs state"
```

---

### Task 5: Register REST API routes and wire up scheduler

**Files:**
- Modify: `apps/server/src/index.ts`

- [ ] **Step 1: Add imports**

At the top of `index.ts`, add to existing imports:

```typescript
import {
  upsertSchedule, getAllSchedules, getScheduleById, deleteSchedule as deleteScheduleRow,
  updateScheduleFields, type ScheduleRecord,
} from "./db.js";
import { startScheduleJob, stopScheduleJob, type ScheduleDispatchFn } from "./scheduler.js";
import {
  createScheduleRequestSchema, updateScheduleRequestSchema,
  scheduleResponseSchema, scheduleListResponseSchema,
  type CreateScheduleRequest, type UpdateScheduleRequest,
} from "./schemas.js";
```

- [ ] **Step 2: Add schedule helper functions**

After the `dispatchCtx` setup (around line 143), add:

```typescript
  const dispatchFn: ScheduleDispatchFn = (message, webhookUrl, cliConfig, priority, requiredLabels) => {
    return dispatchLeaderCommand(message, webhookUrl, cliConfig, priority, requiredLabels);
  };

  async function loadAndStartSchedules() {
    const schedules = await getAllSchedules(db);
    for (const schedule of schedules) {
      if (schedule.enabled) {
        startScheduleJob(schedule, dispatchFn, state, onScheduleFire);
      }
    }
    app.log.info({ count: schedules.length }, "Schedules loaded");
  }

  async function onScheduleFire(scheduleId: string) {
    const now = new Date().toISOString();
    const job = state.scheduleJobs.get(scheduleId);
    const nextRun = job?.nextDate()?.toISO() ?? null;
    await updateScheduleFields(db, scheduleId, { lastRunAt: now, nextRunAt: nextRun });
  }
```

- [ ] **Step 3: Call `loadAndStartSchedules()` after `hydrateState`**

After the line `await hydrateState(db, state, defaultTimeoutSec, maxLogChunksPerTask);` add:

```typescript
  await loadAndStartSchedules();
```

- [ ] **Step 4: Clean up schedule jobs on close**

In the `close` function, add before `await app.close()`:

```typescript
  for (const job of state.scheduleJobs.values()) {
    job.stop();
  }
```

- [ ] **Step 5: Register REST API routes**

Add these routes after the existing task routes, before the WebSocket handlers:

```typescript
  // ── Schedule Routes ─────────────────────────────────────────────

  app.get(
    "/api/schedules",
    {
      schema: {
        tags: ["schedules"],
        summary: "List all schedules",
        response: { 200: scheduleListResponseSchema, 401: errorResponseSchema },
      },
    },
    async () => {
      const schedules = await getAllSchedules(db);
      return { schedules };
    },
  );

  app.get<{ Params: { scheduleId: string } }>(
    "/api/schedules/:scheduleId",
    {
      schema: {
        tags: ["schedules"],
        summary: "Get a schedule by ID",
        params: { type: "object", required: ["scheduleId"], properties: { scheduleId: { type: "string", minLength: 1 } } },
        response: { 200: scheduleResponseSchema, 404: errorResponseSchema, 401: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const schedule = await getScheduleById(db, request.params.scheduleId);
      if (!schedule) return reply.code(404).send({ error: "Schedule not found." });
      return schedule;
    },
  );

  app.post<{ Body: CreateScheduleRequest }>(
    "/api/schedules",
    {
      schema: {
        tags: ["schedules"],
        summary: "Create a schedule",
        body: createScheduleRequestSchema,
        response: { 201: scheduleResponseSchema, 400: errorResponseSchema, 401: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const id = randomUUID();
      const now = new Date().toISOString();
      const schedule: ScheduleRecord = {
        id,
        name: body.name,
        cronExpr: body.cron,
        enabled: body.enabled ?? true,
        targetMode: body.targetMode ?? "queue",
        targetAgents: body.targetAgents ?? [],
        prompt: body.prompt,
        workspace: body.workspace ?? null,
        timeoutSec: body.timeoutSec ?? null,
        priority: body.priority ?? 0,
        requiredLabels: body.requiredLabels ?? null,
        lastRunAt: null,
        nextRunAt: null,
        createdAt: now,
        updatedAt: now,
      };
      try {
        if (schedule.enabled) {
          startScheduleJob(schedule, dispatchFn, state, onScheduleFire);
          schedule.nextRunAt = state.scheduleJobs.get(id)?.nextDate()?.toISO() ?? null;
        }
        await upsertSchedule(db, schedule);
        return reply.code(201).send(schedule);
      } catch (err) {
        stopScheduleJob(state, id);
        return reply.code(400).send({ error: err instanceof Error ? err.message : "Invalid schedule." });
      }
    },
  );

  app.patch<{ Params: { scheduleId: string }; Body: UpdateScheduleRequest }>(
    "/api/schedules/:scheduleId",
    {
      schema: {
        tags: ["schedules"],
        summary: "Update a schedule",
        params: { type: "object", required: ["scheduleId"], properties: { scheduleId: { type: "string", minLength: 1 } } },
        body: updateScheduleRequestSchema,
        response: { 200: scheduleResponseSchema, 404: errorResponseSchema, 401: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const existing = await getScheduleById(db, request.params.scheduleId);
      if (!existing) return reply.code(404).send({ error: "Schedule not found." });
      const fields: Record<string, unknown> = {};
      if (request.body.name !== undefined) fields.name = request.body.name;
      if (request.body.cron !== undefined) fields.cronExpr = request.body.cron;
      if (request.body.enabled !== undefined) fields.enabled = request.body.enabled;
      if (request.body.targetMode !== undefined) fields.targetMode = request.body.targetMode;
      if (request.body.targetAgents !== undefined) fields.targetAgents = request.body.targetAgents;
      if (request.body.prompt !== undefined) fields.prompt = request.body.prompt;
      if (request.body.workspace !== undefined) fields.workspace = request.body.workspace;
      if (request.body.timeoutSec !== undefined) fields.timeoutSec = request.body.timeoutSec;
      if (request.body.priority !== undefined) fields.priority = request.body.priority;
      if (request.body.requiredLabels !== undefined) fields.requiredLabels = request.body.requiredLabels;
      const updated = await updateScheduleFields(db, request.params.scheduleId, fields);
      if (!updated) return reply.code(404).send({ error: "Schedule not found." });
      stopScheduleJob(state, request.params.scheduleId);
      if (updated.enabled) {
        startScheduleJob(updated, dispatchFn, state, onScheduleFire);
        updated.nextRunAt = state.scheduleJobs.get(request.params.scheduleId)?.nextDate()?.toISO() ?? null;
        await updateScheduleFields(db, request.params.scheduleId, { nextRunAt: updated.nextRunAt });
      }
      return updated;
    },
  );

  app.delete<{ Params: { scheduleId: string } }>(
    "/api/schedules/:scheduleId",
    {
      schema: {
        tags: ["schedules"],
        summary: "Delete a schedule",
        params: { type: "object", required: ["scheduleId"], properties: { scheduleId: { type: "string", minLength: 1 } } },
        response: { 200: { type: "object", required: ["deleted"], properties: { deleted: { type: "boolean" } } }, 404: errorResponseSchema, 401: errorResponseSchema },
      },
    },
    async (request, reply) => {
      stopScheduleJob(state, request.params.scheduleId);
      const deleted = await deleteScheduleRow(db, request.params.scheduleId);
      if (!deleted) return reply.code(404).send({ error: "Schedule not found." });
      return { deleted: true };
    },
  );

  app.post<{ Params: { scheduleId: string } }>(
    "/api/schedules/:scheduleId/trigger",
    {
      schema: {
        tags: ["schedules"],
        summary: "Manually trigger a schedule",
        params: { type: "object", required: ["scheduleId"], properties: { scheduleId: { type: "string", minLength: 1 } } },
        response: { 200: scheduleResponseSchema, 404: errorResponseSchema, 401: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const schedule = await getScheduleById(db, request.params.scheduleId);
      if (!schedule) return reply.code(404).send({ error: "Schedule not found." });
      const atAgents = schedule.targetMode === "queue"
        ? ("queue" as const)
        : schedule.targetMode === "broadcast"
        ? ("all" as const)
        : schedule.targetAgents;
      const result = dispatchLeaderCommand(
        { type: "command.dispatch", atAgents, prompt: schedule.prompt, workspace: schedule.workspace ?? undefined, timeoutSec: schedule.timeoutSec ?? undefined },
        null, undefined, schedule.priority, schedule.requiredLabels,
      );
      if (!result.ok) return reply.code(400).send({ error: result.message });
      await onScheduleFire(request.params.scheduleId);
      const updated = await getScheduleById(db, request.params.scheduleId);
      return updated;
    },
  );
```

- [ ] **Step 6: Build and verify**

```bash
pnpm build
```

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: add schedule REST API routes and wire up scheduler"
```

---

### Task 6: Run tests and fix issues

**Files:**
- Modify: as needed

- [ ] **Step 1: Run existing tests**

```bash
pnpm test
```

Expected: all 60 tests pass. If any fail due to the new DB table or state changes, fix them.

- [ ] **Step 2: Build full dist and verify**

```bash
pnpm build && node apps/server/dist/index.js --help
```

Expected: help text prints including schedule-related startup.

- [ ] **Step 3: Final commit**

```bash
git add -A && git commit -m "feat: complete scheduled tasks feature"
```

---

### Task 7: Update CLI help text

**Files:**
- Modify: `apps/server/src/index.ts` (CLI help section)

- [ ] **Step 1: No new CLI flags needed, but update help description**

In the `--help` output, schedules are managed via REST API, no new CLI flags needed. Skip this task.

---

## Verification

1. Start server: `ai-teams-server --token test --port 3789`
2. Create schedule: `curl -X POST -H "Authorization: Bearer test" -H "Content-Type: application/json" -d '{"name":"test","cron":"* * * * *","prompt":"hello","targetMode":"queue"}' http://localhost:3789/api/schedules`
3. List schedules: `curl -H "Authorization: Bearer test" http://localhost:3789/api/schedules`
4. Wait 1 min, check tasks: `curl -H "Authorization: Bearer test" http://localhost:3789/api/tasks`
5. Disable: `curl -X PATCH -H "Authorization: Bearer test" -H "Content-Type: application/json" -d '{"enabled":false}' http://localhost:3789/api/schedules/<id>`
6. Trigger manually: `curl -X POST -H "Authorization: Bearer test" http://localhost:3789/api/schedules/<id>/trigger`
7. Delete: `curl -X DELETE -H "Authorization: Bearer test" http://localhost:3789/api/schedules/<id>`
8. Restart server, verify enabled schedules auto-restore.
