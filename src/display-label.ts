export const MAX_DISPLAY_LABEL_LENGTH = 160;
const MAX_DISPLAY_LABEL_INPUT_LENGTH = MAX_DISPLAY_LABEL_LENGTH * 4;

function cleanDisplayLabel(value: string): string {
  return value
    .slice(0, MAX_DISPLAY_LABEL_INPUT_LENGTH)
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Normalize bounded human-facing labels before placing them in UI text. */
export function sanitizeDisplayLabel(
  value: unknown,
  fallback = "unknown",
): string {
  const cleaned = typeof value === "string" ? cleanDisplayLabel(value) : "";
  if (cleaned) return cleaned.slice(0, MAX_DISPLAY_LABEL_LENGTH);
  return (cleanDisplayLabel(fallback) || "unknown").slice(
    0,
    MAX_DISPLAY_LABEL_LENGTH,
  );
}
