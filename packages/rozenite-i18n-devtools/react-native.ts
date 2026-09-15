/**
 * App-side entry point.
 *
 * Structured so Metro drops the real implementation from production bundles: the `require()`
 * calls sit inside branches that constant-fold away when `NODE_ENV === 'production'`.
 * Copied from @rozenite/storage-plugin@2.4.0, including the Lynx trap below.
 *
 * NOTE: issues #415/#492 are actively dismantling this shim across the official plugins —
 * the maintainer describes it as resting on "transform-order luck". Keep this file minimal
 * so there is little to migrate when it changes.
 */
export type {
  CreateI18nextAdapterOptions,
  I18nextAdapter,
} from './src/react-native/adapters';
export type { UseRozeniteI18nPluginOptions } from './src/react-native/useRozeniteI18nPlugin';
export type {
  AdapterCapabilities,
  AdapterInfo,
  I18nSnapshot,
  InterpolationMissRecord,
  KeyDetail,
  LocaleCoverage,
  MissingKeyRecord,
} from './src/shared/types';

export let createI18nextAdapter: typeof import('./src/react-native/adapters').createI18nextAdapter;
export let useRozeniteI18nPlugin: typeof import('./src/react-native/useRozeniteI18nPlugin').useRozeniteI18nPlugin;

// Neither Lynx runtime has a `window`, so `typeof window` alone reports every Lynx app as a
// server and installs the no-op below. `lynx` is a free binding in module scope, not a
// property of `globalThis`. Kept inline so this stays a foldable expression and the
// `require`s can still be dropped from production bundles.
declare const lynx: unknown;

// Both are real globals here — React Native defines `process.env.NODE_ENV` and Metro
// provides `require`. Declared inline rather than pulling @types/node into a React Native
// package, which would bring the whole Node global surface with it.
declare const process: { env: { NODE_ENV?: string } };
declare const require: (id: string) => any;

const isDev = process.env.NODE_ENV !== 'production';
const isServer = typeof window === 'undefined' && typeof lynx === 'undefined';

if (!isDev || isServer) {
  createI18nextAdapter = ((options: { adapterId?: string; adapterName?: string }) => ({
    id: options?.adapterId ?? 'i18next',
    name: options?.adapterName ?? 'i18next',
    getInfo: () => ({
      id: options?.adapterId ?? 'i18next',
      name: options?.adapterName ?? 'i18next',
      library: 'i18next',
      libraryVersion: null,
      capabilities: {
        missingKeyFeed: false,
        interpolationTracking: false,
        localeSwitching: false,
        coverage: false,
      },
      warnings: [],
    }),
    getSnapshot: () => {
      throw new Error('rozenite-i18n-devtools is disabled in production builds');
    },
    getKey: () => null,
    setLocale: async () => undefined,
    subscribe: () => () => undefined,
  })) as unknown as typeof createI18nextAdapter;
  useRozeniteI18nPlugin = (() => null) as unknown as typeof useRozeniteI18nPlugin;
} else {
  createI18nextAdapter = require('./src/react-native/adapters').createI18nextAdapter;
  useRozeniteI18nPlugin =
    require('./src/react-native/useRozeniteI18nPlugin').useRozeniteI18nPlugin;
}
