# Open Questions — Spec Phase (2026-06-18)

Captured from the Analyst agent during Part 1 spec creation. Each must be resolved
(or explicitly deferred) before consensus planning begins.

## Analyst Phase — Include, skip, or conditional?
- [ ] **OQ-1** — Should the workflow always run an Analyst agent first, require a pre-existing `specPath`, or make the analyst phase conditional on `specPath` absence? Affects the args contract and the script's phase graph.

## Role Prompt Source
- [ ] **OQ-2** — Where do the Planner/Architect/Critic role prompts come from? (a) inlined as string literals in the workflow script (~12 KB), (b) read by each agent via file tools, or (c) persona-prefix only and let the model infer. Inlining is most reproducible.

## Who Writes `plans/plan.md`
- [ ] **OQ-3** — Does the Critic agent write the final plan on its ACCEPT verdict, or does the workflow script do it itself? The script cannot read files (no `fs` in the `vm` sandbox), so Critic-writes is the only feasible path — but Critic must be instructed to copy `plan_draft.md` → `plan.md` after writing its verdict.

## ACCEPT-WITH-RESERVATIONS Semantics
- [ ] **OQ-4** — Should `ACCEPT-WITH-RESERVATIONS` from the Critic count as success (and surface the reservations in the return value), or trigger another iteration? Conservative default: count as success.

## Escalation Path on Disagreement
- [ ] **OQ-5** — When Architect and Critic fundamentally disagree, the original protocol halts and asks the user. Inside a `vm` workflow we cannot prompt mid-run. Should the workflow throw a structured error and let the caller (the main agent) decide?

## Default `workingDir`
- [ ] **OQ-6** — If `args.workingDir` is omitted, fall back to `args.workingDir ?? '.'`? The script's cwd in `vm.runInNewContext` is the parent process cwd; safer to require `workingDir` explicitly.

## DELIBERATE Mode Tri-State
- [ ] **OQ-7** — `args.deliberate === true` → DELIBERATE; `false` → SHORT; omitted → auto-detect from idea text. Confirm the boolean tri-state convention.

## Workflow Composition / Nesting
- [ ] **OQ-8** — Should the analyst phase be a nested `workflow(name)` call? `MAX_WORKFLOW_DEPTH = 1` permits it, but nesting adds complexity for no clear gain. Default: keep flat.

## Distribution Path for the Saved Workflow
- [ ] **OQ-9** — `save_workflow` writes to `~/.pi-subagentura/workflows/{name}.js`. Should the workflow instead be bundled as a static asset inside `pi-subagentura` itself (e.g., `src/workflows/ralplan-consensus.js`)? Bundling makes it part of the package; saving via the tool makes it user-scoped.

## Machine-Readable Consensus Summary
- [ ] **OQ-10** — Should the workflow write a `consensus.md` (iteration history + verdicts) for downstream tooling? Adds writer complexity; out of scope for v1.
