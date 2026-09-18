import { describe, expect, it } from 'vitest';
import { createTrailingCoalescer } from '../coalesce';

/** Manual timer harness so the window is driven explicitly, not by wall clock. */
const harness = () => {
  const timers: Array<() => void> = [];
  return {
    schedule: (fn: () => void) => {
      timers.push(fn);
      return timers.length - 1;
    },
    cancel: (h: unknown) => {
      timers[h as number] = () => {};
    },
    fire: () => {
      const t = timers.splice(0, timers.length);
      t.forEach((f) => f());
    },
  };
};

describe('trailing coalescer — the real-app snapshot fix', () => {
  it('collapses an event burst into one execution', () => {
    const t = harness();
    let runs = 0;
    const c = createTrailingCoalescer(() => runs++, 400, t.schedule, t.cancel);

    // A backend loading 10 locales × 3 namespaces fires `added` 30 times.
    for (let i = 0; i < 30; i++) c.call();
    expect(runs).toBe(0); // nothing yet — window open
    t.fire();
    expect(runs).toBe(1); // one snapshot, not thirty
  });

  it('a call after the window opens a new one', () => {
    const t = harness();
    let runs = 0;
    const c = createTrailingCoalescer(() => runs++, 400, t.schedule, t.cancel);
    c.call();
    t.fire();
    c.call();
    t.fire();
    expect(runs).toBe(2);
  });

  it('dispose cancels pending work', () => {
    const t = harness();
    let runs = 0;
    const c = createTrailingCoalescer(() => runs++, 400, t.schedule, t.cancel);
    c.call();
    c.dispose();
    t.fire();
    expect(runs).toBe(0);
  });

  it('an exploding fn does not break later windows', () => {
    const t = harness();
    let runs = 0;
    const c = createTrailingCoalescer(() => {
      runs++;
      if (runs === 1) throw new Error('boom');
    }, 400, t.schedule, t.cancel);
    c.call();
    t.fire();
    c.call();
    t.fire();
    expect(runs).toBe(2);
  });
});
