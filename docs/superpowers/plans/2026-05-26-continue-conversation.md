# Continue Conversation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to continue a completed task's Claude session by dispatching new tasks that reuse the original session ID, via "继续对话" buttons on the task list and "Reply" buttons on chat bubbles.

**Architecture:** Extend the WebSocket protocol with an optional `sessionId` field on `command.dispatch` (leader→server) and `task.dispatch` (server→agent). When present, the agent uses `--resume <sessionId>` to continue the existing Claude session instead of starting fresh. The web UI adds two entry points: a "继续对话" button on completed task rows and a "Reply" button on agent chat bubbles.

**Tech Stack:** TypeScript, Ant Design X (Bubble.List), WebSocket, Vitest

---

### Task 1: Add `sessionId` to shared protocol types and parsers

**Files:**
- Modify: `packages/shared/src/index.ts:94-109` (ServerToEmployeeMessage)
- Modify: `packages/shared/src/index.ts:148-157` (LeaderToServerMessage)
- Modify: `packages/shared/src/index.ts:205-218` (parseLeaderToServerMessage)
- Modify: `packages/shared/src/index.ts:332-348` (parseServerToEmployeeMessage)
- Modify: `packages/shared/src/index.test.ts` (add tests)

- [ ] **Step 1: Add `sessionId` to `LeaderToServerMessage` type**

In `packages/shared/src/index.ts`, at the `command.dispatch` branch (line 149-157), add optional `sessionId`:

```ts
  | {
      type: "command.dispatch";
      atAgents: AgentTarget;
      prompt: string;
      workspace?: string;
      timeoutSec?: number;
      priority?: number;
      requiredLabels?: string[];
      sessionId?: string;
    }
```

- [ ] **Step 2: Add `sessionId` to `ServerToEmployeeMessage` type**

At the `task.dispatch` branch (line 94-105), add optional `sessionId`:

```ts
  | {
      type: "task.dispatch";
      taskId: string;
      leaderCommandId: string;
      employeeId: string;
      targetMode: TaskTargetMode;
      prompt: string;
      workspace: string | null;
      timeoutSec: number;
      cliConfig: TaskCliConfig | null;
      sessionId?: string;
    }
```

- [ ] **Step 3: Update `parseLeaderToServerMessage` to extract `sessionId`**

At line 209-218, add `sessionId` extraction:

```ts
  if (type === "command.dispatch") {
    return {
      type,
      atAgents: agentTargetField(message, "atAgents"),
      prompt: nonEmptyStringField(message, "prompt"),
      workspace: optionalStringField(message, "workspace"),
      timeoutSec: optionalPositiveNumberField(message, "timeoutSec"),
      priority: optionalNonNegativeNumberField(message, "priority"),
      requiredLabels: optionalStringArrayField(message, "requiredLabels"),
      sessionId: optionalStringField(message, "sessionId"),
    };
  }
```

- [ ] **Step 4: Update `parseServerToEmployeeMessage` to extract `sessionId`**

At line 336-348, add `sessionId` extraction:

```ts
  if (type === "task.dispatch") {
    return {
      type,
      taskId: nonEmptyStringField(message, "taskId"),
      leaderCommandId: nonEmptyStringField(message, "leaderCommandId"),
      employeeId: nonEmptyStringField(message, "employeeId"),
      targetMode: taskTargetModeField(message, "targetMode"),
      prompt: nonEmptyStringField(message, "prompt"),
      workspace: nullableStringField(message, "workspace"),
      timeoutSec: positiveNumberField(message, "timeoutSec"),
      cliConfig: optionalCliConfigField(message, "cliConfig"),
      sessionId: optionalStringField(message, "sessionId"),
    };
  }
```

- [ ] **Step 5: Add tests for sessionId parsing**

In `packages/shared/src/index.test.ts`, add tests inside the `"protocol parsing"` describe block:

