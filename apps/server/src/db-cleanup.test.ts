import { describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { PostgresDatabase } from "./db";

describe("PostgreSQL task cleanup transaction", () => {
  it.each([false, true])("uses one connection and rolls back failures: %s", async (fail) => {
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (fail && sql === "DELETE FROM tasks") throw new Error("database failure");
        return { rows: [{ count: "2" }] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client), query: vi.fn() };
    const db = new PostgresDatabase(pool as unknown as pg.Pool);
    if (fail) await expect(db.clearTaskData()).rejects.toThrow("database failure");
    else await expect(db.clearTaskData()).resolves.toMatchObject({ tasks: 2, missions: 2, generation: expect.any(String) });
    expect(statements[0]).toBe("BEGIN");
    expect(statements.at(-1)).toBe(fail ? "ROLLBACK" : "COMMIT");
    expect(statements.filter((sql) => sql.startsWith("DELETE FROM"))).toHaveLength(7);
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(pool.query).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
