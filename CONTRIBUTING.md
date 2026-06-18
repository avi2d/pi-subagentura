# Contributing

Thanks for contributing to `pi-subagentura`.

## Local development

```bash
npm install
npm run typecheck
npm test
npm run pack:check
```

## Provider list

`resolveModel()` in `helpers.ts` dynamically queries all providers via `getProviders()` from the Pi SDK — no hardcoded list. When Pi adds new providers, bare model IDs resolve automatically without code changes.

## Guidelines

- Keep changes focused and minimal
- Follow existing code style
- Add or update tests when behavior changes
- Use conventional commits when preparing commits

## Release flow

The publish workflow runs when a `v*` tag is pushed and the tag matches the version in `package.json`.

Typical release flow:

```bash
npm version patch
git push origin master --follow-tags
```

## Reporting issues

Please include:

- what you expected
- what happened instead
- Pi version
- package version
- reproduction steps

## Bundled workflows

### Resync the `ralplan-consensus` workflow

The script inlines role prompts from `pi-ralplan/pi/skills/ralplan/prompts/`; when those upstream files change the inlined copies drift.

**Upstream sources:**

- `../pi-ralplan/pi/skills/ralplan/prompts/planner.md` → `PLANNER_PERSONA`
- `../pi-ralplan/pi/skills/ralplan/prompts/architect.md` → `ARCHITECT_PERSONA`
- `../pi-ralplan/pi/skills/ralplan/prompts/critic.md` → `CRITIC_PERSONA`
  (`ANALYST_PERSONA` is synthesized in-script — no upstream to resync.)

**Procedure:**

1. Compare each upstream file against the corresponding `PLANNER_PERSONA` / `ARCHITECT_PERSONA` / `CRITIC_PERSONA` template literal.
2. If any changed: update the inlined literal and bump `last-synced:` in the header comment.
3. Run `npm test -- src/workflow-ralplan.test.ts` — must stay green.
4. If `DELIBERATE_SIGNALS` changed, update the AC-3 test list in `src/workflow-ralplan.test.ts`.

**Install from parent agent:** `workflow("ralplan-consensus", ...)` (see `src/workflow.ts:442` for the save path).

```js
workflow("ralplan-consensus", { idea, workingDir, ... })
```

### Resync the `ralplan-occ` workflow

The script inlines role prompts from `oh-my-claudecode/agents/*.md`; when those upstream files change the inlined copies drift.

**Upstream sources:**

- `../../oh-my-claudecode/agents/planner.md` → `PLANNER_PERSONA`
- `../../oh-my-claudecode/agents/architect.md` → `ARCHITECT_PERSONA`
- `../../oh-my-claudecode/agents/critic.md` → `CRITIC_PERSONA`
- `../../oh-my-claudecode/agents/analyst.md` → `ANALYST_PERSONA`

At sync time, the YAML frontmatter (`name`/`description`/`model`/`level`/`disallowedTools`) and the outer `<Agent_Prompt>...</Agent_Prompt>` wrapper are stripped — the structured role/protocol sections inside are preserved verbatim because the LLM relies on them for context. The workflow runtime does NOT honor OCC's `model: opus` directive; the parent session's model is used.

**Procedure:**

1. Compare each upstream file against the corresponding inlined persona.
2. If any changed: update the inlined literal and bump `last-synced:` in the header comment.
3. Run `npm test -- src/workflow-ralplan-occ.test.ts` — must stay green.
4. If `DELIBERATE_SIGNALS` changed, update the AC-3 test list in `src/workflow-ralplan-occ.test.ts`.

**Artifact paths** follow OCC convention (`.omc/plans/<planName>.md`, `.omc/drafts/plan_draft.md`) — see `agents/planner.md` and `skills/ralplan/SKILL.md`. Default `args.workingDir` should point at the project root containing `.omc/`.

**Install from parent agent:**

```js
workflow("ralplan-occ", { idea, workingDir, ... })
```

