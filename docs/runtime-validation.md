# Runtime tool-parameter validation

pi-subagentura can add a strict, sanitized validation layer around all 21 public
agent tools. It is disabled by default.

Enable it for a Pi process with:

```bash
PI_SUBAGENTURA_WITH_VALIDATION=on pi
```

After trimming and case-folding, only `1`, `true`, `yes`, and `on` enable the
feature. Every other value leaves it disabled.

## Where validation runs

Pi normally validates tool calls before an extension tool's `execute` callback
and may convert compatible primitive values, such as a number passed to a string
field. When this feature is enabled, pi-subagentura installs a
`prepareArguments` hook on every registered tool. The hook validates the raw
prepared arguments before Pi performs that conversion, so an invalid model tool
call cannot reach the extension callback through coercion.

The `execute` wrapper repeats the same check for direct or programmatic callers
that bypass Pi's agent loop. A direct invalid call returns structured details:

```json
{
  "status": "error",
  "code": "invalid_params",
  "tool": "subagent_isolated",
  "errors": [{ "path": "/task", "message": "Expected string" }]
}
```

For a normal model-originated call, Pi converts a thrown pre-execution
validation failure into an error tool result. Its text contains the same
sanitized paths and messages, but Pi owns the outer result shape.

Disabling this feature does **not** disable Pi's built-in validation. It
preserves Pi's normal schema-validation and primitive-coercion behavior.

## Strictness rules

When enabled:

- values must match the TypeBox tool schema before Pi coercion;
- an existing tool-specific `prepareArguments` compatibility shim runs first;
- omitted arguments for an object schema are normalized to `{}`;
- top-level object parameters are treated as closed when the schema declares
  properties, unless it explicitly sets `additionalProperties: true` or supplies
  an additional-property schema;
- nested `Type.Unknown()` values remain unrestricted, including workflow `args`
  and declarative-plan task `input` values.

The top-level closed-object rule is intentionally opt-in. Public schemas remain
permissive when the environment flag is disabled, preserving existing callers.

## Error and resource bounds

Validation errors never include raw parameter values or undeclared property
names. At most eight deduplicated `{path, message}` entries are returned, and
paths are capped at 160 characters.

TypeBox materializes its complete error array. Before requesting that array for
an invalid value, pi-subagentura checks an error-reporting budget of 4,096
container entries and 64 levels of nesting. An invalid value beyond either bound
receives one generic reporting-limit error. These reporting limits do not reject
a schema-valid value, so large valid workflow `Type.Unknown()` payloads remain
compatible.

This feature validates shape and basic schema constraints. It does not replace
path-containment checks, session ownership, authorization, workflow trust, or
other tool-specific safety checks.

## Compatibility

The implementation uses the Pi-supported `typebox/compile` entry point and is
covered in CI against the minimum supported Pi SDK (`0.80.6`) and the current
latest SDK. The minimum SDK currently carries TypeBox `1.1.38`; changes to
TypeBox's compile or validation-error ABI require the compatibility matrix to be
updated before release.
