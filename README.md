# rozenite-i18n-devtools

[![npm](https://img.shields.io/npm/v/rozenite-i18n-devtools)](https://www.npmjs.com/package/rozenite-i18n-devtools)
[![license](https://img.shields.io/npm/l/rozenite-i18n-devtools)](packages/rozenite-i18n-devtools/LICENSE)

An i18n inspector for React Native DevTools, built on [Rozenite](https://rozenite.dev).
A scorecard plus two tabs: **Issues** — every i18n problem, runtime and static, merged into
one deduplicated list — and **Languages** — per-locale coverage, including the keys that
silently fall back and that nothing else reports.

![rozenite-i18n-devtools: scorecard over a merged issues list](https://raw.githubusercontent.com/sbaiahmed1/rozenite-i18n-devtools/main/docs/screenshots/issues.png)

**→ [Package README](packages/rozenite-i18n-devtools/README.md)** — features, install,
how it avoids interfering with your app, limitations.

## Quick start

```bash
npm install --save-dev rozenite-i18n-devtools
```

```tsx
import { createI18nextAdapter, useRozeniteI18nPlugin } from 'rozenite-i18n-devtools';

const adapter = createI18nextAdapter({ i18n });

export default function App() {
  useRozeniteI18nPlugin({ adapter }); // no-op in production
  return <RootNavigator />;
}
```

Optional file checks (locale JSON diffs, keys missing from code, hardcoded text) via one
Metro wrapper — see the [package README](packages/rozenite-i18n-devtools/README.md#install).

## Repository layout

| Path | What it is |
|---|---|
| [`packages/rozenite-i18n-devtools`](packages/rozenite-i18n-devtools) | The plugin — the only published package |
| [`examples/demo`](examples/demo) | Expo app with deliberately planted i18n problems, used to verify the panel end to end |
| [`spikes`](spikes) | `m0-i18next-probe.mjs` — the i18next behavior probe the adapter's design rests on; re-run on every i18next major |
| [`RELEASING.md`](RELEASING.md) | Release order and the traps that bite when it is ignored |

## Developing

```bash
pnpm install
pnpm --filter rozenite-i18n-devtools test        # 67 tests
pnpm --filter rozenite-i18n-devtools typecheck
pnpm --filter rozenite-i18n-devtools build       # stop Metro first — see below
```

Run the demo against your build:

```bash
cd examples/demo
npx expo start
```

then open React Native DevTools and pick the **i18n** panel.

> **Do not run `rozenite build` while Metro is running.** The build empties `dist/` first,
> Metro has the `exports` path cached, and the app dies with *"main has not been registered"*
> mid-build.

## License

MIT
