import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createRozeniteRpc, useRozeniteDevToolsClient } from '@rozenite/plugin-bridge';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  PluginShell,
  QueryField,
  ToggleGroup,
  VirtualizedList,
} from '@rozenite/ui';
import '@rozenite/ui/styles.css';
import type { I18nEventMap, I18nMethods } from '../shared/messaging';
import type {
  I18nSnapshot,
  InterpolationMissRecord,
  KeyDetail,
  LocaleCoverage,
  MissingKeyRecord,
} from '../shared/types';
// Types only — scan-core is Node code; the values live behind the Metro HTTP route.
import type { ScanReport } from '../node/scan-core';
import { countIssues, localeGapKeys, mergeIssues } from './merge';
import type { Issue, IssueKind } from './merge';

const PLUGIN_ID = 'rozenite-i18n-devtools';
const SCAN_ROUTE = '/_rozenite-i18n/scan.json'; // keep in sync with src/node/with-i18n-scan.ts

/**
 * Two tabs, matching the two questions a user brings to the panel: "what's broken?"
 * (Issues — the merged runtime + static list) and "how translated is each language?"
 * (Languages). The scorecard above them is always visible and doubles as navigation.
 */
type Tab = 'issues' | 'languages';
type Filter = IssueKind | 'all';

type ScanPayload = ScanReport & { errors: number; warnings: number; scannedAtMs: number };
type ScanState =
  | { kind: 'loading' }
  | { kind: 'unavailable' } // route absent: the metro wrapper is not installed
  | { kind: 'ready'; report: ScanPayload };

type Selection = { key: string; ns?: string; issue?: Issue };

const pct = (n: number, d: number) => (d === 0 ? 100 : Math.round((n / d) * 100));

const METRO_SNIPPET =
  "const { withRozeniteI18nScan } = require('rozenite-i18n-devtools/metro');  " +
  "module.exports = withRozeniteI18nScan(config, { locales: './src/locales', src: './src' });";

