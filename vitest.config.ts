import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/ndjson.d.ts"],
      thresholds: {
        statements: 75,
        branches: 79,
        functions: 80,
        lines: 75,
      },
    },
  },
});
