# Notification investigation — `notifyOnUpdate: "milestones"` never fired

**Date:** 2026-06-04
**Subject:** the 3 subagent reviewers I spawned (`fb5ed48e`, `e4841d23`, `62d44bbe`) all wrote their final reports to `/tmp/review-*.md`, then sat idle in their tmux panes. No `done`/`error`/`cancelled` event was ever written to the artifact `events.ndjson`. The parent (this session) never received the `notifyOnUpdate: "milestones"` pointer. I had to ask "any updates?" manually.

**Verdict:** working as designed — but the design has a gap. Interactive sub-agents that finish a turn without explicitly calling `cli.mjs done` are **invisible** to the notification system.

---

## Evidence

### The artifact `events.ndjson` for each reviewer

```
fb5ed48e : 108 events = 1 × started + 107 × tool_activity    last 138 min ago
e4841d23 : 103 events = 1 × started + 102 × tool_activity    last 137 min ago
62d44bbe : 158 events = 1 × started + 157 × tool_activity    last 133 min ago
```

**Zero `done`, zero `error`, zero `cancelled`, zero `wip`, zero `output_updated` events** in any of the three. (Verified by `grep -c '"type":"done"|"type":"error"|"type":"cancelled"|"type":"wip"|"type":"output_updated"'` → `0` for all three.)

### The tmux panes

```
1: node* (1 panes) [143x42] @90 (active)                       <- parent
2: review-security (1 panes) [143x42] @109                    <- child
3: review-reliability- (1 panes) [143x42] @110                <- child
4: review-api-dx (1 panes) [143x42] @111                      <- child
```

Panes 2/3/4 are **still alive**. `tmux capture-pane -p -t 87:review-security` shows the last lines of pane 2 are:

```
 Review written to /tmp/review-security.md (304 lines, 6 sections).
 Chat Summary
 [summary text...]
─────────────────────────────────────
─────────────────────────────────────
~/dev/pi-agents (codex-tmux-oneshot) • review-security
↑151k ↓24k R5.7M $0.419 11.8%/1.0M (auto)  (minimax) MiniMax-M3 • medium
rtk ✓
```

The `pi` REPL prompt is back. The child finished its first turn, printed a summary, and is **sitting at a prompt waiting for more input**. The bash wrapper script is also still alive (because `pi` is still alive), so the EXIT trap has not fired.

### The parent session log

Searched all three parent `*.jsonl` files for `subagent`/`notif`/`done`/`cancelled`/`interactive` — only the originating `subagent_interactive` tool calls themselves (15/12/44 mentions) — **no lifecycle event from the poller reached the parent**.

---

## Root cause

The notification chain is:

```
child pi exits
  → bash trap fires: cli.mjs done <exitCode>
    → appends {"type":"done", "status":"done", "exitCode":0} to artifact events.ndjson
      → parent poller (5s setInterval) reads new event
        → shouldNotify(event, "milestones") returns true (line 487-493 of subagent.ts)
          → pi.sendMessage(...) injects a pointer into the parent's LLM context
```

The chain is intact and correct **for any sub-agent that exits**. The break is at step 1: **the child `pi` does not exit.** It runs in **interactive REPL mode** (`pi --session … @<promptFile>`, see `interactive-tmux.ts:161-168`). After the first turn it returns to a prompt and stays there indefinitely. The bash wrapper around it therefore never exits, the trap never fires, and no terminal event is ever written.

### Why `shouldNotify` can't help

`subagent.ts:478-494`:

```ts
function shouldNotify(event: SubagentEvent, mode: NotifyOnUpdate): boolean {
    if (mode === "off") return false;
    if (event.type === "tool_activity") return false;   // silent
    if (event.type === "started") return false;          // silent
    // output_updated is no longer in any mode — the LLM sees the final result on done.
    if (mode === "milestones") {
        return (
            event.type === "done" ||
            event.type === "error" ||
            event.type === "cancelled"
        );
    }
    // "all": lifecycle + wip (legacy opt-in for live progress)
    return true;
}
```

Under `"milestones"` the only way the parent is told is via `done`/`error`/`cancelled`. Under `"all"` the parent also gets `wip` (which the children never called). `output_updated` is **deliberately suppressed in all modes** (the comment says "the LLM sees the final result on done" — true only if `done` is ever written).

So the system is **structurally incapable of notifying on a child that has gone idle without writing a terminal event**.

### Why my reviewers triggered the gap

I instructed them to write their final reports to `/tmp/review-*.md` (so the parent could `read` them). I did not instruct them to call `cli.mjs done` after writing. A child that follows the system prompt literally — finish the task, print a summary, wait — produces zero terminal events. This is the default behavior of an LLM agent in interactive mode and is exactly the case the design doesn't handle.

---

## The fix(es)

Pick one of these layers, depending on the desired UX. All are small.

### Option 1 — Idle detection in the poller (recommended)