export default function I18nPanel() {
  const client = useRozeniteDevToolsClient<I18nEventMap>({ pluginId: PLUGIN_ID });

  const [snapshot, setSnapshot] = useState<I18nSnapshot | null>(null);
  const [missing, setMissing] = useState<MissingKeyRecord[]>([]);
  const [interpolation, setInterpolation] = useState<InterpolationMissRecord[]>([]);
  const [tab, setTab] = useState<Tab>('issues');
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [scan, setScan] = useState<ScanState>({ kind: 'loading' });
  const [detail, setDetail] = useState<KeyDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [showWarnings, setShowWarnings] = useState(false);

  const rpc = useMemo(() => (client ? createRozeniteRpc<I18nMethods>(client) : null), [client]);

  /** Merge by id so a repeated miss updates its row rather than appending a duplicate. */
  const mergeById = <T extends { id: string }>(prev: T[], incoming: T[]): T[] => {
    if (!incoming.length) return prev;
    const byId = new Map(prev.map((r) => [r.id, r]));
    for (const r of incoming) byId.set(r.id, r);
    return [...byId.values()];
  };

  useEffect(() => {
    if (!client || !rpc) return;

    // The panel is recreated on every app reload, so it may ask before the RN tree has
    // mounted the plugin. Ask once, and also listen for `device-ready` in case we lost.
    // Pull whatever the device buffered before this panel existed. Without this, misses
    // that happened before you opened the panel were pushed to nobody and lost.
    const seed = () => {
      rpc
        .method('getFeeds')
        .invoke()
        .then(({ missing: m, interpolation: i }) => {
          // Replace rather than merge: a fresh device-ready means a new app session, and
          // the device's own buffer is the authority.
          setMissing(m);
          setInterpolation(i);
        })
        .catch(() => {
          /* device not listening yet — device-ready will retry */
        });
    };

    rpc
      .method('getSnapshot')
      .invoke()
      .then(setSnapshot)
      .catch(() => {
        /* device not up yet — device-ready will deliver it */
      });
    seed();

    const subs = [
      client.onMessage('device-ready', (m) => {
        setSnapshot(m.snapshot);
        setSelected(null);
        setDetail(null);
        seed();
      }),
      client.onMessage('snapshot', (m) => setSnapshot(m.snapshot)),
      client.onMessage('missing-keys', (m) => setMissing((prev) => mergeById(prev, m.records))),
      client.onMessage('interpolation-misses', (m) =>
        setInterpolation((prev) => mergeById(prev, m.records)),
      ),
    ];
    return () => subs.forEach((s) => s.remove());
  }, [client, rpc]);

  const setLocale = useCallback(
    async (lng: string) => {
      if (!rpc) return;
      setBusy(true);
      try {
        setSnapshot(await rpc.method('setLocale').invoke({ lng }));
      } finally {
        setBusy(false);
      }
    },
    [rpc],
  );

  useEffect(() => {
    if (!rpc || !selected) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    let cancelled = false;
    setDetail(null);
    setDetailError(null);
    rpc
      .method('getKey')
      .invoke({ key: selected.key, ns: selected.ns })
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setDetailError(e instanceof Error ? e.message : 'Key not found');
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, selected]);

  const fetchScan = useCallback(async (fresh = false) => {
    setScan({ kind: 'loading' });
    try {
      const res = await fetch(fresh ? `${SCAN_ROUTE}?fresh=1` : SCAN_ROUTE);
      const type = res.headers.get('content-type') ?? '';
      // Expo's dev server answers unknown paths with the SPA's HTML and a 200, so a
      // status check alone reports "installed" when the wrapper is missing.
      if (!res.ok || !type.includes('application/json')) {
        setScan({ kind: 'unavailable' });
        return;
      }
      setScan({ kind: 'ready', report: (await res.json()) as ScanPayload });
    } catch {
      setScan({ kind: 'unavailable' });
    }
  }, []);

  useEffect(() => {
    fetchScan();
  }, [fetchScan]);

  const clearFeeds = useCallback(async () => {
    if (!rpc) return;
    await rpc.method('clear').invoke();
    setMissing([]);
    setInterpolation([]);
    setSelected(null);
  }, [rpc]);

  const report = scan.kind === 'ready' ? scan.report : null;
  const issues = useMemo(
    () => mergeIssues(missing, interpolation, report),
    [missing, interpolation, report],
  );
  const counts = useMemo(() => countIssues(issues), [issues]);

  const q = query.trim().toLowerCase();
  const visibleIssues = useMemo(() => {
    const byKind = filter === 'all' ? issues : issues.filter((i) => i.kind === filter);
    if (!q) return byKind;
    return byKind.filter(
      (i) =>
        i.title.toLowerCase().includes(q) ||
        (i.variable?.toLowerCase().includes(q) ?? false) ||
        (i.ns?.toLowerCase().includes(q) ?? false),
    );
  }, [issues, filter, q]);

  if (!client) {
    return (
      <PluginShell>
        <PluginShell.Body>
          <EmptyState title="Waiting for the device" description="Start your app with Rozenite enabled." />
        </PluginShell.Body>
      </PluginShell>
    );
  }

  if (!snapshot) {
    return (
      <PluginShell>
        <PluginShell.Body>
          <EmptyState
            title="No i18n adapter registered"
            description="Call useRozeniteI18nPlugin({ adapter: createI18nextAdapter({ i18n }) }) in your app root."
          />
        </PluginShell.Body>
      </PluginShell>
    );
  }

  const { adapter, locales, activeLng, referenceLng } = snapshot;
  const feedDisabled = !adapter.capabilities.missingKeyFeed;

  const openIssue = (issue: Issue) => {
    if (issue.key) setSelected({ key: issue.key, ns: issue.ns, issue });
  };

  return (
    <PluginShell>
      <PluginShell.Body>
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, fontSize: 13 }}>
          {/* ------------------------------------------------------- scorecard */}
          <Scorecard
            counts={counts}
            locales={locales}
            referenceLng={referenceLng}
            onIssues={() => setTab('issues')}
            onLanguages={() => setTab('languages')}
          />

          {/* -------------------------------------------------------- tab strip */}
          <div
            style={{
              display: 'flex',
              gap: 10,
              alignItems: 'center',
              flexWrap: 'wrap',
              padding: 8,
              flex: 'none',
              borderBottom: '1px solid var(--border)',
            }}
          >
            <ToggleGroup
              value={[tab]}
              onValueChange={(v: readonly string[]) => {
                // Base UI ToggleGroup is multi-value; we use it as a single-select tab
                // strip, so ignore the empty array you get from clicking the active item.
                if (v.length > 0) setTab(v[0] as Tab);
              }}
            >
              <ToggleGroup.Item value="issues">{`Issues (${counts.errors})`}</ToggleGroup.Item>
              <ToggleGroup.Item value="languages">Languages</ToggleGroup.Item>
            </ToggleGroup>
            <div style={{ flex: 1, minWidth: 120 }}>
              <QueryField
                value={query}
                onValueChange={setQuery}
                onClear={() => setQuery('')}
                placeholder="Filter keys…"
              />
            </div>
            {scan.kind === 'ready' && <Button onClick={() => fetchScan(true)}>Rescan</Button>}
            <Button onClick={clearFeeds}>Clear</Button>
          </div>

          {/* ----------------------------------------------------- issue filters */}
          {tab === 'issues' && (
            <div
              style={{
                display: 'flex',
                gap: 6,
                alignItems: 'center',
                padding: '6px 8px',
                flex: 'none',
                borderBottom: '1px solid var(--border)',
              }}
            >
              <ToggleGroup
                value={[filter]}
                onValueChange={(v: readonly string[]) => {
                  if (v.length > 0) setFilter(v[0] as Filter);
                }}
              >
                <ToggleGroup.Item value="all">{`All (${counts.byKind.all})`}</ToggleGroup.Item>
                <ToggleGroup.Item value="missing">{`Missing (${counts.byKind.missing})`}</ToggleGroup.Item>
                <ToggleGroup.Item value="variables">{`Variables (${counts.byKind.variables})`}</ToggleGroup.Item>
                <ToggleGroup.Item value="hardcoded">{`Hardcoded (${counts.byKind.hardcoded})`}</ToggleGroup.Item>
                <ToggleGroup.Item value="stale">{`Stale (${counts.byKind.stale})`}</ToggleGroup.Item>
              </ToggleGroup>
            </div>
          )}

          {/* ------------------------------------------------------------- body */}
          <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
            <div style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
              {tab === 'issues' && (
                <IssuesTab
                  issues={visibleIssues}
                  total={issues.length}
                  feedDisabled={feedDisabled}
                  scanAvailable={scan.kind === 'ready'}
                  onSelect={openIssue}
                />
              )}
              {tab === 'languages' && (
                <LanguagesTab
                  snapshot={snapshot}
                  report={report}
                  query={q}
                  busy={busy}
                  onActivate={setLocale}
                  onSelect={(key, ns) => setSelected({ key, ns })}
                />
              )}
            </div>

            {selected && (
              <KeyDetailPane
                selection={selected}
                detail={detail}
                error={detailError}
                activeLng={activeLng}
                onClose={() => setSelected(null)}
              />
            )}
          </div>

          {/* ---------------------------------------------------------- footer */}
          {showWarnings && adapter.warnings.length > 0 && (
            <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {adapter.warnings.map((w, i) => (
                <Alert key={i} tone="warning">
                  <Alert.Description>{w}</Alert.Description>
                </Alert>
              ))}
            </div>
          )}
          <div
            style={{
              display: 'flex',
              gap: 14,
              alignItems: 'center',
              flexWrap: 'wrap',
              padding: '5px 10px',
              borderTop: '1px solid var(--border)',
              flex: 'none',
              fontSize: 11,
              // Dark --muted (#2b2a2f) is near-identical to the ground (#201f24), so it
              // reads as transparent. Mixing the theme's own foreground into its background
              // is guaranteed opaque and clearly a bar on BOTH grounds — verified against
              // the compiled panel CSS in a browser testbed.
              background: 'color-mix(in srgb, var(--foreground) 16%, var(--background))',
              color: 'var(--muted-foreground)',
            }}
          >
            <span>
              {adapter.library}
              {adapter.libraryVersion ? ` ${adapter.libraryVersion}` : ''}
            </span>
            <span>
              active <code>{activeLng}</code> · ref <code>{referenceLng}</code>
            </span>
            {scan.kind === 'ready' && (
              <span title={`${report?.localesDir} — scanned locale files via Metro`}>
                files: on
              </span>
            )}
            {scan.kind === 'loading' && <span>files: scanning…</span>}
            {scan.kind === 'unavailable' && (
              <span title={METRO_SNIPPET}>
                files: off — add withRozeniteI18nScan to metro.config.js
              </span>
            )}
            {adapter.warnings.length > 0 && (
              <button
                onClick={() => setShowWarnings((s) => !s)}
                title={adapter.warnings.join('\n')}
                style={{
                  border: 0,
                  background: 'none',
                  padding: 0,
                  font: 'inherit',
                  cursor: 'pointer',
                  color: 'var(--warning)',
                }}
              >
                ⚠ {adapter.warnings.length} warning{adapter.warnings.length === 1 ? '' : 's'}
              </button>
            )}
          </div>
        </div>
      </PluginShell.Body>
    </PluginShell>
  );
}

