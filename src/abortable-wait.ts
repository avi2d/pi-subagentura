/**
 * Shared helper for abort-signal-aware promise racing.
 *
 * Races a promise against an AbortSignal. If the signal fires before the
 * promise resolves, returns `{ aborted: true }`. Otherwise returns
 * `{ aborted: false, value }`.
 *
 * Used by get_subagent_result and get_workflow_result to avoid duplicating
 * the race/catch/cleanup pattern.
 */

const ABORT_SENTINEL = Symbol("abortable-wait-abort");

export type AbortableWaitResult<T> =
  | {
      aborted: true;
    }
  | { aborted: false; value: T };

export async function abortableWait<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<AbortableWaitResult<T>> {
  if (!signal) {
    return { aborted: false, value: await promise };
  }

  if (signal.aborted) {
    return { aborted: true };
  }

  let abortHandler: (() => void) | undefined;
  try {
    const abortPromise = new Promise<typeof ABORT_SENTINEL>((resolve) => {
      abortHandler = () => resolve(ABORT_SENTINEL);
      signal.addEventListener("abort", abortHandler, { once: true });
    });
    const result = await Promise.race([promise, abortPromise]);
    if (result === ABORT_SENTINEL) {
      return { aborted: true };
    }
    return { aborted: false, value: result as T };
  } finally {
    if (abortHandler) {
      signal.removeEventListener("abort", abortHandler);
    }
  }
}
