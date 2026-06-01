# Deep Analysis: Option 2 vs Option 3

## The Core Question

**Where should we write the exit file to capture the subagent's FINAL result?**

Two candidate locations:
- **Option 2:** `session_shutdown` event (the terminal event of the entire session)
- **Option 3:** `agent_end` event filtered by `stopReason === "stop"` (only on natural completion)

## Lifecycle Recap (from pi-coding-agent docs)

```
user sends prompt
  └─► agent_start
      └─► turn (repeats while LLM calls tools)
          └─► turn_end
      └─► agent_end                            ◄── Option 3 reads stopReason here
user sends another prompt ◄────────────────────┘

/new, /resume, /fork, exit (Ctrl+C, /quit)
  └─► session_shutdown                        ◄── Option 2 writes exit here
```

## Industry Precedents

### OpenAI Agents SDK
- `RunResultStreaming.is_complete` - "whether the streamed run has fully finished"
- `final_output` - "stays None until the stream has finished processing"
- **Pattern:** Detect terminal state, not intermediate

### Claude API Best Practices
- Canonical agentic loop: `while stop_reason == "tool_use"` then exit
- The agent loop exits ONLY on non-tool_use stop reasons
- **Pattern:** Loop terminates on natural completion, framework handles rest

### Cloudflare Agents (Think)
- `onChatResponse` - "After turn completes and message is persisted" - **terminal event**
- `onStepFinish` - per step (one model call + tool calls)
- `onStepFinish` vs `onChatResponse` distinction is EXACTLY like agent_end vs session_shutdown
- **Pattern:** Terminal events for terminal actions

## Comparison Matrix

| Criterion | Option 2 (session_shutdown) | Option 3 (stopReason === "stop") |
|-----------|----------------------------|----------------------------------|
| **Semantic correctness** | ✅ Exit file = "session has truly ended" | ⚠️ Exit file = "agent's last turn was natural" |
| **Single source of truth** | ✅ One event, one place to write | ⚠️ Multiple stopReasons to handle |
| **Future-proof** | ✅ New stopReasons require no code change | ❌ Each new stopReason needs handling |
| **Race conditions** | ✅ Guaranteed last event | ⚠️ Concurrent agent_end + shutdown could race |
| **Reentrancy safety** | ✅ Write once at end | ⚠️ Could write multiple times |
| **Output capture** | ✅ Captures everything before session ends | ✅ Captures last assistant message |
| **Complexity** | Simple - one event handler | Medium - conditional logic |
| **Debuggability** | ✅ Clear: "exit file = session ended" | ⚠️ Need to trace which stopReason triggered write |
| **State dependency** | ✅ Reads final state | ⚠️ Reads intermediate state |
| **Edge case: Abort+Continue** | ✅ Works (write only at true end) | ⚠️ Could write wrong state if abort and then stop |
| **Edge case: length (max_tokens)** | ✅ Written at session end with full output | ❌ Written with truncated output |
| **Edge case: error** | ✅ Session ends, exit written | ✅ Written immediately |
| **Edge case: empty response** | ✅ Final state captured | ⚠️ Could miss follow-up completion |
| **Parent code requirement** | Parent must call ctx.shutdown() at end | Parent can shutdown at any stopReason |
| **Performance** | Single file write | May write multiple times |

## Critical Edge Cases

### Edge Case 1: Abort and Continue (PRIMARY USE CASE)

**Option 2:**
```
Turn 1: aborted (stopReason = "aborted")
  → agent_end fires → NO write
  → ctx.shutdown() deferred (agent continues)
  → Inject "continue"
Turn 2: natural completion (stopReason = "stop")
  → agent_end fires → ctx.shutdown() called
  → session_shutdown fires → WRITE EXIT FILE ✓
```

