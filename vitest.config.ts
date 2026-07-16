import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Compatibility branches are exercised by the baseline/latest SDK matrix.
      exclude: ["src/ndjson.d.ts", "src/pi-sdk-compat.ts"],
      thresholds: {
        statements: 71,
        branches: 64,
        functions: 74,
        lines: 72,
      },
    },
  },
});
