# Final Deep Analysis: Option 2 (session_shutdown) vs Option 3 (stopReason === "stop")

## TL;DR

**Option 2 (session_shutdown) is the better solution.** Score: 9/10 vs 6/10.

## 1. Evidence from Official Documentation

### pi-coding-agent Docs (the framework we're building for)
> "**Do cleanup work in `session_shutdown`**, then reestablish any in-memory state in `session_start`."

Writing the exit file IS cleanup work. This is what `session_shutdown` is explicitly designed for.

The `session_shutdown` event has reasons: `"quit" | "reload" | "new" | "resume" | "fork"`
- Covers all possible session termination cases uniformly

### OpenAI Agents SDK
> `RunResultStreaming.is_complete` - "whether the streamed run has fully finished"
> `final_output` - "stays None until the stream has finished processing"

The pattern is: detect terminal state, not intermediate.

### Claude API Docs (Best Practices)
The agentic loop canonical pattern:
> "while stop_reason == "tool_use": execute_tools(continue)"

The loop **exits on non-tool_use stop reasons** - the framework handles terminality separately.

### Cloudflare Agents (Think framework)
- `onStepFinish` - per step (one model call + tool calls)
- `onChatResponse` - "**After turn completes and message is persisted**" - terminal event
- The documentation explicitly distinguishes "step" (intermediate) from "turn/response" (terminal)

## 2. Edge Case Analysis (Critical)

| Edge Case | Option 2 | Option 3 |
|-----------|----------|----------|
| Normal completion | ✅ Writes | ✅ Writes |
| Abort + Continue (your use case) | ✅ Writes once at end | ✅ Writes once at end |
| `length` (max_tokens truncated) | ✅ **Writes** | ❌ **Never writes** |
| External Ctrl+C (SIGINT) | ✅ Writes | ❌ Never writes |
| External `ctx.shutdown()` from tool | ✅ Writes | ❌ Never writes |
| Single aborted turn (no continue) | ✅ Writes | ❌ Never writes |
| Multiple `toolUse` → final `stop` | ✅ Writes once | ✅ Writes once |
| Empty response (end_turn no content) | ✅ Writes | ✅ Writes |
| Future new stopReason (e.g., `pause_turn`) | ✅ No code change | ❌ Code update needed |

**Key finding:** Option 2 handles ALL termination scenarios. Option 3 misses several.

## 3. Architectural Analysis

### What does the exit file represent?

The exit file represents: **"the final state of the subagent's work for this session"**

This is fundamentally a **session-level state**, not a **turn-level state**.

- `agent_end` = turn boundary (intermediate, may have more turns)
- `session_shutdown` = session boundary (terminal, no more events)

The exit file should be written at the **session boundary**.

### Pattern: State at Boundary

This is a well-known pattern in concurrent systems:
- Write final state at the boundary, not at intermediate points
- Avoid race conditions and stale writes
- Single source of truth

### Race Conditions

**Option 3** has theoretical race risk:
```
agent_end (stopReason === "stop")
  ↓
[async writeExitSidecar starts]
  ↓
ctx.shutdown() called
  ↓
session_shutdown fires simultaneously
```

In practice fs.writeFileSync is synchronous, so this is theoretical. But the conceptual model is muddier.

**Option 2** has no such risk:
```
ctx.shutdown() called
  ↓
session_shutdown fires synchronously
  ↓
[writeExitSidecar runs]
  ↓
process.exit()
```

## 4. Maintainability Analysis

### Adding New StopReasons

pi-ai types define: `"stop" | "length" | "toolUse" | "error" | "aborted"`

What if Anthropic/OpenAI adds new stopReasons (like `pause_turn` for server tools)?

- **Option 2:** Zero code change. Exit file written at session end regardless.
- **Option 3:** Need to add `else if (stopReason === 'pause_turn')` handling. Easy to forget, leading to lost exit files.

### Adding New Session Termination Reasons

`session_shutdown` reasons: `"quit" | "reload" | "new" | "resume" | "fork"`

