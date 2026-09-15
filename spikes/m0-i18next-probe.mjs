// M0 spike — i18next behaviour probe for rozenite-i18n-devtools
// Run:  npm i i18next@26.4.2 && node spikes/m0-i18next-probe.mjs
// Result 2026-09-15 against i18next@26.4.2: 10/10 predictions correct.
// See M0-FINDINGS.md. Re-run this on every i18next major before shipping.

import i18next from 'i18next';

const line = (s) => console.log('\n' + '='.repeat(72) + '\n' + s + '\n' + '='.repeat(72));
const res = {};

// FIXTURE FIX #1: `absent.key` exists in NO locale, so fallback cannot rescue it.
// `only_en` is kept to demonstrate the trap that broke probe v1.
const resources = {
  en: { translation: { greet: 'Hi {{name}}', only_en: 'English only' } },
  de: { translation: { greet: 'Hallo {{name}}' } },
};

// FIX #3: a real logger module — i18next binds console at construction,
// so patching console.log afterwards captures nothing.
const makeLogger = (sink) => ({
  type: 'logger',
  log: (args) => sink.push(['log', ...args].map(String).join(' ')),
  warn: (args) => sink.push(['warn', ...args].map(String).join(' ')),
  error: (args) => sink.push(['error', ...args].map(String).join(' ')),
});

line('TEST 0 — confirm the probe-v1 trap: fallback rescues a key present in `en`');
{
  const emits = [];
  const i = i18next.createInstance();
  await i.init({ lng: 'de', fallbackLng: 'en', resources: structuredClone(resources), saveMissing: true, initImmediate: false });
  i.on('missingKey', (lngs, ns, key) => emits.push({ lngs: [...lngs], key }));
  const r = i.t('only_en');
  console.log('t("only_en") in de     :', JSON.stringify(r), '<- resolved via fallback');
  console.log('missingKey emits       :', emits.length, '<- correctly 0: it was never missing');
  res.fallback_masks_miss = emits.length === 0;
}

line('TEST 1+3 — GENUINE miss: does missingKey fire, and what is lngs[0]?');
{
  const emits = [];
  const i = i18next.createInstance();
  await i.init({ lng: 'de', fallbackLng: 'en', resources: structuredClone(resources), saveMissing: true, initImmediate: false });
  i.on('missingKey', (lngs, ns, key, r) => emits.push({ lngs: [...lngs], ns, key, res: r }));

  const rendered = i.t('absent.key');

  console.log('saveMissingTo (default):', i.options.saveMissingTo);
  console.log('observed locale        :', i.language);
  console.log('t("absent.key")        :', JSON.stringify(rendered));
  console.log('missingKey emits       :', JSON.stringify(emits, null, 2));

  res.fires_with_saveMissing = emits.length > 0;
  res.lngs0 = emits[0]?.lngs[0];
  res.lngs0_is_save_target = emits[0]?.lngs[0] === 'en';
  res.lngs0_is_observed = emits[0]?.lngs[0] === 'de';
}

line('TEST 2 — genuine miss WITHOUT saveMissing');
{
  const emits = [];
  const i = i18next.createInstance();
  await i.init({ lng: 'de', fallbackLng: 'en', resources: structuredClone(resources), initImmediate: false });
  i.on('missingKey', (...a) => emits.push(a));
  i.t('absent.key');
  console.log('saveMissing            :', i.options.saveMissing);
  console.log('missingKey emit count  :', emits.length);
  res.fires_without_saveMissing = emits.length > 0;
}

line('TEST 4 — does debug:true log a genuine missing key? (via real logger module)');
{
  const sink = [];
  const i = i18next.createInstance();
  i.use(makeLogger(sink));
  await i.init({ lng: 'de', fallbackLng: 'en', resources: structuredClone(resources), debug: true, initImmediate: false });
  const before = sink.length;
  i.t('absent.key');
  const during = sink.slice(before);

  console.log('lines logged during t():', during.length);
  console.log(JSON.stringify(during, null, 2));
  res.debug_logs_missing_key = during.some((l) => /missingKey/i.test(l));
}

