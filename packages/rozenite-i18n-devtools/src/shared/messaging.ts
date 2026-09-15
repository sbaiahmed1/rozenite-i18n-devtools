import type {
  I18nSnapshot,
  InterpolationMissRecord,
  KeyDetail,
  LocaleCode,
  MissingKeyRecord,
} from './types';

export type I18nFeeds = {
  missing: MissingKeyRecord[];
  interpolation: InterpolationMissRecord[];
};

/* ------------------------------------------------------------------ device -> panel */

/**
 * Announced by the device once it is listening. The panel is recreated on every app
 * reload and asks for a snapshot immediately, which can land before the app's React tree
 * has mounted the plugin; this lets the panel ask again instead of waiting forever.
 *
 * Same reload-race defence as @rozenite/storage-plugin's `device-ready`.
 */
export type I18nDeviceReadyEvent = {
  type: 'device-ready';
  snapshot: I18nSnapshot;
};

/** Coalesced batch of new/updated missing keys. Never one message per miss. */
export type I18nMissingKeysEvent = {
  type: 'missing-keys';
  records: MissingKeyRecord[];
  /** Total distinct misses held device-side, including any evicted from the ring buffer. */
  distinctTotal: number;
  /** Records dropped by the ring buffer since the last message, if any. */
  dropped: number;
};

export type I18nInterpolationMissesEvent = {
  type: 'interpolation-misses';
  records: InterpolationMissRecord[];
  distinctTotal: number;
};

/** The app changed locale on its own, or our `set-locale` landed. */
export type I18nSnapshotEvent = {
  type: 'snapshot';
  snapshot: I18nSnapshot;
};

export type I18nDeviceEvent =
  | I18nDeviceReadyEvent
  | I18nMissingKeysEvent
  | I18nInterpolationMissesEvent
  | I18nSnapshotEvent;

export type I18nEventMap = {
  [K in I18nDeviceEvent['type']]: Extract<I18nDeviceEvent, { type: K }>;
};

/* ------------------------------------------------------------------ panel -> device */

export type I18nErrorCode =
  | 'NO_ADAPTER'
  | 'KEY_NOT_FOUND'
  | 'LOCALE_NOT_AVAILABLE'
  | 'CAPABILITY_UNAVAILABLE'
  | 'LOAD_FAILED'
  | 'INTERNAL';

export type I18nRequestError = {
  code: I18nErrorCode;
  message: string;
};

/**
 * RPC surface, consumed via `createRozeniteRpc` from @rozenite/plugin-bridge.
 *
 * Every payload here is ASCII or ASCII-escaped. Rozenite issue #407 silently drops
 * non-BMP characters HOST->DEVICE (PR #408 was closed unmerged; the double
 * JSON.stringify into Runtime.evaluate is still present in shipped 2.4.0). Locale codes
 * and key paths are ASCII by construction, so the MVP is unaffected — but any future
 * method that sends user-authored translation text device-ward must route through
 * `toAscii()` in ./ascii.ts. That is why live translation editing is deferred to v2.
 */
export type I18nMethods = {
  /** Full snapshot: coverage per locale, namespaces, active language, capabilities. */
  getSnapshot: () => Promise<I18nSnapshot>;

  /**
   * Everything the device has buffered so far.
   *
   * The device starts observing when the app mounts; the panel may open minutes later, or
   * be recreated by a reload. Without this, every miss that happened before the panel
   * connected was simply lost — the device pushed `missing-keys` to nobody. The panel pulls
   * this on connect and on every `device-ready`.
   */
  getFeeds: () => Promise<I18nFeeds>;

  /**
   * Everything known about one key across locales, including which locale the active
   * chain resolves it from. Walks the resource store directly — never calls `t()`.
   *
   * Calling `t()` here would re-enter the very code path that emits `missingKey` and
   * invokes `saveMissing`, so a panel probing keys would fabricate entries in its own
   * feed and POST junk to the user's translation backend. See M0-FINDINGS.md.
   */
  getKey: (input: { key: string; ns?: string }) => Promise<KeyDetail>;

  /** Switch the running app's locale. `lng` is ASCII, so #407-safe. */
  setLocale: (input: { lng: LocaleCode }) => Promise<I18nSnapshot>;

  /** Drop the device-side missing-key and interpolation buffers. */
  clear: () => Promise<{ cleared: number }>;

  /**
   * Echo a payload back unchanged. Used by the M0 Unicode spike to prove whether
   * issue #407 is live on this Rozenite version before we trust any text-carrying path.
   */
  echo: (input: { raw: string; encoded: string }) => Promise<{
    raw: string;
    encoded: string;
    rawMatched: boolean;
    encodedMatched: boolean;
  }>;
};
