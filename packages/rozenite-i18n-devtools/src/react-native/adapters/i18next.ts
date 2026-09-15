import type {
  AdapterCapabilities,
  AdapterInfo,
  I18nSnapshot,
  KeyDetail,
  LocaleCoverage,
  LocaleCode,
  TextDirection,
} from '../../shared/types';
import { DEFAULT_FALLBACK_SAMPLE } from '../../shared/types';

/**
 * Structural type for the bits of an i18next instance we touch. Deliberately not
 * `import type { i18n } from 'i18next'` — i18next is an optional peerDependency and the
 * plugin must typecheck in an app that does not have it installed.
 */
type I18nLike = {
  language?: string;
  languages?: readonly string[];
  options?: Record<string, any>;
  store?: { data?: Record<string, Record<string, any>>; on?: (e: string, cb: () => void) => void; off?: (e: string, cb: () => void) => void };
  services?: Record<string, any>;
  on?: (event: string, cb: (...args: any[]) => void) => void;
  off?: (event: string, cb: (...args: any[]) => void) => void;
  dir?: (lng?: string) => string;
  changeLanguage?: (lng: string) => Promise<unknown>;
  loadLanguages?: (lngs: string | string[]) => Promise<unknown>;
  reportNamespaces?: { getUsedNamespaces?: () => string[] };
};

export type MissingKeyObservation = {
  key: string;
  ns: string;
  /** The locale actually being displayed — NOT i18next's `lngs[0]`. */
  observedLng: string;
  /** i18next's raw `lngs`: the save target(s), per `saveMissingTo` (default 'fallback'). */
  saveTargets: string[];
  rendered: string;
};

export type InterpolationObservation = {
  key: string;
  ns: string;
  template: string;
  variable: string;
  lng: string;
};

export type CreateI18nextAdapterOptions = {
  i18n: I18nLike;
  adapterId?: string;
  adapterName?: string;
  /** Locale to measure coverage against. Defaults to the first configured fallback, else 'en'. */
  referenceLng?: string;
  /**
   * How to obtain the `missingKey` feed, which requires `saveMissing: true`.
   *
   * - `auto` (default) — enable it ONLY when no backend can write. If the app has a backend
   *   with `create()`, enabling it would POST every missing key to the user's translation
   *   service (i18next-http-backend does ~9.6M downloads/month). We refuse and warn instead.
   * - `never`  — never touch `saveMissing`. The feed works only if the app already enabled it.
   * - `force`  — enable regardless. Only for apps that know they have no writable backend.
   */
  missingKeyCapture?: 'auto' | 'never' | 'force';
  /**
   * Track unresolved interpolation variables (`{{name}}` never supplied).
   *
   * Implemented with a postProcessor that returns the value UNCHANGED and scans it for
   * leftover `{{token}}`s, which `skipOnVariables: true` leaves in the output. That mutates
   * nothing on the render path, so it cannot diverge. (An earlier attempt using
   * `missingInterpolationHandler` did diverge — it displaces the `skipOnVariables` branch,
   * whose `continue` skips the escape step, so `{{a<b}}` rendered as `{{a&lt;b}}`.)
   *
   * Cost: runs on every t() call — a substring check, and a regex only when `{{` is present.
   */
  trackInterpolation?: boolean;
};

export type I18nextAdapter = {
  id: string;
  name: string;
  getInfo: () => AdapterInfo;
  getSnapshot: () => I18nSnapshot;
  getKey: (key: string, ns?: string) => KeyDetail | null;
  setLocale: (lng: string) => Promise<void>;
  subscribe: (handlers: {
    onMissingKey: (o: MissingKeyObservation) => void;
    onInterpolationMiss: (o: InterpolationObservation) => void;
    onChanged: () => void;
  }) => () => void;
};

const INTERP_VAR = /\{\{\s*([^}]+?)\s*\}\}/g;

/**
 * Where we stash the PRISTINE state of an i18next instance, on the instance itself.
 *
 * `createI18nextAdapter` can run more than once against the same instance — Fast Refresh
 * re-executes the module that builds it, and a component that constructs the adapter inline
 * rebuilds it on every render. Without this, the second call reads the state the FIRST call
 * already mutated and records it as "original", so teardown restores the mutation instead of
 * removing it and the host app is permanently left with `saveMissing: true` and our
 * postProcessor installed. Found on-device; unit tests build a fresh instance each time and
 * structurally cannot catch it.
 */
