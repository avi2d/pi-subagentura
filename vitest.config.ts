import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/ndjson.d.ts"],
      thresholds: {
        statements: 70,
        branches: 63,
        functions: 73,
        lines: 72,
      },
    },
  },
});
