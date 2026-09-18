# rozenite-i18n-devtools

Runtime + static i18n inspector for React Native DevTools, via [Rozenite](https://rozenite.dev).
i18next first; the adapter interface is library-neutral.

**Status: 0.2.0 — device-verified end to end** on an Expo SDK 57 / RN 0.86.3 iOS simulator.
67 tests, clean typecheck, production stripping verified against a real `expo export` bundle.
See *Verified* and *Not yet proven* at the bottom — this README does not claim more than has
been run.

## The panel

One screen answers the two questions you actually bring to a devtool:

- **Scorecard** (always visible) — error count, warning count, one tile per locale with its
  coverage. The tiles navigate: errors/warnings jump to Issues, a locale jumps to Languages.
- **Issues** — *what's broken.* One merged list of every finding, runtime and static,
  deduplicated by key, with filter chips (`Missing · Variables · Hardcoded · Stale`). Each row
  carries evidence badges: `runtime` (the running app hit it), `files` (the scan found it on
  disk), or both — both at once is the highest-confidence finding the panel can make.
- **Languages** — *how translated is each locale.* Per-locale blocks with a coverage bar, the
  keys that silently fall back to the reference, and a locale switcher.
- **Status footer** — adapter, active/reference locale, whether file checks are on, and any
  setup warnings. One line; no banners.

Clicking any row opens a detail pane: per-locale values, which locale the resolution chain
actually lands on, variables, and where the key is used in code.

## What it catches

| Finding | Severity | Detected by |
|---|---|---|
| Key used in code that resolves in **no** locale | error | runtime + files |
| Dynamic key (``t(`x.${y}`)``) that resolves nowhere | error | runtime only — the scan cannot see it |
| Key on a screen nobody opened, absent from the JSONs | error | files only — runtime never saw it |
| `{{variable}}` never supplied at render | error | runtime |
| `{{variable}}` renamed or dropped in a translation | error | files |
| Locale JSON that does not parse | error | files |
| Hardcoded JSX text that never goes through i18n (heuristic) | warning | files |
| Stale key present in a locale but not in the reference | warning | files |
| Keys that silently fall back to the reference locale | Languages tab | runtime + files |

The two detectors are complements, not alternatives: the scan covers screens nobody has
opened, the runtime covers dynamic keys the scan cannot verify.

Three findings deserve their own line, because nothing else reports them:

1. **Silent fallbacks are not "missing" to i18next.** A key absent in German but present in
   English resolves, renders English, and emits no event. It is the most common i18n bug
   (*"why is this screen in English?"*) and it is invisible to `debug: true`. The Languages
   tab counts exactly these — deliberately kept out of Issues, because they are translation
   debt, not code bugs, and would repeat once per locale.
2. **Interpolation misses are invisible even with `debug: true`.** The warning sits behind
   `else if (skipOnVariables)`, and `skipOnVariables` defaults to `true`, so it never fires.
3. **Missing keys ARE logged by `debug: true`** (`i18next.js:680`). On that finding this panel
   is aggregation, not revelation: dedup, locale sets, persistence, search. If console output
   is enough for you, use that.

Rows appear **as screens render** — navigating checks every key the screen requests, no
tapping required. Only keys behind a tap or a condition wait for that to happen.

## Install

```bash
npm install --save-dev rozenite-i18n-devtools
```

```tsx
// App.tsx
import i18n from './i18n';
import { createI18nextAdapter, useRozeniteI18nPlugin } from 'rozenite-i18n-devtools';

const adapter = createI18nextAdapter({ i18n });

export default function App() {
  useRozeniteI18nPlugin({ adapter }); // no-op in production
  return <RootNavigator />;
}
```

That enables the runtime side. For the file checks, add one wrapper in `metro.config.js`
(your locale files live on your machine, so only Metro can read them):

```js
const { withRozeniteI18nScan } = require('rozenite-i18n-devtools/metro');

module.exports = withRozeniteI18nScan(config, {
  locales: './src/locales',  // <lng>.json files, or <lng>/<ns>.json folders
  src: './src',              // omit to skip the source checks
  ref: 'en',
});
```

It composes with `withRozenite` in either order. Without it the footer says file checks are
off and the runtime findings work as before.

## How it avoids breaking your app

A devtool that corrupts dev builds is worse than no devtool. Every hook was chosen for
non-interference, and each choice is covered by a test.

| We do NOT | Because |
|---|---|
| assign `missingKeyHandler` | It is the `if` to `backendConnector.saveMissing`'s `else if`. Setting it **silently disables your app's own missing-key reporting.** We subscribe to the `missingKey` *event* instead, which is emitted unconditionally after both branches. |
| install `missingInterpolationHandler` | It displaces the `skipOnVariables` branch, whose `continue` skips the escape step. Even returning the identical `match[0]` renders `{{a<b}}` as `{{a&lt;b}}`. We use a postProcessor that returns the value **unchanged** and scans it instead. |
| enable `saveMissing` when a backend can write | That would POST every missing key to your translation service. We detect `backend.create` and refuse, with a warning in the footer. |
| call `t()` for panel reads | `t()` re-enters the code that emits `missingKey` and calls `saveMissing` — a panel probing keys would fabricate rows in its own feed and POST junk. We walk the resource store directly. |

Everything we touch is restored on unmount.

## Performance

Snapshot pushes are coalesced (400ms; `snapshotDebounceMs` on the hook). Feed flushes are
deduplicated and batched on the device (250ms; `flushMs`). If the panel still feels heavy on
a very large app, the next knob is `trackInterpolation: false` on the adapter, which removes
the per-`t()` postProcessor entirely.

## Known limitations

- **If your app defines its own `missingInterpolationHandler`**, it replaces the token before
  we can see it, so interpolation misses are under-reported. The panel says so rather than
  staying quiet.
- **`saveMissingTo` defaults to `'fallback'`**, so i18next reports misses against the fallback
  locale. We capture and display the locale your app was *actually* showing.
- **The hardcoded-text check is a heuristic** (JSX text nodes). Expect false positives; they
  are warnings, not errors, for exactly that reason.
- **Live translation editing is not implemented.** Rozenite
  [issue #407](https://github.com/callstackincubator/rozenite/issues/407) silently drops
  non-BMP characters host→device, and PR #408 was closed unmerged. The read path is
  unaffected; the locale switcher sends ASCII only.
- **i18next only, today.** `i18n-js` has no event emitter and no `saveMissing`, so the feed
  cannot be built on it. The adapter interface is library-neutral so another can be added.

## Compared to what you already have

- **`debug: true`** — logs missing keys, but no dedup, no locale sets, gone on reload, and
  silent about both fallbacks and interpolation.
- **[i18n Ally](https://github.com/lokalise/i18n-ally)** (VS Code) — better than this at
  everything static: it reads your locale files and lets you edit them. It cannot see runtime
  state: which locale is active, what actually got requested, what fell back.

Use both. They do not overlap.

## Development

```bash
pnpm install
pnpm --filter rozenite-i18n-devtools test       # 67 tests
pnpm --filter rozenite-i18n-devtools typecheck
pnpm --filter rozenite-i18n-devtools build      # stop Metro first — see below
node spikes/m0-i18next-probe.mjs                # re-run on every i18next major
```

> **Do not run `rozenite build` while Metro is running.** The build empties `dist/` first,
> Metro has the `exports` path cached, and the app dies with *"main has not been registered"*
> mid-build.

## Verified

- **Production stripping.** `expo export` of the example app was grepped for every string
  unique to the real adapter (`__rozeniteI18nDevtoolsPristine`, the warning texts, the
  postProcessor name). All absent; only the no-op stub ships. This is the one that matters —
  a leak would mean `saveMissing` writing to a production resource store.
- **The full panel loop** on an iOS simulator: scorecard, the merged Issues list with both
  evidence sources, Languages, locale switching, detail panes, clear/rescan, the footer.
- **No store pollution.** `BackendConnector.saveMissing` ends with an unguarded
  `store.addResource` outside its `if (this.backend?.create)` check — enabling the flag
  mutates your translations. The adapter takes the other branch; a test asserts the reference
  locale's key count is unchanged after a miss.
- **StrictMode / Fast Refresh.** Instrumentation is refcounted across subscribers and
  restores pristine state on the last unsubscribe; mount → cleanup → mount cycles do not
  disable capture. Found on a device, not by the suite — then locked in by regression tests.
- **Namespaces**, including a lazily-loaded namespace being excluded from coverage as
  "unknown" rather than counted as untranslated.

## Not yet proven

1. **Android — never run.** Everything above is the iOS simulator. Nothing here is
   platform-specific, but that is an assumption, not a result.
2. **postProcessor cost.** It runs on every `t()` call — a substring check, and a regex only
   when `{{` is present. Never measured on a heavy list screen.
3. **Real multi-namespace apps.** Namespace handling is unit-tested and demo-verified only;
   no production app with lazy-loaded namespaces has been run against it.

## License

MIT