- **Option 2:** Already handles all reasons uniformly.
- **Option 3:** Doesn't care about session reasons.

### Code Complexity

**Option 2:** 8 lines of code in `session_shutdown` handler
```typescript
pi.on('session_shutdown', () => {
  const finalOutput = sessionOutput || '(no output)';
  writeExitSidecar(SESSION_DIR, 'done', { output: finalOutput });
  flushPendingActivity(SESSION_DIR);
});
```

**Option 3:** 40+ lines with conditional logic
```typescript
if (stopReason === 'stop') { /* write done */ }
else if (stopReason === 'error') { /* write error */ }
else { /* track activity */ }
// Plus the extractFromMessages helper function
```

## 5. Real-World Project Patterns

Looking at your project's existing code:

### `tmux-spawner.ts:328-329` (parent side)
```typescript
// When parent KILLS the subagent, write 'cancelled' exit
if (job.sessionDir) {
  const { writeExitSidecar } = require('./tmux-session');
  writeExitSidecar(job.sessionDir, 'cancelled');
}
```

The parent already has the capability to write the exit file in certain scenarios. This shows the **"exit file is written at the boundary"** pattern is already established in your codebase.

### `tmux-spawner.ts:87-97` (parent polling)
```typescript
function checkAllSessionsForExit(): void {
  for (const [jobId, job] of tmuxJobRegistry) {
    if (job.state !== 'running' && job.state !== 'attached') continue;
    if (!job.sessionDir) continue;
    const exitData = peekExitSidecar(job.sessionDir);
    if (exitData) {
      consumeExitSidecar(job.sessionDir);
      handleTmuxJobCompletion(jobId, exitData);
    }
  }
}
```

The parent polls for the exit file. When it appears, the job is marked complete. **The parent doesn't care HOW the exit file was written** - just that it exists.

This means both options work, but Option 2 is more reliable because it always writes the file at session end.

## 6. The "Documented Pattern" Argument

The pi-coding-agent docs explicitly state:

> "**Do cleanup work in `session_shutdown`**"

This is the **canonical pattern** for the framework we're extending. Following the documented pattern is the right choice for:
- Discoverability (other devs know where to look)
- Maintenance (less surprising)
- Future compatibility (pi-coding-agent may add features to session_shutdown)

## 7. Performance

| Metric | Option 2 | Option 3 |
|--------|----------|----------|
| File writes during normal flow | 0 | 0 |
| File writes at completion | 1 | 1 |
| File writes on abort+continue | 0 (intermediate) + 1 (final) | 0 (intermediate) + 1 (final) |
| File writes on abort only (no continue) | 1 (at session end) | 0 ❌ |
| File writes on Ctrl+C | 1 (at session end) | 0 ❌ |

Similar performance, but Option 2 always writes when needed.

## 8. Industry Precedent Summary

| Framework | Pattern |
|-----------|---------|
| OpenAI Agents SDK | `is_complete` flag for terminal detection |
| Cloudflare Agents | `onChatResponse` for terminal events |
| Claude API | Agent loop exits on non-tool_use, framework handles rest |
| LangChain | `AgentFinish` returned when stopping condition met |
| pi-coding-agent | `session_shutdown` for cleanup work |

**The industry pattern is: terminal events for terminal actions.** Option 2 follows this.

## Final Verdict

### **Option 2 (session_shutdown) is the right choice.**

Reasons:
1. ✅ Matches the documented pi-coding-agent pattern ("cleanup in session_shutdown")
2. ✅ Handles more edge cases (max_tokens, Ctrl+C, external shutdown)
3. ✅ Future-proof (new stopReasons don't need code changes)
4. ✅ Simpler code (8 lines vs 40+ lines)
5. ✅ Single source of truth
6. ✅ Industry precedent (terminal events for terminal actions)
7. ✅ More reliable (always writes when needed)

### Score: Option 2 = 9/10, Option 3 = 6/10

**Recommendation:** Merge Option 2 into the main branch.
