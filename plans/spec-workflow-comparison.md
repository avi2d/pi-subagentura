# Workflow Plans: A vs B vs C — Comparison

**Date:** 2026-06-08
**Author:** planning agent

## Feature matrix

| Capability | **A: in-process `vm`** | **B: sidecar subprocess** | **C: `worker_threads`** |
|---|---|---|---|
| New code LOC (new + modified) | ~1,560 | ~3,100 (revised: +~250 for §11 cross-platform) | ~1,650 |
| New npm bin | No | Yes (`pi-workflow-runner`) | No |
| New build step | No | No | No (if `workflow-worker.mjs` is hand-written ESM) |
| Heap isolation (workflow ↔ parent) | None — shared | Full — separate process | Full — separate V8 isolate |
| Workflow outlives the spawning turn | No | Yes (artifact + reconnect) | No |
| Workflow survives parent crash | No | Yes (artifact on disk) | No |
| Preemptive abort on cancel | No (cooperative only) | Yes (`subprocess.kill()`; platform-portable) | Yes (`worker.terminate()`) |
| Reuses `startSubagentJob` from `helpers.ts` | Yes (direct import) | Yes (imported in runner) | Yes (via postMessage proxy) |
| Reuses `jobRegistry` for status/cancel tools | Yes (with `kind: "workflow"`) | No (runner is private) | Yes (with `kind: "workflow"`) |
| New failure modes introduced | Loop blocks parent; sandbox escape | Runner-died; stdio backpressure; protocol drift; cross-platform regression | postMessage overhead; Worker startup; sandbox escape |
| Effective concurrency ceiling (parallel sub-agents) | Bounded by parent heap; default 8 | Bounded by runner heap; default 8 | Bounded by worker heap; default 8 |
| Order-of-magnitude dev time | 3 days | **8 days** (was 7, +1 for cross-platform matrix + CI matrix) | 4 days |
| Order-of-magnitude token cost (LLM at runtime) | O(return-value size) | O(return-value size) | O(return-value size) |
| Cross-platform (Windows-friendly) | Yes | **Yes** (§11 compatibility matrix; v1 is cross-platform from day one) | Yes |
| Version bump | 2.2.0 (minor; was 2.1.0, but 2.1.0 was already published) | 2.2.0 (minor; new bin) | 2.2.0 (minor) |
| Backward compatible | Yes | Yes | Yes |

## When to pick each

### Plan A — in-process `node:vm`

**Pick A** when you want the smallest possible change, the fastest path to a working feature, and you're confident the workflow's intermediate state fits comfortably in the parent Pi's heap. Authors iterate on scripts, learn what works, and you defer the resilience question. This is the right "ship the v1" choice. A workflow that allocates 100 MB of intermediates is fine; a workflow that allocates 1 GB will starve the parent.

### Plan B — sidecar subprocess

**Pick B** when you have a real need for workflows to outlive the spawning turn, survive a parent Pi crash, or run cross-platform (Windows is a hard requirement, not a v2 follow-up). A 30-minute audit across 500 files, where the user wants to start it, walk away, and read the result later, is a B-shaped use case. B is the only plan that delivers Claude Code's "workflow is checkpointed and resumable" property. It is also the most code (~3,100 LOC, **8 dev-days** including the §11 cross-platform work and CI matrix) and the most failure modes (runner-died, stdio backpressure, protocol drift, cross-platform regression). Don't pick B "just in case" — pick it because you have a concrete resume/attach or cross-platform use case. **The cross-platform commitment (per the user's requirement) is what makes B the only plan that needs a §11 compatibility matrix; A and C are POSIX/Win-clean by construction (in-process), but a cross-process boundary is where platform differences live.**

### Plan C — `worker_threads`

**Pick C** when you want real heap isolation without paying for a new bin or a new protocol. The Worker is a V8 isolate with its own heap, so a script that allocates 1 GB doesn't bloat the parent Pi. The `worker.terminate()` call is also preemptive — better than A's cooperative abort and better than B's `process.kill` for clean Worker shutdown. C is the right "I have a heap-pressure concern but don't need resume" choice.

## If unsure, pick Plan A (unless cross-platform is a hard requirement)

Plan A is the recommended default for POSIX/Unix-only use cases. It is the smallest, fastest, and lowest-risk path to a working workflow primitive. It reuses 100% of the existing sub-agent plumbing (`startSubagentJob`, `jobRegistry`, all status tools). It composes cleanly with Plans B and C: if you later need a resume story, you can build Plan B's runner on top of Plan A's combinator API. If you later need heap isolation, you can build Plan C's Worker host on top of the same combinator API. Plan A is the foundation; B and C are evolutionary paths.

**However, if Windows is a hard requirement from day one** (per the user's direction in the project), Plan B with the §11 compatibility matrix is the only plan that delivers a cross-process boundary on Windows. A and C are POSIX/Win-clean by construction but cannot survive parent crashes. **For the `pi-subagentura` project's v2.2.0 release, the choice is Plan B with the cross-platform matrix.**
