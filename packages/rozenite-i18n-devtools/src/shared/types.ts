export type LocaleCode = string;
export type TextDirection = 'ltr' | 'rtl';

/**
 * A key that resolved NOWHERE — not in the active locale and not in any fallback.
 *
 * This is deliberately NOT the same population as `LocaleCoverage.fallingBackCount`.
 * A key present in the fallback locale is not "missing" to i18next: it resolves, renders
 * the fallback text, and emits no `missingKey` event at all. Verified in M0-FINDINGS.md.
 *
 * So: this type catches typos and unextracted strings. Coverage catches the much larger
 * and more common problem — "why is this screen in English?". The panel must not conflate them.
 */
export type MissingKeyRecord = {
  /** Dedup identity: namespace + key. Stable across repeats. */
  id: string;
  key: string;
  ns: string;
  /**
   * The locale the app was actually displaying when the miss happened.
   *
   * NOT `lngs[0]` from i18next's `missingKey` event. `saveMissingTo` defaults to 'fallback',
   * so in a `fallbackLng: 'en'` app a key missing in German emits `lngs === ['en']`.
   * Putting that on the wire labels every row 'en'. Captured separately by the adapter.
   */
  observedLng: LocaleCode;
  /**
   * Every locale this key has been missed in.
   *
   * Shown on the row instead of `observedLng`, which only ever held the latest sighting and
   * therefore flipped every time you switched language — a stable row that looked unstable.
   * Same fix, and same reasoning, as InterpolationMissRecord.locales.
   */
  observedLocales: LocaleCode[];
  /** i18next's raw `lngs` argument — the save target(s). Kept for backend-reporting parity. */
  saveTargets: LocaleCode[];
  /** What i18next rendered in place of the value (usually the key itself). */
  rendered: string;
  /**
   * Sightings, NOT distinct problems — and deliberately NOT shown, same as the
   * interpolation feed.
   *
   * It looks meaningful when you tap a button five times, but a missing key inside a list
   * row that renders a hundred times reports ×100. That is render frequency, exactly what
   * it measures on the other tab. Showing it on one feed and not the other implied a
   * distinction that does not survive a real app.
   */
  count: number;
  firstSeenMs: number;
  lastSeenMs: number;
};

/**
 * An unresolved interpolation variable: `t('greet')` where the value is `"Hi {{name}}"`
 * and no `name` was passed.
 *
 * i18next does NOT log these even with `debug: true` — the warn sits behind
 * `else if (skipOnVariables)` and `skipOnVariables` defaults to true, so it never fires.
 * Genuinely invisible today. See M0-FINDINGS.md finding 3.
 */
export type InterpolationMissRecord = {
  /**
   * Identity is `ns:key:variable` — deliberately the same shape as MissingKeyRecord's
   * `ns:key`, so both feeds dedupe by WHAT is broken rather than by where it was seen.
   *
   * Keying on the locale as well (the first implementation) produced one row per locale
   * visited, because the template text differs per language: the same unsupplied
   * `{{name}}` appeared three times after switching de -> en -> ar. Same panel, two
   * different dedup rules.
   */
  id: string;
  /** The translation key, e.g. "greeting". */
  key: string;
  ns: string;
  /** The raw template as resolved, e.g. "Hi {{name}}". Display only — not identity. */
  template: string;
  /** The variable that was never supplied, e.g. "name". */
  variable: string;
  /** Locale at the most recent sighting. Like MissingKeyRecord.observedLng. */
  lng: LocaleCode;
  /**
   * Every locale this has been seen unresolved in.
   *
   * More useful on the row than the latest template, which flips language on every locale
   * switch and makes a stable row look like it is changing identity. Seen in all locales
   * means the variable is never passed at all, rather than one translation being at fault.
   */
  locales: LocaleCode[];
  /**
   * Sightings, NOT distinct problems — and deliberately NOT shown in the panel.
   *
   * One unsupplied variable in a component that re-renders 15 times counts 15, and
   * switching locale alone drives it up because changeLanguage re-renders every
   * useTranslation consumer. The number therefore measures React render churn rather than
   * anything the developer did, which is misleading next to the Missing tab's count, where
   * ×7 really does mean seven failed lookups you caused.
   *
   * Kept on the record because it is accurate and an agent tool may want "how hot is this
   * path", but the row shows the locale set instead.
   */
  count: number;
  firstSeenMs: number;
  lastSeenMs: number;
};

/**
 * Per-locale coverage against a reference locale.
 *
 * `fallingBack` is the headline number: keys that EXIST in the reference locale but are
 * absent here, so they silently render reference text. These produce zero `missingKey`
 * events, which is exactly why the feed alone is not enough.
 */
export type LocaleCoverage = {
  lng: LocaleCode;
  dir: TextDirection;
  isActive: boolean;
  /** Keys present in this locale (union across loaded namespaces). */
  translated: number;
  /** Keys present in the reference locale — the denominator. */
  total: number;
  /** Capped sample of keys that fall back. Full count in `fallingBackCount`. */
  fallingBack: string[];
  fallingBackCount: number;
  /**
   * True when no namespace for this locale has loaded yet. Distinguishes
   * "0% translated" from "not loaded" — they look identical otherwise and
   * reporting a real app as 0% translated destroys trust instantly.
   */
  notLoaded: boolean;
  /**
   * Namespaces absent from the store for this locale, and therefore excluded from both
   * sides of the ratio.
   *
   * With lazy namespace loading (i18next-http-backend and friends) a namespace that has
   * simply not downloaded yet is indistinguishable from one with no translations. Counting
   * it as untranslated reports a healthy app as broken — the same false positive
   * `notLoaded` guards against, one level down.
   */
  notLoadedNamespaces: string[];
};

export type AdapterCapabilities = {
  /** `saveMissing` is on, so the `missingKey` event fires. Without it there is no feed. */
  missingKeyFeed: boolean;
  /** The adapter installed an observer-safe `missingInterpolationHandler`. */
  interpolationTracking: boolean;
  /** `changeLanguage` is available. */
  localeSwitching: boolean;
  /** The resource store is readable for coverage math. */
  coverage: boolean;
};

export type AdapterInfo = {
  id: string;
  name: string;
  library: string;
  libraryVersion: string | null;
  capabilities: AdapterCapabilities;
  /**
   * Non-fatal setup problems worth showing in the panel — e.g. `saveMissing` is off,
   * so the feed will stay empty no matter what the user does.
   */
  warnings: string[];
};

export type I18nSnapshot = {
  adapter: AdapterInfo;
  activeLng: LocaleCode;
  /** Resolution hierarchy for the active locale, most specific first. */
  languages: LocaleCode[];
  fallbackLng: LocaleCode[];
  referenceLng: LocaleCode;
  namespaces: string[];
  locales: LocaleCoverage[];
  capturedAtMs: number;
};

/** Detail for one key across every loaded locale — powers "why is this English?". */
export type KeyDetail = {
  key: string;
  ns: string;
  /** Per-locale value, or null when absent in that locale. */
  values: Array<{ lng: LocaleCode; value: string | null }>;
  /** Which locale the active resolution chain actually lands on. */
  resolvedFrom: LocaleCode | null;
  resolvedValue: string | null;
  /** Interpolation variables detected in the resolved value, e.g. ["name", "count"]. */
  variables: string[];
};

export const DEFAULT_FALLBACK_SAMPLE = 25;
export const MISSING_FEED_CAPACITY = 500;
export const INTERPOLATION_FEED_CAPACITY = 200;
