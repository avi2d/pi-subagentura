# Critical issues — `master..HEAD` on `codex-tmux-oneshot`

**Scope:** 4 commits adding tmux-backed interactive subagent tools (`1dc42bd` → `9edd58e` → `85bdd82` → `c81f04c` → `5f56609`).
**Reviewers:** security, reliability/perf, API/DX. Reports at `/tmp/review-{security,reliability,api-dx}.md`.
**All five claims below verified against source on 2026-06-04.**

---

## 1. `helpers.ts` missing from published tarball — publish blocker

`package.json:25-32` (`files` array) lists `subagent.ts`, `interactive-tmux.ts`, `artifact.ts`, `subagent-artifact-cli.ts`, `README.md`, `LICENSE` — **`helpers.ts` is not in the list**.

But `subagent.ts:50` and `:2064` still do `import { … } from "./helpers"`.

**Verified with `npm run pack:check`**:
```
npm notice Tarball Contents
npm notice 1.1kB LICENSE
npm notice 10.2kB README.md
npm notice 5.7kB artifact.ts
npm notice 17.1kB interactive-tmux.ts
npm notice 1.3kB package.json
npm notice 4.1kB subagent-artifact-cli.ts
npm notice 70.6kB subagent.ts
npm notice total files: 7
```

No `helpers.ts`. The published extension will throw `Cannot find module './helpers'` the moment it loads.

**Fix:** re-add `"helpers.ts"` to the `files` array. Add a CI step that runs `npm run pack:check` so `files`-drift is caught before merge.

---

## 2. Path traversal in `findArtifactById` — verified exfil primitive

`subagent.ts:766-785`:

```ts
function findArtifactById(id: string): SubagentArtifact | null {
    const root = process.env.PI_CODING_AGENT_SESSION_DIR ?? join(homedir(), ".pi", "agent", "sessions");
    let topLevel: string[];
    try { topLevel = readdirSync(root); } catch { return null; }
    for (const entry of topLevel) {
        const candidate = join(root, entry, "artifacts", id);   // <-- id is LLM-controlled, never validated
        try {
            if (statSync(candidate).isDirectory()) {
                return artifactPath(join(root, entry, "artifacts"), id);
            }
        } catch { /* not here */ }
    }
    return null;
}
```

`id` is `Type.String` only — TypeBox + AJV validate the type, not the contents. The shape used at spawn is `randomBytes(4).toString("hex")` (8 hex chars), but the fallback path accepts any string. `path.join` normalizes `..`, so `id = "../../../etc"` resolves outside the artifact root. If a sibling directory of the sessions root contains `events.ndjson` and `output.md`, `read_subagent_artifact` (`subagent.ts:1796-1840`) reads them and ships the contents back to the LLM via `details`.

**Verified by the security reviewer** end-to-end against a temp tree.

**Fix:** validate `id` against `/^[a-f0-9]{8}$/` before joining, or `realpath` the candidate and assert it stays under `root`.

---

## 3. `setInterval` poller never cleared — process-lifetime leak

`subagent.ts:861-866` (in `session_start`):

```ts
if (!g2.__piSubagenturaInteractivePollerHandle) {
    g2.__piSubagenturaInteractivePollerHandle = setInterval(
        () => pollArtifactChanges(pi),
        5000,
    );
}
```

`session_shutdown` (`subagent.ts:2026-2043`):

```ts
(pi as any).on?.("session_shutdown", () => {
    // Aborts running jobs, clears jobRegistry, nulls piRef/injectCount
    jobRegistry.clear();
    g2.__piSubagenturaPiRef = undefined;
    g2.__piSubagenturaInjectCount = 0;
});
```

**Verified:** `grep clearInterval subagent.ts` returns **zero matches**. The interval keeps firing for the lifetime of the Node process. On a long-running pi session (hours/days), every 5 s tick walks the artifact dir of every (now-orphaned) sub-agent. The handle is never `.unref()`-ed either, so the interval pins the loop — a clean Ctrl-D / `q`-quit may hang until something kills the interval.

**Fix:** in `session_shutdown`, `clearInterval(g.__piSubagenturaInteractivePollerHandle)`, walk `interactiveSubagentRegistry` to kill live tmux panes for any `status === "running"`, then `.clear()` the registry.

---

## 4. Data loss in `processSessionLogChunk` — cursor advances past partial line

`subagent.ts:575-617`:

```ts
const len = size - cursor;
const buf = Buffer.alloc(len);
let bytesRead = 0;
while (bytesRead < len) { /* readSync into buf */ }
const chunk = buf.subarray(0, bytesRead).toString("utf8");
processSessionLogChunk(state, art, chunk);
state.lastDeliveredSessionByte = cursor + bytesRead;   // <-- advances past partial line
```

And in `processSessionLogChunk`:

```ts
// Last entry may be a partial line (the child hasn't finished writing it yet).
// We still process complete lines; the partial line will be re-read on the next tick.
const completeLines = chunk.endsWith("\n") ? lines : lines.slice(0, -1);
```

The comment is **false**. The cursor advances to `cursor + bytesRead` (line 606), so the partial final line is permanently skipped. If a tool-call JSONL entry straddles a 5 s poll boundary, its `tool_activity` event is silently dropped.

**Verified by the codifying test at `subagent-session-log.test.ts:261-286`**: the test writes a complete line + a truncated second line (`{ "type": "mess`), then asserts `events.filter(e => e.type === "tool_activity").toHaveLength(1)` — i.e. it expects the truncated line to be lost.

**Fix:** back the cursor up to `size - trailingIncomplete.length` (i.e. only advance to the last newline), or stream lines one at a time and advance the cursor only after a complete line is processed. Flip the codifying test to assert the partial is preserved across polls.

---

## 5. Unbounded `Buffer.alloc(len)` in `tailReadSessionLog` — OOM / TUI stall

`subagent.ts:575-609`:

```ts
const size = statSync(sessionFile).size;
const len = size - cursor;          // <-- unbounded
const buf = Buffer.alloc(len);      // <-- one allocation for the whole delta
let bytesRead = 0;
while (bytesRead < len) {
    const n = readSync(fd, buf, bytesRead, len - bytesRead, cursor + bytesRead);
    if (n <= 0) break;
    bytesRead += n;
}
const chunk = buf.subarray(0, bytesRead).toString("utf8");
processSessionLogChunk(state, art, chunk);
```

A single child `pi` write of a multi-MB `write`/`edit` tool-call argument, or a burst of tool calls between two polls, allocates the whole delta into one sync `Buffer` and `JSON.parse`s it on the main TUI thread. No cap, no streaming, no per-poll budget. Three concurrent runaway sub-agents can stall the TUI and OOM the parent.

**Fix:** cap `len` to e.g. 1 MiB per tick and carry the rest to the next tick, or use a `FileHandle` + `createReadStream` + `readline` for line-streaming. Either way, never allocate the full delta.

---

## Quick verification commands

```bash
# Issue 1
npm run pack:check

# Issue 2
sed -n '760,790p' subagent.ts

# Issue 3
grep -n "clearInterval" subagent.ts   # expect: no matches
sed -n '2020,2050p' subagent.ts

# Issue 4
sed -n '595,625p' subagent.ts
sed -n '255,295p' subagent-session-log.test.ts

# Issue 5
sed -n '575,615p' subagent.ts
```
