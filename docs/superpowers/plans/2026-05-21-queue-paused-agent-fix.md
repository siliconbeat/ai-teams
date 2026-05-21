# Queue Paused Agent Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix agents silently excluded from queue dispatch by adding auto-recovery (server), visual indicators, and a resume button (web).

**Architecture:** Server-side lazy timeout check resets failure count after 10 minutes. Web shows "队列暂停" status badge and "恢复队列" button on paused agents.

**Tech Stack:** Fastify server (TypeScript), React web app, shared types package

**Spec:** `docs/superpowers/specs/2026-05-21-queue-paused-agent-design.md`

---

### Task 1: Add `failureTimestamps` to server state

**Files:**
- Modify: `apps/server/src/state-store.ts:6-23` (StateStore interface)
- Modify: `apps/server/src/state-store.ts:25-44` (createInMemoryStateStore factory)

- [ ] **Step 1: Add `failureTimestamps` field to StateStore interface**

In `apps/server/src/state-store.ts`, add after line 22 (`consecutiveQueueFailures`):

```ts
  failureTimestamps: Map<string, number>;
```

- [ ] **Step 2: Initialize `failureTimestamps` in factory**

In `createInMemoryStateStore()`, add after line 42 (`consecutiveQueueFailures: new Map()`):

```ts
    failureTimestamps: new Map(),
```

- [ ] **Step 3: Verify build**

```bash
cd /Users/junhang/workspace/agent/ai-teams && pnpm --filter @csdwd/ai-teams-server build
```

Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/state-store.ts
git commit -m "feat(server): add failureTimestamps to state store"
```

---

### Task 2: Server auto-recovery logic in dispatch.ts

**Files:**
- Modify: `apps/server/src/dispatch.ts:201` (add AUTO_RESUME_MS constant)
- Modify: `apps/server/src/dispatch.ts:203-215` (trackQueueFailure — record timestamp)
- Modify: `apps/server/src/dispatch.ts:375-411` (pickAvailableEmployeeIdForQueue — lazy check)
- Modify: `apps/server/src/dispatch.ts:1074-1089` (resumeAgentQueue — clear timestamp)

- [ ] **Step 1: Add AUTO_RESUME_MS constant**

In `dispatch.ts`, add after line 201 (`const MAX_CONSECUTIVE_QUEUE_FAILURES = 5;`):

```ts
  const AUTO_RESUME_MS = 10 * 60 * 1000; // 10 minutes
```

- [ ] **Step 2: Record timestamp in trackQueueFailure**

In `trackQueueFailure()` (line 212-214), after the `if (next >= MAX_CONSECUTIVE_QUEUE_FAILURES)` check, add timestamp recording. Replace lines 212-214:

```ts
    if (next >= MAX_CONSECUTIVE_QUEUE_FAILURES) {
      state.failureTimestamps.set(employeeId, Date.now());
      log.warn({ employeeId, consecutiveFailures: next }, "Agent paused for queue tasks due to consecutive failures");
    }
```

(The `log.warn` line stays the same, only the `state.failureTimestamps.set` line is added before it.)

- [ ] **Step 3: Add lazy auto-recovery in pickAvailableEmployeeIdForQueue**

In `pickAvailableEmployeeIdForQueue()` (line 382-383), replace the simple exclusion check with lazy recovery. Replace lines 382-383:

```ts
        const failures = state.consecutiveQueueFailures.get(employee.id) ?? 0;
        if (failures >= MAX_CONSECUTIVE_QUEUE_FAILURES) {
          const failureTs = state.failureTimestamps.get(employee.id);
          if (failureTs && (Date.now() - failureTs) > AUTO_RESUME_MS) {
            state.consecutiveQueueFailures.set(employee.id, 0);
            state.failureTimestamps.delete(employee.id);
            const emp = state.employees.get(employee.id);
            if (emp) {
              emp.consecutiveQueueFailures = 0;
              upsertEmployee(emp);
            }
            log.info({ employeeId: employee.id }, "Agent auto-resumed after timeout, failure count reset");
          } else {
            return false;
          }
        }
```

This replaces the single `if ((state.consecutiveQueueFailures.get(employee.id) ?? 0) >= MAX_CONSECUTIVE_QUEUE_FAILURES) { return false; }` block. The new code checks if the agent has been paused for more than 10 minutes and auto-recovers; otherwise excludes it.

- [ ] **Step 4: Clear timestamp in resumeAgentQueue**

In `resumeAgentQueue()` (line 1079), add after `state.consecutiveQueueFailures.set(employeeId, 0)`:

```ts
    state.failureTimestamps.delete(employeeId);
```

- [ ] **Step 5: Verify build and run server tests**

```bash
cd /Users/junhang/workspace/agent/ai-teams && pnpm --filter @csdwd/ai-teams-server build && pnpm vitest run apps/server/src/index.test.ts
```

Expected: Build succeeds, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/dispatch.ts
git commit -m "feat(server): auto-resume agents after 10min queue failure timeout"
```

---

### Task 3: Web — Show "队列暂停" status in EmployeeCard

