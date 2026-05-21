# Agent Weight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `weight` parameter to agents that controls queue task distribution probability via weighted random selection among equally-loaded agents.

**Architecture:** Agent declares weight via CLI/env, sends it during registration. Server stores weight on EmployeeSnapshot and uses it in `pickAvailableEmployeeIdForQueue` for weighted random dispatch. Web shows weight on EmployeeCard.

**Tech Stack:** TypeScript monorepo (shared/agent/server/web), WebSocket protocol, React web app

**Spec:** `docs/superpowers/specs/2026-05-21-agent-weight-design.md`

---

### Task 1: Add `weight` to shared types

**Files:**
- Modify: `packages/shared/src/index.ts:29-43` (EmployeeSnapshot interface)
- Modify: `packages/shared/src/index.ts:109-121` (agent.register message type)

- [ ] **Step 1: Add `weight` to EmployeeSnapshot**

In `packages/shared/src/index.ts`, add after `version?: string;` (line 42):

```ts
  weight: number;
```

- [ ] **Step 2: Add `weight` to agent.register message type**

In the same file, add after `lastOutputSeq?: number;` (line 120):

```ts
      weight?: number;
```

- [ ] **Step 3: Verify build**

```bash
cd /Users/junhang/workspace/agent/ai-teams && pnpm --filter @ai-teams/shared build
```

Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/index.ts
git commit -m "feat(shared): add weight field to EmployeeSnapshot and agent.register"
```

---

### Task 2: Agent CLI — `--weight` parameter

**Files:**
- Modify: `apps/agent/src/config.ts:6-55` (add EMPLOYEE_WEIGHT, update reinitializeConfig)
- Modify: `apps/agent/src/index.ts:287-311` (help text) and `apps/agent/src/index.ts:336-349` (applyCliArgsToEnv)
- Modify: `apps/agent/src/connection.ts:122-139` (registerAgent — send weight)

- [ ] **Step 1: Add EMPLOYEE_WEIGHT to config.ts**

In `apps/agent/src/config.ts`, add after `EMPLOYEE_LABELS` (line 13):

```ts
export let EMPLOYEE_WEIGHT = Math.max(1, Number(process.env.EMPLOYEE_WEIGHT) || 1);
```

Also add inside `reinitializeConfig()` after the `EMPLOYEE_LABELS` line (line 40):

```ts
  EMPLOYEE_WEIGHT = Math.max(1, Number(process.env.EMPLOYEE_WEIGHT) || 1);
```

- [ ] **Step 2: Add `--weight` to CLI args and help text**

In `apps/agent/src/index.ts`, update the help text (around line 304, after `--runner <mode>`):

```
  --weight <number>     队列任务分配权重 (默认 1)
```

In the `applyCliArgsToEnv()` function (around line 348), add after the `cliRunner` block:

```ts
    const cliWeight = getArgValue("--weight");
    if (cliWeight) process.env.EMPLOYEE_WEIGHT = cliWeight;
```

- [ ] **Step 3: Include weight in registerAgent**

In `apps/agent/src/connection.ts`, add the import for EMPLOYEE_WEIGHT. Find the import from `./config.js` (line 13-21) and add `EMPLOYEE_WEIGHT` to the import list.

Then in `registerAgent()` (line 127-139), add after `lastOutputSeq`:

```ts
    weight: EMPLOYEE_WEIGHT,
```

- [ ] **Step 4: Verify build**

```bash
cd /Users/junhang/workspace/agent/ai-teams && pnpm build
```

Expected: All packages build successfully.

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/config.ts apps/agent/src/index.ts apps/agent/src/connection.ts
git commit -m "feat(agent): add --weight CLI parameter for queue dispatch weight"
```

---

### Task 3: Server — store weight and weighted random dispatch

**Files:**
- Modify: `apps/server/src/dispatch.ts:740-754` (handleRegister — store weight in upsertEmployee)
- Modify: `apps/server/src/dispatch.ts:397-426` (pickAvailableEmployeeIdForQueue — weighted random)

- [ ] **Step 1: Store weight in handleRegister**

In `apps/server/src/dispatch.ts`, find the `upsertEmployee({...})` call in `handleRegister()` (around line 740-754). Add after `version: message.version,`:

```ts
      weight: message.weight ?? 1,
```

- [ ] **Step 2: Replace round-robin with weighted random in pickAvailableEmployeeIdForQueue**

Find the round-robin selection code at the end of `pickAvailableEmployeeIdForQueue()` (the block starting with `const lightest = ...` and ending with `void persistSharedQueueCursor`). Replace it with:

```ts
    const lightest = available.filter((e) => (e.mainTaskId ? 1 : 0) + (e.queueTaskId ? 1 : 0) === minLoad);

    if (lightest.length === 1) {
      return lightest[0].id;
    }

    const totalWeight = lightest.reduce((sum, e) => sum + (e.weight ?? 1), 0);
    let random = Math.random() * totalWeight;
    for (const employee of lightest) {
      random -= (employee.weight ?? 1);
      if (random < 0) {
        return employee.id;
      }
    }
    return lightest[lightest.length - 1].id;
```

This replaces the `sharedQueueCursor` round-robin with a weighted random selection among lightest-loaded agents. The `sharedQueueCursor` and `persistSharedQueueCursor` calls are no longer needed for queue dispatch.

- [ ] **Step 3: Verify build and run server tests**

```bash
cd /Users/junhang/workspace/agent/ai-teams && pnpm --filter @csdwd/ai-teams-server build && pnpm vitest run apps/server/src/index.test.ts
```

Expected: Build succeeds, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/dispatch.ts
git commit -m "feat(server): weighted random queue dispatch based on agent weight"
```

---

### Task 4: Web — show weight in EmployeeCard

**Files:**
- Modify: `apps/web/src/App.tsx` (EmployeeCard metadata section)

- [ ] **Step 1: Add weight display to EmployeeCard**

Find the EmployeeCard component's metadata section where employee info is displayed. Look for the span showing labels or other meta info. Add after it:

```tsx
        {employee.weight > 1 && (
          <span>权重: {employee.weight}</span>
        )}
```

The exact location is the metadata row inside EmployeeCard, after the existing status/labels spans.

- [ ] **Step 2: Verify build**

```bash
cd /Users/junhang/workspace/agent/ai-teams && pnpm --filter @ai-teams/web build
```

Expected: Build succeeds.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/App.tsx
git commit -m "feat(web): show agent weight in EmployeeCard"
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
