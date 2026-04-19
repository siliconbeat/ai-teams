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
        atAgents: ["alice", "bob"],
        prompt: "run checks",
        timeoutSec: 30,
      }),
    ).toMatchObject({
      type: "command.dispatch",
      atAgents: ["alice", "bob"],
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
        maxConcurrentTasks: 1,
        activeTaskId: "task-1",
        lastOutputSeq: 4,
      }),
    ).toMatchObject({ activeTaskId: "task-1", lastOutputSeq: 4 });
  });

  it("rejects malformed server-to-agent dispatch messages", () => {
    expect(() =>
      parseServerToEmployeeMessage({
        type: "task.dispatch",
        taskId: "task-1",
        leaderCommandId: "cmd-1",
        employeeId: "alice",
        prompt: "x",
        workspace: null,
        timeoutSec: 0,
      }),
    ).toThrow();
  });
});

describe("resolveAtAgentsFromPrompt", () => {
  it("defaults to all when there are no selected or mentioned agents", () => {
    expect(resolveAtAgentsFromPrompt("run checks", employees)).toMatchObject({
      atAgents: "all",
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

  it("keeps all when only unknown @mentions are present", () => {
    expect(resolveAtAgentsFromPrompt("@nobody run checks", employees)).toMatchObject({
      atAgents: "all",
      prompt: "@nobody run checks",
      unknownMentions: ["nobody"],
    });
  });
});
