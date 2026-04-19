import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "node:sqlite": fileURLToPath(new URL("./vitest.node-sqlite.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
  },
});
