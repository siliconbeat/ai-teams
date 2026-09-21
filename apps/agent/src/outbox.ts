import fs from "node:fs";
import { parseEmployeeToServerMessage, type TaskTerminalMessage } from "@ai-teams/shared";
import { STATE_FILE } from "./config.js";
import { atomicWriteJson } from "./state.js";

const file = `${STATE_FILE}.outbox.json`;
export function loadTerminalOutbox(): TaskTerminalMessage[] {
  try {
    if (fs.statSync(file).size > 8 * 1024 * 1024) throw new Error("Terminal outbox exceeds 8 MiB; inspect before restarting.");
    const values: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(values) || values.length > 400) throw new Error("Invalid terminal outbox");
    return values.map(value => {
      const message = parseEmployeeToServerMessage(value);
      if (message.type !== "task.completed" && message.type !== "task.failed" && message.type !== "task.cancelled") throw new Error("Invalid terminal outbox event");
      return message;
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error; // Fail closed, never silently discard an unreadable outbox.
  }
}
export function saveTerminalOutbox(messages: TaskTerminalMessage[]) { atomicWriteJson(file, messages); }
