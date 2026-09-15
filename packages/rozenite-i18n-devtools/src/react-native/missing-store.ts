import type { InterpolationMissRecord, MissingKeyRecord } from '../shared/types';
import { INTERPOLATION_FEED_CAPACITY, MISSING_FEED_CAPACITY } from '../shared/types';

/**
 * Device-side dedup + ring buffer for the two feeds.
 *
 * Deduplicated by identity, so a key missed 4,000 times during a scroll is ONE row with
 * `count: 4000` rather than 4,000 messages. Flushes are coalesced on a timer: i18next can
 * emit `missingKey` once per `t()` call, which on a list screen is a burst, and one
 * message per miss would swamp the bridge.
 */
export type Flush = {
  missing: MissingKeyRecord[];
  interpolation: InterpolationMissRecord[];
  missingTotal: number;
  interpolationTotal: number;
  dropped: number;
};

export type MissingStoreOptions = {
  onFlush: (f: Flush) => void;
  /** Coalescing window. 250ms keeps the feed feeling live without bursting. */
  flushMs?: number;
  capacity?: number;
  interpolationCapacity?: number;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
};

export const createMissingStore = (options: MissingStoreOptions) => {
  const {
    onFlush,
    flushMs = 250,
    capacity = MISSING_FEED_CAPACITY,
    interpolationCapacity = INTERPOLATION_FEED_CAPACITY,
    now = () => Date.now(),
    schedule = (fn, ms) => setTimeout(fn, ms),
    cancel = (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  } = options;

  const missing = new Map<string, MissingKeyRecord>();
  const interpolation = new Map<string, InterpolationMissRecord>();
  const dirtyMissing = new Set<string>();
  const dirtyInterp = new Set<string>();
  let dropped = 0;
  let timer: unknown = null;

  /** Evict the least-recently-seen entry, so a long session cannot grow without bound. */
  const evictOldest = <T extends { lastSeenMs: number }>(map: Map<string, T>) => {
    let oldestKey: string | null = null;
    let oldest = Infinity;
    for (const [k, v] of map) {
      if (v.lastSeenMs < oldest) {
        oldest = v.lastSeenMs;
        oldestKey = k;
      }
    }
    if (oldestKey !== null) {
      map.delete(oldestKey);
      dropped++;
    }
  };

  const scheduleFlush = () => {
    if (timer !== null) return;
    timer = schedule(() => {
      timer = null;
      flush();
    }, flushMs);
  };

  const flush = () => {
    if (dirtyMissing.size === 0 && dirtyInterp.size === 0) return;
    const m = [...dirtyMissing].map((k) => missing.get(k)).filter(Boolean) as MissingKeyRecord[];
    const i = [...dirtyInterp].map((k) => interpolation.get(k)).filter(Boolean) as InterpolationMissRecord[];
    dirtyMissing.clear();
    dirtyInterp.clear();
    const d = dropped;
    dropped = 0;
    onFlush({
      missing: m,
      interpolation: i,
      missingTotal: missing.size,
      interpolationTotal: interpolation.size,
      dropped: d,
    });
  };

  return {
    addMissing(
      input: Omit<
        MissingKeyRecord,
        'id' | 'count' | 'firstSeenMs' | 'lastSeenMs' | 'observedLocales'
      >,
    ) {
      const id = `${input.ns}:${input.key}`;
      const ts = now();
      const existing = missing.get(id);
      if (existing) {
        existing.count++;
        existing.lastSeenMs = ts;
        // A key can be missed in more than one locale. Keep the latest for context, but
        // ACCUMULATE the set — that is what the row shows, so it stays stable while you
        // switch language.
        existing.observedLng = input.observedLng;
        if (input.observedLng && !existing.observedLocales.includes(input.observedLng)) {
          existing.observedLocales.push(input.observedLng);
        }
      } else {
        if (missing.size >= capacity) evictOldest(missing);
        missing.set(id, {
          ...input,
          id,
          observedLocales: input.observedLng ? [input.observedLng] : [],
          count: 1,
          firstSeenMs: ts,
          lastSeenMs: ts,
        });
      }
      dirtyMissing.add(id);
      scheduleFlush();
    },

    addInterpolation(
      input: Omit<InterpolationMissRecord, 'id' | 'count' | 'firstSeenMs' | 'lastSeenMs' | 'locales'>,
    ) {
      // Same identity shape as addMissing's `ns:key`. NOT keyed on locale — see the
      // comment on InterpolationMissRecord.
      const id = `${input.ns}:${input.key}:${input.variable}`;
      const ts = now();
      const existing = interpolation.get(id);
      if (existing) {
        existing.count++;
        existing.lastSeenMs = ts;
        // Keep the most recent sighting's locale and template...
        existing.lng = input.lng;
        existing.template = input.template;
        // ...but ACCUMULATE the locale set. That is what the row shows, because it is
        // stable and says whether this is a translation problem or a missing-variable one.
        if (input.lng && !existing.locales.includes(input.lng)) existing.locales.push(input.lng);
      } else {
        if (interpolation.size >= interpolationCapacity) evictOldest(interpolation);
        interpolation.set(id, {
          ...input,
          id,
          locales: input.lng ? [input.lng] : [],
          count: 1,
          firstSeenMs: ts,
          lastSeenMs: ts,
        });
      }
      dirtyInterp.add(id);
      scheduleFlush();
    },

    /** Everything currently held — used to seed a panel that just (re)connected. */
    snapshot(): { missing: MissingKeyRecord[]; interpolation: InterpolationMissRecord[] } {
      return { missing: [...missing.values()], interpolation: [...interpolation.values()] };
    },

    clear(): number {
      const n = missing.size + interpolation.size;
      missing.clear();
      interpolation.clear();
      dirtyMissing.clear();
      dirtyInterp.clear();
      dropped = 0;
      return n;
    },

    flushNow: flush,

    dispose() {
      if (timer !== null) cancel(timer);
      timer = null;
    },
  };
};

export type MissingStore = ReturnType<typeof createMissingStore>;
