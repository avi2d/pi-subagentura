# PR #84 X01–X06 boundary matrix

Status: **X01 partial implementation; X02–X06 deferred**.

This document is separate from the F01–F20 acceptance contract. It records only
claims backed by the current production path. A helper API or unit test is not
counted as production closure unless a registered workflow path exercises it.

## X01 — durable process-child launch and adoption

### Proven in this worktree

- Declarative durable plans may request `isolation: "process"`.
- The durable runner preserves that requested isolation when invoking its
  registered `runAgent` implementation.
- Before invoking the agent, the runner appends a claim-bound
  `process_launch_intent` event containing the run/task/attempt identity,
  attempt number, lease epoch, nonce, launch marker, requested/effective
  isolation, and fallback mode.
- The registered `start_durable_workflow` path has executed a real process task
  to terminal success and the persisted journal contains the launch intent
  after `task_started`.

Evidence:

- `src/workflow-durable-plan-runner.ts`
- `src/workflow-plan.ts`
- `src/workflow-run-store.ts`
- `tests/workflow-durable-plan-runner.test.ts` — intent ordering and payload
- `tests/workflow-contract-foundation.test.ts` — plan admission
- `tests/workflow-acceptance-lifecycle-compatibility.test.ts` — F18 real
  `start_durable_workflow` process lane

### Still deferred

The following are not claimed: durable `launch_dispatched` before the actual
multiplexer command send; child `started` evidence bound to the persisted nonce
and marker; pane adoption after coordinator restart; stale-candidate fencing;
exactly-one-child enforcement; dead-child accounting with complete-vs-lower-bound
usage; and reconciliation across a different host or multiplexer namespace.
The existing `workflow-process-handshake.ts` helpers remain helper-level until
those production paths are wired and independently exercised.

## X02 — durable arbitrary-JavaScript replay

**Deferred.** Durable declarative process-task admission is not durable replay of
arbitrary JavaScript. Stable call IDs, immutable root/nested definition
snapshots, independent dispatch/response ordinals, ordered response replay,
`replay_diverged` handling, missing-ordinal failure, and definition/options
fingerprinting are not claimed for the legacy JavaScript workflow path.

## X03 — host-forced routing

**Deferred.** Routing policy remains opt-in. Local routing helpers and measured
policy tests do not prove host enforcement for every listed context, nor do they
prove environment compliance when the selected multiplexer is unavailable.
`routing_unconfirmed` remains the honest result for unmeasured compliance.

## X04 — autonomous wake after mutation

**Deferred.** Mutations and approval/budget changes remain durable and
owner/epoch/revision fenced, but an eligible mutation does not yet wake a
single existing executor automatically. Explicit resume remains required; the
mutation path does not claim to start model work.

## X05 — exactly-once execution and notification

**Deferred.** The journal and delivery identifiers support idempotent recovery
and at-least-once-oriented accounting. They do not establish exactly-once model
execution or exactly-once external notification across crashes, process death,
transport retries, or coordinator failover.

## X06 — same-user path-race containment

**Deferred.** Existing storage checks reject malformed/non-regular paths and
exercise helper-level symlink/substitution defenses. This worktree makes no
`openat2`-class claim against a malicious same-user parent-directory rename or
substitution race. Closing that boundary requires a platform-specific native
primitive (or an equivalently strong verified implementation), plus adversarial
multi-process evidence.

## Verdict rule

Only the proven subset above may be described as implemented. X01–X06 must not
be summarized as all PASS until each deferred subsection has direct production
and adversarial evidence.