line('TEST 5 — does missingKeyHandler suppress backend.create? (if / else-if)');
{
  const run = async (withHandler) => {
    let backendCreate = 0, handler = 0;
    const i = i18next.createInstance();
    i.use({
      type: 'backend',
      init() {},
      read(lng, ns, cb) { cb(null, {}); },
      create() { backendCreate++; },
    });
    await i.init({
      lng: 'de', fallbackLng: 'en', resources: structuredClone(resources),
      saveMissing: true, initImmediate: false,
      ...(withHandler ? { missingKeyHandler: () => { handler++; } } : {}),
    });
    i.t('absent.key');
    return { backendCreate, handler };
  };

  const without = await run(false);
  const withH = await run(true);
  console.log('no handler  -> backend.create:', without.backendCreate, '| handler:', without.handler);
  console.log('w/ handler  -> backend.create:', withH.backendCreate, '| handler:', withH.handler);
  res.backend_fires_alone = without.backendCreate > 0;
  res.handler_suppresses_backend = withH.handler > 0 && withH.backendCreate === 0;
}

line('TEST 6 — missingInterpolationHandler: TOP-LEVEL vs nested, and output impact');
{
  const mk = async (opts) => {
    const i = i18next.createInstance();
    await i.init({ lng: 'en', resources: structuredClone(resources), initImmediate: false, ...opts });
    return i;
  };

  const baseline = await mk({});
  // FIX #2: top level, not under `interpolation`.
  const topNaive = await mk({ missingInterpolationHandler: () => undefined });
  const topSafe = await mk({ missingInterpolationHandler: (str, match) => match[0] });
  const nested = await mk({ interpolation: { missingInterpolationHandler: () => undefined } });

  let seen = null;
  const observer = await mk({
    missingInterpolationHandler: (str, match) => { seen = match[1].trim(); return match[0]; },
  });

  const a = baseline.t('greet');
  const b = topNaive.t('greet');
  const c = topSafe.t('greet');
  const d = nested.t('greet');
  const e = observer.t('greet');

  console.log('skipOnVariables default  :', baseline.options.interpolation.skipOnVariables);
  console.log('baseline                 :', JSON.stringify(a));
  console.log('top-level naive (undef)  :', JSON.stringify(b));
  console.log('top-level safe (match[0]):', JSON.stringify(c));
  console.log('NESTED under interpolation:', JSON.stringify(d), '<- if === baseline, nesting is ignored');
  console.log('observer variant         :', JSON.stringify(e), '| captured var:', JSON.stringify(seen));

  res.naive_handler_changes_output = a !== b;
  res.safe_handler_preserves_output = a === c;
  res.nesting_is_ignored = a === d;
  res.observer_can_see_var = seen === 'name' && a === e;
}

line('TEST 7 — does debug:true log an unresolved interpolation? (I claim NO)');
{
  const sink = [];
  const i = i18next.createInstance();
  i.use(makeLogger(sink));
  await i.init({ lng: 'en', resources: structuredClone(resources), debug: true, initImmediate: false });
  const before = sink.length;
  i.t('greet');
  const during = sink.slice(before);
  console.log('lines during t():', during.length, JSON.stringify(during));
  res.debug_logs_interpolation = during.some((l) => /missed to pass in variable/i.test(l));
}

line('VERDICT');
console.log(JSON.stringify(res, null, 2));

const checks = [
  ['KILL COND: missingKey fires on a genuine miss', res.fires_with_saveMissing, true],
  ['missingKey does NOT fire without saveMissing', res.fires_without_saveMissing, false],
  ['lngs[0] is the SAVE TARGET (en), not observed (de)', res.lngs0_is_save_target, true],
  ['debug:true already logs missing keys', res.debug_logs_missing_key, true],
  ['backend.create fires when no handler set', res.backend_fires_alone, true],
  ['missingKeyHandler SUPPRESSES backend.create', res.handler_suppresses_backend, true],
  ['naive interpolation handler CHANGES output', res.naive_handler_changes_output, true],
  ['observer-safe handler PRESERVES output', res.safe_handler_preserves_output, true],
  ['observer can still read the variable name', res.observer_can_see_var, true],
  ['debug:true does NOT log interpolation misses', res.debug_logs_interpolation, false],
];

console.log('');
for (const [label, actual, expected] of checks) {
  console.log(`${actual === expected ? '  PASS' : '  FAIL'}  ${label}  (got ${actual}, predicted ${expected})`);
}
const bad = checks.filter(([, a, e]) => a !== e);
console.log(`\n${checks.length - bad.length}/${checks.length} predictions correct`);
console.log(res.fires_with_saveMissing
  ? '\n>>> KILL CONDITION CLEARED — the flagship feature works.'
  : '\n*** PROJECT KILL CONDITION TRIGGERED ***');
