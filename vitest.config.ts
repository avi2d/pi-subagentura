import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/ndjson.d.ts"],
      thresholds: {
        statements: 71,
        branches: 64,
        functions: 74,
        lines: 72,
      },
    },
  },
});
