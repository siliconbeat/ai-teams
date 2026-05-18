# Schedule Web UI Design

## Context

Server-side schedule CRUD + cron dispatch is fully implemented (see `2026-05-18-scheduled-tasks-design.md`). The Web leader console lacks any UI for managing schedules. This spec covers adding a "定时任务" page to the existing SPA.

## Scope

Pure frontend work. No server or shared package changes required — the REST API (`/api/schedules`) already supports full CRUD + manual trigger.

## UI Design

### Navigation

- Add `"schedules"` to `ActivePage` union
- Add nav button "定时任务" in header nav, between "任务" and "员工" (or at end)

### Schedule List Page

Card/table layout matching existing `.task-log-page` pattern. Each row shows:

| Column | Source field |
|--------|-------------|
| 名称 | `name` |
| Cron | `cronExpr` |
| 目标 | `targetMode` (queue/direct/broadcast) |
| 状态 | `enabled` — toggle switch |
| 上次执行 | `lastRunAt` — formatted relative time |
| 下次执行 | `nextRunAt` — formatted datetime |
| 操作 | 编辑 / 手动触发 / 删除 buttons |

- Top bar: title "定时任务" + "新建" primary button
- Empty state: placeholder message when no schedules exist

### Create/Edit Modal

Modal dialog (matching existing `.modal-overlay` / `.modal` pattern if present, or new overlay pattern consistent with app style). Fields:

| Field | Type | Required | Default |
|-------|------|----------|---------|
| 名称 | text input | yes | — |
| Cron 表达式 | text input | yes | — |
| Prompt | textarea | yes | — |
| 目标模式 | select (queue/direct/broadcast) | yes | queue |
| 目标 Agents | multi-select chips | if targetMode=direct | [] |
| 工作目录 | text input | no | — |
| 超时(秒) | number input | no | — |
| 启用 | checkbox/toggle | no | true |

### Interactions

- **Create**: POST `/api/schedules` → refresh list
- **Edit**: PATCH `/api/schedules/:id` → refresh list
- **Delete**: confirmation dialog → DELETE `/api/schedules/:id` → refresh list
- **Toggle enable/disable**: PATCH with `{ enabled }` → refresh list
- **Manual trigger**: POST `/api/schedules/:id/trigger` → toast/feedback

### Data Fetching

- On page mount (`activePage === "schedules"`): `GET /api/schedules`
- After any mutation: re-fetch the full list
- No WebSocket subscription needed — schedules change infrequently

## File Changes

| File | Change |
|------|--------|
| `apps/web/src/App.tsx` | Add `schedules` page, nav button, state, fetch logic, modal |
| `apps/web/src/App.css` | Add schedule page styles matching existing patterns |

## Verification

1. Navigate to "定时任务" tab — list loads via GET /api/schedules
2. Click "新建" — modal opens, fill form, submit — new schedule appears in list
3. Click edit on a schedule — modal pre-fills, update cron, save — list updates
4. Toggle enable/disable — schedule status changes, cron job stops/starts
5. Click "手动触发" — task created immediately, visible in tasks page
6. Click delete — confirmation, schedule removed from list
7. Test responsive layout at desktop/tablet/mobile breakpoints