**Files:**
- Modify: `apps/web/src/App.tsx:233-250` (getAgentPresence function)
- Modify: `apps/web/src/App.tsx:347-351` (EmployeeCard metadata section)
- Modify: `apps/web/src/App.css` (add paused style)

- [ ] **Step 1: Update getAgentPresence to check consecutiveQueueFailures**

In `apps/web/src/App.tsx`, in the `getAgentPresence` function (line 233-250), add the paused check after the offline check. The function should become:

```tsx
function getAgentPresence(employee: EmployeeSnapshot, activeTask?: TaskRecord) {
  if (employee.status === "offline") {
    return { label: "离线", className: "offline" };
  }
  if (employee.consecutiveQueueFailures >= 5) {
    return { label: "队列暂停", className: "paused" };
  }
  if (!activeTask) {
    return { label: "在线", className: "online" };
  }
  if (activeTask.status === "dispatched") {
    return { label: "派发中", className: "dispatched" };
  }
  if (activeTask.status === "accepted") {
    return { label: "已接单", className: "accepted" };
  }
  if (activeTask.status === "running") {
    return { label: "任务中", className: "busy" };
  }
  return { label: "在线", className: "online" };
}
```

- [ ] **Step 2: Add failure count to EmployeeCard metadata**

In the EmployeeCard component, after the metadata spans (line 350, after the labels span), add:

```tsx
        {employee.consecutiveQueueFailures >= 5 && (
          <span className="meta-warning">连续失败: {employee.consecutiveQueueFailures} 次</span>
        )}
```

- [ ] **Step 3: Add CSS for paused state**

In `apps/web/src/App.css`, add after the existing `.agent-presence` styles (find `.agent-presence.online` and add after it):

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

- [ ] **Step 4: Verify build**

```bash
cd /Users/junhang/workspace/agent/ai-teams && pnpm --filter @ai-teams/web build
```

Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/App.tsx apps/web/src/App.css
git commit -m "feat(web): show queue-paused status and failure count on agent cards"
```

---

### Task 4: Web — Add "恢复队列" button in EmployeeCard

**Files:**
- Modify: `apps/web/src/App.tsx` — EmployeeCard props (line 288-304), menu dropdown (line 336-345), resumeQueue callback, EmployeeCard usage in monitor page

- [ ] **Step 1: Add `onResumeQueue` prop to EmployeeCard**

In the EmployeeCard component definition (line 288-304), add `onResumeQueue` to props:

```tsx
const EmployeeCard = memo(function EmployeeCard({
  employee,
  mainTask,
  queueTask,
  displayTask,
  terminalText,
  cancelTask,
  onResetSession,
  onResumeQueue,
}: {
  employee: EmployeeSnapshot;
  mainTask: TaskRecord | undefined;
  queueTask: TaskRecord | undefined;
  displayTask: TaskRecord | undefined;
  terminalText: string;
  cancelTask: (taskId: string) => void;
  onResetSession: (employeeId: string) => void;
  onResumeQueue: (employeeId: string) => void;
}) {
```

- [ ] **Step 2: Add "恢复队列" menu item**

In the card-menu-dropdown (line 338-343), add the resume button after the "重置会话" button. The dropdown should become:

```tsx
<div className="card-menu-dropdown">
  <button className="card-menu-item" onClick={() => { setMenuOpen(false); onResetSession(employee.id); }}>
    重置会话
  </button>
  {employee.consecutiveQueueFailures >= 5 && (
    <button className="card-menu-item" onClick={() => { setMenuOpen(false); onResumeQueue(employee.id); }}>
      恢复队列
    </button>
  )}
</div>
```

- [ ] **Step 3: Add `resumeQueue` callback in App component**

Add after the existing `resetSession` callback (find it near line 921-928):

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

- [ ] **Step 4: Pass `onResumeQueue` to EmployeeCard in monitor page**

Find where EmployeeCard is rendered in the monitor page grid. Add `onResumeQueue={resumeQueue}` prop:

```tsx
<EmployeeCard
  key={employee.id}
  employee={employee}
  mainTask={slots?.main}
  queueTask={slots?.queue}
  displayTask={displayTasksByEmployee[employee.id]}
  terminalText={terminalText}
  cancelTask={cancelTask}
  onResetSession={resetSession}
  onResumeQueue={resumeQueue}
/>
```

- [ ] **Step 5: Verify build**

```bash
cd /Users/junhang/workspace/agent/ai-teams && pnpm --filter @ai-teams/web build
```

Expected: Build succeeds.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/App.tsx
git commit -m "feat(web): add resume-queue button to paused agent cards"
```

---

### Task 5: Final verification

**Files:** All changed files

- [ ] **Step 1: Run full typecheck**

```bash
cd /Users/junhang/workspace/agent/ai-teams && pnpm typecheck
```

Expected: No type errors.

- [ ] **Step 2: Run full build**

```bash
cd /Users/junhang/workspace/agent/ai-teams && pnpm build
```

Expected: All packages build successfully.

- [ ] **Step 3: Run all tests**

```bash
cd /Users/junhang/workspace/agent/ai-teams && pnpm test
```

Expected: All tests pass.

- [ ] **Step 4: Final commit if any fixes needed**