/* ================================================================== scorecard */

/**
 * Always-visible health read, and the panel's shortcuts: the error/warning tiles land on
 * Issues, a locale tile lands on Languages. Absorbs the old Coverage tab's headline.
 */
function Scorecard({
  counts,
  locales,
  referenceLng,
  onIssues,
  onLanguages,
}: {
  counts: { errors: number; warnings: number };
  locales: LocaleCoverage[];
  referenceLng: string;
  onIssues: () => void;
  onLanguages: () => void;
}) {
  const tile: React.CSSProperties = {
    flex: '1 1 90px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 0,
    padding: '6px 12px',
    border: '1px solid var(--border)',
    borderRadius: 6,
    background: 'transparent',
    cursor: 'pointer',
    font: 'inherit',
    color: 'inherit',
    textAlign: 'left',
  };
  const value: React.CSSProperties = {
    fontSize: 18,
    fontWeight: 600,
    fontVariantNumeric: 'tabular-nums',
    lineHeight: 1.3,
  };
  const label: React.CSSProperties = {
    fontSize: 10,
    letterSpacing: '.08em',
    textTransform: 'uppercase',
    color: 'var(--muted-foreground)',
  };

  const localeTone = (l: LocaleCoverage): string => {
    if (l.notLoaded) return 'var(--muted-foreground)';
    if (l.fallingBackCount === 0) return 'var(--success)';
    return l.fallingBackCount > l.total / 4 ? 'var(--danger)' : 'var(--warning)';
  };

  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: 8, flex: 'none' }}>
      <button onClick={onIssues} style={tile}>
        <span style={{ ...value, color: counts.errors > 0 ? 'var(--danger)' : 'var(--success)' }}>
          {counts.errors}
        </span>
        <span style={label}>errors</span>
      </button>
      <button onClick={onIssues} style={tile}>
        <span style={{ ...value, color: counts.warnings > 0 ? 'var(--warning)' : 'var(--success)' }}>
          {counts.warnings}
        </span>
        <span style={label}>warnings</span>
      </button>
      {locales
        .filter((l) => l.lng !== referenceLng)
        .map((l) => (
          <button key={l.lng} onClick={onLanguages} style={tile}>
            <span style={{ ...value, color: localeTone(l) }}>
              {l.notLoaded ? '·' : `${pct(l.translated, l.total)}%`}
            </span>
            <span style={label}>
              {l.lng}
              {l.isActive ? ' · active' : ''}
            </span>
          </button>
        ))}
    </div>
  );
}