const PRISTINE = '__rozeniteI18nDevtoolsPristine';

type Pristine = {
  saveMissing: unknown;
  postProcess: unknown;
  missingInterpolationHandler: unknown;
  missingKeyHandler: unknown;
};

/** Capture once per instance; every later adapter reuses the first capture. */
const getPristine = (i18n: I18nLike): Pristine => {
  const existing = (i18n as any)[PRISTINE] as Pristine | undefined;
  if (existing) return existing;
  const captured: Pristine = {
    saveMissing: i18n.options?.saveMissing,
    postProcess: i18n.options?.postProcess,
    missingInterpolationHandler: i18n.options?.missingInterpolationHandler,
    missingKeyHandler: i18n.options?.missingKeyHandler,
  };
  try {
    Object.defineProperty(i18n, PRISTINE, { value: captured, enumerable: false, configurable: true });
  } catch {
    (i18n as any)[PRISTINE] = captured;
  }
  return captured;
};

/** Flatten a nested resource tree into dotted key paths. */
const flatten = (node: unknown, prefix: string, out: Map<string, string>): void => {
  if (node == null) return;
  if (typeof node !== 'object') {
    out.set(prefix, String(node));
    return;
  }
  if (Array.isArray(node)) {
    out.set(prefix, node.join(' '));
    return;
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    flatten(v, prefix ? `${prefix}.${k}` : k, out);
  }
};

const keysForLocale = (
  i18n: I18nLike,
  lng: string,
  namespaces: string[],
): { keys: Map<string, string>; absentNamespaces: string[] } => {
  const keys = new Map<string, string>();
  const absentNamespaces: string[] = [];
  const bundle = i18n.store?.data?.[lng];
  if (!bundle) return { keys, absentNamespaces: [...namespaces] };
  for (const ns of namespaces) {
    const nsData = bundle[ns];
    if (nsData == null) {
      // Absent, not empty — the caller must not count these as untranslated.
      absentNamespaces.push(ns);
      continue;
    }
    const sub = new Map<string, string>();
    flatten(nsData, '', sub);
    for (const [k, v] of sub) keys.set(namespaces.length > 1 ? `${ns}:${k}` : k, v);
  }
  return { keys, absentNamespaces };
};

const asArray = (v: unknown): string[] => {
  if (!v) return [];
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'object') {
    const def = (v as Record<string, unknown>).default;
    return Array.isArray(def) ? (def as string[]) : [];
  }
  return [];
};

