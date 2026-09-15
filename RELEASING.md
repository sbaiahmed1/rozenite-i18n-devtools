# Releasing `rozenite-i18n-devtools`

## Repository

`repository`, `homepage` and `bugs` point at
<https://github.com/sbaiahmed1/rozenite-i18n-devtools>. If the repo is ever renamed or moved,
update all three in `package.json` — npm renders them in the package sidebar and a stale link
reads as abandonware.

## Every release

Run in this order. **Order matters** — see the traps below.

```bash
nvm use 24                                   # a v13 default is on PATH; expo export dies on it

# 1. bump the version FIRST
cd packages/rozenite-i18n-devtools
npm version minor --no-git-tag-version        # or patch / major

# 2. THEN build — the version is baked into dist/rozenite.json at build time
#    (stop Metro first: the build empties dist/ and Metro caches the exports path)
pnpm --filter rozenite-i18n-devtools build

# 3. verify
pnpm --filter rozenite-i18n-devtools test         # 40 tests
pnpm --filter rozenite-i18n-devtools typecheck
node spikes/m0-i18next-probe.mjs                  # 10/10 against the installed i18next

# 4. confirm the manifest and package agree
python3 -c "import json;a=json.load(open('dist/rozenite.json'))['version'];b=json.load(open('package.json'))['version'];print(a,b,'MATCH' if a==b else 'MISMATCH')"

# 5. confirm production stripping still holds
cd ../../examples/demo
NODE_ENV=production ./node_modules/.bin/expo export --platform ios --output-dir dist-export
strings dist-export/_expo/static/js/ios/*.hbc | grep -c "__rozeniteI18nDevtoolsPristine"   # must be 0
strings dist-export/_expo/static/js/ios/*.hbc | grep -c "disabled in production builds"    # must be 1
rm -rf dist-export

# 6. inspect the tarball before it leaves
cd ../../packages/rozenite-i18n-devtools
npm pack --dry-run | grep -c __tests__        # must be 0

# 7. publish
npm publish --access public
```

## Traps, each of which has already happened once

| Trap | What it looks like |
|---|---|
| **Building while Metro runs** | Build empties `dist/`, Metro has the `exports` path cached; the app dies with *"main has not been registered"* mid-build. Stop Metro first. |
| **Bumping the version after building** | `dist/rozenite.json` keeps the old version and you ship a manifest that disagrees with `package.json`. Bump, then build. |
| **Wrong Node** | The default here is v13.12.0. `expo export` crashes in `internal/modules/cjs/loader.js` and any script using `??` dies. `nvm use 24`. |
| **Tests in the tarball** | `files` includes `src` for the `./sdk` development condition; `!src/**/__tests__` keeps tests out. Re-check after touching `files`. |

## After a new i18next major

Run `node spikes/m0-i18next-probe.mjs`. All ten behaviours it asserts are load-bearing and several
are undocumented internals — including the unguarded `store.addResource` at the end of
`BackendConnector.saveMissing` that this plugin exists to route around.