/* ================================================================ issues tab */

const KIND_TONE: Record<IssueKind, 'danger' | 'warning'> = {
  parse: 'danger',
  missing: 'danger',
  variables: 'danger',
  hardcoded: 'warning',
  stale: 'warning',
};

function IssuesTab({
  issues,
  total,
  feedDisabled,
  scanAvailable,
  onSelect,
}: {
  issues: Issue[];
  total: number;
  feedDisabled: boolean;
  scanAvailable: boolean;
  onSelect: (issue: Issue) => void;
}) {
  if (issues.length === 0) {
    if (total > 0) {
      return <EmptyState title="No matches" description="Nothing matches that filter." />;
    }
    const parts: string[] = [];
    parts.push(
      feedDisabled
        ? 'The runtime feed is off — i18next only emits missingKey when saveMissing is true (see the warning in the footer).'
        : 'Runtime findings appear as screens render — navigate the app and every key each screen requests is checked automatically.',
    );
    parts.push(
      scanAvailable
        ? 'The file scan found nothing wrong on disk either.'
        : 'File checks are off — add withRozeniteI18nScan to metro.config.js to also catch problems on screens you have not opened (see the footer).',
    );
    return <EmptyState title="Nothing broken yet" description={parts.join(' ')} />;
  }

  return (
    <VirtualizedList
      ariaLabel="Issues"
      data={issues}
      onItemClick={(i) => onSelect(i)}
      getItemKey={(i) => i.id}
      getItemTextValue={(i) => i.title}
      renderItem={(i) => (
        <div
          style={{
            padding: '7px 12px',
            display: 'flex',
            gap: 8,
            alignItems: 'baseline',
            cursor: i.key ? 'pointer' : 'default',
          }}
          title={i.note}
        >
          <Badge tone={KIND_TONE[i.kind]}>{i.kind}</Badge>
          <code style={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>
            {i.title}
            {i.variable ? (
              <span style={{ color: 'var(--warning)' }}>{` · {{${i.variable}}}`}</span>
            ) : null}
          </code>
          {/* Where the evidence came from. Both badges on one row = seen live AND on
              disk — the highest-confidence finding the panel can make. */}
          {i.sources.runtime && <Badge tone="info">runtime</Badge>}
          {i.sources.files && <Badge tone="neutral">files</Badge>}
          {i.fileRefs.length > 0 && (
            <span style={{ color: 'var(--muted-foreground)', fontSize: 11, flex: 'none' }}>
              {i.fileRefs[0]}
              {i.fileRefs.length > 1 ? ` +${i.fileRefs.length - 1}` : ''}
            </span>
          )}
          {i.locales.length > 0 && (
            <span style={{ color: 'var(--muted-foreground)', fontSize: 11, flex: 'none' }}>
              {i.locales.join(' ')}
            </span>
          )}
        </div>
      )}
    />
  );
}

/* ============================================================= languages tab */

/**
 * The old Coverage tab's depth, one block per locale: the bar, the keys that silently
 * fall back (union of what runtime saw and what the scan found on disk), make-active.
 * Deliberately NOT part of Issues — a silent fallback is translation debt, not a code
 * bug, and listing it there would repeat every gap once per locale.
 */
const GAP_DISPLAY_CAP = 50;

function LanguagesTab({
  snapshot,
  report,
  query,
  busy,
  onActivate,
  onSelect,
}: {
  snapshot: I18nSnapshot;
  report: ScanReport | null;
  query: string;
  busy: boolean;
  onActivate: (lng: string) => void;
  onSelect: (key: string, ns?: string) => void;
}) {
  const { referenceLng, namespaces } = snapshot;

  const selectKey = (k: string) => {
    // A gap row is `ns:key` only when the app has several namespaces.
    const hasNs = namespaces.length > 1 && k.includes(':');
    if (hasNs) onSelect(k.slice(k.indexOf(':') + 1), k.slice(0, k.indexOf(':')));
    else onSelect(k);
  };

  const sectionLabel: React.CSSProperties = {
    fontSize: 10,
    letterSpacing: '.08em',
    textTransform: 'uppercase',
    color: 'var(--muted-foreground)',
  };

  return (
    <div style={{ height: '100%', overflowY: 'auto' }}>
      {snapshot.locales.map((l) => {
        const isRef = l.lng === referenceLng;
        const gaps = isRef ? [] : localeGapKeys(l.fallingBack, report?.missing[l.lng]);
        const shown = query ? gaps.filter((k) => k.toLowerCase().includes(query)) : gaps;
        const gapTotal = Math.max(l.fallingBackCount, gaps.length);
        return (
          <div
            key={l.lng}
            style={{
              padding: '12px 14px',
              borderBottom: '1px solid var(--border)',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <code style={{ fontWeight: 600 }}>{l.lng}</code>
              {l.dir === 'rtl' && <span style={{ color: 'var(--muted-foreground)' }}>rtl</span>}
              {isRef ? (
                // Never a percentage: every locale is measured AGAINST this one, so it is
                // always trivially 100%.
                <Badge tone="neutral">reference</Badge>
              ) : l.notLoaded ? (
                <Badge tone="neutral">not loaded</Badge>
              ) : (
                <>
                  <Badge
                    tone={
                      l.fallingBackCount === 0
                        ? 'success'
                        : l.fallingBackCount > l.total / 4
                          ? 'danger'
                          : 'warning'
                    }
                  >
                    {pct(l.translated, l.total)}%
                  </Badge>
                  <span style={{ color: 'var(--muted-foreground)' }}>
                    {l.translated}/{l.total} keys
                  </span>
                </>
              )}
              {l.isActive ? (
                <Badge tone="info">active</Badge>
              ) : (
                <span style={{ marginLeft: 'auto' }}>
                  <Button onClick={() => onActivate(l.lng)} disabled={busy}>
                    Make active
                  </Button>
                </span>
              )}
            </div>

            {!isRef && !l.notLoaded && (
              <div
                aria-hidden
                style={{
                  height: 5,
                  borderRadius: 3,
                  background: 'var(--muted)',
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${pct(l.translated, l.total)}%`,
                    height: '100%',
                    background: 'var(--primary)',
                  }}
                />
              </div>
            )}

            {isRef && (
              <span style={{ color: 'var(--muted-foreground)', fontSize: 12 }}>
                Defines the {l.total} keys every other locale is measured against. Keys missing
                here too resolve nowhere and appear under Issues instead.
              </span>
            )}

            {l.notLoadedNamespaces.length > 0 && (
              <span style={{ color: 'var(--muted-foreground)', fontSize: 12 }}>
                Not loaded yet: {l.notLoadedNamespaces.join(', ')} — excluded from the numbers
                (unknown, not untranslated).
              </span>
            )}

            {shown.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={sectionLabel}>
                  falls back silently to {referenceLng} — {gapTotal} key{gapTotal === 1 ? '' : 's'}
                </span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {shown.slice(0, GAP_DISPLAY_CAP).map((k) => (
                    <button
                      key={k}
                      onClick={() => selectKey(k)}
                      style={{
                        border: '1px solid var(--border)',
                        borderRadius: 4,
                        background: 'transparent',
                        color: 'inherit',
                        font: 'inherit',
                        fontSize: 12,
                        padding: '2px 7px',
                        cursor: 'pointer',
                      }}
                    >
                      <code>{k}</code>
                    </button>
                  ))}
                  {shown.length > GAP_DISPLAY_CAP && (
                    <span style={{ color: 'var(--muted-foreground)', fontSize: 12 }}>
                      +{shown.length - GAP_DISPLAY_CAP} more — use the filter box
                    </span>
                  )}
                </div>
              </div>
            )}

            {!isRef && !l.notLoaded && gaps.length > 0 && shown.length === 0 && (
              <span style={{ color: 'var(--muted-foreground)', fontSize: 12 }}>
                No gap keys match that filter.
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ============================================================== detail pane */

/**
 * The payoff for `getKey`: shows every locale's value for one key and which locale the
 * active resolution chain actually lands on. That last line is the answer to "why is this
 * screen in English?" — the question the whole plugin exists for.
 *
 * Note this is served by walking the resource store, never by calling `t()`. Calling `t()`
 * here would re-enter the code that emits `missingKey`, so opening this pane would
 * fabricate rows in the very feed you clicked from.
 */
function KeyDetailPane({
  selection,
  detail,
  error,
  activeLng,
  onClose,
}: {
  selection: Selection;
  detail: KeyDetail | null;
  error: string | null;
  activeLng: string;
  onClose: () => void;
}) {
  const issue = selection.issue;
  return (
    <aside
      style={{
        width: 340,
        flex: 'none',
        borderLeft: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        overflowY: 'auto',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8,
          padding: '10px 12px',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <code style={{ flex: 1, minWidth: 0, wordBreak: 'break-all', fontSize: 12 }}>
          {selection.key}
        </code>
        <Button onClick={onClose} aria-label="Close details">
          ✕
        </Button>
      </div>

      {issue && (
        <div style={{ padding: '10px 12px 0', display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 }}>
          <Row label="Evidence">
            <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'baseline' }}>
              {issue.sources.runtime && <Badge tone="info">runtime</Badge>}
              {issue.sources.files && <Badge tone="neutral">files</Badge>}
              {issue.sources.runtime && issue.sources.files && (
                <span style={{ color: 'var(--muted-foreground)' }}>— seen live and on disk</span>
              )}
            </span>
          </Row>
          {issue.note && <div style={{ color: 'var(--muted-foreground)' }}>{issue.note}</div>}
          {issue.fileRefs.length > 0 && (
            <Row label="Used at">
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {issue.fileRefs.map((f) => (
                  <code key={f} style={{ fontSize: 11 }}>
                    {f}
                  </code>
                ))}
              </span>
            </Row>
          )}
        </div>
      )}

      {error && (
        <div style={{ padding: 12 }}>
          <Alert tone="danger">
            <Alert.Description>{error}</Alert.Description>
          </Alert>
        </div>
      )}

      {!detail && !error && (
        <div style={{ padding: 12, fontSize: 12, color: 'var(--muted-foreground)' }}>Loading…</div>
      )}

      {detail && (
        <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 14, fontSize: 12 }}>
          <Row label="Namespace">
            <code>{detail.ns}</code>
          </Row>

          <Row label="Resolves from">
            {detail.resolvedFrom ? (
              <span>
                <Badge tone={detail.resolvedFrom === activeLng ? 'success' : 'warning'}>
                  {detail.resolvedFrom}
                </Badge>{' '}
                {detail.resolvedFrom !== activeLng && (
                  <span style={{ color: 'var(--muted-foreground)' }}>
                    — falls back from <code>{activeLng}</code>
                  </span>
                )}
              </span>
            ) : (
              <Badge tone="danger">nowhere</Badge>
            )}
          </Row>

          {detail.variables.length > 0 && (
            <Row label="Variables">
              <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {detail.variables.map((v) => (
                  <Badge key={v} tone="neutral">{`{{${v}}}`}</Badge>
                ))}
              </span>
            </Row>
          )}

          <div>
            <div
              style={{
                fontSize: 10,
                letterSpacing: '.09em',
                textTransform: 'uppercase',
                color: 'var(--muted-foreground)',
                marginBottom: 6,
              }}
            >
              Value per locale
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {detail.values.map((v) => (
                <div
                  key={v.lng}
                  style={{
                    display: 'flex',
                    gap: 8,
                    alignItems: 'baseline',
                    padding: '6px 8px',
                    borderRadius: 4,
                    background:
                      v.lng === detail.resolvedFrom ? 'var(--sidebar-accent)' : 'transparent',
                  }}
                >
                  <Badge tone={v.value === null ? 'danger' : 'neutral'}>{v.lng}</Badge>
                  {v.value === null ? (
                    <span style={{ color: 'var(--muted-foreground)', fontStyle: 'italic' }}>
                      missing
                    </span>
                  ) : (
                    <span style={{ minWidth: 0, wordBreak: 'break-word' }}>{v.value}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          letterSpacing: '.09em',
          textTransform: 'uppercase',
          color: 'var(--muted-foreground)',
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}
