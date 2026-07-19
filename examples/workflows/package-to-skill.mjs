export const meta = {
  name: "package-to-skill",
  description:
    "Distill a Pi package source (TS extension + skill files) into a pure skill (SKILL.md + role prompts), installable via `pi install`.",
  phases: [
    { title: "Survey package source" },
    { title: "Distill skill semantics" },
    { title: "Generate skill files" },
    { title: "Validate and persist" },
  ],
};

// ── Args ─────────────────────────────────────────────────────────────────
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
const SOURCE_PATH =
  _a && typeof _a.sourcePath === "string" && _a.sourcePath
    ? _a.sourcePath
    : null;
const SKILL_DIR =
  _a && typeof _a.skillDir === "string" && _a.skillDir ? _a.skillDir : null;
const PACKAGE_NAME =
  _a && typeof _a.packageName === "string" && _a.packageName
    ? _a.packageName
    : null;
const PACKAGE_VERSION =
  _a && typeof _a.packageVersion === "string" && _a.packageVersion
    ? _a.packageVersion
    : "0.1.0";

if (!SOURCE_PATH) {
  return {
    error:
      "args.sourcePath is required (absolute path to a Pi package source directory containing package.json with a `pi` field).",
  };
}
if (!SKILL_DIR) {
  return {
    error:
      "args.skillDir is required (absolute path to the output directory; will be created if missing).",
  };
}

log("Distilling skill from " + SOURCE_PATH + " -> " + SKILL_DIR);

// ── 1. Survey package source ─────────────────────────────────────────────
phase("Survey package source");
const survey = await agent(
  [
    "Use bash and read tools to inspect the Pi package at " + SOURCE_PATH + ".",
    "",
    "Find and report on:",
    "- package.json (name, version, description, peer/dev/runtime deps, `pi.extensions` and `pi.skills` entries, scripts)",
    "- SKILL.md or skills/<name>/SKILL.md (frontmatter name/description/argument-hint/level; body sections)",
    "- skills/ directory tree: SKILL.md + subdirs (prompts/, references/, etc.)",
    "- extensions/ or pi/extensions/ directory tree (TS source files)",
    "- agents/ directory if it exists (role prompt files)",
    "- Any README.md or docs/ that explains the package's intent",
    "",
    "For each file: full absolute path, size in bytes, type (package-json | skill-md | role-prompt | ts-source | readme | other).",
    "",
    "Return JSON:",
    "{ packageJson: { path, exists, parsed: { name, version, description, piExtensions, piSkills } | null }, skillMd: { path, exists } | null, rolePrompts: [{ path, size, role }], extensionFiles: [{ path, size, inferredRole }], agentsFiles: [{ path, size, role }], references: [{ path, size }], readme: { path, exists } | null }",
  ].join("\n"),
  {
    schema: {
      type: "object",
      properties: {
        packageJson: {
          type: "object",
          properties: {
            path: { type: "string" },
            exists: { type: "boolean" },
            parsed: {
              type: "object",
              properties: {
                name: { type: "string" },
                version: { type: "string" },
                description: { type: "string" },
                piExtensions: { type: "array", items: { type: "string" } },
                piSkills: { type: "array", items: { type: "string" } },
              },
              required: ["name"],
            },
          },
          required: ["path", "exists"],
        },
        skillMd: {
          type: "object",
          properties: { path: { type: "string" }, exists: { type: "boolean" } },
          required: ["path", "exists"],
        },
        rolePrompts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              size: { type: "integer" },
              role: { type: "string" },
            },
            required: ["path", "size", "role"],
          },
        },
        extensionFiles: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              size: { type: "integer" },
              inferredRole: { type: "string" },
            },
            required: ["path", "size", "inferredRole"],
          },
        },
        agentsFiles: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              size: { type: "integer" },
              role: { type: "string" },
            },
            required: ["path", "size", "role"],
          },
        },
        references: {
          type: "array",
          items: {
            type: "object",
            properties: { path: { type: "string" }, size: { type: "integer" } },
            required: ["path", "size"],
          },
        },
        readme: {
          type: "object",
          properties: { path: { type: "string" }, exists: { type: "boolean" } },
          required: ["path", "exists"],
        },
      },
      required: [
        "packageJson",
        "skillMd",
        "rolePrompts",
        "extensionFiles",
        "agentsFiles",
        "references",
        "readme",
      ],
    },
    label: "survey",
  },
);