**Where:** `subagent.ts:533-547` (`pollArtifactChanges`), in the per-state loop, before/after the `readEvents` call.

**What:** for each running interactive sub-agent, additionally tail-read the child's session log and check whether the last entry is an assistant message and there has been no new `tool_activity` for N seconds (e.g. 30 s). If so, emit a synthetic `done` event into the artifact's `events.ndjson` (or call the same `deliverArtifactNotification` code path directly) and let `shouldNotify` handle it.

The data is already on disk: `tailReadSessionLog` (`subagent.ts:575-617`) reads the child's session file; the last entry's `message.role === "assistant"` and a quiet period is exactly the "child finished a turn" signal.

Sketch:

```ts
// in pollArtifactChanges, per state:
const idleFor = Date.now() - (state.lastToolActivityTs ?? 0);
const lastEntry = readLastSessionEntry(state.sessionFile);
if (
    state.status === "running"
    && lastEntry?.message?.role === "assistant"
    && !state.turnCompletionNotified
    && idleFor > 30_000
) {
    state.turnCompletionNotified = true;
    // synthesize a done event so shouldNotify fires:
    appendEvent(art, { ts: Date.now(), type: "done", status: "done", exitCode: 0 });
    // or directly call deliverArtifactNotification with a synthetic event
}
```

Tradeoff: 30 s of "false silence" after a turn. Tunable.

### Option 2 — Force non-interactive `pi` in the launch script

**Where:** `interactive-tmux.ts:161-168` (the `buildLaunchCommand` function) and the `pi` invocation at line 273.

**What:** use `pi --print` (or whatever the non-interactive flag is) so `pi` exits after the first turn. The bash trap fires, `cli.mjs done` is written, notification works.

Tradeoff: **kills the "interact with running sub-agents" feature** — the whole point of `subagent_interactive` is that the child stays alive and the user can attach to it. This option throws the baby out with the bathwater.

**Unless** the launch script does something like: `pi @<file> & sleep 1; ...interactive shell here...` — i.e. start the turn, then expose the prompt. Complicated; not recommended.

### Option 3 — Wrap `pi` with `timeout`

**Where:** same as Option 2.

**What:** `timeout 30m pi …` so the child dies after 30 minutes, the bash trap fires, and notification happens. The user can re-launch if they want to keep going.

Tradeoff: a hard cap. If the user is mid-investigation the child dies under them. Not great UX.

### Option 4 — Document and require explicit `cli.mjs done`

**Where:** the system prompt / persona that's sent to the child (`interactive-tmux.ts:300-304` writes the system prompt; `interactive-tmux.ts:304` writes the @-file prompt).

**What:** instruct the child LLM: "When you have completed the user's task and have nothing more to add, run `$ARTIFACT_DIR/cli.mjs done 0` so the parent can be notified."

Tradeoff: LLMs are unreliable at this. They might forget, or they might call it twice. Also requires no code changes — just better docs/system prompts.

**Could be combined with Option 1** as a backstop.

### Recommended combination

**Option 1 (idle detection) + Option 4 (system-prompt instruction).** Option 1 catches the case where the child forgot; Option 4 gives the child a clean way to signal completion when it does remember. Together they make the notification system robust without breaking the interactive-attachment feature.

---

## Additional issues uncovered during this investigation

These are smaller than the 5 Critical issues in `crit.md` but worth filing:

- **The 5 s `setInterval` poller in the parent has been polling these 3 zombie sub-agents every 5 s for 2+ hours** (≈ 1440 ticks × 3 agents = ~4320 needless iterations). This is a real-world example of the leak flagged as Critical #3 in `crit.md`. The setInterval survives `session_shutdown` cleanup; if the parent process is the long-running Pi session itself, this is the same handle that will keep the loop pinned on quit.
- **`get_interactive_subagent_status` would have told the parent the children were idle** — but the notification system is supposed to push that info, not require the parent to poll. The mismatch between push (`notifyOnUpdate`) and pull (`get_status`) is the user-visible bug.
- **The launch-script's `tmux set-option -p -t "$TMUX_PANE" @pi-exit-code "$?"` fallback** (`interactive-tmux.ts:272`) also doesn't fire for the same reason. It would have been a redundant safety net.

---

## Quick verification commands

```bash
# Are the children still alive? (Yes — listed as windows 2/3/4)
tmux list-windows -t 87

# Did any 'done'/'cancelled'/'error' event get written?
for j in fb5ed48e e4841d23 62d44bbe; do
  grep -c '"type":"done"\|"type":"error"\|"type":"cancelled"' \
    /Users/applesucks/.pi/agent/sessions/subagentura/pi-agents-*/artifacts/$j/events.ndjson
done
# All return 0.

# What was the last activity in each pane?
tmux capture-pane -p -t 87:review-security    -S -20
tmux capture-pane -p -t 87:review-reliability -S -20
tmux capture-pane -p -t 87:review-api-dx      -S -20
```
