import { describe, expect, it } from 'vitest';
import { createMissingStore } from '../missing-store';

const mk = () => {
  const flushes: unknown[] = [];
  const store = createMissingStore({
    onFlush: (f) => flushes.push(f),
    // run flushes synchronously so the tests don't depend on timers
    schedule: (fn) => {
      fn();
      return 0;
    },
    cancel: () => {},
    now: () => 1,
  });
  return { store, flushes };
};

describe('interpolation rows are stable across locale switches', () => {
  it('accumulates the locale set instead of replacing it', () => {
    const { store } = mk();
    const base = { key: 'greeting', ns: 'translation', variable: 'name' };

    store.addInterpolation({ ...base, template: 'Hallo {{name}}', lng: 'de' });
    store.addInterpolation({ ...base, template: 'Hello {{name}}', lng: 'en' });
    store.addInterpolation({ ...base, template: 'مرحبا {{name}}', lng: 'ar' });
    store.addInterpolation({ ...base, template: 'Hallo {{name}}', lng: 'de' });

    const { interpolation } = store.snapshot();
    expect(interpolation).toHaveLength(1); // one row, not one per locale
    expect([...interpolation[0].locales].sort()).toEqual(['ar', 'de', 'en']);
    expect(interpolation[0].count).toBe(4); // sightings, including the repeat
    expect(interpolation[0].id).toBe('translation:greeting:name');
  });

  it('keeps two different variables in the same key apart', () => {
    const { store } = mk();
    store.addInterpolation({ key: 'nested.deep', ns: 'translation', variable: 'a', template: 'x {{a}} {{b}}', lng: 'de' });
    store.addInterpolation({ key: 'nested.deep', ns: 'translation', variable: 'b', template: 'x {{a}} {{b}}', lng: 'de' });
    expect(store.snapshot().interpolation).toHaveLength(2);
  });

  it('keeps the same variable in different keys apart', () => {
    const { store } = mk();
    store.addInterpolation({ key: 'a.one', ns: 'translation', variable: 'count', template: '{{count}}', lng: 'de' });
    store.addInterpolation({ key: 'a.two', ns: 'translation', variable: 'count', template: '{{count}}', lng: 'de' });
    expect(store.snapshot().interpolation).toHaveLength(2);
  });
});


describe('missing rows are stable too — both feeds behave identically', () => {
  it('accumulates the observed locale set instead of replacing it', () => {
    const { store } = mk();
    const base = { key: 'checkout.absent', ns: 'translation', rendered: 'checkout.absent' };

    store.addMissing({ ...base, observedLng: 'de', saveTargets: ['en'] });
    store.addMissing({ ...base, observedLng: 'ar', saveTargets: ['en'] });
    store.addMissing({ ...base, observedLng: 'de', saveTargets: ['en'] });

    const { missing } = store.snapshot();
    expect(missing).toHaveLength(1);
    expect([...missing[0].observedLocales].sort()).toEqual(['ar', 'de']);
    expect(missing[0].observedLng).toBe('de'); // latest kept for context
    expect(missing[0].count).toBe(3); // tracked, but not rendered
  });

  it('still separates different keys and namespaces', () => {
    const { store } = mk();
    store.addMissing({ key: 'a', ns: 'translation', observedLng: 'de', saveTargets: [], rendered: 'a' });
    store.addMissing({ key: 'a', ns: 'other', observedLng: 'de', saveTargets: [], rendered: 'a' });
    store.addMissing({ key: 'b', ns: 'translation', observedLng: 'de', saveTargets: [], rendered: 'b' });
    expect(store.snapshot().missing).toHaveLength(3);
  });
});
