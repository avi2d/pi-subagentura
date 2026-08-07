# Workflow redesign implementation TODO

Source: `aq.md`, answered against PR #84. Items are kept in checklist order and must be marked complete only after implementation and verification.

## Durable authority and outbox

- [x] 1. Wire durable run creation before dispatch through the production extension path.
- [x] 2. Make `get_workflow_result` recover terminal results from durable projections after registry loss.
- [ ] 3. Repair result, terminal, delivery-intent, dispatch, and receipt crash gaps independently.
- [x] 4. Fence stale and duplicate evidence from reopening terminal work.
- [x] 5. Dispatch deterministic terminal delivery intents and persist dispatch before receipt.
- [ ] 6. Make cancellation idempotent across reload and reconstructed owners.
- [ ] 7. Restore interrupted, blocked, and budget-paused runs as actionable after restart.

## Ownership, leases, and storage safety

- [x] 8. Integrate one namespace lease so concurrent Pi processes cannot write together.
- [ ] 9. Add process identity/liveness checks and fail-closed stale takeover.
- [ ] 10. Apply owner, token, and epoch fencing to every durable mutation.
- [ ] 11. Harden filesystem storage against symlinks, hardlinks, races, traversal, and non-regular files.
- [x] 12. Stop recovery on malformed complete event lines.
- [x] 13. Recover torn tails only at complete-line byte boundaries.
- [ ] 14. Complete ENOSPC, event, run, owner-byte, blob, and output quota behavior.
- [x] 15. Retain active, blocked, approval-pending, interrupted, and undelivered terminal runs.

## Parallel execution and accounting

- [ ] 16. Cover committed/running/undispatched sibling crash recovery.
- [ ] 17. Add a namespace-shared dispatcher with process and in-process caps.
- [ ] 18. Make stop-on-failure draining and dispatch order deterministic.
- [x] 19. Deduplicate attempt accounting across replay and crash boundaries.
- [ ] 20. Mark interrupted usage as an explicit lower bound with provenance.
- [ ] 21. Make terminal task and result ordering stable across reloads.

## Process-child handshake and adoption

- [ ] 22. Persist process launch intent before pane creation.
- [ ] 23. Persist attempt nonce, epoch, launch marker, and effective fallback mode.
- [ ] 24. Persist launch dispatch and validate child start before model work.
- [ ] 25. Discover, fence, and adopt intended panes after startup crashes.
- [ ] 26. Probe and fence ambiguous command dispatch before retry.
- [ ] 27. Reject stale child nonce, attempt, and epoch evidence.
- [ ] 28. Project dead-child usage as a lower bound.

## Durable JavaScript replay

- [ ] 29. Add explicit stable IDs for durable `agent()` and nested `workflow()` calls.
- [ ] 30. Snapshot root and nested definitions into immutable durable blobs.
- [ ] 31. Persist dispatch and response ordinals independently.
- [ ] 32. Replay all worker-visible response kinds in original order.
- [ ] 33. Bound nondeterministic Promise and nested replay as `replay_diverged`.
- [ ] 34. Fail boundedly on missing response ordinals.
- [ ] 35. Detect prompt/options/schema/model/isolation/definition divergence.
- [x] 36. Preserve legacy non-durable script/name behavior.
- [ ] 37. Reject unsupported durable concurrency before `run_created`.

## Plan mutations and human editing

- [ ] 38. Require exact owner, lease epoch, and base revision for mutations.
- [x] 39. Restrict mutations to pending or blocked future tasks.
- [x] 40. Keep running and terminal task definitions/history immutable.
- [x] 41. Preserve skip as an audited append-only event.
- [ ] 42. Add monotonic mutation content hashes and a verified hash chain.
- [ ] 43. Wake the single executor without starting model work in the mutation path.
- [ ] 44. Preserve plan, phase modes, stable IDs, and read-only history in export/view.
- [ ] 45. Return stale-editor refresh/diff data without changing authority.
- [ ] 46. Enforce owner-only, contained, interactive edit/export paths.

## Context, reminders, and approvals

- [ ] 47. Inject bounded factual continuity context after reload/compaction.
- [ ] 48. Include required run/revision/status/phase/task/count fields without outputs.
- [ ] 49. Suppress reminders for active wakeups, all-blocked runs, and pending input.
- [ ] 50. Cap reminders per turn/generation and reset on progress.
- [ ] 51. Bind and single-consume approvals to all authority fields.
- [x] 52. Keep approval grants on trusted host paths, not model-callable tools.
- [ ] 53. Make stale, wrong-owner, duplicate, and post-reload decisions no-ops.
- [ ] 54. Wake the correct continuation once and implement denial policy.

## Release and compatibility gates

- [ ] 55. Expand minimum/latest SDK compatibility coverage to durable and routing behavior.
- [ ] 56. Assert packed runtime/public types and exclude stores, fixtures, temporary plans, and secrets.
- [ ] 57. Add measured routing rollout gates and policy lanes.
- [ ] 58. Test preferred routing suppression for all listed contexts.
- [ ] 59. Track observed routing compliance and report `routing_unconfirmed` honestly.
- [x] 60. Reject unsupported durable legacy requests instead of silently downgrading.

## Verification

- [x] Run `npm run typecheck`.
- [x] Run `npm test`.
- [x] Run `npm run format:check`.
- [x] Run `npm run pack:check`.
