/**
 * Trailing-edge coalescer: many calls inside the window collapse into one execution.
 *
 * Exists because of a real-app performance failure. The hook wired i18next's `added`,
 * `removed` and `languageChanged` events straight to "compute a full snapshot and push it
 * over CDP" — and `added` fires once per namespace per language while a backend loads
 * bundles. Every event re-flattened every locale × namespace and re-serialized the result.
 * On the 8-key demo that was invisible; on a production app it made the panel barely usable.
 *
 * Timers are injectable for the same reason they are in missing-store: so the behaviour is
 * testable without wall-clock waits.
 */
export type Coalescer = {
  /** Request an execution. Calls during a pending window are absorbed into it. */
  call: () => void;
  /** Run immediately if anything is pending, and cancel the timer. */
  flush: () => void;
  /** Cancel without running. */
  dispose: () => void;
};

export const createTrailingCoalescer = (
  fn: () => void,
  ms: number,
  schedule: (fn: () => void, ms: number) => unknown = (f, m) => setTimeout(f, m),
  cancel: (handle: unknown) => void = (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
): Coalescer => {
  let timer: unknown = null;
  let pending = false;

  const run = () => {
    pending = false;
    try {
      fn();
    } catch {
      // The coalesced work must never take the caller down; the next window retries.
    }
  };

  return {
    call() {
      pending = true;
      if (timer !== null) return; // absorbed into the open window
      timer = schedule(() => {
        timer = null;
        if (pending) run();
      }, ms);
    },
    flush() {
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
      if (pending) run();
    },
    dispose() {
      if (timer !== null) cancel(timer);
      timer = null;
      pending = false;
    },
  };
};
