import { describe, expect, it } from 'vitest';
import i18next from 'i18next';
import { createI18nextAdapter } from '../adapters/i18next';

const resources = {
  en: {
    translation: {
      greet: 'Hi {{name}}',
      plain: 'Plain text',
      nested: { deep: 'Deep {{a}} and {{b}}' },
      only_en: 'English only',
      empty: '',
    },
  },
  de: {
    translation: {
      greet: 'Hallo {{name}}',
      plain: 'Einfacher Text',
      nested: { deep: 'Tief {{a}} und {{b}}' },
    },
  },
};

const mkI18n = async (extra: Record<string, unknown> = {}) => {
  const i = i18next.createInstance();
  await i.init({
    lng: 'de',
    fallbackLng: 'en',
    resources: structuredClone(resources),
    initAsync: false,
    ...extra,
  });
  return i;
};

/** A backend whose create() would POST to a translation service. */
const writableBackend = (counter: { n: number }) => ({
  type: 'backend' as const,
  init() {},
  read(_l: string, _n: string, cb: (e: unknown, d: unknown) => void) {
    cb(null, {});
  },
  create() {
    counter.n++;
  },
});

describe('behaviour equivalence — the adapter must not change what the app renders', () => {
  const CASES: Array<[string, string, Record<string, unknown> | undefined]> = [
    ['resolved in active locale', 'plain', undefined],
    ['interpolated, variable supplied', 'greet', { name: 'Ada' }],
    ['interpolated, variable MISSING', 'greet', undefined],
    ['nested key, both vars missing', 'nested.deep', undefined],
    ['nested key, one var supplied', 'nested.deep', { a: '1' }],
    ['falls back to reference locale', 'only_en', undefined],
    ['absent everywhere', 'totally.absent', undefined],
    ['empty string value', 'empty', undefined],
  ];

  it.each(CASES)('%s', async (_label, key, opts) => {
    const baseline = await mkI18n();
    const instrumented = await mkI18n();
    createI18nextAdapter({ i18n: instrumented as never });

    const a = opts ? baseline.t(key, opts) : baseline.t(key);
    const b = opts ? instrumented.t(key, opts) : instrumented.t(key);

    expect(b).toBe(a);
  });

  it('leaves an app-owned missingInterpolationHandler alone, and says so', async () => {
    const calls: string[] = [];
    const i = await mkI18n({
      missingInterpolationHandler: (_s: string, m: RegExpExecArray) => {
        calls.push(m[1].trim());
        return 'APPHANDLER'; // no HTML chars: i18next escapes interpolated values by default
      },
    });

    const before = i.t('greet');
    expect(before).toBe('Hallo APPHANDLER');

    const seen: string[] = [];
    const adapter = createI18nextAdapter({ i18n: i as never });
    adapter.subscribe({
      onMissingKey: () => {},
      onInterpolationMiss: (o) => seen.push(o.variable),
      onChanged: () => {},
    });

    const after = i.t('greet');

    // The app's handler is untouched and still wins.
    expect(after).toBe('Hallo APPHANDLER');
    expect(calls.length).toBeGreaterThan(1);

    // And we genuinely cannot see the miss: the app replaced the token before our
    // postProcessor ran. That is the cost of never mutating the render path. The adapter
    // must SAY so rather than silently under-report.
    expect(seen).toHaveLength(0);
    expect(adapter.getInfo().warnings.join(' ')).toMatch(/under-reported/i);
  });

  it('observes interpolation misses when the app has no handler of its own', async () => {
    const i = await mkI18n();
    const seen: string[] = [];
    const adapter = createI18nextAdapter({ i18n: i as never });
    adapter.subscribe({
      onMissingKey: () => {},
      onInterpolationMiss: (o) => seen.push(o.variable),
      onChanged: () => {},
    });

    expect(i.t('greet')).toBe('Hallo {{name}}'); // unchanged
    expect(seen).toContain('name');

    expect(i.t('nested.deep')).toBe('Tief {{a}} und {{b}}');
    expect(seen).toEqual(expect.arrayContaining(['a', 'b']));
  });

  /**
   * The escaping divergence.
   *
   * Baseline's `skipOnVariables` branch does `value = match[0]; continue;` — the `continue`
   * skips the rest of the loop body, INCLUDING the escape step. Our handler returns the same
   * string but flows on through escaping. For an ordinary `{{name}}` that is a no-op, but a
   * variable name containing an HTML-escapable character would diverge.
   *
   * If this ever fails, the fix is for the adapter to escape-proof its return, not to accept
   * the divergence.
   */
  it('does not introduce HTML escaping on an unresolved token with a special char', async () => {
    const withSpecial = {
      en: { translation: { odd: 'X {{a<b}} Y' } },
      de: { translation: { odd: 'X {{a<b}} Y' } },
    };
    const mk = async (instrument: boolean) => {
      const i = i18next.createInstance();
      await i.init({
        lng: 'de',
        fallbackLng: 'en',
        resources: structuredClone(withSpecial),
        initAsync: false,
      });
      if (instrument) createI18nextAdapter({ i18n: i as never });
      return i;
    };

    const baseline = await mk(false);
    const instrumented = await mk(true);

    expect(instrumented.t('odd')).toBe(baseline.t('odd'));
  });
});