// ── 2. Distill skill semantics ───────────────────────────────────────────
// Return ONLY metadata (paths, names, descriptions), NOT file content.
// The generate phase will read the files directly to avoid huge payload.
phase("Distill skill semantics");
const distilledRaw = await agent(
  [
    "Read the SKILL.md, role prompt files, and key extension source files for this Pi package, and distill them into a pure skill (SKILL.md + role prompts, no TypeScript extension glue).",
    "",
    "Survey of files to read:",
    JSON.stringify(survey, null, 2),
    "",
    "Distillation goal: produce a SKILL.md that captures the user-facing behavior of the package (slash command, arguments, modes, completion signals) plus role prompts (planner/architect/critic or whatever roles exist) — without referencing the TypeScript internals.",
    "",
    "IMPORTANT: Return a JSON object with a single field 'distilledJson' whose value is a JSON-encoded string containing the distillation METADATA ONLY (no file content).",
    "Schema for the stringified object:",
    "{ skillName, slashCommand, argumentHint, description, coreDirective, hardConstraints: [string], iterationLoop, rolePrompts: [{ role, filename, sourcePath }], completionSignals: [string], outputArtifacts: [string], planningExecutionBoundary }",
    "rolePrompts[i].sourcePath must be the absolute path the generate phase should read to inline content. rolePrompts[i].filename is the relative output path (e.g. 'prompts/planner.md').",
    "Do NOT inline content in this distillation — just metadata.",
    'Example return shape: { "distilledJson": "{\\"skillName\\":\\"ralplan\\",\\"slashCommand\\":\\"/ralplan\\",\\"description\\":\\"...\\",\\"rolePrompts\\":[{\\"role\\":\\"planner\\",\\"filename\\":\\"prompts/planner.md\\",\\"sourcePath\\":\\"/Users/.../planner.md\\"}]}" }',
  ].join("\n"),
  {
    schema: {
      type: "object",
      properties: {
        distilledJson: { type: "string" },
      },
      required: ["distilledJson"],
    },
    label: "distill",
  },
);
let distilled;
try {
  distilled = JSON.parse(distilledRaw.distilledJson);
} catch (e) {
  distilled = null;
}

// ── 3. Generate + Persist (combined to avoid JSON-encoding large file content) ──
// The agent reads role prompt files directly and writes them via the write tool,
// returning only a small success report rather than the full file content.
phase("Generate and persist");
log("Output directory: " + SKILL_DIR + " (agent's write tool creates parents)");
const validation = await agent(
  [
    "Generate the COMPLETE skill (SKILL.md + prompts/<role>.md + README.md + package.json) at " +
      SKILL_DIR +
      " and verify the result.",
    "",
    "Distilled metadata (use this to write SKILL.md and README.md):",
    JSON.stringify(distilled, null, 2),
    "",
    "Role prompt source files (use the read tool to fetch each, then write verbatim to the output path):",
    JSON.stringify(
      (distilled && distilled.rolePrompts ? distilled.rolePrompts : []).map(
        function (r) {
          return {
            role: r.role,
            read_from: r.sourcePath,
            write_to: SKILL_DIR + "/" + r.filename,
          };
        },
      ),
      null,
      2,
    ),
    "",
    "Steps:",
    "1. Use the read tool to fetch each role prompt from its read_from path.",
    "2. Use the write tool to save each prompt verbatim at its write_to path.",
    "3. Compose SKILL.md at " +
      SKILL_DIR +
      "/SKILL.md with YAML frontmatter (name, description, argument-hint, level) + body sections: Usage, Flags/Options, Core Directive, Hard Constraints, Iteration Loop, Output Artifacts, Completion Signals, Termination Conditions, Planning/Execution Boundary, Fallback Mode (if any).",
    "4. Compose README.md at " + SKILL_DIR + "/README.md (1 page max).",
    "5. Write package.json at " + SKILL_DIR + "/package.json with:",
    '   { "name": "' +
      PACKAGE_NAME +
      '", "version": "' +
      PACKAGE_VERSION +
      '", "description": ' +
      JSON.stringify(
        distilled && distilled.description ? distilled.description : "",
      ) +
      ', "type": "module", "pi": { "skills": ["."] }, "files": ["SKILL.md", "prompts/", "README.md", "package.json"], "license": "MIT" }',
    "6. Run bash: ls -la " +
      SKILL_DIR +
      " && echo --- && head -10 " +
      SKILL_DIR +
      "/SKILL.md",
    "",
    "Constraints: frontmatter is valid YAML between --- markers; body uses standard markdown; role prompt filenames match distilled.rolePrompts[i].filename exactly; preserve completion signals EXACTLY (PIPELINE_*_COMPLETE etc).",
    "",
    "Return JSON: { valid: boolean, issues: [string], skillDir: string, filesWritten: [string], totalBytes: number }",
  ].join("\n"),
  {
    schema: {
      type: "object",
      properties: {
        valid: { type: "boolean" },
        issues: { type: "array", items: { type: "string" } },
        skillDir: { type: "string" },
        filesWritten: { type: "array", items: { type: "string" } },
        totalBytes: { type: "integer" },
      },
      required: ["valid", "issues", "skillDir", "filesWritten", "totalBytes"],
    },
    label: "generate-and-persist",
  },
);

// ── Summary ──────────────────────────────────────────────────────────────
return {
  sourcePath: SOURCE_PATH,
  skillDir: SKILL_DIR,
  packageName:
    PACKAGE_NAME ||
    (distilled && distilled.skillName ? distilled.skillName : null),
  survey: survey ?? null,
  distilled: distilled ?? null,
  filesGenerated:
    validation && Array.isArray(validation.filesWritten)
      ? validation.filesWritten.length
      : 0,
  validation: validation ?? null,
};
