# rozenite-i18n-devtools

Runtime i18n inspector for React Native DevTools, via [Rozenite](https://rozenite.dev).

**Status: 0.1.0 — device-verified end to end.** 40 tests, clean typecheck, and the full loop runs
in React Native DevTools against an Expo SDK 57 / RN 0.86.3 iOS simulator: coverage, the missing-key
feed, interpolation misses, locale switching and the key detail pane. Production stripping is
verified against a real `expo export` bundle — see *Verified* and *Not yet proven* below.

## What it does

Three things, and the first one is the reason it exists.

### 1. Coverage — the keys that fall back silently

A key missing in German but present in English **is not "missing" to i18next**. It resolves via
`fallbackLng`, renders English, and emits no event. Nothing reports it. It is also the single most
common i18n bug: *"why is this screen in English?"*

The Coverage tab counts exactly those keys, per locale, against a reference locale.

### 2. Missing keys — the ones that resolve nowhere

Live and deduplicated, with the set of locales each key was missed in. These are typos and
unextracted strings.

Rows appear **as screens render** — navigating to a screen checks every key it requests, with no
interaction. Only keys resolved behind a tap or a condition wait for that to happen.

**Be aware:** i18next's own `debug: true` already logs every one of these to the console
(`i18next.js:680`). This panel is not revelation, it is aggregation — dedup, counts, persistence
across reloads, search, and a queryable surface. If console output is enough for you, use that.

### 3. Interpolation misses — genuinely invisible today

`t('greet')` where the value is `"Hi {{name}}"` and no `name` was passed. i18next does **not** log
these even with `debug: true`: the warning sits behind `else if (skipOnVariables)`, and
`skipOnVariables` defaults to `true`, so it never fires.

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

## How it avoids breaking your app

A devtool that corrupts dev builds is worse than no devtool. Every hook here was chosen for
non-interference, and each choice is covered by a test.

| We do NOT | Because |
|---|---|
| assign `missingKeyHandler` | It is the `if` to `backendConnector.saveMissing`'s `else if`. Setting it **silently disables your app's own missing-key reporting.** We subscribe to the `missingKey` *event* instead, which is emitted unconditionally after both branches. |
| install `missingInterpolationHandler` | It displaces the `skipOnVariables` branch, whose `continue` skips the escape step. Even returning the identical `match[0]` renders `{{a<b}}` as `{{a&lt;b}}`. We use a postProcessor that returns the value **unchanged** and scans it instead. |
| enable `saveMissing` when a backend can write | That would POST every missing key to your translation service. With `missingKeyCapture: 'auto'` (default) we detect `backend.create` and refuse, with a warning in the panel. |
| call `t()` for panel reads | `t()` re-enters the code that emits `missingKey` and calls `saveMissing` — a panel probing keys would fabricate rows in its own feed and POST junk. We walk the resource store directly. |

Everything we touch is restored on unmount.

## Known limitations

- **If your app defines its own `missingInterpolationHandler`**, it replaces the token before we can
  see it, so interpolation misses are under-reported. The panel says so rather than staying quiet.
- **`saveMissingTo` defaults to `'fallback'`**, so i18next reports misses against the fallback
  locale. We capture and display the locale your app was *actually* showing.
- **Live translation editing is not implemented.** Rozenite
  [issue #407](https://github.com/callstackincubator/rozenite/issues/407) silently drops non-BMP
  characters host→device, and PR #408 was closed unmerged. The read path is unaffected; the locale
  switcher sends ASCII only.
- **i18next only.** `i18n-js` has no event emitter and no `saveMissing`, so the feed cannot be built
  on it. The adapter interface is library-neutral so another can be added.

## Compared to what you already have

- **`debug: true`** — logs missing keys, but no dedup, no counts, gone on reload, and silent about
  interpolation.
- **[i18n Ally](https://github.com/lokalise/i18n-ally)** (VS Code) — better than this at everything
  static: it reads your locale files from disk and lets you edit them. It cannot see runtime state:
  which locale is active, what actually got requested, what fell back.

Use both. They do not overlap.

## Development

```bash
pnpm install
pnpm --filter rozenite-i18n-devtools test       # 40 tests
pnpm --filter rozenite-i18n-devtools typecheck
pnpm --filter rozenite-i18n-devtools build      # stop Metro first — see below
node spikes/m0-i18next-probe.mjs                # re-run on every i18next major
```

> **Do not run `rozenite build` while Metro is running.** The build empties `dist/` first, Metro has
> the `exports` path cached, and the app dies with *"main has not been registered"* mid-build.

## Verified

- **Production stripping.** `expo export` of the example app was grepped for every string unique to
  the real adapter (`__rozeniteI18nDevtoolsPristine`, the warning texts, the postProcessor name).
  All absent; only the no-op stub ships. This is the one that matters — a leak would mean
  `saveMissing` writing to a production resource store.
- **The full panel loop** on an iOS simulator: coverage, both feeds, locale switching, detail pane.
- **No store pollution.** Covered by a test asserting the reference locale's key count is unchanged
  after a miss.
- **Namespaces**, including a namespace that has not loaded yet being excluded from coverage rather
  than counted as untranslated.

## Not yet proven

1. **Android — never run.** Everything so far is the iOS simulator. Nothing here is
   platform-specific, but that is an assumption, not a result.
2. **Issue #407.** The `echo` RPC exists to probe it and has never been fired. Relevant only to
   host→device text, which the MVP does not send.
3. **postProcessor cost.** It runs on every `t()` call — a substring check, and a regex only when
   `{{` is present. Never measured on a list screen.
4. **Real multi-namespace apps.** Namespace handling is unit-tested only; no app with lazy-loaded
   namespaces has been run against it.

Two bugs here were found by running on a device, not by the test suite, and both are worth knowing
if you read the adapter:

- **`saveMissing` silently writes to the resource store.** `BackendConnector.saveMissing` ends with
  an unguarded `store.addResource`, outside its `if (this.backend?.create)` check — so enabling the
  flag mutates your translations. The adapter installs a `missingKeyHandler` to take the other
  branch, which skips the write while the event still fires.
- **Instrumentation used to be installed at construction and torn down per-unsubscribe**, so React
  StrictMode's mount → cleanup → mount cycle permanently disabled capture: the listener came back,
  `saveMissing` and the postProcessor did not. It is now refcounted across subscribers.

Both are covered by regression tests that a fresh-instance unit test could not have caught.