describe('no re-entrancy — panel reads must not fabricate misses or POST to a backend', () => {
  it('getKey() over many keys emits zero missingKey events and zero backend writes', async () => {
    const backendCalls = { n: 0 };
    const i = i18next.createInstance();
    i.use(writableBackend(backendCalls));
    await i.init({
      lng: 'de',
      fallbackLng: 'en',
      resources: structuredClone(resources),
      saveMissing: true, // app already opted in
      initAsync: false,
    });

    const emits: unknown[] = [];
    i.on('missingKey', (...a) => emits.push(a));

    const adapter = createI18nextAdapter({ i18n: i as never });
    for (const k of ['plain', 'greet', 'only_en', 'nope.one', 'nope.two', 'nope.three']) {
      adapter.getKey(k);
    }
    adapter.getSnapshot();

    expect(emits).toHaveLength(0);
    expect(backendCalls.n).toBe(0);
  });
});

describe('missingKey semantics — lngs[0] is the save target, not the observed locale', () => {
  it('labels the row with the locale the app was actually showing', async () => {
    const i = await mkI18n({ saveMissing: true });
    const adapter = createI18nextAdapter({ i18n: i as never });

    const seen: Array<{ observedLng: string; saveTargets: string[]; key: string }> = [];
    adapter.subscribe({
      onMissingKey: (o) => seen.push({ observedLng: o.observedLng, saveTargets: o.saveTargets, key: o.key }),
      onInterpolationMiss: () => {},
      onChanged: () => {},
    });

    i.t('totally.absent');

    expect(seen).toHaveLength(1);
    expect(seen[0].observedLng).toBe('de'); // what the user was looking at
    expect(seen[0].saveTargets).toEqual(['en']); // what i18next reports
  });

  it('a key that falls back is NOT reported as missing', async () => {
    const i = await mkI18n({ saveMissing: true });
    const adapter = createI18nextAdapter({ i18n: i as never });
    const seen: unknown[] = [];
    adapter.subscribe({ onMissingKey: (o) => seen.push(o), onInterpolationMiss: () => {}, onChanged: () => {} });

    expect(i.t('only_en')).toBe('English only');
    expect(seen).toHaveLength(0); // resolved via fallback — correctly silent
  });
});

