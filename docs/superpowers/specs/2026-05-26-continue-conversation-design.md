# Continue Conversation Feature Design

Date: 2026-05-26

## Overview

Add "continue conversation" and "reply" capabilities to the AI Teams web console. Users can resume a completed task's Claude session to send follow-up messages, instead of starting a fresh session each time.

## User-facing Behavior

### Task List — "Continue" Button

- Only tasks with `status === "completed"` show a "继续对话" button
- On click: navigate to Chat page, load the session's history, set `selectedTarget` to the task's agent, focus the input box
- When the user sends a message, the `command.dispatch` payload includes `sessionId` from the original task

### Chat Bubbles — "Reply" Button

- Agent response bubbles display a "Reply" button
- On click: set `selectedTarget` to the agent, focus the input box
- When the user sends a message, the `command.dispatch` payload includes `sessionId` from the bubble's associated task

### Shared Send Flow

- Both "Continue" and "Reply" converge on the same mechanism: `sendCommand()` includes an optional `sessionId` in the dispatch payload
- A `resumeSessionId` state variable tracks the session being continued. It is set by "Continue" or "Reply" clicks and cleared after sending

## Protocol Changes

### `LeaderToServerMessage` — `command.dispatch`

Add optional `sessionId` field:

```ts
{ type: "command.dispatch", atAgents: ..., prompt: ..., workspace?: string, sessionId?: string }
```

### `ServerToEmployeeMessage` — `task.dispatch`

Add optional `sessionId` field:

```ts
{ type: "task.dispatch", taskId: ..., ..., sessionId?: string }
```

### Parsing

`parseLeaderToServerMessage` and `parseServerToEmployeeMessage` must extract the new `sessionId` field when present.

## Server Changes (apps/server)

### `createTask()` (dispatch.ts)

- Add `sessionId?: string` parameter
- When provided, store it in the `TaskRecord.sessionId` field (instead of `null`)

### `dispatchLeaderCommand()` (dispatch.ts)

- Extract `sessionId` from the incoming `command.dispatch` message
- Pass it through to `createTask()` for each target agent

### `dispatchTask()` (dispatch.ts)

- Include `sessionId` in the `task.dispatch` message payload sent to the agent

### `POST /api/tasks`

- Accept optional `sessionId` in the request body
- Pass it through to `dispatchLeaderCommand()`

## Agent Changes (apps/agent)

### `startTask()` (index.ts)

- When `message.sessionId` is present, set `task.claudeSessionId = message.sessionId`
- This overrides the default behavior (fresh UUID for queue, persistent session for direct)

### `buildClaudeArgs()` (runner.ts)

- When the task has an explicit `sessionId` from dispatch (i.e., this is a continuation), use `--resume <sessionId>` regardless of `targetMode`
- Track this with a flag on the `ActiveTask` type (e.g., `resumingSession: boolean`)

## Web Changes (apps/web)

### New State

```ts
const [resumeSessionId, setResumeSessionId] = useState<string | null>(null);
```

### Task List — Continue Button

- In the task row rendering (Tasks page), conditionally render a "继续对话" button when `task.status === "completed"` and `task.sessionId` exists
- On click:
  1. `setResumeSessionId(task.sessionId)`
  2. `setSelectedTarget(task.employeeId)`
  3. Navigate to Chat page (`setActivePage("chat")`)
  4. Load session history via `GET /api/sessions/:sessionId/history`

### Chat Bubbles — Reply Button

- In the `Bubble.List` renderer for `role: "ai"`, add a "Reply" button
- The button is associated with the chat feed item's source task (which carries `sessionId` and `employeeId`)
- On click:
  1. `setResumeSessionId(task.sessionId)`
  2. `setSelectedTarget(task.employeeId)` (or the employee from the feed item)
  3. Focus the input box

### `sendCommand()` Modification

- When `resumeSessionId` is set, include `sessionId: resumeSessionId` in the `command.dispatch` payload
- After sending, clear `resumeSessionId` and reset `selectedTarget` to `"queue"`

## Implementation Order

1. Shared protocol types — add `sessionId` to both message types and parsers
2. Server — thread `sessionId` through `createTask` → `dispatchTask`
3. Agent — handle `sessionId` in `startTask` and `buildClaudeArgs`
4. Web — add `resumeSessionId` state, "Continue" button, "Reply" button, modify `sendCommand`
5. Test end-to-end: complete a task → click continue → verify agent resumes session

## Out of Scope

- Continuing failed/cancelled/timeout tasks
- Session history pagination
- Multi-agent session continuation (only single-agent direct dispatch)
