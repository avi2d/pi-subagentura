export const MAX_COMPLETION_DISPLAY_LABEL_LENGTH = 160;
const MAX_COMPLETION_DISPLAY_LABEL_INPUT_LENGTH =
  MAX_COMPLETION_DISPLAY_LABEL_LENGTH * 4;

/** Normalize an optional human-facing label without exposing technical IDs. */
export function completionDisplayLabel(
  value: unknown,
  fallback = "sub-agent",
): string {
  if (typeof value !== "string") return fallback;
  const label = value
    .slice(0, MAX_COMPLETION_DISPLAY_LABEL_INPUT_LENGTH)
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (label.length === 0) return fallback;
  return label.slice(0, MAX_COMPLETION_DISPLAY_LABEL_LENGTH);
}

export function formatCompletionMessage(
  label: unknown,
  text: string,
  fallback = "sub-agent",
): string {
  return `from: ${completionDisplayLabel(label, fallback)}, ${text}`;
}
