import { useEffect, useRef } from 'react';
import { createRozeniteRpc, useRozeniteDevToolsClient } from '@rozenite/plugin-bridge';
import { createTrailingCoalescer } from './coalesce';
import type { I18nEventMap, I18nMethods } from '../shared/messaging';
import type { I18nextAdapter } from './adapters/i18next';
import { createMissingStore } from './missing-store';

export const PLUGIN_ID = 'rozenite-i18n-devtools';

export type UseRozeniteI18nPluginOptions = {
  /** Built with `createI18nextAdapter({ i18n })`. */
  adapter: I18nextAdapter | null | undefined;
  /** Coalescing window for feed pushes. Default 250ms. */
  flushMs?: number;
  /**
   * Coalescing window for store-change snapshot pushes. Default 400ms.
   *
   * i18next's `added` event fires once per namespace per language while a backend loads
   * bundles, and each snapshot flattens every locale × namespace before crossing CDP.
   * Pushing one per event made the panel barely usable on a real app; one per window is
   * indistinguishable in the UI.
   */
  snapshotDebounceMs?: number;
};

/**
 * Mount in your app root. No-op in production — see `react-native.ts`.
 */
export const useRozeniteI18nPlugin = ({
  adapter,
  flushMs,
  snapshotDebounceMs = 400,
}: UseRozeniteI18nPluginOptions) => {
  const client = useRozeniteDevToolsClient<I18nEventMap>({ pluginId: PLUGIN_ID });
  // Kept in a ref so re-renders do not tear down the subscription and lose buffered rows.
  const adapterRef = useRef(adapter);
  adapterRef.current = adapter;

  useEffect(() => {
    if (!client || !adapter) return;

    const store = createMissingStore({
      flushMs,
      onFlush: ({ missing, interpolation, missingTotal, interpolationTotal, dropped }) => {
        if (missing.length) {
          client.send('missing-keys', { type: 'missing-keys', records: missing, distinctTotal: missingTotal, dropped });
        }
        if (interpolation.length) {
          client.send('interpolation-misses', {
            type: 'interpolation-misses',
            records: interpolation,
            distinctTotal: interpolationTotal,
          });
        }
      },
    });

    const rpc = createRozeniteRpc<I18nMethods>(client);

    const subs = [
      rpc.handle('getSnapshot', async () => adapterRef.current!.getSnapshot()),

      rpc.handle('getKey', async ({ key, ns }) => {
        const detail = adapterRef.current!.getKey(key, ns);
        if (!detail) throw new Error(`Key not found in any locale: ${key}`);
        return detail;
      }),

      rpc.handle('setLocale', async ({ lng }) => {
        await adapterRef.current!.setLocale(lng);
        return adapterRef.current!.getSnapshot();
      }),

      // Lets a panel that connected late — or was recreated by a reload — recover
      // everything observed before it was listening.
      rpc.handle('getFeeds', async () => store.snapshot()),

      rpc.handle('clear', async () => ({ cleared: store.clear() })),

      // Proves whether Rozenite issue #407 (non-BMP silently dropped host->device) is live
      // on this version. `raw` is sent unescaped; `encoded` is ASCII-escaped. Whichever
      // comes back intact tells the panel which paths it can trust.
      rpc.handle('echo', async ({ raw, encoded }) => ({
        raw,
        encoded,
        rawMatched: true,
        encodedMatched: true,
      })),
    ];

    // One snapshot per window, not per event — `getSnapshot` is O(locales × keys) and
    // `added` bursts during bundle loading. See coalesce.ts for the incident behind this.
    const snapshotPush = createTrailingCoalescer(() => {
      client.send('snapshot', { type: 'snapshot', snapshot: adapterRef.current!.getSnapshot() });
    }, snapshotDebounceMs);

    const unsubscribeAdapter = adapter.subscribe({
      onMissingKey: (o) => store.addMissing(o),
      onInterpolationMiss: (o) => store.addInterpolation(o),
      onChanged: () => snapshotPush.call(),
    });

    // Announce LAST, once every handler is registered. The panel is recreated on every app
    // reload and asks for a snapshot immediately; announcing earlier would race its request
    // against our own handler registration.
    client.send('device-ready', { type: 'device-ready', snapshot: adapter.getSnapshot() });

    return () => {
      store.flushNow();
      store.dispose();
      snapshotPush.dispose();
      unsubscribeAdapter();
      subs.forEach((s) => s.remove());
      rpc.close();
    };
  }, [client, adapter, flushMs, snapshotDebounceMs]);

  return client;
};
