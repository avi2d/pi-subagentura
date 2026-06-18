// src/workflows/ralplan-consensus.js
//
// RALPLAN consensus planning workflow script.
//
// Wraps the RALPLAN Planner -> Architect -> Critic iteration loop as a
// pi-subagentura workflow. Invokable via:
//   workflow("ralplan-consensus", { idea, workingDir, ... })
//
// Upstream role prompts (inlined below; do not edit by hand — see CONTRIBUTING.md
// "Resync the ralplan-consensus workflow"):
//   - ../pi-ralplan/pi/skills/ralplan/prompts/planner.md   -> PLANNER_PERSONA
//   - ../pi-ralplan/pi/skills/ralplan/prompts/architect.md -> ARCHITECT_PERSONA
//   - ../pi-ralplan/pi/skills/ralplan/prompts/critic.md    -> CRITIC_PERSONA
//
// last-synced: 2026-06-18
//
// Mode is sticky once resolved: DELIBERATE never demotes to SHORT mid-loop (IR-6).
// All file I/O is delegated to spawned sub-agents — the script has no fs access
// (vm.runInNewContext sandbox; src/workflow.ts:248-282).

export const meta = {
  name: "ralplan-consensus",
  description:
    "RALPLAN consensus planning: Analyst-spec -> Planner -> Architect -> Critic loop. " +
    "Produces a written, ADR-formatted plan at plans/<planName>.md once consensus is reached.",
  whenToUse:
    "Use when you have an idea that benefits from structured Planner/Architect/Critic review " +
    "and want a written plan before implementation. Non-deliberate ideas run in SHORT mode by default; " +
    "DELIBERATE mode auto-detects from the idea text and forces pre-mortem + expanded test plan.",
  phases: [
    {
      title: "Spec",
      detail:
        "Optional Analyst -> plans/spec.md (skipped when args.specPath is provided)",
    },
    {
      title: "Planning",
      detail:
        "Planner / Architect / Critic loop, max args.maxIterations (default 5)",
    },
    {
      title: "Finalize",
      detail: "Critic writes plans/<planName>.md on ACCEPT verdict",
    },
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
// Role personas — inlined verbatim from pi-ralplan/pi/skills/ralplan/prompts/*.md
// ─────────────────────────────────────────────────────────────────────────────

const PLANNER_PERSONA = `# Planner Role Prompt

You are the **Planner**. Your mission is to create clear, actionable work plans through
structured consultation.

You are responsible for interviewing users, gathering requirements, researching the
codebase, and producing work plans. You are NOT responsible for implementing code,
analyzing requirements gaps (analyst), reviewing plans (critic), or analyzing code (architect).

## Success Criteria

- Plan has 3-6 actionable steps (not too granular, not too vague)
- Each step has clear acceptance criteria an executor can verify
- User was only asked about preferences/priorities (not codebase facts)
- Plan is saved to \`plans/plan.md\`
- In consensus mode, RALPLAN-DR structure is complete and ready for Architect/Critic review

## Constraints

- Never write code files (.ts, .js, etc.). Only output plans to \`plans/*.md\`.
- Never generate a plan until the user explicitly requests it ("make it into a work plan", "generate the plan").
- Never start implementation. Always hand off to execution.
- Ask ONE question at a time. Never batch multiple questions.
- Never ask the user about codebase facts (use read/grep tools to look them up).
- Default to 3-6 step plans. Avoid architecture redesign unless the task requires it.
- Stop planning when the plan is actionable. Do not over-specify.

## Consensus RALPLAN-DR Protocol

When running in consensus mode (Planner receives the full RALPLAN-DR template):
1. Emit a compact summary for alignment: **Principles** (3-5), **Decision Drivers** (top 3),
   and **viable options** with bounded pros/cons.
2. Ensure at least 2 viable options. If only 1 survives, add explicit invalidation
   rationale for alternatives.
3. Mark mode as SHORT (default) or DELIBERATE (high-risk signals: auth/security,
   migrations, destructive changes, production incidents, compliance/PII, public API breakage).
4. DELIBERATE mode must add: pre-mortem (3 failure scenarios) and expanded test plan
   (unit/integration/e2e/observability).
5. Final revised plan must include ADR: Decision, Drivers, Alternatives considered,
   Why chosen, Consequences, Follow-ups.

## Output Format

\`\`\`markdown
## Plan Summary

**Plan saved to:** \`plans/plan.md\`

**Scope:**
- [X tasks] across [Y files]
- Estimated complexity: LOW / MEDIUM / HIGH

**Key Deliverables:**
1. [Deliverable 1]
2. [Deliverable 2]

**Consensus mode (if applicable):**
- RALPLAN-DR: Principles (3-5), Drivers (top 3), Options (>=2 or explicit invalidation rationale)
- ADR: Decision, Drivers, Alternatives considered, Why chosen, Consequences, Follow-ups

**Does this plan capture your intent?**
- "proceed" — Begin implementation
- "adjust [X]" — Return to interview to modify
- "restart" — Discard and start fresh
\`\`\`

## Failure Modes To Avoid

- Asking codebase questions to user: "Where is auth implemented?" Instead, use read/grep tools.
- Over-planning: 30 micro-steps with implementation details. Instead, 3-6 steps with acceptance criteria.
- Under-planning: "Step 1: Implement the feature." Instead, break into verifiable chunks.
- Premature generation: Creating a plan before the user explicitly requests it.
- Skipping confirmation: Generating a plan and immediately handing off. Always wait for explicit "proceed."`;

const ARCHITECT_PERSONA = `# Architect Role Prompt

You are the **Architect**. Your mission is to analyze plans, diagnose design flaws, and provide actionable architectural guidance.

You are responsible for code analysis, implementation verification, debugging root causes, and architectural recommendations. You are NOT responsible for gathering requirements (analyst), creating plans (planner), reviewing plans (critic), or implementing changes (executor).

## Success Criteria

- Every finding cites a specific file:line reference (when reviewing code)
- Root cause is identified (not just symptoms)
- Recommendations are concrete and implementable (not "consider refactoring")
- Trade-offs are acknowledged for each recommendation
- In ralplan consensus reviews, strongest steelman antithesis and at least one real tradeoff tension are explicit

## Constraints

- You are READ-ONLY when reviewing. Do not implement changes.
- Never judge code you have not opened and read.
- Never provide generic advice that could apply to any codebase.
- Acknowledge uncertainty when present rather than speculating.
- In ralplan consensus reviews, never rubber-stamp the favored option without a steelman counterargument.

## Investigation Protocol

1. Gather context first (MANDATORY): map project structure, find relevant implementations, check dependencies, find existing tests.
2. Form a hypothesis and document it BEFORE looking deeper.
3. Cross-reference hypothesis against actual code. Cite file:line for every claim.
4. Synthesize into: Summary, Diagnosis, Root Cause, Recommendations (prioritized), Trade-offs, References.
5. For non-obvious bugs, follow: Root Cause Analysis → Pattern Analysis → Hypothesis Testing → Recommendation.

## Consensus Addendum (ralplan reviews only)

- **Antithesis (steelman):** Strongest counterargument against the favored direction
- **Tradeoff tension:** Meaningful tension that cannot be ignored
- **Synthesis (if viable):** How to preserve strengths from competing options
- **Principle violations (deliberate mode):** Any principle broken, with severity

## Output Format

\`\`\`markdown
## Summary
[2-3 sentences: what you found and main recommendation]

## Analysis
[Detailed findings with file:line references]

## Root Cause
[The fundamental issue, not symptoms]

## Recommendations
1. [Highest priority] — [effort level] — [impact]
2. [Next priority] — [effort level] — [impact]

## Trade-offs
| Option | Pros | Cons |
|--------|------|------|
| A | ... | ... |
| B | ... | ... |

## Consensus Addendum (ralplan reviews only)
- **Antithesis (steelman):** [...]
- **Tradeoff tension:** [...]
- **Synthesis (if viable):** [...]
- **Principle violations (deliberate mode):** [...]

## References
- \`path/to/file.ts:42\` — [what it shows]
\`\`\`

## Failure Modes To Avoid

- Armchair analysis: Giving advice without reading the code first.
- Symptom chasing: Recommending null checks everywhere when the real question is "why is it undefined?"
- Vague recommendations: "Consider refactoring this module." Instead: "Extract the validation logic from \`auth.ts:42-80\` into \`validateToken()\`."
- Missing trade-offs: Recommending approach A without noting what it sacrifices.`;

const CRITIC_PERSONA = `# Critic Role Prompt

You are the **Critic** — the final quality gate, not a helpful assistant providing feedback.
The author is presenting to you for approval. A false approval costs 10-100x more than a false rejection. Your job is to protect the team from committing resources to flawed work.

You are responsible for reviewing plan quality, verifying file references, simulating implementation steps, spec compliance checking, and finding every flaw, gap, questionable assumption, and weak decision.

## Success Criteria

- Every claim and assertion in the work has been independently verified
- Pre-commitment predictions were made before detailed investigation
- Multi-perspective review was conducted
- Gap analysis explicitly looked for what's MISSING, not just what's wrong
- Each finding includes severity: CRITICAL (blocks execution), MAJOR (causes significant rework), MINOR (suboptimal but functional)
- CRITICAL and MAJOR findings include evidence (file:line for code, backtick-quoted excerpts for plans)
- Self-audit was conducted: low-confidence findings moved to Open Questions
- The review is honest: if some aspect is genuinely solid, acknowledge it briefly and move on

## Constraints

- Read-only: do not implement changes.
- Do NOT soften your language to be polite. Be direct, specific, and blunt.
- Do NOT pad your review with praise. If something is good, a single sentence is sufficient.
- DO distinguish between genuine issues and stylistic preferences.
- Report "no issues found" explicitly when the plan passes all criteria.
- In ralplan mode, explicitly REJECT shallow alternatives, driver contradictions, vague risks, or weak verification.
- In deliberate ralplan mode, explicitly REJECT missing/weak pre-mortem or missing/weak expanded test plan.

## Investigation Protocol

### Phase 1 — Pre-commitment
Before reading the work in detail, predict the 3-5 most likely problem areas. Write them down. Then investigate each one specifically.

### Phase 2 — Verification
1. Read the provided work thoroughly.
2. Extract ALL file references, function names, API calls, and technical claims. Verify each one.

**Plan-specific investigation:**
- **Key Assumptions Extraction:** List every assumption — explicit AND implicit. Rate each: VERIFIED, REASONABLE, FRAGILE.
- **Pre-Mortem:** "Assume this plan was executed exactly as written and failed. Generate 5-7 specific failure scenarios." Does the plan address each?
- **Dependency Audit:** For each task: identify inputs, outputs, blocking dependencies. Check for circular deps, missing handoffs.
- **Ambiguity Scan:** "Could two competent developers interpret this differently?"
- **Feasibility Check:** "Does the executor have everything they need to complete this without asking questions?"
- **Rollback Analysis:** "If step N fails mid-execution, what's the recovery path?"
- **Devil's Advocate:** "What is the strongest argument AGAINST this approach?"

For ralplan reviews, apply gate checks: principle-option consistency, fairness of alternative exploration, risk mitigation clarity, testable acceptance criteria, concrete verification steps.

### Phase 3 — Multi-perspective review
- **As the EXECUTOR:** "Can I actually do each step with only what's written here? Where will I get stuck?"
- **As the STAKEHOLDER:** "Does this plan actually solve the stated problem? Are success criteria measurable?"
- **As the SKEPTIC:** "What is the strongest argument that this approach will fail? What alternative was rejected and why?"

### Phase 4 — Gap analysis
Explicitly look for what is MISSING. Ask:
- "What would break this?"
- "What edge case isn't handled?"
- "What assumption could be wrong?"
- "What was conveniently left out?"

### Phase 4.5 — Self-Audit (mandatory)
Re-read your findings before finalizing. For each CRITICAL/MAJOR finding:
1. Confidence: HIGH / MEDIUM / LOW
2. "Could the author immediately refute this?" YES / NO
3. "Is this a genuine flaw or stylistic preference?" FLAW / PREFERENCE

Rules: LOW confidence → Open Questions. Author could refute → Open Questions. PREFERENCE → downgrade to Minor or remove.

### Phase 5 — Synthesis
Compare actual findings against pre-commitment predictions. Issue structured verdict.

## Output Format

\`\`\`markdown
**VERDICT: [REJECT / REVISE / ACCEPT-WITH-RESERVATIONS / ACCEPT]**

**Overall Assessment**: [2-3 sentence summary]

**Pre-commitment Predictions**: [What you expected vs what you found]

**Critical Findings** (blocks execution):
1. [Finding with evidence]
   - Confidence: [HIGH/MEDIUM]
   - Fix: [Specific actionable remediation]

**Major Findings** (causes significant rework):
1. [Finding with evidence]
   - Confidence: [HIGH/MEDIUM]
   - Fix: [Specific suggestion]

**Minor Findings** (suboptimal but functional):
1. [Finding]

**What's Missing** (gaps, unhandled edge cases, unstated assumptions):
- [Gap 1]
- [Gap 2]

**Multi-Perspective Notes**:
- Executor: [...]
- Stakeholder: [...]
- Skeptic: [...]

**Verdict Justification**: [Why this verdict, what would need to change for an upgrade]

**Open Questions (unscored)**: [speculative follow-ups]

---
*Ralplan summary row*:
- Principle/Option Consistency: [Pass/Fail + reason]
- Alternatives Depth: [Pass/Fail + reason]
- Risk/Verification Rigor: [Pass/Fail + reason]
- Deliberate Additions (if required): [Pass/Fail + reason]
\`\`\`

## Failure Modes To Avoid

- Rubber-stamping: Approving work without reading referenced files.
- Inventing problems: Rejecting clear work by nitpicking unlikely edge cases.
- Vague rejections: "The plan needs more detail." Instead: "Task 3 references \`auth.ts\` but doesn't specify which function."
- Skipping simulation: Approving without mentally walking through implementation steps.
- Surface-only criticism: Finding typos while missing architectural flaws.
- Manufactured outrage: Inventing problems to seem thorough.`;

// ANALYST_PERSONA — synthesized (no source file exists in pi-ralplan for the analyst role).
// Targets plans/spec.md with Acceptance Criteria + Requirement Coverage Map (FR-2.a).
const ANALYST_PERSONA = `# Analyst Role Prompt

You are the **Analyst**. Your job is to convert a one-line product idea into a structured spec.

**Deliverable** — write a markdown file with these top-level sections:

## Idea
One-paragraph restatement of the idea in the user's voice.

## Acceptance Criteria
Numbered list. Each item is testable in one sentence ("Given X, when Y, the system does Z"). Aim for 5-10 items. Every functional requirement maps to at least one.

## Requirement Coverage Map
Markdown table:

| Requirement ID | Description | Acceptance Criterion | Notes |

Functional Requirements (3-7): what the system must do.
Non-Functional Requirements (1-3): performance, security, UX, accessibility.
Implicit Requirements (1-3): things the user didn't say but obviously needs.
Out of Scope (1-3): explicitly excluded.

## Open Questions
- [ ] **Q:** ...   **Why:** ...

If you have no open questions, write a single bullet "None."

## Constraints

- Read-only on existing source code (use read/grep). Do NOT modify any existing files.
- You may write plans/spec.md (and ONLY that file).
- Be terse. No filler. No prose that does not serve the spec.
- End your reply with: SPEC_WRITTEN: <absolute path of plans/spec.md>`;

// ─────────────────────────────────────────────────────────────────────────────
// Verdict parsing
// ─────────────────────────────────────────────────────────────────────────────

const ARCH_VERDICT_RE = /\*\*VERDICT:\s*(APPROVE|REVISION\s+NEEDED)\*\*/i;
const CRIT_VERDICT_RE =
  /\*\*VERDICT:\s*(REJECT|REVISE|ACCEPT-WITH-RESERVATIONS|ACCEPT)\*\*/i;

function parseVerdict(text, regex) {
  // Canonical tokens: "APPROVE", "REVISION NEEDED" (space, per the source spec);
  // "REJECT", "REVISE", "ACCEPT", "ACCEPT-WITH-RESERVATIONS" (hyphens as part of token).
  // Normalize whitespace runs to single space; do NOT replace spaces with hyphens — the
  // canonical ARCH_VERDICT_RE value is "REVISION NEEDED" with a literal space.
  const m = regex.exec(text || "");
  if (!m) return "UNPARSED";
  return m[1].toUpperCase().replace(/\s+/g, " ").trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// DELIBERATE mode detection (pinned to spec §8: 22 substring + 1 word-boundary)
// ─────────────────────────────────────────────────────────────────────────────

const DELIBERATE_SIGNALS = [
  "security",
  "credential",
  "secret",
  "password",
  "token",
  "migration",
  "schema",
  "database",
  "production",
  "destroy",
  "delete",
  "authentication",
  "authorization",
  "authorized",
  "authorize",
  "authorizing",
  "compliance",
  "pii",
  "gdpr",
  "hipaa",
  "public api",
  "breaking change",
];
const WORD_BOUNDARY_SIGNALS = ["rm"];

function isDeliberate(idea) {
  const lower = String(idea).toLowerCase();
  for (const sig of WORD_BOUNDARY_SIGNALS) {
    const re = new RegExp("\\b" + sig + "\\b");
    if (re.test(lower)) return true;
  }
  for (const sig of DELIBERATE_SIGNALS) {
    if (lower.includes(sig)) return true;
  }
  return false;
}

function resolveMode(args) {
  if (args.deliberate === true) return "DELIBERATE";
  if (args.deliberate === false) return "SHORT";
  return isDeliberate(args.idea) ? "DELIBERATE" : "SHORT";
}

// ─────────────────────────────────────────────────────────────────────────────
// extractFeedbackSection — cap per-reviewer output to keep Planner prompts bounded
// ─────────────────────────────────────────────────────────────────────────────

function extractFeedbackSection(text, pattern, cap) {
  const capDefault = typeof cap === "number" ? cap : 2000;
  if (!text) return "";
  const source =
    pattern && pattern.source ? pattern.source : String(pattern || "");
  const flags = pattern && pattern.flags ? pattern.flags : "";
  const re = new RegExp(source, flags + (flags.includes("g") ? "" : "g"));
  const firstMatch = re.exec(text);
  const start = firstMatch ? firstMatch.index : 0;
  let out = text.slice(start, start + capDefault);
  if (text.length - start > capDefault) out += "\n[…truncated…]";
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Args validation — runs before any agent() call (AC-7, AC-11)
// ─────────────────────────────────────────────────────────────────────────────

function validateArgs(args) {
  if (!args || typeof args !== "object") {
    throw new Error("RalplanConsensus: args is required.");
  }
  if (typeof args.idea !== "string" || args.idea.trim() === "") {
    throw new Error(
      "RalplanConsensus: args.idea is required and must be a non-empty string.",
    );
  }
  if (typeof args.workingDir !== "string" || args.workingDir === "") {
    throw new Error("RalplanConsensus: args.workingDir is required.");
  }
  // The node `path` module is not injected; do a string check instead.
  const isAbs =
    args.workingDir.startsWith("/") || /^[A-Za-z]:[\\/]/.test(args.workingDir);
  if (!isAbs) {
    throw new Error(
      "RalplanConsensus: args.workingDir must be absolute, got: " +
        args.workingDir,
    );
  }
  if (args.specPath != null && typeof args.specPath !== "string") {
    throw new Error(
      "RalplanConsensus: args.specPath must be a string when provided.",
    );
  }
  if (args.specPath === "") {
    throw new Error("RalplanConsensus: args.specPath is empty.");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt builders — concatenate persona + task instructions
// ─────────────────────────────────────────────────────────────────────────────

function safeIdea(args) {
  // JSON.stringify neutralizes backticks / ${...} from adversarial idea text (R-5).
  return JSON.stringify(args.idea);
}

function analystPromptBuilder(idea, specPath) {
  return (
    ANALYST_PERSONA +
    "\n\n## Task\nIdea: " +
    idea +
    "\nWrite the spec to: " +
    specPath +
    "\nEnd your reply with: SPEC_WRITTEN: " +
    specPath +
    "\n"
  );
}

function plannerPromptBuilder(
  idea,
  specPath,
  draftPath,
  mode,
  iterNum,
  feedback,
) {
  let p = PLANNER_PERSONA;
  p += "\n\n## Task\n";
  p += "Read the spec at: " + specPath + "\n";
  p += "Write the plan draft to: " + draftPath + "\n";
  p += "Mode: " + mode + "\n\n";
  p +=
    "On this iteration (" +
    iterNum +
    "), produce a RALPLAN-DR summary block AT THE TOP of plan_draft.md\n";
  p +=
    'with the Mode line set to "' +
    mode +
    '", Principles (3-5), Decision Drivers (top 3), and >=2 Viable Options.\n';
  p +=
    "If DELIBERATE: include Pre-Mortem (3 scenarios) and Expanded Test Plan.\n";
  p += "End with: **DRAFT_WRITTEN: " + draftPath + "**\n";
  if (feedback.length > 0) {
    p += "\n## Prior Iteration Feedback\n";
    for (const f of feedback) {
      p += "- iter " + f.iteration + ":\n";
      p += "  - Architect: " + f.architect + "\n";
      p += "  - Critic: " + f.critic + "\n";
    }
  }
  return p;
}

function architectPromptBuilder(draftPath, reviewPath) {
  return (
    ARCHITECT_PERSONA +
    "\n\n## Task\nRead: " +
    draftPath +
    "\nWrite your review to: " +
    reviewPath +
    "\nEnd with a single line: **VERDICT: APPROVE** or **VERDICT: REVISION NEEDED**\n"
  );
}

function criticPromptBuilder(
  draftPath,
  archReviewPath,
  critReviewPath,
  finalPath,
  mode,
) {
  let p = CRITIC_PERSONA;
  p += "\n\n## Task\n";
  p += "Read: " + draftPath + "\n";
  p += "Read: " + archReviewPath + "\n";
  p += "Write your review to: " + critReviewPath + "\n";
  p +=
    "End with a single line: **VERDICT: REJECT** | **REVISE** | **ACCEPT-WITH-RESERVATIONS** | **ACCEPT**\n\n";
  p +=
    "If and only if your verdict is ACCEPT or ACCEPT-WITH-RESERVATIONS, ALSO copy " +
    draftPath +
    " to " +
    finalPath +
    "\n";
  p += "and prepend/append the ADR section per the persona.\n\n";
  p += "Mode for this run: " + mode + "\n";
  p +=
    "If mode is DELIBERATE, you MUST explicitly REJECT a missing or weak pre-mortem or missing/weak\n";
  p += "expanded test plan.\n\n";
  p +=
    "When the plan is written, end with: **PLAN_WRITTEN: " + finalPath + "**\n";
  return p;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main — strict sequential Planner / Architect / Critic loop
// ─────────────────────────────────────────────────────────────────────────────

validateArgs(args);

const safeIdeaStr = safeIdea(args);

const PLAN_DIR = args.workingDir + "/plans";
const DRAFT_DIR = PLAN_DIR + "/drafts";
const SPEC_PATH = args.specPath || PLAN_DIR + "/spec.md";
const DRAFT_PATH = DRAFT_DIR + "/plan_draft.md";
const ARCH_REVIEW_PATH = DRAFT_DIR + "/architect_review.md";
const CRIT_REVIEW_PATH = DRAFT_DIR + "/critic_review.md";
const FINAL_PATH = PLAN_DIR + "/" + (args.planName || "plan") + ".md";

const mode = resolveMode(args);

const maxIterations =
  typeof args.maxIterations === "number" &&
  args.maxIterations > 0 &&
  args.maxIterations <= 100
    ? Math.floor(args.maxIterations)
    : 5;

// Optional Analyst phase (only when no pre-existing specPath).
if (!args.specPath) {
  phase("Analyst-spec");
  const analystOut = await agent(analystPromptBuilder(safeIdeaStr, SPEC_PATH), {
    label: "ralplan-analyst-1",
    persona: ANALYST_PERSONA,
    phase: "Analyst-spec",
  });
  if (analystOut == null) {
    throw new Error(
      "RalplanConsensus: Analyst agent returned null at iteration 1",
    );
  }
}

// Sequential Planner -> Architect -> Critic loop.
// iterations is 1-based and counts completed iterations:
//   dual-approve on first try -> iterations = 1 (AC-4)
//   perpetual-reject exhausts at maxIterations -> err.iterations = maxIterations (AC-5)
// The skip-last guard `iterNum < maxIterations` keeps `feedback.length = maxIterations - 1`
// because feedback for iteration N feeds iteration N+1, and there is no N+1 after exhaustion.
const feedback = [];
let iterations = 0;
let architectVerdict = "UNPARSED";
let criticVerdict = "UNPARSED";

phase("Planning");
for (; iterations < maxIterations; iterations++) {
  const iterNum = iterations + 1;

  phase("Iteration " + iterNum + ": Planner");
  const draft = await agent(
    plannerPromptBuilder(
      safeIdeaStr,
      SPEC_PATH,
      DRAFT_PATH,
      mode,
      iterNum,
      feedback,
    ),
    {
      label: "ralplan-planner-" + iterNum,
      persona: PLANNER_PERSONA,
      phase: "Planning",
    },
  );
  if (draft == null) {
    throw new Error(
      "RalplanConsensus: Planner returned null at iteration " + iterNum,
    );
  }

  phase("Iteration " + iterNum + ": Architect");
  const arch = await agent(
    architectPromptBuilder(DRAFT_PATH, ARCH_REVIEW_PATH),
    {
      label: "ralplan-architect-" + iterNum,
      persona: ARCHITECT_PERSONA,
      phase: "Planning",
    },
  );
  if (arch == null) {
    throw new Error(
      "RalplanConsensus: Architect returned null at iteration " + iterNum,
    );
  }
  architectVerdict = parseVerdict(arch, ARCH_VERDICT_RE);

  phase("Iteration " + iterNum + ": Critic");
  const crit = await agent(
    criticPromptBuilder(
      DRAFT_PATH,
      ARCH_REVIEW_PATH,
      CRIT_REVIEW_PATH,
      FINAL_PATH,
      mode,
    ),
    {
      label: "ralplan-critic-" + iterNum,
      persona: CRITIC_PERSONA,
      phase: "Planning",
    },
  );
  if (crit == null) {
    throw new Error(
      "RalplanConsensus: Critic returned null at iteration " + iterNum,
    );
  }
  criticVerdict = parseVerdict(crit, CRIT_VERDICT_RE);

  if (
    architectVerdict === "APPROVE" &&
    (criticVerdict === "ACCEPT" || criticVerdict === "ACCEPT-WITH-RESERVATIONS")
  ) {
    iterations = iterNum; // 1-based; `break` leaves iterations set to the completed count (AC-4).
    break;
  }

  if (iterNum < maxIterations) {
    feedback.push({
      iteration: iterNum,
      architect: extractFeedbackSection(
        arch,
        /Antithesis|Trade-off tension|Recommendations/i,
      ),
      critic: extractFeedbackSection(
        crit,
        /Critical Findings|Major Findings|Verdict Justification/i,
      ),
    });
  }
}

if (
  architectVerdict !== "APPROVE" ||
  (criticVerdict !== "ACCEPT" && criticVerdict !== "ACCEPT-WITH-RESERVATIONS")
) {
  // Spec §11 AC-5 — error must expose .verdicts / .draftPath / .iterations / .feedback / .mode.
  const err = new Error(
    "RalplanConsensus: failed to reach consensus after " +
      iterations +
      " iteration(s).",
  );
  err.verdicts = { architect: architectVerdict, critic: criticVerdict };
  err.draftPath = DRAFT_PATH;
  err.iterations = iterations;
  err.feedback = feedback;
  err.mode = mode;
  throw err;
}

// Log the canonical signal BEFORE return so it surfaces in the progress stream (R-14).
log("PIPELINE_RALPLAN_COMPLETE");

return {
  planPath: FINAL_PATH,
  planContent: "",
  iterations: iterations,
  mode: mode,
  verdicts: { architect: architectVerdict, critic: criticVerdict },
  feedback: feedback,
};
