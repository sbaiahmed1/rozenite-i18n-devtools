import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The bin is a plain module when imported; main() only runs when executed directly.
import {
  discoverLocales,
  diffLocales,
  varsOf,
  extractUsedKeys,
  findHardcodedText,
  runScan,
  countProblems,
} from '../../../bin/i18n-scan.mjs';

const roots: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'i18n-scan-'));
  roots.push(d);
  return d;
};
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('locale discovery', () => {
  it('reads the flat layout: locales/<lng>.json', () => {
    const d = tmp();
    writeFileSync(join(d, 'en.json'), JSON.stringify({ a: 'A', nested: { b: 'B' } }));
    writeFileSync(join(d, 'de.json'), JSON.stringify({ a: 'A-de' }));
    const { locales, namespaces } = discoverLocales(d);
    expect(namespaces).toEqual(['translation']);
    expect([...locales.get('en')!.keys()].sort()).toEqual(['a', 'nested.b']);
    expect(locales.get('de')!.has('nested.b')).toBe(false);
  });

  it('reads the namespaced layout: locales/<lng>/<ns>.json with ns-prefixed keys', () => {
    const d = tmp();
    for (const lng of ['en', 'de']) mkdirSync(join(d, lng));
    writeFileSync(join(d, 'en', 'common.json'), JSON.stringify({ ok: 'OK' }));
    writeFileSync(join(d, 'en', 'checkout.json'), JSON.stringify({ total: 'Total' }));
    writeFileSync(join(d, 'de', 'common.json'), JSON.stringify({ ok: 'OK' }));
    const { locales, namespaces } = discoverLocales(d);
    expect(namespaces).toEqual(['checkout', 'common']);
    expect([...locales.get('en')!.keys()].sort()).toEqual(['checkout:total', 'common:ok']);
  });

  it('reports unparsable files instead of dying, and strips a BOM', () => {
    const d = tmp();
    writeFileSync(join(d, 'en.json'), '﻿{"a":"A"}');
    writeFileSync(join(d, 'broken.json'), '{nope');
    const { locales, errors } = discoverLocales(d);
    expect(locales.get('en')!.get('a')).toBe('A');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('broken.json');
  });
});

describe('diffing', () => {
  it('finds missing, extra, and variable mismatches', () => {
    const d = tmp();
    writeFileSync(
      join(d, 'en.json'),
      JSON.stringify({ greet: 'Hi {{name}}', bye: 'Bye', priced: '{{price, currency}}' }),
    );
    writeFileSync(
      join(d, 'de.json'),
      JSON.stringify({ greet: 'Hallo', stale: 'alt', priced: '{{price, currency}}' }),
    );
    const { locales } = discoverLocales(d);
    const diff = diffLocales(locales, 'en');
    expect(diff.missing.get('de')).toEqual(['bye']);
    expect(diff.extra.get('de')).toEqual(['stale']);
    expect(diff.varMismatch).toEqual([
      { key: 'greet', lng: 'de', refVars: ['name'], vars: [] },
    ]);
  });

  it('formatter suffixes do not count as different variables', () => {
    expect(varsOf('{{price, currency}} and {{price}}')).toEqual(['price']);
  });
});

describe('source extraction', () => {
  it('finds literal t() keys and i18nKey, and counts dynamic ones separately', () => {
    const src = `
      const a = t('checkout.total');
      const b = t("nav.home");
      const c = t(\`plain.template\`);
      const d = t(\`dyn.\${section}\`);
      const e = t(variable);
      const f = format(x); // not a t() call
      <Trans i18nKey="trans.key" />
    `;
    const { used, dynamic } = extractUsedKeys(src);
    expect(used.map((u) => u.key).sort()).toEqual([
      'checkout.total',
      'nav.home',
      'plain.template',
      'trans.key',
    ]);
    expect(dynamic).toBe(2);
  });

  it('flags hardcoded JSX text but not expressions or punctuation', () => {
    const src = `
      <Text>Save changes</Text>
      <Text>{t('ok')}</Text>
      <Text>×</Text>
      <Text>42</Text>
    `;
    const found = findHardcodedText(src);
    expect(found.map((f) => f.text)).toEqual(['Save changes']);
  });
});

describe('end to end', () => {
  it('scans locales plus source and counts problems', () => {
    const d = tmp();
    const loc = join(d, 'locales');
    const src = join(d, 'src');
    mkdirSync(loc);
    mkdirSync(src);
    writeFileSync(join(loc, 'en.json'), JSON.stringify({ known: 'Known', greet: 'Hi {{name}}' }));
    writeFileSync(join(loc, 'de.json'), JSON.stringify({ known: 'Bekannt', greet: 'Hallo' }));
    writeFileSync(
      join(src, 'App.tsx'),
      `export const A = () => <Text>Hardcoded label</Text>;
       const x = t('known'); const y = t('missing.everywhere');`,
    );

    const report = runScan({ localesDir: loc, srcDir: src, ref: 'en' });
    expect(report.missing).toEqual({}); // de has every en key
    expect(report.varMismatch).toHaveLength(1); // greet lost {{name}}
    // the bin ships as untyped .mjs, so give its source block a shape here
    const source = report.source as unknown as {
      missingInCode: Array<{ key: string }>;
      hardcoded: Array<{ text: string }>;
    };
    expect(source.missingInCode).toEqual([
      expect.objectContaining({ key: 'missing.everywhere' }),
    ]);
    expect(source.hardcoded.map((h) => h.text)).toEqual(['Hardcoded label']);

    const lax = countProblems(report, false);
    expect(lax.errors).toBe(2); // varMismatch + missingInCode
    expect(lax.warnings).toBe(1); // hardcoded
    const strict = countProblems(report, true);
    expect(strict.errors).toBe(3);
  });

  it('a missing reference locale is an error, not a crash', () => {
    const d = tmp();
    writeFileSync(join(d, 'de.json'), JSON.stringify({ a: 'A' }));
    const report = runScan({ localesDir: d, srcDir: null, ref: 'en' });
    expect(report.parseErrors.join(' ')).toContain('reference locale "en" not found');
  });
});
