---
title: "Interactive Sub-Agent Test Isolation"
keywords:
  [interactive subagent, test isolation, Vitest, child protocol, artifacts]
---

# Interactive Sub-Agent Test Isolation

## Problem

Interactive Pi sub-agents use private bootstrap variables such as:

```bash
PI_SUBAGENTURA_CHILD=1
ARTIFACT_DIR=<sub-agent artifact directory>
```

Commands launched by the sub-agent inherit those variables. If a test process loads the pi-subagentura extension and creates fake Pi sessions, the extension can enter child mode and attach lifecycle handlers to the real sub-agent artifact.

The fake sessions may then write `turn_started` and `completion` events, reset `output.md`, or reuse `active-turn.json`. The parent poller cannot distinguish those events from genuine child activity, so it may deliver false empty completions.

One sub-agent running the affected tests is sufficient. Multiple sub-agents only make the resulting activity more frequent and harder to diagnose.

## Why ordinary CI may miss it

In normal local and CI runs, `PI_SUBAGENTURA_CHILD` is usually absent, so tests load the extension in parent mode. The problem appears when the same test command is run from inside an interactive sub-agent, where the child environment is inherited.

The risk is an ambient-mode decision in the test harness: a harness without an explicit `childArtifactDir` can accidentally use the invoking process's child mode and artifact path.

## Current mitigation

`vitest.config.ts` removes `PI_SUBAGENTURA_CHILD` before test configuration is loaded:

```ts
delete process.env.PI_SUBAGENTURA_CHILD;
```

This keeps ordinary Vitest runs in parent mode across supported Node platforms without relying on shell-specific environment syntax. `ARTIFACT_DIR` is intentionally preserved because terminal E2E fixtures may use it independently.

Tests that intentionally exercise the child protocol must opt in explicitly by setting `PI_SUBAGENTURA_CHILD=1` and an isolated `ARTIFACT_DIR` while loading the extension, then restoring both variables.

## Immediate workaround

For a worktree that does not contain the mitigation, run tests with the child variables removed:

```bash
env -u PI_SUBAGENTURA_CHILD -u ARTIFACT_DIR npm test -- --run
```

This workaround is suitable for Unix-like systems. It applies only to the command that uses it; arbitrary commands or alternate test runners may still inherit the variables.

## Recommended test-harness hardening

The Vitest guard is a low-risk first layer. The stronger test-infrastructure fix is to make `createPiSessionHarness` explicitly own its mode:

- with `childArtifactDir`, set child mode and use that isolated artifact;
- without `childArtifactDir`, temporarily remove child mode;
- restore the previous environment in `finally`.

Add a regression that starts with inherited child variables, creates a parent-mode harness, settles a fake turn, and verifies that a sentinel artifact remains untouched. Retain positive child-protocol tests to verify explicit opt-in still works.

## Longer-term production hardening

A stronger runtime design would treat these variables as bootstrap-only rather than relying on inherited environment state:

1. Capture and validate child runtime state during real child startup.
2. Store the state in process-local runtime data that survives extension reloads but is not inherited by tools.
3. Make `cli.mjs` resolve its artifact directory from its own path.
4. Allow child tool processes to run without the private child marker and artifact variable.
5. Keep event/session validation as defense in depth; do not reject legitimate empty completions solely because they are empty.

This should be a separate compatibility-sensitive change because it affects CLI invocation, reload behavior, descendant sub-agents, lineage, and terminal E2E fixtures.

## Recovery guidance

When contamination is detected:

1. Cancel affected sub-agents through the normal lifecycle.
2. Preserve append-only event logs for diagnosis.
3. Do not truncate or rewrite `events.ndjson`.
4. Start replacement work with fresh sub-agent IDs and fresh artifact directories.
5. Do not treat empty completion events as valid reports without checking their source and session context.

## Verification

The mitigation should be verified with both normal and inherited-environment runs:

```bash
npm run typecheck
npm test
npm run format:check
npm run pack:check
PI_SUBAGENTURA_CHILD=1 ARTIFACT_DIR=<temporary-sentinel> \
  npm test -- --run tests/pi-session-delivery.integration.test.ts
```

The inherited-environment run must leave the sentinel artifact untouched while explicit child-protocol tests continue to pass.
