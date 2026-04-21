import { describe, expect, it } from "vitest";
import {
  parseEmployeeToServerMessage,
  parseLeaderToServerMessage,
  parseServerToEmployeeMessage,
  resolveAtAgentsFromPrompt,
} from "./index";

const employees = [
  { id: "alice", name: "Alice" },
  { id: "bob", name: "Bob" },
];

describe("protocol parsing", () => {
  it("accepts canonical leader dispatch messages", () => {
    expect(
      parseLeaderToServerMessage({
        type: "command.dispatch",
        atAgents: "queue",
        prompt: "run checks",
        timeoutSec: 30,
      }),
    ).toMatchObject({
      type: "command.dispatch",
      atAgents: "queue",
      prompt: "run checks",
      timeoutSec: 30,
    });
  });

  it("rejects invalid leader messages", () => {
    expect(() => parseLeaderToServerMessage({ type: "command.dispatch", atAgents: [], prompt: "" })).toThrow();
    expect(() => parseLeaderToServerMessage({ type: "unknown" })).toThrow();
  });

  it("accepts agent registration recovery fields", () => {
    expect(
      parseEmployeeToServerMessage({
        type: "agent.register",
        employeeId: "alice",
        name: "Alice",
        machineId: "alice",
        hostname: "host",
        labels: ["frontend"],
        activeMainTaskId: "task-1",
        activeQueueTaskId: "task-2",
        lastOutputSeq: 4,
      }),
    ).toMatchObject({ activeMainTaskId: "task-1", activeQueueTaskId: "task-2", lastOutputSeq: 4 });
  });

  it("accepts task started session ids", () => {
    expect(
      parseEmployeeToServerMessage({
        type: "task.started",
        taskId: "task-1",
        pid: 123,
        sessionId: "session-1",
      }),
    ).toMatchObject({ type: "task.started", sessionId: "session-1" });
  });

  it("rejects malformed server-to-agent dispatch messages", () => {
    expect(() =>
      parseServerToEmployeeMessage({
        type: "task.dispatch",
        taskId: "task-1",
        leaderCommandId: "cmd-1",
        employeeId: "alice",
        targetMode: "direct",
        prompt: "x",
        workspace: null,
        timeoutSec: 0,
      }),
    ).toThrow();
  });
});

describe("resolveAtAgentsFromPrompt", () => {
  it("defaults to queue when there are no selected or mentioned agents", () => {
    expect(resolveAtAgentsFromPrompt("run checks", employees)).toMatchObject({
      atAgents: "queue",
      prompt: "run checks",
    });
  });

  it("supports multiple selected agents", () => {
    expect(resolveAtAgentsFromPrompt("run checks", employees, ["alice", "bob"]).atAgents).toEqual(["alice", "bob"]);
  });

  it("merges valid @mentions into selected targets and removes them from the prompt", () => {
    expect(resolveAtAgentsFromPrompt("@Alice fix it @bob", employees, ["alice"])).toMatchObject({
      atAgents: ["alice", "bob"],
      prompt: "fix it",
      matchedMentions: ["Alice", "bob"],
    });
  });

  it("keeps queue when only unknown @mentions are present", () => {
    expect(resolveAtAgentsFromPrompt("@nobody run checks", employees)).toMatchObject({
      atAgents: "queue",
      prompt: "@nobody run checks",
      unknownMentions: ["nobody"],
    });
  });

  it("keeps explicit all target even when mentions are present", () => {
    expect(resolveAtAgentsFromPrompt("@Alice run checks", employees, "all")).toMatchObject({
      atAgents: "all",
      prompt: "run checks",
    });
  });
});