describe('saveMissing safety — never start network writes on someone else@s behalf', () => {
  it('refuses to enable saveMissing when a writable backend is present (auto)', async () => {
    const backendCalls = { n: 0 };
    const i = i18next.createInstance();
    i.use(writableBackend(backendCalls));
    await i.init({ lng: 'de', fallbackLng: 'en', resources: structuredClone(resources), initAsync: false });

    expect(i.options.saveMissing).toBeFalsy();
    const adapter = createI18nextAdapter({ i18n: i as never });

    expect(i.options.saveMissing).toBeFalsy(); // untouched
    expect(adapter.getInfo().capabilities.missingKeyFeed).toBe(false);
    expect(adapter.getInfo().warnings.join(' ')).toMatch(/translation service/i);

    i.t('totally.absent');
    expect(backendCalls.n).toBe(0);
  });

  it('enables saveMissing on the first subscriber, not at construction', async () => {
    const i = await mkI18n();
    expect(i.options.saveMissing).toBeFalsy();

    const adapter = createI18nextAdapter({ i18n: i as never });
    // Construction must not mutate the host app — instrumentation is subscriber-scoped.
    expect(i.options.saveMissing).toBeFalsy();
    expect(adapter.getInfo().capabilities.missingKeyFeed).toBe(true);

    const unsub = adapter.subscribe({
      onMissingKey: () => {},
      onInterpolationMiss: () => {},
      onChanged: () => {},
    });
    expect(i.options.saveMissing).toBe(true);
    unsub();
    expect(i.options.saveMissing).toBeFalsy();
  });

  it('never touches saveMissing when missingKeyCapture is "never"', async () => {
    const i = await mkI18n();
    createI18nextAdapter({ i18n: i as never, missingKeyCapture: 'never' });
    expect(i.options.saveMissing).toBeFalsy();
  });

  it('never assigns missingKeyHandler, so the app backend keeps reporting', async () => {
    const backendCalls = { n: 0 };
    const i = i18next.createInstance();
    i.use(writableBackend(backendCalls));
    await i.init({
      lng: 'de',
      fallbackLng: 'en',
      resources: structuredClone(resources),
      saveMissing: true,
      initAsync: false,
    });

    createI18nextAdapter({ i18n: i as never });
    expect(i.options.missingKeyHandler).toBeFalsy();

    i.t('totally.absent');
    expect(backendCalls.n).toBe(1); // app's own reporting survived
  });
});

describe('teardown restores the host app', () => {
  it('restores saveMissing and postProcess', async () => {
    const i = await mkI18n();
    const originalPostProcess = i.options.postProcess;
    const originalSave = i.options.saveMissing;

    const adapter = createI18nextAdapter({ i18n: i as never });
    const unsubscribe = adapter.subscribe({
      onMissingKey: () => {},
      onInterpolationMiss: () => {},
      onChanged: () => {},
    });

    expect(i.options.saveMissing).toBe(true);
    expect(i.options.postProcess).toContain('rozenite-i18n-devtools');

    unsubscribe();

    expect(i.options.saveMissing).toBe(originalSave);
    expect(i.options.postProcess).toBe(originalPostProcess);
    expect(i.t('greet')).toBe('Hallo {{name}}');
  });
});

describe('coverage — catches the silent fallbacks the feed cannot see', () => {
  it('counts keys that exist in the reference locale but not the active one', async () => {
    const i = await mkI18n({ saveMissing: true });
    const adapter = createI18nextAdapter({ i18n: i as never });
    const snap = adapter.getSnapshot();

    const de = snap.locales.find((l) => l.lng === 'de')!;
    const en = snap.locales.find((l) => l.lng === 'en')!;

    expect(snap.activeLng).toBe('de');
    expect(snap.referenceLng).toBe('en');
    expect(en.fallingBackCount).toBe(0);
    // `only_en` and `empty` exist in en but not de -> they silently fall back.
    expect(de.fallingBackCount).toBe(2);
    expect(de.fallingBack).toEqual(expect.arrayContaining(['only_en', 'empty']));
    expect(de.translated).toBeLessThan(de.total);
    expect(de.isActive).toBe(true);
    expect(de.notLoaded).toBe(false);
  });

  it('getKey reports which locale the active chain resolves from', async () => {
    const i = await mkI18n();
    const adapter = createI18nextAdapter({ i18n: i as never });

    const local = adapter.getKey('plain')!;
    expect(local.resolvedFrom).toBe('de');

    const fellBack = adapter.getKey('only_en')!;
    expect(fellBack.resolvedFrom).toBe('en'); // the "why is this English?" answer
    expect(fellBack.values.find((v) => v.lng === 'de')?.value).toBeNull();

    const interpolated = adapter.getKey('nested.deep')!;
    expect(interpolated.variables).toEqual(['a', 'b']);

    expect(adapter.getKey('totally.absent')).toBeNull();
  });
});

