export const meta = {
  name: "skill-to-workflow",
  description:
    "Generic converter: turn a Pi skill (SKILL.md + role prompts) into a pi-subagentura workflow script.",
  phases: [
    { title: "Discover skill structure" },
    { title: "Analyze skill semantics" },
    { title: "Map to workflow primitives" },
    { title: "Generate workflow script" },
    { title: "Validate and persist" },
  ],
};

// ── Args ─────────────────────────────────────────────────────────────────
// Defensive parse: when this script is invoked via the workflow tool from an
// LLM agent, args may arrive as a JSON-encoded string rather than an object.
function _parseArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === "object") return raw;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return {};
}
const _a = _parseArgs(args);
const SKILL_PATH =
  _a && typeof _a.skillPath === "string" && _a.skillPath ? _a.skillPath : null;
const OUTPUT_PATH =
  _a && typeof _a.outputPath === "string" && _a.outputPath
    ? _a.outputPath
    : null;

if (!SKILL_PATH) {
  return {
    error:
      "args.skillPath is required (absolute path to a skill directory containing SKILL.md).",
  };
}
if (!OUTPUT_PATH) {
  return {
    error:
      "args.outputPath is required (absolute path for the generated workflow .mjs file).",
  };
}

log("Converting skill: " + SKILL_PATH + " -> " + OUTPUT_PATH);

// ── 1. Discover skill structure ──────────────────────────────────────────
phase("Discover skill structure");
const discovery = await agent(
  [
    "Use bash and read tools to inspect the skill directory at " +
      SKILL_PATH +
      ".",
    "",
    "Find and report on:",
    "- SKILL.md (frontmatter + body) — the canonical skill definition",
    "- Any *.md files (likely role prompts: planner.md, architect.md, critic.md, executor.md, etc.)",
    "- Any subdirectories (prompts/, references/, etc.)",
    "- Any scripts/binaries referenced from SKILL.md (note them but do not execute)",
    "",
    "For each file: full absolute path, size in bytes, and an inferred type",
    "(skill-md | role-prompt | reference | script | other) based on filename and content sample.",
    "",
    "Return JSON:",
    "{ skillMd: { path, size, exists }, rolePrompts: [{ path, size, role, inferredType }], references: [{ path, size }], scripts: [{ path }], subdirs: [string], totalSize: number }",
  ].join("\n"),
  {
    schema: {
      type: "object",
      properties: {
        skillMd: {
          type: "object",
          properties: {
            path: { type: "string" },
            size: { type: "integer" },
            exists: { type: "boolean" },
          },
          required: ["path", "size", "exists"],
        },
        rolePrompts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              size: { type: "integer" },
              role: { type: "string" },
              inferredType: { type: "string" },
            },
            required: ["path", "size", "role", "inferredType"],
          },
        },
        references: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              size: { type: "integer" },
            },
            required: ["path", "size"],
          },
        },
        scripts: {
          type: "array",
          items: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
        subdirs: { type: "array", items: { type: "string" } },
        totalSize: { type: "integer" },
      },
      required: [
        "skillMd",
        "rolePrompts",
        "references",
        "scripts",
        "subdirs",
        "totalSize",
      ],
    },
    label: "discover",
  },
);

// ── 2. Analyze skill semantics ───────────────────────────────────────────
phase("Analyze skill semantics");
const analysis = await agent(
  [
    "Read the SKILL.md and role prompt files at these paths and produce a structured analysis:",
    JSON.stringify(discovery, null, 2),
    "",
    "Extract:",
    "- Skill name + description (from frontmatter)",
    "- Core directive / mission",
    "- Hard constraints",
    "- Iteration loop / state machine (e.g. Planner -> Architect -> Critic, max rounds)",
    "- Roles defined (each: { name, model, tools, responsibility, personaPath })",
    "- Output artifacts (file paths)",
    "- Completion signals (e.g. PIPELINE_*_COMPLETE)",
    "- Verdict formats (APPROVE / REVISION_NEEDED / etc.)",
    "- Any input gate logic (vague prompt detection, escape prefixes, word threshold)",
    "- Deliberate mode / risk-triggered augmentation",
    "- Interactive checkpoints",
    "- Planning/execution boundary",
    "",
    "Return JSON.",
  ].join("\n"),
  {
    schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        coreDirective: { type: "string" },
        roles: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              model: { type: "string" },
              tools: { type: "string" },
              responsibility: { type: "string" },
              personaPath: { type: "string" },
            },
            required: ["name", "responsibility"],
          },
        },
        stateMachine: {
          type: "object",
          properties: {
            type: { type: "string" },
            phases: { type: "array", items: { type: "string" } },
            maxIterations: { type: "integer" },
            verdictFormat: { type: "array", items: { type: "string" } },
          },
          required: ["type"],
        },
        artifacts: { type: "array", items: { type: "string" } },
        signals: { type: "array", items: { type: "string" } },
        gate: { type: "object", properties: {}, additionalProperties: true },
        deliberateMode: {
          type: "object",
          properties: {},
          additionalProperties: true,
        },
        interactiveCheckpoints: { type: "array", items: { type: "string" } },
        boundary: { type: "string" },
      },
      required: ["name", "description", "roles", "stateMachine"],
    },
    label: "analyze",
  },
);