```ts
  it("accepts sessionId in command.dispatch", () => {
    expect(
      parseLeaderToServerMessage({
        type: "command.dispatch",
        atAgents: "queue",
        prompt: "continue this",
        sessionId: "abc-123",
      }),
    ).toMatchObject({
      type: "command.dispatch",
      atAgents: "queue",
      prompt: "continue this",
      sessionId: "abc-123",
    });
  });

  it("accepts command.dispatch without sessionId", () => {
    expect(
      parseLeaderToServerMessage({
        type: "command.dispatch",
        atAgents: "queue",
        prompt: "run checks",
      }),
    ).not.toHaveProperty("sessionId");
  });

  it("accepts sessionId in task.dispatch", () => {
    expect(
      parseServerToEmployeeMessage({
        type: "task.dispatch",
        taskId: "task-1",
        leaderCommandId: "cmd-1",
        employeeId: "alice",
        targetMode: "direct",
        prompt: "continue this",
        workspace: null,
        timeoutSec: 30,
        sessionId: "abc-123",
      }),
    ).toMatchObject({
      type: "task.dispatch",
      sessionId: "abc-123",
    });
  });

  it("accepts task.dispatch without sessionId", () => {
    expect(
      parseServerToEmployeeMessage({
        type: "task.dispatch",
        taskId: "task-1",
        leaderCommandId: "cmd-1",
        employeeId: "alice",
        targetMode: "direct",
        prompt: "x",
        workspace: null,
        timeoutSec: 30,
      }),
    ).not.toHaveProperty("sessionId");
  });
```

- [ ] **Step 6: Run tests**

Run: `pnpm vitest run packages/shared/src/index.test.ts`
Expected: All tests pass (including new ones)

- [ ] **Step 7: Build shared package**

