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

export interface AbortableWaitResult<T> {
  aborted: boolean;
  value?: T;
}

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
    const abortPromise = new Promise<never>((_, reject) => {
      abortHandler = () => {
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal.addEventListener("abort", abortHandler, { once: true });
    });
    const value = await Promise.race([promise, abortPromise]);
    return { aborted: false, value };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return { aborted: true };
    }
    throw err;
  } finally {
    if (abortHandler) {
      signal.removeEventListener("abort", abortHandler);
    }
  }
}
