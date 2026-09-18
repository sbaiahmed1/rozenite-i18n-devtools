/**
 * Metro-side half of the Files tab.
 *
 * Neither the panel (a browser iframe) nor the device can read the project's files — only
 * the Metro process can. So this wraps the Metro config, mounts a same-origin HTTP route
 * via `server.enhanceMiddleware`, and the panel fetches the scan from it. This is the
 * @rozenite/expo-atlas-plugin pattern; @rozenite/plugin-bridge deliberately throws in Node,
 * so plain HTTP is the only channel — and the right one.
 *
 * `enhanceMiddleware` is deprecated in metro-config's types with no replacement reachable
 * from a config transformer. Accepted risk, shared with expo-atlas: whenever it breaks,
 * it breaks for both of us.
 */
import { isAbsolute, resolve } from 'node:path';
import { runScan, countProblems, type ScanReport } from './scan-core';

export const SCAN_ROUTE = '/_rozenite-i18n/scan.json';

export type WithI18nScanOptions = {
  /** Directory of locale JSONs: either <lng>.json files or <lng>/<ns>.json folders. */
  locales: string;
  /** Source root for the t()-key and hardcoded-text checks. Omit to skip source scanning. */
  src?: string;
  /** Reference locale to diff against. Default 'en'. */
  ref?: string;
  /** Re-scan at most this often; requests inside the window get the cached report. Default 2000ms. */
  cacheMs?: number;
};

type ScanPayload = ScanReport & { errors: number; warnings: number; scannedAtMs: number };

/**
 * Pure request handler, exported separately so it is testable without Metro.
 * Matches only the exact route; everything else falls through untouched.
 */
export const createScanRequestHandler = (
  options: WithI18nScanOptions,
  projectRoot: string,
  now: () => number = () => Date.now(),
) => {
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(projectRoot, p));
  const cacheMs = options.cacheMs ?? 2000;
  let cached: { at: number; payload: ScanPayload } | null = null;

  const scan = (): ScanPayload => {
    const report = runScan({
      localesDir: abs(options.locales),
      srcDir: options.src ? abs(options.src) : null,
      ref: options.ref ?? 'en',
    });
    return { ...report, ...countProblems(report, false), scannedAtMs: now() };
  };

  return (
    req: { url?: string },
    res: {
      statusCode: number;
      setHeader: (k: string, v: string) => void;
      end: (body?: string) => void;
    },
    next: (err?: unknown) => void,
  ) => {
    const path = (req.url ?? '').split('?')[0];
    if (path !== SCAN_ROUTE) return next();

    try {
      const fresh = (req.url ?? '').includes('fresh=1');
      if (!cached || fresh || now() - cached.at > cacheMs) {
        cached = { at: now(), payload: scan() };
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(cached.payload));
    } catch (e) {
      // A scan failure must never take the dev server down.
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
  };
};

type AnyMetroConfig = {
  projectRoot?: string;
  server?: {
    enhanceMiddleware?: (middleware: unknown, server: unknown) => unknown;
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

type ConfigInput<T> = T | Promise<T> | (() => T | Promise<T>);

/**
 * Wrap a Metro config so the dev server answers the panel's Files-tab requests.
 * Composes in either order with withRozenite: accepts a plain config, a promise, or the
 * async thunk withRozenite returns, and preserves any existing enhanceMiddleware.
 */
export const withRozeniteI18nScan = <T extends AnyMetroConfig>(
  config: ConfigInput<T>,
  options: WithI18nScanOptions,
): (() => Promise<T>) => {
  return async () => {
    const resolved = await (typeof config === 'function' ? (config as () => T | Promise<T>)() : config);
    const projectRoot = resolved.projectRoot ?? '.';
    const handler = createScanRequestHandler(options, projectRoot);
    const prevEnhance = resolved.server?.enhanceMiddleware;

    return {
      ...resolved,
      server: {
        ...resolved.server,
        enhanceMiddleware: (middleware: unknown, server: unknown) => {
          const delegated = prevEnhance ? prevEnhance(middleware, server) : middleware;
          return (req: unknown, res: unknown, next: (err?: unknown) => void) => {
            handler(req as never, res as never, (err?: unknown) => {
              if (err) return next(err);
              (delegated as (r: unknown, s: unknown, n: unknown) => void)(req, res, next);
            });
          };
        },
      },
    } as T;
  };
};