Run: `pnpm build`
Expected: Build succeeds

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/index.ts packages/shared/src/index.test.ts
git commit -m "feat(shared): add optional sessionId to command.dispatch and task.dispatch protocol"
```

---

### Task 2: Thread `sessionId` through server dispatch pipeline

**Files:**
- Modify: `apps/server/src/dispatch.ts:590-645` (createTask)
- Modify: `apps/server/src/dispatch.ts:657-692` (dispatchLeaderCommand)
- Modify: `apps/server/src/dispatch.ts:531-541` (dispatchTask)
- Modify: `apps/server/src/schemas.ts:3-12` (RestTaskRequest type)
- Modify: `apps/server/src/schemas.ts:174-208` (restTaskRequestSchema)
- Modify: `apps/server/src/schemas.ts:304-326` (parseRestTaskRequest)

- [ ] **Step 1: Add `sessionId` parameter to `createTask`**

In `dispatch.ts`, add `sessionId` parameter to `createTask` (line 590-601). Add it after `requiredLabels`:

```ts
  function createTask(
    employeeId: string | null,
    prompt: string,
    workspace: string | undefined,
    timeoutSec: number | undefined,
    leaderCommandId: string | undefined,
    targetMode: TaskTargetMode,
    webhookUrl?: string | null,
    cliConfig?: unknown,
    priority?: number,
    requiredLabels?: string[] | null,
    sessionId?: string,
  ) {
```

At line 607, change `sessionId: null` to use the parameter:

```ts
      sessionId: sessionId ?? null,
```

- [ ] **Step 2: Pass `sessionId` in `dispatchLeaderCommand`**

In `dispatchLeaderCommand` (line 657-692), extract `sessionId` from the message and pass it to `createTask`.

For the queue branch (line 671):

```ts
        tasks: [createTask(null, message.prompt, message.workspace, message.timeoutSec, leaderCommandId, "queue", webhookUrl, cliConfig, resolvedPriority, resolvedRequiredLabels, message.sessionId)],
```

For the direct/broadcast branch (line 689):

```ts
        tasks: targetIds.map((employeeId) =>
          createTask(employeeId, message.prompt, message.workspace, message.timeoutSec, leaderCommandId, targetMode, webhookUrl, cliConfig, resolvedPriority, resolvedRequiredLabels, message.sessionId),
        ),
```

- [ ] **Step 3: Include `sessionId` in `dispatchTask` message to agent**

In `dispatchTask` (line 531-541), add `sessionId` to the message payload. Change the `sendJson` call:

```ts
    sendJson<ServerToEmployeeMessage>(socket, {
      type: "task.dispatch",
      taskId: task.id,
      leaderCommandId: task.leaderCommandId,
      employeeId: assignedEmployeeId,
      targetMode: task.targetMode,
      prompt: task.prompt,
      workspace: task.workspace,
      timeoutSec: task.timeoutSec,
      cliConfig: task.cliConfig,
      ...(task.sessionId ? { sessionId: task.sessionId } : {}),
    }, ctx.encryptor);
```

- [ ] **Step 4: Update REST API schema and parser**

In `schemas.ts`, add `sessionId` to `RestTaskRequest` type (line 3-12):

```ts
export type RestTaskRequest = {
  atAgents?: unknown;
  prompt?: unknown;
  workspace?: unknown;
  timeoutSec?: unknown;
  cliConfig?: unknown;
  webhook?: unknown;
  webHook?: unknown;
  webhookUrl?: unknown;
  sessionId?: unknown;
};
```

Add to `restTaskRequestSchema` properties (line 174-208):

```ts
    sessionId: { type: "string" },
```

In `parseRestTaskRequest` (line 304-326), thread `sessionId` through. Change the `parseLeaderToServerMessage` call to include `sessionId`:

```ts
  const command = parseLeaderToServerMessage({
    type: "command.dispatch",
    atAgents: request.atAgents ?? "queue",
    prompt: request.prompt,
    workspace: request.workspace,
    timeoutSec: request.timeoutSec,
    sessionId: request.sessionId,
  });
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run apps/server/src/index.test.ts`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/dispatch.ts apps/server/src/schemas.ts
git commit -m "feat(server): thread sessionId through task dispatch pipeline"
```

---

### Task 3: Handle `sessionId` in agent

**Files:**
- Modify: `apps/agent/src/config.ts:69-93` (ActiveTask type)
- Modify: `apps/agent/src/index.ts:144-191` (startTask)
- Modify: `apps/agent/src/runner.ts:224-230` (buildClaudeArgs)

- [ ] **Step 1: Add `resumingSession` flag to `ActiveTask` type**

In `config.ts`, add to the `ActiveTask` type (after `retriedWithFreshSession`):

```ts
  resumingSession: boolean;
```

- [ ] **Step 2: Use `message.sessionId` in `startTask`**

In `index.ts` `startTask` (line 164-179), when `message.sessionId` is present, use it and set `resumingSession`:

```ts
  const task: ActiveTask = {
    taskId: message.taskId,
    seq: 0,
    child: null,
    summary: [],
    cancelRequested: false,
    sawStreamText: false,
    lastToolBlock: false,
    stderrTail: "",
    retriedWithFreshSession: false,
    resumingSession: !!message.sessionId,
    generation: 0,
    targetMode: message.targetMode,
    claudeSessionId: message.sessionId ?? (message.targetMode === "queue" ? randomUUID() : agentState.claudeSessionId),
    cliConfig: message.cliConfig ?? null,
    resultMetrics: {},
  };
```

- [ ] **Step 3: Handle `resumingSession` in `buildClaudeArgs`**

In `runner.ts` `buildClaudeArgs` (line 224-230), add a check for `resumingSession` before the existing logic:

```ts
  if (task.resumingSession) {
    args.push("--resume", task.claudeSessionId);
  } else if (task.targetMode === "queue") {
    args.push("--session-id", task.claudeSessionId);
  } else if (agentState.sessionReady) {
    args.push("--resume", agentState.claudeSessionId);
  } else {
    args.push("--session-id", agentState.claudeSessionId);
  }
```

- [ ] **Step 4: Build and verify**

Run: `pnpm build`
Expected: Build succeeds with no type errors

- [ ] **Step 5: Commit**

```bash
git add apps/agent/src/config.ts apps/agent/src/index.ts apps/agent/src/runner.ts
git commit -m "feat(agent): support session resumption via dispatch sessionId"
```

---

### Task 4: Add "继续对话" button to task list and "Reply" button to chat bubbles

**Files:**
- Modify: `apps/web/src/App.tsx:141-152` (ChatFeedItem type)
- Modify: `apps/web/src/App.tsx:765-776` (employeeItems in chatFeed)
- Modify: `apps/web/src/App.tsx:781-798` (bubbleItems — add taskId/employeeId/sessionId to extraInfo)
- Modify: `apps/web/src/App.tsx:1066-1095` (sendCommand — include sessionId)
- Modify: `apps/web/src/App.tsx:1601-1637` (task row rendering — add continue button)
- Modify: `apps/web/src/App.tsx:1469-1483` (mobile ai bubble contentRender — add reply button)
- Modify: `apps/web/src/App.tsx:2026-2042` (desktop ai bubble contentRender — add reply button)

- [ ] **Step 1: Add `resumeSessionId` state**

Near the existing `selectedTarget` state (around line 485), add:

```ts
  const [resumeSessionId, setResumeSessionId] = useState<string | null>(null);
```

- [ ] **Step 2: Add task metadata to `ChatFeedItem` type**

In the `ChatFeedItem` type (line 141-152), add fields for linking back to the source task:

```ts
type ChatFeedItem = {
  id: string;
  side: "leader" | "employee";
  author: string;
  target?: string;
  content: string;
  createdAt: string;
  createdAtMs: number;
  status?: TaskStatus;
  executingBy?: ExecutingAgent[];
  quotedPrompt?: string;
  taskId?: string;
  employeeId?: string;
  sessionId?: string;
};
```

- [ ] **Step 3: Populate task metadata in `employeeItems`**

In the `chatFeed` useMemo, at the `employeeItems` mapping (line 765-776), add the new fields:

```ts
    const employeeItems: ChatFeedItem[] = Object.values(tasks)
      .filter((task) => task.finishedAt && isTerminalStatus(task.status))
      .map((task) => ({
        id: `employee-${task.id}`,
        side: "employee" as const,
        author: task.employeeId ? employees[task.employeeId]?.name ?? task.employeeId : "任务队列",
        content: task.summary || task.error || statusToMessage(task.status),
        createdAt: new Date(task.finishedAt ?? task.createdAt).toLocaleTimeString(),
        createdAtMs: new Date(task.finishedAt ?? task.createdAt).getTime(),
        status: task.status,
        quotedPrompt: task.prompt,
        taskId: task.id,
        employeeId: task.employeeId ?? undefined,
        sessionId: task.sessionId ?? undefined,
      }));
```

- [ ] **Step 4: Pass task metadata through `bubbleItems`**

In `bubbleItems` useMemo (line 781-798), add the new fields to `extraInfo`:

```ts
  const bubbleItems = useMemo(() =>
    chatFeed.map((item) => {
      const isLeader = item.side === "leader";
      return {
        key: item.id,
        role: isLeader ? "user" as const : "ai" as const,
        content: item.content,
        extraInfo: {
          executingBy: isLeader && item.executingBy?.length ? item.executingBy : undefined,
          taskStatus: !isLeader && item.status ? item.status : undefined,
          target: isLeader && item.target ? item.target : undefined,
          quotedPrompt: !isLeader ? item.quotedPrompt : undefined,
          createdAt: item.createdAt,
          author: item.author,
          taskId: item.taskId,
          employeeId: item.employeeId,
          sessionId: item.sessionId,
        },
      };
    })
  , [chatFeed]);
```

- [ ] **Step 5: Modify `sendCommand` to include `sessionId`**

In `sendCommand` (line 1066-1095), add `sessionId` to the payload and clear it after:

```ts
  function sendCommand() {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN || !draft.prompt.trim()) {
      return;
    }

    const resolved = resolveAtAgentsFromPrompt(draft.prompt.trim(), employeeList, selectedTarget);
    const commandPrompt = (resolved.prompt || draft.prompt.trim()).replace(/@all\s*/gi, "").trim();
    const payload: LeaderToServerMessage = {
      type: "command.dispatch",
      atAgents: resolved.atAgents,
      prompt: commandPrompt,
      workspace: draft.workspace.trim() || undefined,
      ...(resumeSessionId ? { sessionId: resumeSessionId } : {}),
    };

    webCryptoEncrypt(JSON.stringify(payload)).then((encrypted) => {
      wsRef.current?.send(encrypted);
    });
    setHistory((current) => [
      ...current,
      {
        id: `${Date.now()}`,
        target: resolved.atAgents,
        prompt: commandPrompt,
        createdAt: new Date().toLocaleTimeString(),
        createdAtMs: Date.now(),
      },
    ]);
    setDraft((current) => ({ ...current, prompt: "" }));
    setSelectedTarget("queue");
    setResumeSessionId(null);
  }
```

- [ ] **Step 6: Add "继续对话" button to task list rows**

In the task row rendering (line 1601-1637), add a continue button for completed tasks. After the existing retry button area (line 1616-1621), add:

```tsx
                            {task.status === "completed" && task.sessionId && (
                              <button className="retry-btn" onClick={(e) => {
                                e.stopPropagation();
                                setResumeSessionId(task.sessionId);
                                setSelectedTarget(task.employeeId ? [task.employeeId] : "queue");
                                setActivePage("chat");
                              }}>继续对话</button>
                            )}
```

- [ ] **Step 7: Add "Reply" button to desktop ai bubble contentRender**

In the desktop ai bubble `contentRender` (line 2026-2042), add a reply button. After the existing copy button (line 2037-2039), add:

```tsx
                          <button className="bubble-copy-btn" onClick={() => navigator.clipboard.writeText(String(_content))}>
                            <CopyOutlined />
                          </button>
                          {item.sessionId && item.employeeId && (
                            <button
                              className="bubble-reply-btn"
                              onClick={() => {
                                setResumeSessionId(item.sessionId);
                                setSelectedTarget([item.employeeId]);
                              }}
                              title="回复"
                            >
                              ↩
                            </button>
                          )}
```

- [ ] **Step 8: Add "Reply" button to mobile ai bubble contentRender**

In the mobile ai bubble `contentRender` (line 1469-1483), add the same reply button after the copy button:

```tsx
                      <button className="bubble-copy-btn" onClick={() => navigator.clipboard.writeText(String(_content))}>
                        <CopyOutlined />
                      </button>
                      {item.sessionId && item.employeeId && (
                        <button
                          className="bubble-reply-btn"
                          onClick={() => {
                            setResumeSessionId(item.sessionId);
                            setSelectedTarget([item.employeeId]);
                          }}
                          title="回复"
                        >
                          ↩
                        </button>
                      )}
```

- [ ] **Step 9: Add CSS for the reply button**

Add to the existing stylesheet (in `App.css` or the `<style>` tag wherever `.bubble-copy-btn` is defined). Add a style for `.bubble-reply-btn` that matches the existing `.bubble-copy-btn` style:

```css
.bubble-reply-btn {
  /* Same base style as bubble-copy-btn */
  background: none;
  border: none;
  cursor: pointer;
  opacity: 0.5;
  font-size: 14px;
  padding: 2px 4px;
  color: inherit;
  transition: opacity 0.2s;
}
.bubble-reply-btn:hover {
  opacity: 1;
}
```

- [ ] **Step 10: Build and verify**

Run: `pnpm build`
Expected: Build succeeds

- [ ] **Step 11: Commit**

```bash
git add apps/web/src/App.tsx apps/web/src/App.css
git commit -m "feat(web): add continue and reply buttons for session resumption"
```

---

### Task 5: End-to-end manual verification

- [ ] **Step 1: Start dev services**

Run: `pnpm dev:all`

- [ ] **Step 2: Send a direct task to an agent and wait for completion**

Via the web UI, send a task to an agent (e.g. `@alice 你好`). Wait for it to complete.

- [ ] **Step 3: Verify "继续对话" button appears**

Go to the Tasks page. The completed task should show a "继续对话" button.

- [ ] **Step 4: Test continue flow**

Click "继续对话". Verify:
- Navigates to Chat page
- Target agent is selected
- Type a follow-up message and send
- Verify in server/agent logs that `sessionId` is passed and `--resume` is used

- [ ] **Step 5: Verify "Reply" button on chat bubble**

In the Chat page, find an agent response bubble. Verify it has a ↩ reply button.

- [ ] **Step 6: Test reply flow**

Click the reply button. Verify:
- Target agent is selected
- Input is focused
- Send a message and verify session resumption

- [ ] **Step 7: Verify normal dispatch still works**

Send a regular task without any session resumption. Verify it works as before (no sessionId in payload).