describe('idempotent construction — the Fast Refresh bug', () => {
  /**
   * Found on a real device, not here: Fast Refresh re-ran the module that builds the
   * adapter, so `createI18nextAdapter` ran twice against the same i18next instance. The
   * second call read the state the FIRST call had already mutated and recorded it as
   * "original", so teardown restored the mutation instead of removing it — the host app
   * was permanently left with saveMissing on and our postProcessor installed.
   *
   * Every other test in this file builds a fresh instance, which is exactly why none of
   * them could catch this.
   */
  it('restores pristine state even when the adapter is built twice on one instance', async () => {
    const i = await mkI18n();
    const pristineSave = i.options.saveMissing;
    const pristinePostProcess = i.options.postProcess;

    const first = createI18nextAdapter({ i18n: i as never });
    const unsubFirst = first.subscribe({
      onMissingKey: () => {},
      onInterpolationMiss: () => {},
      onChanged: () => {},
    });

    // Simulate Fast Refresh: the module re-runs and rebuilds the adapter.
    const second = createI18nextAdapter({ i18n: i as never });
    const unsubSecond = second.subscribe({
      onMissingKey: () => {},
      onInterpolationMiss: () => {},
      onChanged: () => {},
    });

    expect(i.options.saveMissing).toBe(true);

    unsubFirst();
    unsubSecond();

    expect(i.options.saveMissing).toBe(pristineSave);
    expect(i.options.postProcess).toBe(pristinePostProcess);
    expect(i.t('greet')).toBe('Hallo {{name}}');
  });

  it('a second adapter does not double-register the postProcessor', async () => {
    const i = await mkI18n();
    const subs = [
      createI18nextAdapter({ i18n: i as never }),
      createI18nextAdapter({ i18n: i as never }),
      createI18nextAdapter({ i18n: i as never }),
    ].map((a) =>
      a.subscribe({ onMissingKey: () => {}, onInterpolationMiss: () => {}, onChanged: () => {} }),
    );

    const pp = i.options.postProcess as string[];
    expect(pp.filter((n) => n === 'rozenite-i18n-devtools')).toHaveLength(1);
    subs.forEach((u) => u());
  });
});


