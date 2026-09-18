import { describe, expect, it } from 'vitest';
import { countIssues, localeGapKeys, mergeIssues } from '../../ui/merge';
import type { ScanReport } from '../../node/scan-core';
import type { InterpolationMissRecord, MissingKeyRecord } from '../../shared/types';

const missingRecord = (over: Partial<MissingKeyRecord> = {}): MissingKeyRecord => ({
  id: 'translation:checkout.vat',
  key: 'checkout.vat',
  ns: 'translation',
  observedLng: 'de',
  observedLocales: ['de', 'en'],
  saveTargets: ['en'],
  rendered: 'checkout.vat',
  count: 3,
  firstSeenMs: 1,
  lastSeenMs: 2,
  ...over,
});

const interpRecord = (over: Partial<InterpolationMissRecord> = {}): InterpolationMissRecord => ({
  id: 'translation:greeting:name',
  key: 'greeting',
  ns: 'translation',
  template: 'Hi {{name}}',
  variable: 'name',
  lng: 'en',
  locales: ['en', 'de'],
  count: 5,
  firstSeenMs: 1,
  lastSeenMs: 2,
  ...over,
});

const report = (over: Partial<ScanReport> = {}): ScanReport => ({
  localesDir: 'locales',
  ref: 'en',
  namespaces: ['translation'],
  locales: ['en', 'de'],
  parseErrors: [],
  missing: {},
  extra: {},
  varMismatch: [],
  source: null,
  ...over,
});

describe('mergeIssues', () => {
  it('a key missed at runtime AND found by the scan is ONE row with both sources', () => {
    const issues = mergeIssues(
      [missingRecord()],
      [],
      report({
        source: {
          srcDir: '.',
          missingInCode: [{ file: 'App.tsx', line: 31, key: 'checkout.vat' }],
          dynamicKeys: 0,
          hardcoded: [],
        },
      }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].sources).toEqual({ runtime: true, files: true });
    expect(issues[0].fileRefs).toEqual(['App.tsx:31']);
    expect(issues[0].locales).toEqual(['de', 'en']);
  });

  it('matches a runtime record against an ns-prefixed code literal', () => {
    const issues = mergeIssues(
      [missingRecord({ id: 'shop:cart.title', key: 'cart.title', ns: 'shop' })],
      [],
      report({
        source: {
          srcDir: '.',
          missingInCode: [{ file: 'Cart.tsx', line: 4, key: 'shop:cart.title' }],
          dynamicKeys: 0,
          hardcoded: [],
        },
      }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].sources).toEqual({ runtime: true, files: true });
  });

  it('a scan-only missing key (screen never opened) becomes its own row', () => {
    const issues = mergeIssues(
      [],
      [],
      report({
        source: {
          srcDir: '.',
          missingInCode: [
            { file: 'Settings.tsx', line: 18, key: 'settings.privacy' },
            { file: 'Menu.tsx', line: 9, key: 'settings.privacy' },
          ],
          dynamicKeys: 0,
          hardcoded: [],
        },
      }),
    );
    // Two sightings of the same key collapse into one row with both file refs.
    expect(issues).toHaveLength(1);
    expect(issues[0].sources).toEqual({ runtime: false, files: true });
    expect(issues[0].fileRefs).toEqual(['Settings.tsx:18', 'Menu.tsx:9']);
  });

  it('a var mismatch corroborates the runtime interpolation miss for the same key+variable', () => {
    const issues = mergeIssues(
      [],
      [interpRecord()],
      report({
        varMismatch: [{ key: 'greeting', lng: 'ar', refVars: ['name'], vars: [] }],
      }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe('variables');
    expect(issues[0].sources).toEqual({ runtime: true, files: true });
    // The mismatch's locale joins the runtime set.
    expect(issues[0].locales).toContain('ar');
  });

  it('a var mismatch with no runtime sighting is a scan-only variables row', () => {
    const issues = mergeIssues(
      [],
      [],
      report({
        varMismatch: [{ key: 'welcome.title', lng: 'de', refVars: ['user'], vars: ['usr'] }],
      }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].sources).toEqual({ runtime: false, files: true });
    expect(issues[0].note).toContain('{{user}}');
    expect(issues[0].note).toContain('{{usr}}');
  });

  it('stale keys aggregate per key with the locale set, not per (locale, key)', () => {
    const issues = mergeIssues(
      [],
      [],
      report({ extra: { de: ['profile.legacyBio'], ar: ['profile.legacyBio'] } }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe('stale');
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].locales.sort()).toEqual(['ar', 'de']);
  });

  it('sorts errors before warnings, parse errors first', () => {
    const issues = mergeIssues(
      [missingRecord()],
      [],
      report({
        parseErrors: ['de.json: bad JSON'],
        extra: { de: ['old.key'] },
        source: {
          srcDir: '.',
          missingInCode: [],
          dynamicKeys: 0,
          hardcoded: [{ file: 'App.tsx', line: 83, text: 'Continue to payment' }],
        },
      }),
    );
    expect(issues.map((i) => i.kind)).toEqual(['parse', 'missing', 'hardcoded', 'stale']);
  });

  it('without a scan report, runtime findings still merge cleanly', () => {
    const issues = mergeIssues([missingRecord()], [interpRecord()], null);
    expect(issues.map((i) => i.kind)).toEqual(['missing', 'variables']);
    expect(issues.every((i) => i.sources.runtime && !i.sources.files)).toBe(true);
  });
});

describe('countIssues', () => {
  it('splits severities and counts kinds', () => {
    const issues = mergeIssues(
      [missingRecord()],
      [],
      report({ extra: { de: ['old.key'] } }),
    );
    const c = countIssues(issues);
    expect(c.errors).toBe(1);
    expect(c.warnings).toBe(1);
    expect(c.byKind.all).toBe(2);
    expect(c.byKind.missing).toBe(1);
    expect(c.byKind.stale).toBe(1);
  });
});

describe('localeGapKeys', () => {
  it('unions the runtime sample with the scan diff', () => {
    // Runtime only saw what rendered; the scan also covers unopened screens.
    expect(localeGapKeys(['checkout.tax'], ['checkout.tax', 'profile.bio'])).toEqual([
      'checkout.tax',
      'profile.bio',
    ]);
  });

  it('works with no scan data', () => {
    expect(localeGapKeys(['b', 'a'], undefined)).toEqual(['a', 'b']);
  });
});
