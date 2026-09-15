import { describe, expect, it } from 'vitest';
import i18next from 'i18next';
import { createI18nextAdapter } from '../adapters/i18next';

/** Two namespaces, with gaps in each, in different locales. */
const resources = {
  en: {
    common: { ok: 'OK', cancel: 'Cancel', retry: 'Retry' },
    checkout: { total: 'Total', tax: 'Tax', shipping: 'Shipping' },
  },
  de: {
    common: { ok: 'OK', cancel: 'Abbrechen' }, // missing common:retry
    checkout: { total: 'Gesamt' }, // missing checkout:tax and checkout:shipping
  },
};

const mk = async (extra: Record<string, unknown> = {}) => {
  const i = i18next.createInstance();
  await i.init({
    lng: 'de',
    fallbackLng: 'en',
    ns: ['common', 'checkout'],
    defaultNS: 'common',
    resources: structuredClone(resources),
    initAsync: false,
    ...extra,
  });
  return i;
};

describe('namespaces', () => {
  it('counts coverage across every namespace, not just the default', async () => {
    const i = await mk();
    const adapter = createI18nextAdapter({ i18n: i as never });
    const snap = adapter.getSnapshot();

    expect(snap.namespaces.sort()).toEqual(['checkout', 'common']);

    const de = snap.locales.find((l) => l.lng === 'de')!;
    // en has 6 keys across both namespaces; de has 3.
    expect(de.total).toBe(6);
    expect(de.translated).toBe(3);
    expect(de.fallingBackCount).toBe(3);
    expect([...de.fallingBack].sort()).toEqual([
      'checkout:shipping',
      'checkout:tax',
      'common:retry',
    ]);
  });

  it('reports the right namespace on a missing key', async () => {
    const i = await mk();
    const adapter = createI18nextAdapter({ i18n: i as never });
    const seen: Array<{ key: string; ns: string }> = [];
    const unsub = adapter.subscribe({
      onMissingKey: (o) => seen.push({ key: o.key, ns: o.ns }),
      onInterpolationMiss: () => {},
      onChanged: () => {},
    });

    i.t('checkout:nope');
    i.t('nope', { ns: 'common' });

    expect(seen).toEqual([
      { key: 'nope', ns: 'checkout' },
      { key: 'nope', ns: 'common' },
    ]);
    unsub();
  });

  it('keeps the same key in two namespaces apart', async () => {
    const i = await mk();
    const adapter = createI18nextAdapter({ i18n: i as never });

    const inCommon = adapter.getKey('ok', 'common');
    const inCheckout = adapter.getKey('total', 'checkout');

    expect(inCommon?.ns).toBe('common');
    expect(inCommon?.values.find((v) => v.lng === 'de')?.value).toBe('OK');
    expect(inCheckout?.ns).toBe('checkout');
    expect(inCheckout?.resolvedFrom).toBe('de');

    // a key that only exists in `en` for that namespace
    const tax = adapter.getKey('tax', 'checkout');
    expect(tax?.resolvedFrom).toBe('en');
    expect(tax?.values.find((v) => v.lng === 'de')?.value).toBeNull();
  });

  it('does not confuse a key present in one namespace with the other', async () => {
    const i = await mk();
    const adapter = createI18nextAdapter({ i18n: i as never });
    // `total` exists in checkout, not in common
    expect(adapter.getKey('total', 'common')).toBeNull();
    expect(adapter.getKey('total', 'checkout')).not.toBeNull();
  });

  /**
   * With lazy namespace loading a namespace that has not downloaded yet is
   * indistinguishable from one with no translations. Counting it as untranslated reported
   * a healthy app as broken — `de` showed 33% when `checkout` simply had not arrived.
   */
  it('excludes an unloaded namespace from the ratio instead of blaming it', async () => {
    const i = await mk();
    delete (i.store.data as any).de.checkout; // `checkout` never loaded for de

    const adapter = createI18nextAdapter({ i18n: i as never });
    const de = adapter.getSnapshot().locales.find((l) => l.lng === 'de')!;

    expect(de.notLoadedNamespaces).toEqual(['checkout']);
    // Only `common` is countable: 3 reference keys, 2 present in de.
    expect(de.total).toBe(3);
    expect(de.translated).toBe(2);
    expect(de.fallingBackCount).toBe(1);
    expect(de.fallingBack).toEqual(['common:retry']);
    // Crucially NOT the 4 it used to report.
  });

  it('reports no unloaded namespaces when everything is present', async () => {
    const i = await mk();
    const adapter = createI18nextAdapter({ i18n: i as never });
    const de = adapter.getSnapshot().locales.find((l) => l.lng === 'de')!;
    expect(de.notLoadedNamespaces).toEqual([]);
    expect(de.total).toBe(6);
  });
});