describe('the two bugs device testing found', () => {
  /**
   * BUG 1 — saveMissing silently writes every missed key into the app's resource store.
   *
   * `BackendConnector.saveMissing` ends with an unguarded
   *   `this.store.addResource(languages[0], namespace, key, fallbackValue)`
   * OUTSIDE its `if (this.backend?.create)` check. Observed live: a 7-key fixture became
   * 8 keys after one miss, and the key resolved forever after.
   *
   * Installing a `missingKeyHandler` takes the other branch of that if/else-if, so the
   * write never happens and the event still fires.
   */
  it('does NOT write the missed key into the resource store', async () => {
    const i = await mkI18n();
    const adapter = createI18nextAdapter({ i18n: i as never });
    const seen: string[] = [];
    const unsub = adapter.subscribe({
      onMissingKey: (o) => seen.push(o.key),
      onInterpolationMiss: () => {},
      onChanged: () => {},
    });

    const before = Object.keys((i.store.data as any).en.translation).length;
    i.t('totally.absent');
    const after = Object.keys((i.store.data as any).en.translation).length;

    expect(seen).toEqual(['totally.absent']); // still captured
    expect(after).toBe(before); // and the store is untouched
    expect(i.t('totally.absent')).toBe('totally.absent'); // still missing on re-read

    unsub();
  });

  it('still chains to an app-owned missingKeyHandler', async () => {
    const appCalls: string[] = [];
    const i = await mkI18n({ missingKeyHandler: (_l: unknown, _ns: string, k: string) => appCalls.push(k) });
    const adapter = createI18nextAdapter({ i18n: i as never });
    const seen: string[] = [];
    const unsub = adapter.subscribe({
      onMissingKey: (o) => seen.push(o.key),
      onInterpolationMiss: () => {},
      onChanged: () => {},
    });

    i.t('totally.absent');

    expect(seen).toEqual(['totally.absent']);
    expect(appCalls).toEqual(['totally.absent']); // the app's handler still ran
    unsub();
    expect(i.options.missingKeyHandler).toBeTypeOf('function'); // theirs restored
  });

  /**
   * BUG 2 — instrumentation was installed at construction but torn down per-unsubscribe,
   * so React StrictMode's mount -> cleanup -> mount cycle permanently disabled capture:
   * the listener came back, saveMissing and the postProcessor did not. Observed live as a
   * missing-key feed stuck at 0 while the event was demonstrably firing.
   */
  it('survives a subscribe / unsubscribe / subscribe cycle', async () => {
    const i = await mkI18n();
    const adapter = createI18nextAdapter({ i18n: i as never });

    const first = adapter.subscribe({
      onMissingKey: () => {},
      onInterpolationMiss: () => {},
      onChanged: () => {},
    });
    first(); // StrictMode cleanup

    const seen: string[] = [];
    const interp: string[] = [];
    const second = adapter.subscribe({
      onMissingKey: (o) => seen.push(o.key),
      onInterpolationMiss: (o) => interp.push(o.variable),
      onChanged: () => {},
    });

    i.t('totally.absent');
    i.t('greet');

    expect(seen).toEqual(['totally.absent']); // feed alive again
    expect(interp).toContain('name'); // interpolation alive again
    second();
  });

  it('keeps instrumentation alive while any subscriber remains', async () => {
    const i = await mkI18n();
    const adapter = createI18nextAdapter({ i18n: i as never });
    const a = adapter.subscribe({ onMissingKey: () => {}, onInterpolationMiss: () => {}, onChanged: () => {} });
    const seen: string[] = [];
    const b = adapter.subscribe({
      onMissingKey: (o) => seen.push(o.key),
      onInterpolationMiss: () => {},
      onChanged: () => {},
    });

    a(); // one leaves
    expect(i.options.saveMissing).toBe(true); // still installed for b
    i.t('totally.absent');
    expect(seen).toEqual(['totally.absent']);

    b(); // last one leaves
    expect(i.options.saveMissing).toBeFalsy();
  });
});


describe('feed identity is consistent across both tabs', () => {
  /**
   * The first implementation keyed interpolation misses on `lng:template:variable`. Because
   * the template text differs per language, switching de -> en -> ar produced THREE rows for
   * one unsupplied `{{name}}`, while the Missing tab deduped by `ns:key` regardless of
   * locale. Same panel, two different rules. Spotted in the running app.
   */
  it('dedupes one unsupplied variable to one row across locales', async () => {
    const i = await mkI18n();
    const adapter = createI18nextAdapter({ i18n: i as never });
    const seen: Array<{ key: string; ns: string; variable: string; lng: string }> = [];
    const unsub = adapter.subscribe({
      onMissingKey: () => {},
      onInterpolationMiss: (o) => seen.push(o),
      onChanged: () => {},
    });

    i.t('greet'); // de
    await i.changeLanguage('en');
    i.t('greet'); // en — different template text, same broken thing
    await i.changeLanguage('de');
    i.t('greet');

    expect(seen.length).toBeGreaterThanOrEqual(3); // three observations...
    const ids = new Set(seen.map((o) => `${o.ns}:${o.key}:${o.variable}`));
    expect(ids.size).toBe(1); // ...collapsing to ONE identity
    expect([...ids][0]).toBe('translation:greet:name');

    unsub();
  });

  it('carries the key and namespace, not just the template', async () => {
    const i = await mkI18n();
    const adapter = createI18nextAdapter({ i18n: i as never });
    const seen: Array<{ key: string; ns: string; variable: string }> = [];
    const unsub = adapter.subscribe({
      onMissingKey: () => {},
      onInterpolationMiss: (o) => seen.push(o),
      onChanged: () => {},
    });

    i.t('nested.deep'); // "Tief {{a}} und {{b}}" — two unsupplied variables

    expect(seen.map((o) => o.variable).sort()).toEqual(['a', 'b']);
    expect(seen.every((o) => o.key === 'nested.deep')).toBe(true);
    expect(seen.every((o) => o.ns === 'translation')).toBe(true);
    unsub();
  });
});