**Option 3:**
```
Turn 1: aborted (stopReason = "aborted")
  → agent_end fires → stopReason !== "stop" → NO write
  → ctx.shutdown() deferred
  → Inject "continue"
Turn 2: natural completion (stopReason = "stop")
  → agent_end fires → stopReason === "stop" → WRITE EXIT FILE ✓
```

Both work the same here. ✓

### Edge Case 2: Length (max_tokens) Truncation

**Option 2:**
```
Turn 1: max_tokens reached (stopReason = "length")
  → agent_end fires → NO write
  → ctx.shutdown() called
  → session_shutdown fires → WRITE EXIT FILE (full session output) ✓
```

**Option 3:**
```
Turn 1: max_tokens reached (stopReason = "length")
  → agent_end fires → stopReason !== "stop" → NO write
  → ctx.shutdown() called
  → session_shutdown fires → NO write (Option 3 doesn't write here)
  → EXIT FILE NEVER WRITTEN ❌
```

**Option 2 wins:** Catches the final output even if last turn was truncated.

### Edge Case 3: Tool Use → Multiple Turns → Natural Completion

**Option 2:**
```
Turn 1: toolUse → NO write
Turn 2: toolUse → NO write
Turn 3: stop → ctx.shutdown() → session_shutdown → WRITE ✓
```

**Option 3:**
```
Turn 1: toolUse → NO write
Turn 2: toolUse → NO write
Turn 3: stop → WRITE ✓
```

Both work. ✓

### Edge Case 4: User Ctrl+C (External Interrupt)

**Option 2:**
```
SIGINT received
  → session_shutdown fires (reason: "quit")
  → WRITE EXIT FILE (whatever state we have) ✓
```

**Option 3:**
```
SIGINT received
  → session_shutdown fires
  → but Option 3 doesn't write here
  → EXIT FILE NEVER WRITTEN ❌
```

**Option 2 wins:** Catches external interrupts.

### Edge Case 5: parentCalls `ctx.shutdown()` from External Code

**Option 2:**
```
External code calls ctx.shutdown()
  → session_shutdown fires
  → WRITE EXIT FILE ✓
```

**Option 3:**
```
External code calls ctx.shutdown()
  → session_shutdown fires
  → Option 3 doesn't write
  → EXIT FILE NEVER WRITTEN ❌
```

**Option 2 wins:** Works regardless of WHO calls shutdown.

### Edge Case 6: StopReason = "aborted" (Single Turn, No Continue)

**Option 2:**
```
Single turn aborted
  → ctx.shutdown() called
  → session_shutdown fires → WRITE EXIT FILE
  → Output: incomplete (last assistant message was aborted)
```

**Option 3:**
```
Single turn aborted
  → agent_end → stopReason === "aborted" → NO write
  → ctx.shutdown() → session_shutdown → NO write
  → EXIT FILE NEVER WRITTEN ❌
```

**Option 2 wins:** Always writes something.

### Edge Case 7: Empty Response (end_turn with no content)

From Claude API docs: "Sometimes Claude returns an empty response (exactly 2-3 tokens with no content) with stop_reason: 'end_turn'. This typically happens when Claude interprets that the assistant turn is complete, particularly after tool results."

**Option 2:**
```
Empty response (stopReason = "stop")
  → agent_end fires → ctx.shutdown()
  → session_shutdown → WRITE EXIT FILE (empty) ✓
```

**Option 3:**
```
Empty response (stopReason = "stop")
  → agent_end → stopReason === "stop" → WRITE EXIT FILE (empty) ✓
```

Both handle. ✓

## Architectural Insights

### The "Last Wins" Pattern
Option 3 has an inherent issue: it can write the exit file multiple times. The current implementation only writes once, but if you add ANY logic that re-emits or re-triggers, you get duplicate writes. This is a **write amplification** problem.

Option 2 has a natural guard: `session_shutdown` only fires once per session.

### The "State at Boundary" Principle
The exit file represents "what is the final state of the subagent?" This is fundamentally a **boundary state**, not a **turn state**.

