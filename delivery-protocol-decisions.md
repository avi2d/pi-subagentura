# Delivery Protocol Decisions

Status: accepted requirements for the delivery-protocol redesign patch.

## Per-turn output history

- `output.md` is the mutable staging file for only the active child turn.
- Reset only `output.md` when a new turn starts.
- On completion, snapshot the active turn's staging output to immutable
  `outputs/<eventId>.md`.
- The completion event maps its Pi-derived `turnId` to the immutable snapshot.
- Never delete or overwrite previous immutable snapshots.
- A turn that writes no output must produce an empty/missing-output result or an
  explicit error. It must never inherit a previous turn's `output.md`.
- Historical protocol-v2 outputs must be discoverable and readable by turn, not
  merely retained on disk.

## Parent delivery modes

- `inject` persists the full turn output as an attributed custom message in the parent context.
- `notify` persists a pointer-only custom message in the parent context without injecting output.
- `notify` with `triggerTurnOnComplete: true` persists the pointer and wakes the main agent immediately.
- `inject` with `triggerTurnOnComplete: false` persists the full output without waking the main agent.
- Async in-process tools continue to default to `inject`; the public `subagent_interactive` tool defaults to `notify` with `triggerTurnOnComplete: true`.

## Required patch changes

- Do not implement untriggered `notify` with `ui.notify()` alone; that is
  visual-only and does not enter parent model context.
- Do not leave async in-process completion delivery silent when
  `notifyOnComplete` is omitted.
- Prevent stale `output.md` content from being snapshotted for a later turn.
- Extend artifact read/list behavior so protocol-v2 history can be resolved from
  `turnId` to `eventId` to `outputs/<eventId>.md`.
