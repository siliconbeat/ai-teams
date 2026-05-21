# Queue Dispatch Paused Agent Fix

## Summary

Fix three issues where agents with consecutive queue failures are silently excluded from the queue with no UI indicator and no automatic recovery.

## Problem

When an agent fails 5 consecutive queue tasks (`MAX_CONSECUTIVE_QUEUE_FAILURES` in `dispatch.ts:201`), it is permanently excluded from the queue candidate pool (`dispatch.ts:382`). The automatic recovery path (reset on success, `dispatch.ts:867`) is unreachable because the agent can never receive another queue task. The web UI shows these agents as normal "在线" (online) with no visual distinction. The only recovery path is a manual API call that has no UI button.

## Design

### 1. Web: Show "队列暂停" status in EmployeeCard

**File:** `apps/web/src/App.tsx`

Modify `getAgentPresence()` (line 233) to check `consecutiveQueueFailures >= 5` before returning "在线":

```tsx
function getAgentPresence(employee: EmployeeSnapshot, activeTask?: TaskRecord) {
  if (employee.status === "offline") {
    return { label: "离线", className: "offline" };
  }
  if (employee.consecutiveQueueFailures >= 5) {
    return { label: "队列暂停", className: "paused" };
  }
  // ... existing logic unchanged
}
```

Add failure count to EmployeeCard metadata (line 347-351):

```tsx
{employee.consecutiveQueueFailures >= 5 && (
  <span className="meta-warning">连续失败: {employee.consecutiveQueueFailures} 次</span>
)}
```

### 2. Web: Add "恢复队列" button in EmployeeCard menu

**File:** `apps/web/src/App.tsx`

Add `onResumeQueue` prop to EmployeeCard. Show "恢复队列" menu item when `consecutiveQueueFailures >= 5`:

```tsx
{employee.consecutiveQueueFailures >= 5 && (
  <button className="card-menu-item" onClick={() => { setMenuOpen(false); onResumeQueue(employee.id); }}>
    恢复队列
  </button>
)}
```

Add `resumeQueue` callback in App component (same pattern as `resetSession`):

```tsx
const resumeQueue = useCallback((employeeId: string) => {
  fetch(`/api/agents/${employeeId}/resume-queue`, {
    method: "POST",
    headers: { Authorization: `Bearer ${authToken}` },
  }).then((res) => {
    if (!res.ok) return res.json().then((d) => { alert(d.error || "恢复失败"); });
  }).catch(() => { alert("网络请求失败"); });
}, [authToken]);
```

Pass `onResumeQueue={resumeQueue}` to EmployeeCard in the monitor page grid.

### 3. Server: Auto-recovery via lazy timeout check

**File:** `apps/server/src/dispatch.ts`

Add `failureTimestamps` to state store — a `Map<string, number>` recording when each agent first hit the failure cap.

In `trackQueueFailure()` (line 203): when `next >= MAX_CONSECUTIVE_QUEUE_FAILURES`, record the timestamp:

```ts
if (next >= MAX_CONSECUTIVE_QUEUE_FAILURES) {
  state.failureTimestamps.set(employeeId, Date.now());
  log.warn(..., "Agent paused for queue tasks due to consecutive failures");
}
```

In `pickAvailableEmployeeIdForQueue()` (line 375): before the exclusion check at line 382, add lazy recovery:

```ts
const failureTs = state.failureTimestamps.get(employee.id);
const failures = state.consecutiveQueueFailures.get(employee.id) ?? 0;
if (failures >= MAX_CONSECUTIVE_QUEUE_FAILURES && failureTs && (Date.now() - failureTs) > AUTO_RESUME_MS) {
  // Auto-recover: reset failure count
  state.consecutiveQueueFailures.set(employee.id, 0);
  state.failureTimestamps.delete(employee.id);
  const emp = state.employees.get(employee.id);
  if (emp) {
    emp.consecutiveQueueFailures = 0;
    upsertEmployee(emp);
  }
  // Continue — agent is now eligible
} else if (failures >= MAX_CONSECUTIVE_QUEUE_FAILURES) {
  return false; // Still blocked
}
```

Define `AUTO_RESUME_MS = 10 * 60 * 1000` (10 minutes) at top of file.

In `resumeAgentQueue()` (line 1074): also clear the timestamp:

```ts
state.failureTimestamps.delete(employeeId);
```

### 4. CSS: Paused state styling

**File:** `apps/web/src/App.css`

```css
.agent-presence.paused {
  color: #faad14;
  background: rgba(250, 173, 20, 0.12);
}

.meta-warning {
  color: #faad14;
  font-weight: 600;
}
```

## Files Changed

| File | Change |
|------|--------|
| `apps/web/src/App.tsx` | Update `getAgentPresence`, add `onResumeQueue` prop to EmployeeCard, add `resumeQueue` callback, show failure count |
| `apps/web/src/App.css` | Add `.agent-presence.paused` and `.meta-warning` styles |
| `apps/server/src/dispatch.ts` | Add `failureTimestamps`, lazy timeout check, `AUTO_RESUME_MS`, clear timestamp in `resumeAgentQueue` |
| `apps/server/src/state-store.ts` | Add `failureTimestamps` field to state type |

## What's NOT Changing

- Queue dispatch algorithm (load-based + round-robin)
- `MAX_CONSECUTIVE_QUEUE_FAILURES` threshold (stays at 5)
- REST API surface (endpoint already exists)
- Task lifecycle or WebSocket protocol
- Mobile layout (uses same EmployeeCard)
