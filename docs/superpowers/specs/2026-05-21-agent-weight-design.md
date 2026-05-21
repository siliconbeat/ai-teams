# Agent Weight for Queue Dispatch

## Summary

Add a `weight` parameter to agents that controls how likely each agent is to receive queue tasks. Higher weight = more tasks.

## Problem

All agents have equal probability of receiving queue tasks (round-robin among lightest-loaded). When agents have different performance capabilities (e.g., a Mac Mini vs a MacBook Air), the faster machine sits idle waiting for the slower one.

## Design

### 1. Agent CLI: `--weight` parameter

**File:** `apps/agent/src/config.ts`, `apps/agent/src/index.ts`

Add `--weight <number>` CLI argument and `EMPLOYEE_WEIGHT` env var. Default is 1. Minimum is 1.

```
ai-teams-agent start --weight 3
EMPLOYEE_WEIGHT=3 ai-teams-agent start
```

Config fallback: env var `EMPLOYEE_WEIGHT` → CLI `--weight` → config file `weight` → default `1`.

The weight is read at startup and included in the `agent.register` message.

### 2. Shared protocol: `weight` field in registration

**File:** `packages/shared/src/index.ts`

Add `weight: number` to the `agent.register` variant of `EmployeeToServerMessage`.

### 3. Server: weighted random dispatch

**File:** `apps/server/src/dispatch.ts`

In `pickAvailableEmployeeIdForQueue()`, replace the round-robin selection among lightest-loaded agents with weighted random selection:

```
lightest = [A(weight=3), B(weight=1)]
total = 3 + 1 = 4
random = Math.random() * 4  // e.g., 2.7
A covers [0, 3), B covers [3, 4)
2.7 < 3 → select A
```

Remove `sharedQueueCursor` round-robin logic for queue dispatch (the cursor is no longer needed).

### 4. Web: show weight in EmployeeCard

**File:** `apps/web/src/App.tsx`

Display weight value in EmployeeCard metadata when weight > 1. Show as a small badge or text like `权重: 3`.

### 5. Agent help text

**File:** `apps/agent/src/index.ts`

Add `--weight <number>` to the `--help` output:

```
  --weight <number>     队列任务分配权重 (默认 1)
```

## Files Changed

| File | Change |
|------|--------|
| `apps/agent/src/config.ts` | Add `EMPLOYEE_WEIGHT` config |
| `apps/agent/src/index.ts` | Add `--weight` CLI arg, update help text |
| `apps/agent/src/connection.ts` | Include weight in `registerAgent` |
| `packages/shared/src/index.ts` | Add `weight` to `agent.register` message |
| `apps/server/src/dispatch.ts` | Weighted random in `pickAvailableEmployeeIdForQueue` |
| `apps/server/src/dispatch.ts` | Store weight from registration in `upsertEmployee` |
| `apps/web/src/App.tsx` | Show weight in EmployeeCard |

## What's NOT Changing

- Direct/broadcast dispatch (not affected by weight)
- Task submission API
- Queue FIFO ordering (tasks still processed in order)
- Agent reconnection behavior
- Failure tracking and auto-recovery
