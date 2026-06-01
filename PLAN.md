# Option 2: Exit File on session_shutdown

## Problem
Current code writes exit file at EVERY `agent_end`, but `agent_end` fires after each turn, not just final completion. This causes incorrect exit file when subagent is aborted and asked to continue.

## Solution
Write exit file ONLY at `session_shutdown` event, which fires when `ctx.shutdown()` is called and the session is truly ending.

## Implementation Plan

### 1. Modify `tmux-child.ts`

**Remove** exit file writing from `agent_end` handler:
- Remove `writeExitSidecar` calls from the `agent_end` handler
- Keep activity tracking only

**Add** exit file writing to `session_shutdown` handler:
- Add `writeExitSidecar` call with final output

### 2. Key Code Changes

```typescript
// agent_end handler - DON'T write exit file here
pi.on('agent_end', (event: any, ctx: ExtensionContext) => {
  // Track activity only
  writeTmuxActivity(SESSION_DIR, {
    phase: 'active',
    activeScope: 'idle',
    latestEvent: 'agent_end',
  });
  
  // IMPORTANT: Still call ctx.shutdown() to trigger session_shutdown
  ctx.shutdown();
});

// session_shutdown handler - WRITE exit file here
pi.on('session_shutdown', () => {
  // Extract final output from sessionOutput variable
  const finalOutput = sessionOutput || '(no output)';
  
  writeExitSidecar(SESSION_DIR, 'done', { output: finalOutput });
  
  // Flush activity
  flushPendingActivity(SESSION_DIR);
  writeTmuxActivity(SESSION_DIR, {
    phase: 'done',
    activeScope: 'idle',
    latestEvent: 'session_shutdown',
  });
});
```

### 3. Edge Case: Abort and Continue

Flow:
1. Turn ends with `stopReason = "aborted"` (ctx.abort() was called)
2. `agent_end` fires → NO exit file written ✓
3. Parent injects continue message
4. Agent continues with Turn 2
5. Eventually natural completion → `ctx.shutdown()` called
6. `session_shutdown` fires → exit file written with final result ✓

### 4. Test Cases

1. **Natural completion**: Exit file written with final output
2. **Error completion**: Exit file written with error
3. **Abort and continue**: Exit file written only after final completion
4. **Multiple aborts**: Exit file written only at true end

## Files to Modify
- `/Users/applesucks/dev/pi-agents-option2/tmux-child.ts`

## Instructions
1. Read the current tmux-child.ts file
2. Make the changes as described above
3. Run tests if any exist to verify the changes work