export const createI18nextAdapter = (options: CreateI18nextAdapterOptions): I18nextAdapter => {
  const {
    i18n,
    adapterId = 'i18next',
    adapterName = 'i18next',
    missingKeyCapture = 'auto',
    trackInterpolation = true,
  } = options;

  const warnings: string[] = [];

  const libraryVersion: string | null =
    typeof (i18n as any)?.options?.compatibilityJSON === 'string' ? null : null;

  /* ---------------------------------------------------------------- saveMissing */
  // The `missingKey` EVENT is emitted unconditionally, AFTER the
  // missingKeyHandler / backendConnector.saveMissing if-else-if (verified at
  // i18next@26.4.2 i18next.js:699-707). So we subscribe to the event and never assign
  // `missingKeyHandler` — assigning it would silently disable the app's own backend
  // reporting, because it is the `if` to the backend's `else if`.
  //
  // But the event only fires at all when `saveMissing` is true, and `saveMissing` has a
  // second, undocumented effect: `BackendConnector.saveMissing` ends with
  //
  //     if (!languages || !languages[0]) return;
  //     this.store.addResource(languages[0], namespace, key, fallbackValue);
  //
  // OUTSIDE its `if (this.backend?.create)` guard. So turning `saveMissing` on writes every
  // missed key into the app's in-memory resource store, backend or not. Observed live: a
  // 7-key fixture became 8 keys after one miss, and the key then resolved for good.
  //
  // The fix is the branch above it:
  //
  //     if (this.options.missingKeyHandler) { handler(...) }
  //     else if (this.backendConnector?.saveMissing) { ...addResource... }
  //     this.emit('missingKey', ...)          // fires either way
  //
  // Installing a `missingKeyHandler` skips the polluting branch while the event still
  // fires. We only do it when there is nothing to suppress — no app handler and no backend
  // that can write — and we chain to an app handler when one exists.
  const backendCanWrite =
    typeof (i18n.services as any)?.backendConnector?.backend?.create === 'function';
  const pristine = getPristine(i18n);
  const originalSaveMissing = pristine.saveMissing;
  const originalMissingKeyHandler = pristine.missingKeyHandler;

  const POST_PROCESSOR_NAME = 'rozenite-i18n-devtools';
  const originalPostProcess = pristine.postProcess;

  const skipOnVariables = i18n.options?.interpolation?.skipOnVariables !== false;

  const wantsMissingFeed =
    Boolean(originalSaveMissing) ||
    missingKeyCapture === 'force' ||
    (missingKeyCapture === 'auto' && !backendCanWrite);

  if (!originalSaveMissing) {
    if (missingKeyCapture === 'auto' && backendCanWrite) {
      warnings.push(
        'saveMissing is off and this app has a backend that can write, so enabling it would ' +
          'POST every missing key to your translation service. The missing-key feed is disabled. ' +
          'Set saveMissing: true yourself, or pass missingKeyCapture: "force" if you know the ' +
          'backend is read-only.',
      );
    } else if (missingKeyCapture === 'never') {
      warnings.push('missingKeyCapture is "never" — the missing-key feed will stay empty.');
    }
  }

  if (wantsMissingFeed && i18n.options?.saveMissingTo && i18n.options.saveMissingTo !== 'current') {
    warnings.push(
      `saveMissingTo is "${i18n.options.saveMissingTo}", so i18next reports misses against the ` +
        'fallback locale. Rows are labelled with the locale your app was actually showing.',
    );
  }

  const trackInterp = trackInterpolation && Boolean(i18n.options) && typeof (i18n as any).use === 'function' && skipOnVariables;

  if (trackInterpolation && !skipOnVariables) {
    warnings.push(
      'interpolation.skipOnVariables is false, so unresolved variables render as empty ' +
        'strings and cannot be detected by inspection. Interpolation tracking is off.',
    );
  }

  if (trackInterp && typeof pristine.missingInterpolationHandler === 'function') {
    warnings.push(
      'This app defines its own missingInterpolationHandler, which replaces unresolved ' +
        'variables before they can be observed. Interpolation misses will be under-reported.',
    );
  }

  let interpSink: ((o: InterpolationObservation) => void) | null = null;
  let postProcessorRegistered = false;

  /* ------------------------------------------------ refcounted instrumentation ------ */
  //
  // Install on the FIRST subscriber, uninstall on the LAST. Previously this ran at
  // construction and was torn down on every unsubscribe, so React's StrictMode
  // mount -> cleanup -> mount cycle permanently disabled capture: the listener came back
  // but `saveMissing` and the postProcessor did not. Observed live as a feed stuck at 0.
  let subscribers = 0;

  const install = () => {
    if (!i18n.options) return;

    if (wantsMissingFeed) {
      i18n.options.saveMissing = true;

      // Skip BackendConnector.saveMissing (and its store write) unless the app genuinely
      // needs it. Chain to an app-owned handler so its reporting still happens.
      if (!backendCanWrite) {
        i18n.options.missingKeyHandler = (...args: unknown[]) => {
          if (typeof originalMissingKeyHandler === 'function') {
            (originalMissingKeyHandler as (...a: unknown[]) => unknown)(...args);
          }
        };
      }
    }

    if (trackInterp) {
      if (!postProcessorRegistered) {
        (i18n as any).use({
          type: 'postProcessor',
          name: POST_PROCESSOR_NAME,
          // (value, key, options, translator) — we take the key too, so a miss is
          // identified by what it is rather than by the language it was seen in.
          process: (value: unknown, key?: unknown, opts?: Record<string, unknown>) => {
            try {
              if (typeof value === 'string' && value.includes('{{')) {
                const resolvedKey = Array.isArray(key) ? String(key[0] ?? '') : String(key ?? '');
                const nsOpt = opts?.ns;
                const resolvedNs = Array.isArray(nsOpt)
                  ? String(nsOpt[0] ?? '')
                  : typeof nsOpt === 'string'
                    ? nsOpt
                    : (getNamespaces()[0] ?? 'translation');
                INTERP_VAR.lastIndex = 0;
                let m: RegExpExecArray | null;
                while ((m = INTERP_VAR.exec(value))) {
                  interpSink?.({
                    key: resolvedKey,
                    ns: resolvedNs,
                    template: value,
                    variable: m[1].trim(),
                    lng: i18n.language ?? '',
                  });
                }
              }
            } catch {
              /* observation must never break rendering */
            }
            return value; // unchanged — this is the whole point
          },
        });
        postProcessorRegistered = true;
      }
      const existing = i18n.options.postProcess;
      const list = existing ? (Array.isArray(existing) ? [...existing] : [existing as string]) : [];
      if (!list.includes(POST_PROCESSOR_NAME)) list.push(POST_PROCESSOR_NAME);
      i18n.options.postProcess = list;
    }
  };

  const uninstall = () => {
    if (!i18n.options) return;
    i18n.options.saveMissing = originalSaveMissing;
    i18n.options.missingKeyHandler = originalMissingKeyHandler;
    const pp = i18n.options.postProcess;
    const hasOurs = Array.isArray(pp) ? pp.includes(POST_PROCESSOR_NAME) : pp === POST_PROCESSOR_NAME;
    if (hasOurs) i18n.options.postProcess = originalPostProcess;
  };

  /* ----------------------------------------------------------------- introspection */
  const getNamespaces = (): string[] => {
    const used = i18n.reportNamespaces?.getUsedNamespaces?.();
    if (used?.length) return used;
    const ns = asArray(i18n.options?.ns);
    if (ns.length) return ns;
    const firstLocale = Object.values(i18n.store?.data ?? {})[0];
    return firstLocale ? Object.keys(firstLocale) : ['translation'];
  };

  const getReferenceLng = (): string =>
    options.referenceLng ?? asArray(i18n.options?.fallbackLng)[0] ?? i18n.language ?? 'en';

  const getDir = (lng: string): TextDirection => {
    try {
      return i18n.dir?.(lng) === 'rtl' ? 'rtl' : 'ltr';
    } catch {
      return 'ltr';
    }
  };

  const capabilities = (): AdapterCapabilities => ({
    missingKeyFeed: wantsMissingFeed,
    interpolationTracking: trackInterp,
    localeSwitching: typeof i18n.changeLanguage === 'function',
    coverage: Boolean(i18n.store?.data),
  });

  const getInfo = (): AdapterInfo => ({
    id: adapterId,
    name: adapterName,
    library: 'i18next',
    libraryVersion,
    capabilities: capabilities(),
    warnings: [...warnings],
  });

  const getSnapshot = (): I18nSnapshot => {
    const namespaces = getNamespaces();
    const referenceLng = getReferenceLng();
    const activeLng = i18n.language ?? referenceLng;

    const { keys: referenceKeys } = keysForLocale(i18n, referenceLng, namespaces);
    const allLngs = Object.keys(i18n.store?.data ?? {});
    if (!allLngs.includes(referenceLng)) allLngs.push(referenceLng);

    const locales: LocaleCoverage[] = allLngs.sort().map((lng) => {
      const { keys: own, absentNamespaces } = keysForLocale(i18n, lng, namespaces);

      // Exclude keys belonging to a namespace that has not loaded for this locale. They are
      // unknown, not untranslated, and counting them reports a healthy app as broken.
      const countable = [...referenceKeys.keys()].filter((k) => {
        if (namespaces.length <= 1) return absentNamespaces.length === 0;
        const ns = k.slice(0, k.indexOf(':'));
        return !absentNamespaces.includes(ns);
      });

      // Keys that EXIST in the reference locale but are absent here. These resolve via
      // fallback and emit NO missingKey event — invisible to the feed. This is the number
      // that answers "why is this screen in English?".
      const fallingBack = countable.filter((k) => !own.has(k));

      return {
        lng,
        dir: getDir(lng),
        isActive: lng === activeLng,
        translated: own.size,
        total: countable.length,
        fallingBack: fallingBack.slice(0, DEFAULT_FALLBACK_SAMPLE),
        fallingBackCount: fallingBack.length,
        notLoaded: own.size === 0 && lng !== referenceLng,
        notLoadedNamespaces: lng === referenceLng ? [] : absentNamespaces,
      };
    });

    return {
      adapter: getInfo(),
      activeLng,
      languages: [...(i18n.languages ?? [activeLng])],
      fallbackLng: asArray(i18n.options?.fallbackLng),
      referenceLng,
      namespaces,
      locales,
      capturedAtMs: Date.now(),
    };
  };

  /**
   * Resolve a key WITHOUT calling `t()`.
   *
   * `t()` re-enters the closure that emits `missingKey` and calls `saveMissing`, so a
   * panel probing 100 keys would inject 100 fabricated rows into its own feed and POST
   * 100 junk keys to the user's backend. There is no per-call suppression — `saveMissing`
   * is read from `options` only. So we walk the store instead.
   */
  const getKey = (key: string, ns?: string): KeyDetail | null => {
    const namespaces = getNamespaces();
    const targetNs = ns ?? namespaces[0] ?? 'translation';
    const lngs = Object.keys(i18n.store?.data ?? {}).sort();

    const values = lngs.map((lng) => {
      const { keys: flat } = keysForLocale(i18n, lng, [targetNs]);
      return { lng, value: flat.has(key) ? (flat.get(key) as string) : null };
    });
    if (values.every((v) => v.value === null)) return null;

    let chain: string[] = [];
    try {
      chain = i18n.services?.languageUtils?.toResolveHierarchy?.(i18n.language) ?? [];
    } catch {
      chain = [];
    }
    if (!chain.length) chain = [i18n.language ?? '', ...asArray(i18n.options?.fallbackLng)].filter(Boolean);

    let resolvedFrom: string | null = null;
    let resolvedValue: string | null = null;
    for (const lng of chain) {
      const hit = values.find((v) => v.lng === lng && v.value !== null);
      if (hit) {
        resolvedFrom = hit.lng;
        resolvedValue = hit.value;
        break;
      }
    }

    const variables: string[] = [];
    if (resolvedValue) {
      INTERP_VAR.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = INTERP_VAR.exec(resolvedValue))) variables.push(m[1].trim());
    }

    return { key, ns: targetNs, values, resolvedFrom, resolvedValue, variables };
  };

  const setLocale = async (lng: string): Promise<void> => {
    if (typeof i18n.changeLanguage !== 'function') throw new Error('changeLanguage unavailable');
    // Load first so the panel does not briefly report the target locale as 0% translated.
    try {
      await i18n.loadLanguages?.(lng);
    } catch {
      /* best effort — changeLanguage will load too */
    }
    await i18n.changeLanguage(lng);
  };

  const subscribe: I18nextAdapter['subscribe'] = ({ onMissingKey, onInterpolationMiss, onChanged }) => {
    // Install on the first subscriber. Doing this at construction and tearing it down per
    // unsubscribe is what broke the feed under StrictMode.
    if (subscribers === 0) install();
    subscribers++;
    interpSink = onInterpolationMiss;

    const handleMissing = (lngs: readonly string[], ns: string, key: string, rendered: string) => {
      onMissingKey({
        key,
        ns,
        // `lngs[0]` is the SAVE TARGET, not what the user was looking at. With the default
        // saveMissingTo:'fallback', a German miss arrives as ['en']. Capture the real one.
        observedLng: i18n.language ?? '',
        saveTargets: [...lngs],
        rendered,
      });
    };

    const handleChanged = () => onChanged();

    i18n.on?.('missingKey', handleMissing);
    i18n.on?.('languageChanged', handleChanged);
    i18n.store?.on?.('added', handleChanged);
    i18n.store?.on?.('removed', handleChanged);

    let released = false;
    return () => {
      if (released) return;
      released = true;

      i18n.off?.('missingKey', handleMissing);
      i18n.off?.('languageChanged', handleChanged);
      i18n.store?.off?.('added', handleChanged);
      i18n.store?.off?.('removed', handleChanged);

      subscribers = Math.max(0, subscribers - 1);
      if (subscribers > 0) return; // another subscriber still needs the instrumentation
      interpSink = null;

      // Restore everything we touched. A devtool that leaves the host app mutated after
      // unmount is worse than one that never ran.
      // Last subscriber gone: put the host app back exactly as we found it.
      uninstall();
    };
  };

  return { id: adapterId, name: adapterName, getInfo, getSnapshot, getKey, setLocale, subscribe };
};