// ── 3. Map to workflow primitives ────────────────────────────────────────
phase("Map to workflow primitives");
const design = await agent(
  [
    "Given this skill analysis, map each behavior to pi-subagentura's workflow tool primitives:",
    JSON.stringify(analysis, null, 2),
    "",
    "Primitives: agent(prompt, opts), parallel(thunks), pipeline(items, ...stages), phase(title), log(msg), args, budget.",
    "",
    "Mapping rules:",
    "- Roles -> agent() calls; persona inlined as template-literal constant",
    "- State machine with iteration -> for/while loop in body",
    "- Concurrent roles -> parallel() only when protocol allows; sequential when ordering matters",
    "- Pipeline stages -> pipeline() for item-streaming",
    "- Input gate -> pure-JS function checkGate(args) returning { gated, reason }",
    "- Deliberate mode -> isDeliberate(idea, args) + Planner prompt augmentation",
    "- Interactive checkpoints -> [pending approval] markers (workflow runtime cannot pause)",
    "- Planning/execution boundary -> always pending_approval: true, execution_halted: true",
    "",
    "Return JSON:",
    "{ algorithm (pseudocode), mappings: [{ skillElement, primitive, fidelityGap? }], fidelityLimitations: [string], args: [{ name, type, required, default, description }], returnShape }",
  ].join("\n"),
  {
    schema: {
      type: "object",
      properties: {
        algorithm: { type: "string" },
        mappings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              skillElement: { type: "string" },
              primitive: { type: "string" },
              fidelityGap: { type: "string" },
            },
            required: ["skillElement", "primitive"],
          },
        },
        fidelityLimitations: { type: "array", items: { type: "string" } },
        args: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              type: { type: "string" },
              required: { type: "boolean" },
              default: { type: "string" },
              description: { type: "string" },
            },
            required: ["name", "type"],
          },
        },
        returnShape: { type: "string" },
      },
      required: [
        "algorithm",
        "mappings",
        "fidelityLimitations",
        "args",
        "returnShape",
      ],
    },
    label: "design",
  },
);

// ── 4. Generate workflow script ──────────────────────────────────────────
phase("Generate workflow script");
const generated = await agent(
  [
    "Generate the COMPLETE workflow script source code for the skill.",
    "Analysis: " + JSON.stringify(analysis, null, 2),
    "Design: " + JSON.stringify(design, null, 2),
    "",
    "Skill path: " + SKILL_PATH,
    "",
    "REQUIREMENTS:",
    "1. Start with literal: export const meta = { name: <kebab-case from skill name>, description: <from skill>, phases: [{ title: ... }, ...] }",
    "2. Use only: agent(), parallel(), pipeline(), phase(), log(), args, budget, console",
    "3. NEVER Date.now() / Math.random() / argless new Date()",
    "4. Read each role prompt file with the read tool and inline its FULL content as template-literal constants at the top of the script (PLANNER_PERSONA, ARCHITECT_PERSONA, etc. — use SCREAMING_SNAKE_CASE derived from the role name)",
    "5. Implement state machine per the design",
    "6. Implement gate / deliberate / interactive / boundary logic per the design",
    "7. Self-contained — no imports, no external file reads at runtime",
    "",
    "Return ONLY the script content as a single string in field 'script'. No markdown fences, no commentary.",
  ].join("\n"),
  {
    schema: {
      type: "object",
      properties: {
        script: { type: "string" },
      },
      required: ["script"],
    },
    label: "generate",
  },
);

// ── 5. Validate and persist ─────────────────────────────────────────────
phase("Validate and persist");
const validation = await agent(
  [
    "Validate and write this workflow script to disk.",
    "",
    "Script to validate:",
    generated.script,
    "",
    "Checks:",
    "1. Starts with literal 'export const meta = { ... }' and parses to a valid object with name + description + phases",
    "2. No Date.now() / Math.random() / argless new Date()",
    "3. Required functions present per design mappings",
    "4. Role prompts inlined from skill files (constants in SCREAMING_SNAKE_CASE)",
    "5. Self-contained — no external imports",
    "",
    "If valid, write the script verbatim to " +
      OUTPUT_PATH +
      " via the write tool.",
    "After writing, run bash: ls -la " +
      OUTPUT_PATH +
      " && head -20 " +
      OUTPUT_PATH,
    "",
    "Return JSON: { valid: boolean, issues: [string], scriptPath: string, lineCount: number }",
  ].join("\n"),
  {
    schema: {
      type: "object",
      properties: {
        valid: { type: "boolean" },
        issues: { type: "array", items: { type: "string" } },
        scriptPath: { type: "string" },
        lineCount: { type: "integer" },
      },
      required: ["valid", "issues", "scriptPath", "lineCount"],
    },
    label: "validate",
  },
);

// ── Summary ──────────────────────────────────────────────────────────────
return {
  skillPath: SKILL_PATH,
  outputPath: OUTPUT_PATH,
  discovery: discovery ?? null,
  analysis: analysis ?? null,
  design: design ?? null,
  generatedScriptLength:
    generated && generated.script ? generated.script.length : 0,
  validation: validation ?? null,
};
