# Changelog

## 0.1.0

First release. Runtime i18n inspector for React Native DevTools via Rozenite.

### Features
- **Coverage** — per-locale completeness against a reference locale, computed on connect with no
  interaction. Finds keys that silently fall back, which emit no i18next event at all.
- **Missing keys** — live feed of keys that resolve in no locale, deduplicated by `ns:key`, with the
  set of locales each was missed in. Populates as screens render.
- **Interpolation misses** — `{{name}}` never supplied. i18next does not log these even with
  `debug: true`, because the warning sits behind `skipOnVariables`, which defaults to `true`.
- **Key detail** — every locale's value for one key, and which locale the active chain resolves from.
- **Live locale switching** from the panel.
- Namespace-aware throughout, including excluding not-yet-loaded namespaces from coverage.

### Safety
This plugin instruments a live third-party library inside dev builds. It:
- subscribes to the `missingKey` **event** rather than assigning `missingKeyHandler`, which would
  silently disable your app's own backend reporting;
- installs a `missingKeyHandler` **only** when nothing would be suppressed, to skip i18next's
  unguarded `store.addResource` and avoid writing missed keys into your resource store;
- observes interpolation with a postProcessor that returns the value **unchanged**, rather than
  `missingInterpolationHandler`, which changes rendered output;
- never calls `t()` for panel reads, which would fabricate entries in its own feed;
- installs on the first subscriber and restores everything on the last;
- compiles out of production bundles — verified against a real `expo export`.
