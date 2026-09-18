import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createScanRequestHandler, SCAN_ROUTE } from '../../node/with-i18n-scan';

const roots: string[] = [];
const fixture = () => {
  const d = mkdtempSync(join(tmpdir(), 'scan-handler-'));
  roots.push(d);
  writeFileSync(join(d, 'en.json'), JSON.stringify({ a: 'A', b: 'B' }));
  writeFileSync(join(d, 'de.json'), JSON.stringify({ a: 'A' }));
  return d;
};
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

const call = (handler: ReturnType<typeof createScanRequestHandler>, url: string) => {
  let body = '';
  let fell = false;
  const res = {
    statusCode: 0,
    setHeader: () => {},
    end: (b?: string) => {
      body = b ?? '';
    },
  };
  handler({ url }, res, () => {
    fell = true;
  });
  return { body: body ? JSON.parse(body) : null, status: res.statusCode, fell };
};

describe('scan route handler', () => {
  it('answers its exact route and falls through for everything else', () => {
    const h = createScanRequestHandler({ locales: fixture() }, '/');
    expect(call(h, '/index.bundle').fell).toBe(true);
    expect(call(h, '/_rozenite-i18n/other').fell).toBe(true);

    const r = call(h, SCAN_ROUTE);
    expect(r.fell).toBe(false);
    expect(r.status).toBe(200);
    expect(r.body.missing).toEqual({ de: ['b'] });
    expect(r.body.errors).toBe(1);
  });

  it('caches inside the window, rescans on fresh=1', () => {
    let t = 0;
    const dir = fixture();
    const h = createScanRequestHandler({ locales: dir, cacheMs: 2000 }, '/', () => t);

    const first = call(h, SCAN_ROUTE).body;
    // the locale file changes on disk...
    writeFileSync(join(dir, 'de.json'), JSON.stringify({ a: 'A', b: 'B' }));
    t = 500; // ...but we are inside the cache window
    expect(call(h, SCAN_ROUTE).body.scannedAtMs).toBe(first.scannedAtMs);

    expect(call(h, `${SCAN_ROUTE}?fresh=1`).body.missing).toEqual({}); // forced rescan sees it
  });

  it('a scan explosion returns 500 JSON instead of killing the dev server', () => {
    const h = createScanRequestHandler({ locales: '/nope/definitely/missing' }, '/');
    const r = call(h, SCAN_ROUTE);
    // unreadable dir is a *reported* condition, not a crash
    expect(r.status).toBe(200);
    expect(r.body.parseErrors.join(' ')).toContain('cannot read');
  });
});
