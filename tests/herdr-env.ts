/**
 * The herdr context injected into the pane that launched this test worker.
 *
 * Captured at module load — `setup-lineage-env.ts` imports this module BEFORE
 * scrubbing the live values, for the same reason it scrubs the lineage
 * variables: a worker holding the developer's real `HERDR_PANE_ID` has
 * authority over their actual terminal (a split-mode test would divide the
 * pane they are typing in), and `HERDR_ENV` alone silently flips `getMux`
 * auto-resolution to herdr under every suite that stubs a different backend.
 *
 * Only `tests/herdr.integration.test.ts` restores the snapshot: driving the
 * real binary from the calling workspace is that suite's entire point.
 */
export const HOST_HERDR_ENV_NAMES = [
  "HERDR_ENV",
  "HERDR_WORKSPACE_ID",
  "HERDR_TAB_ID",
  "HERDR_PANE_ID",
  "HERDR_SOCKET_PATH",
  "HERDR_BIN_PATH",
] as const;

const snapshot: Partial<Record<string, string>> = {};
for (const name of HOST_HERDR_ENV_NAMES) {
  const value = process.env[name];
  if (value !== undefined) snapshot[name] = value;
}

export function scrubHostHerdrEnvironment(): void {
  for (const name of HOST_HERDR_ENV_NAMES) delete process.env[name];
}

export function restoreHostHerdrEnvironment(): void {
  for (const name of HOST_HERDR_ENV_NAMES) {
    const value = snapshot[name];
    if (value !== undefined) process.env[name] = value;
    else delete process.env[name];
  }
}