- `agent_end` = turn boundary (intermediate)
- `session_shutdown` = session boundary (terminal)

The exit file should be written at the **session boundary**, not the **turn boundary**.

### The "Cleanup at Exit" Pattern
The `session_shutdown` event is documented for cleanup work:
> "Do cleanup work in `session_shutdown`, then reestablish any in-memory state in `session_start`"

Writing the exit file IS cleanup work - persisting the subagent's final state for the parent to read. This is **exactly** what `session_shutdown` is designed for.

### The "Race Condition" Risk
Option 3 has a subtle race condition risk:
```
agent_end fires (stopReason === "stop")
  ↓
[asynchronous writeExitSidecar starts]
  ↓
ctx.shutdown() called
  ↓
session_shutdown fires (simultaneously)
  ↓
[second writeExitSidecar might overlap]
```

In practice, fs.writeFileSync is synchronous, so this isn't a real issue. But the conceptual model is muddier.

Option 2 has no such risk:
```
ctx.shutdown() called
  ↓
session_shutdown fires (synchronously, after listeners)
  ↓
[writeExitSidecar runs]
  ↓
process.exit()
```

## Maintainability Analysis

### Adding New StopReasons in the Future
pi-ai types.ts defines: `"stop" | "length" | "toolUse" | "error" | "aborted"`

What if Anthropic adds `"pause_turn"` (which it has, for server tools)?

- **Option 2:** No code change needed. Exit file written at session end.
- **Option 3:** Need to add `else if (stopReason === 'pause_turn')` handling.

What if OpenAI adds a new stopReason?
- **Option 2:** No code change.
- **Option 3:** Need to update the switch.

### Adding New Session Termination Reasons
`session_shutdown` has reasons: `"quit" | "reload" | "new" | "resume" | "fork"`

- **Option 2:** Already handles all reasons uniformly.
- **Option 3:** Doesn't care about session reasons.

### Adding New Events
If pi-coding-agent adds new events (e.g., `agent_pause`, `agent_resume`):
- **Option 2:** Exit file logic stays the same.
- **Option 3:** May need to handle new events.

## Performance Analysis

### Option 2
- 0 writes during normal operation
- 1 write at session_shutdown
- 0 writes on intermediate turns
- 0 writes on abort-and-continue

### Option 3
- 0 writes during toolUse turns
- 1 write on natural completion
- 0 writes on aborted turns (if filter excludes aborted)
- 0 writes on length (if filter excludes length)

Both are similar in performance.

## Recommendation: **Option 2 (session_shutdown) is Better**

### Why?

1. **Semantically correct:** Exit file = "session ended", not "agent's last turn was natural"

2. **More edge cases handled:**
   - ✅ max_tokens (length) - Option 2 writes, Option 3 doesn't
   - ✅ External Ctrl+C - Option 2 writes, Option 3 doesn't
   - ✅ External ctx.shutdown() - Option 2 writes, Option 3 doesn't
   - ✅ Single aborted turn - Option 2 writes, Option 3 doesn't

3. **Future-proof:** New stopReasons need no code change in Option 2

4. **Single source of truth:** One event, one place to write

5. **Industry precedent:** OpenAI, Cloudflare Agents, and Claude API docs all use terminal events for terminal actions

6. **Documented pattern:** `session_shutdown` is explicitly documented as "do cleanup work"

7. **No race conditions:** Write happens once, at the very end, synchronously

8. **State at boundary:** Reads the final state of the session, not intermediate state

### When Option 3 Might Be Better

- If you want **immediate notification** of completion (don't wait for ctx.shutdown())
- If you want to differentiate between error and normal exit
- If the parent is deeply integrated and can handle multiple writes

But for THIS use case (parent waiting for subagent to truly finish, then reading exit file), **Option 2 is unambiguously better**.

## Score: Option 2 = 9/10, Option 3 = 6/10
