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
  MissingKeyRecord,
} from '../shared/types';
// Types only — scan-core is Node code; the values live behind the Metro HTTP route.
import type { ScanReport } from '../node/scan-core';

const PLUGIN_ID = 'rozenite-i18n-devtools';
const SCAN_ROUTE = '/_rozenite-i18n/scan.json'; // keep in sync with src/node/with-i18n-scan.ts
type Tab = 'coverage' | 'missing' | 'interpolation' | 'files';

type ScanPayload = ScanReport & { errors: number; warnings: number; scannedAtMs: number };
type ScanState =
  | { kind: 'loading' }
  | { kind: 'unavailable' } // route absent: the metro wrapper is not installed
  | { kind: 'ready'; report: ScanPayload };

const pct = (n: number, d: number) => (d === 0 ? 100 : Math.round((n / d) * 100));

export default function I18nPanel() {
  const client = useRozeniteDevToolsClient<I18nEventMap>({ pluginId: PLUGIN_ID });

  const [snapshot, setSnapshot] = useState<I18nSnapshot | null>(null);
  const [missing, setMissing] = useState<MissingKeyRecord[]>([]);
  const [interpolation, setInterpolation] = useState<InterpolationMissRecord[]>([]);
  const [tab, setTab] = useState<Tab>('coverage');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<{ key: string; ns?: string } | null>(null);
  const [scan, setScan] = useState<ScanState>({ kind: 'loading' });
  const [detail, setDetail] = useState<KeyDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

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

  const q = query.trim().toLowerCase();
  const filteredMissing = useMemo(
    () => (q ? missing.filter((r) => r.key.toLowerCase().includes(q) || r.ns.toLowerCase().includes(q)) : missing),
    [missing, q],
  );
  const filteredInterp = useMemo(
    () =>
      q
        ? interpolation.filter(
            (r) =>
              r.variable.toLowerCase().includes(q) ||
              r.key.toLowerCase().includes(q) ||
              r.template.toLowerCase().includes(q),
          )
        : interpolation,
    [interpolation, q],
  );

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

  return (
    <PluginShell>
      <PluginShell.Body>
        <div style={{ display: 'flex', height: '100%', minHeight: 0, fontSize: 13 }}>
          {/* ---------------------------------------------------------- locales */}
          <aside
            style={{
              width: 240,
              flex: 'none',
              overflowY: 'auto',
              borderRight: '1px solid var(--color-border)',
              padding: 8,
            }}
          >
            <div style={{ padding: '4px 8px 8px', opacity: 0.6, fontSize: 11, letterSpacing: '.08em' }}>
              LOCALES · ref {referenceLng}
            </div>
            {locales.map((l) => (
              <button
                key={l.lng}
                onClick={() => setLocale(l.lng)}
                disabled={busy || !adapter.capabilities.localeSwitching}
                style={{
                  display: 'flex',
                  width: '100%',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  padding: '7px 8px',
                  marginBottom: 2,
                  border: 0,
                  borderRadius: 4,
                  cursor: 'pointer',
                  textAlign: 'left',
                  background: l.isActive ? 'var(--color-sidebar-accent)' : 'transparent',
                  color: 'inherit',
                  font: 'inherit',
                }}
              >
                <span>
                  {l.lng}
                  {l.dir === 'rtl' ? <span style={{ opacity: 0.5 }}> · rtl</span> : null}
                  {l.notLoadedNamespaces.length > 0 && (
                    <span
                      style={{ opacity: 0.5 }}
                      title={`Not loaded yet: ${l.notLoadedNamespaces.join(', ')}. These namespaces are excluded from the percentage.`}
                    >
                      {' '}
                      · partial
                    </span>
                  )}
                </span>
                {l.lng === referenceLng ? (
                  // Never a percentage: every locale is measured AGAINST this one, so it is
                  // always trivially 100%. Showing that next to a Missing tab reporting gaps
                  // in this very locale reads as a contradiction.
                  <Badge tone="neutral">reference</Badge>
                ) : l.notLoaded ? (
                  <Badge tone="neutral">not loaded</Badge>
                ) : (
                  <Badge tone={l.fallingBackCount === 0 ? 'success' : l.fallingBackCount > l.total / 4 ? 'danger' : 'warning'}>
                    {pct(l.translated, l.total)}%
                  </Badge>
                )}
              </button>
            ))}
          </aside>

          {/* ------------------------------------------------------------- main */}
          <section style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <div
              style={{
                display: 'flex',
                gap: 10,
                alignItems: 'center',
                padding: 8,
                borderBottom: '1px solid var(--color-border)',
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
                <ToggleGroup.Item value="coverage">Coverage</ToggleGroup.Item>
                <ToggleGroup.Item value="missing">{`Missing (${missing.length})`}</ToggleGroup.Item>
                <ToggleGroup.Item value="interpolation">
                  {`Interpolation (${interpolation.length})`}
                </ToggleGroup.Item>
                <ToggleGroup.Item value="files">
                  {scan.kind === 'ready' ? `Files (${scan.report.errors})` : 'Files'}
                </ToggleGroup.Item>
              </ToggleGroup>
              <div style={{ flex: 1, minWidth: 120 }}>
                <QueryField
                  value={query}
                  onValueChange={setQuery}
                  onClear={() => setQuery('')}
                  placeholder="Filter keys…"
                />
              </div>
              <Button onClick={clearFeeds}>Clear</Button>
            </div>

            {adapter.warnings.length > 0 && (
              <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {adapter.warnings.map((w, i) => (
                  <Alert key={i} tone="warning">
                    <Alert.Description>{w}</Alert.Description>
                  </Alert>
                ))}
              </div>
            )}

            <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
              <div style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
              {tab === 'files' && (
                <FilesTab
                  scan={scan}
                  onRescan={() => fetchScan(true)}
                  onSelect={(key, ns) => setSelected({ key, ns })}
                />
              )}
              {tab === 'coverage' && (
                <CoverageTab
                  snapshot={snapshot}
                  query={q}
                  onSelect={(k) => {
                    // A coverage row is `ns:key` only when the app has several namespaces.
                    const hasNs = snapshot.namespaces.length > 1 && k.includes(':');
                    setSelected(
                      hasNs
                        ? { ns: k.slice(0, k.indexOf(':')), key: k.slice(k.indexOf(':') + 1) }
                        : { key: k },
                    );
                  }}
                />
              )}

              {tab === 'missing' &&
                (feedDisabled ? (
                  <EmptyState
                    title="Missing-key feed is off"
                    description="i18next only emits missingKey when saveMissing is true. See the warning above."
                  />
                ) : filteredMissing.length === 0 ? (
                  <EmptyState
                    title={missing.length ? 'No matches' : 'Nothing missing on the screens you have opened'}
                    description={
                      missing.length
                        ? 'Nothing matches that filter.'
                        : 'Rows appear as screens render — navigate and every key that screen ' +
                          'requests is checked automatically. Only keys resolved behind a tap or ' +
                          'a condition wait for that to happen. This catches typos and ' +
                          `unextracted strings: keys that resolve in no locale at all. Keys missing only in ${activeLng} ` +
                          'fall back silently and never fire an event — Coverage finds those.'
                    }
                  />
                ) : (
                  <VirtualizedList
                    ariaLabel="Missing keys"
                    data={filteredMissing}
                    followOutput
                    onItemClick={(r) => setSelected({ key: r.key, ns: r.ns })}
                    getItemKey={(r) => r.id}
                    getItemTextValue={(r) => r.key}
                    renderItem={(r) => (
                      <div style={{ padding: '7px 12px', display: 'flex', gap: 10, alignItems: 'baseline' }}>
                        {/* The locale SET, not the latest sighting — stable while you switch
                            language, and it says whether the key is missed everywhere. */}
                        <span style={{ display: 'flex', gap: 3 }}>
                          {[...r.observedLocales].sort().map((l) => (
                            <Badge key={l} tone="danger">
                              {l}
                            </Badge>
                          ))}
                        </span>
                        <code style={{ flex: 1, minWidth: 0, wordBreak: 'break-all' }}>{r.key}</code>
                        <span style={{ opacity: 0.5, fontSize: 11 }}>{r.ns}</span>
                      </div>
                    )}
                  />
                ))}

              {tab === 'interpolation' &&
                (filteredInterp.length === 0 ? (
                  <EmptyState
                    title={interpolation.length ? 'No matches' : 'No interpolation misses yet'}
                    description={
                      interpolation.length
                        ? 'Nothing matches that filter.'
                        : 'Variables like {{name}} that are never supplied show up here, once the ' +
                          'string renders. i18next does not log these even with debug: true — the ' +
                          'warning sits behind skipOnVariables, which defaults to true.'
                    }
                  />
                ) : (
                  <VirtualizedList
                    ariaLabel="Interpolation misses"
                    data={filteredInterp}
                    followOutput
                    onItemClick={(r) => setSelected({ key: r.key, ns: r.ns })}
                    getItemKey={(r) => r.id}
                    getItemTextValue={(r) => r.variable}
                    renderItem={(r) => (
                      <div
                        style={{ padding: '7px 12px', display: 'flex', gap: 10, alignItems: 'baseline' }}
                        title={r.template}
                      >
                        <Badge tone="warning">{`{{${r.variable}}}`}</Badge>
                        <code style={{ flex: 1, minWidth: 0, wordBreak: 'break-all' }}>{r.key}</code>
                        {/* The locale SET, not the latest template: stable, and it says whether
                            one translation is at fault or the variable is never passed at all. */}
                        <span style={{ display: 'flex', gap: 3 }}>
                          {[...r.locales].sort().map((l) => (
                            <Badge key={l} tone="neutral">
                              {l}
                            </Badge>
                          ))}
                        </span>
                      </div>
                    )}
                  />
                ))}
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
          </section>
        </div>
      </PluginShell.Body>
    </PluginShell>
  );
}

function CoverageTab({
  snapshot,
  query,
  onSelect,
}: {
  snapshot: I18nSnapshot;
  query: string;
  onSelect: (key: string) => void;
}) {
  const rows = useMemo(() => {
    const active = snapshot.locales.find((l) => l.isActive);
    if (!active) return [];
    return query ? active.fallingBack.filter((k) => k.toLowerCase().includes(query)) : active.fallingBack;
  }, [snapshot, query]);

  const active = snapshot.locales.find((l) => l.isActive);
  if (!active) return <EmptyState title="No active locale" description="" />;

  if (active.lng === snapshot.referenceLng) {
    return (
      <EmptyState
        title={`${active.lng} is the reference locale`}
        description={
          `Every other locale is measured against this one, so it has nothing to fall back ` +
          `to and no percentage to report — it defines the ${active.total} keys that count. ` +
          `That does NOT mean it is complete: keys your code requests that are missing from ` +
          `${active.lng} too resolve nowhere, so they appear in the Missing tab rather than here. ` +
          `Switch to another locale to see what falls back to ${active.lng}.`
        }
      />
    );
  }

  if (active.fallingBackCount === 0) {
    return (
      <EmptyState
        title={`${active.lng} is fully translated`}
        description={`All ${active.total} keys from ${snapshot.referenceLng} are present.`}
      />
    );
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {active.notLoadedNamespaces.length > 0 && (
        <div style={{ padding: '10px 12px 0' }}>
          <Alert tone="info">
            <Alert.Description>
              {active.notLoadedNamespaces.length === 1
                ? `The "${active.notLoadedNamespaces[0]}" namespace has not loaded for ${active.lng} yet, so its keys are excluded from these numbers — unknown, not untranslated.`
                : `${active.notLoadedNamespaces.length} namespaces have not loaded for ${active.lng} yet (${active.notLoadedNamespaces.join(', ')}), so their keys are excluded from these numbers — unknown, not untranslated.`}
            </Alert.Description>
          </Alert>
        </div>
      )}
      <div style={{ padding: '10px 12px', fontSize: 12, lineHeight: 1.55, opacity: 0.85 }}>
        <strong>{active.fallingBackCount}</strong> of {active.total} keys are missing in{' '}
        <strong>{active.lng}</strong> and silently render {snapshot.referenceLng} text.{' '}
        <span style={{ opacity: 0.7 }}>
          These emit no missingKey event, so the Missing tab cannot see them.
        </span>
        {active.fallingBackCount > active.fallingBack.length && (
          <span style={{ opacity: 0.7 }}> Showing the first {active.fallingBack.length}.</span>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <VirtualizedList
          ariaLabel="Keys falling back"
          data={rows}
          onItemClick={onSelect}
          getItemKey={(k) => k}
          getItemTextValue={(k) => k}
          renderItem={(k) => (
            <div style={{ padding: '6px 12px', display: 'flex', gap: 10 }}>
              <Badge tone="warning">fallback</Badge>
              <code style={{ wordBreak: 'break-all' }}>{k}</code>
            </div>
          )}
        />
      </div>
    </div>
  );
}

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
  selection: { key: string; ns?: string };
  detail: KeyDetail | null;
  error: string | null;
  activeLng: string;
  onClose: () => void;
}) {
  return (
    <aside
      style={{
        width: 340,
        flex: 'none',
        borderLeft: '1px solid var(--color-border)',
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
          borderBottom: '1px solid var(--color-border)',
        }}
      >
        <code style={{ flex: 1, minWidth: 0, wordBreak: 'break-all', fontSize: 12 }}>
          {selection.key}
        </code>
        <Button onClick={onClose} aria-label="Close details">
          ✕
        </Button>
      </div>

      {error && (
        <div style={{ padding: 12 }}>
          <Alert tone="danger">
            <Alert.Description>{error}</Alert.Description>
          </Alert>
        </div>
      )}

      {!detail && !error && (
        <div style={{ padding: 12, fontSize: 12, color: 'var(--color-muted-foreground)' }}>Loading…</div>
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
                  <span style={{ color: 'var(--color-muted-foreground)' }}>
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
                color: 'var(--color-muted-foreground)',
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
                      v.lng === detail.resolvedFrom ? 'var(--color-sidebar-accent)' : 'transparent',
                  }}
                >
                  <Badge tone={v.value === null ? 'danger' : 'neutral'}>{v.lng}</Badge>
                  {v.value === null ? (
                    <span style={{ color: 'var(--color-muted-foreground)', fontStyle: 'italic' }}>
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
          color: 'var(--color-muted-foreground)',
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

/**
 * Results of the static scan served by the Metro wrapper — the checks that need the files
 * on disk rather than the running app: per-locale diffs of the locale JSONs, {{variable}}
 * mismatches, t() keys absent from the reference, and hardcoded JSX text.
 */
function FilesTab({
  scan,
  onRescan,
  onSelect,
}: {
  scan: ScanState;
  onRescan: () => void;
  onSelect: (key: string, ns?: string) => void;
}) {
  if (scan.kind === 'loading') {
    return <EmptyState title="Scanning…" description="Reading the locale files via Metro." />;
  }
  if (scan.kind === 'unavailable') {
    return (
      <EmptyState
        title="Static scanning is not wired up"
        description={
          'Add the Metro wrapper so the dev server can read your locale files:  ' +
          "const { withRozeniteI18nScan } = require('rozenite-i18n-devtools/metro');  " +
          "module.exports = withRozeniteI18nScan(config, { locales: './src/locales', src: './src' });  " +
          'Then restart Metro. The runtime tabs work without it.'
        }
      />
    );
  }

  const r = scan.report;
  const sectionTitle: React.CSSProperties = {
    fontSize: 10,
    letterSpacing: '.09em',
    textTransform: 'uppercase',
    color: 'var(--color-muted-foreground)',
    margin: '14px 0 6px',
  };
  const row: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'baseline', padding: '3px 0' };
  const clean = r.errors === 0 && r.warnings === 0 && r.parseErrors.length === 0;

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '10px 12px', fontSize: 12 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <span style={{ color: 'var(--color-muted-foreground)' }}>
          {r.localesDir} · ref <code>{r.ref}</code> · {r.locales.join(', ')}
        </span>
        <Button onClick={onRescan}>Rescan</Button>
      </div>

      {r.parseErrors.map((e, i) => (
        <div key={i} style={{ marginTop: 8 }}>
          <Alert tone="danger">
            <Alert.Description>{e}</Alert.Description>
          </Alert>
        </div>
      ))}

      {clean && (
        <div style={{ marginTop: 10 }}>
          <Alert tone="success">
            <Alert.Description>
              Locale files agree with {r.ref}
              {r.source ? ', and every literal key in the source resolves.' : '.'}
            </Alert.Description>
          </Alert>
        </div>
      )}

      {Object.entries(r.missing).map(([lng, keys]) => (
        <div key={lng}>
          <div style={sectionTitle}>
            missing in {lng} — {keys.length}
          </div>
          {keys.map((k) => (
            <div key={k} style={{ ...row, cursor: 'pointer' }} onClick={() => onSelect(k)}>
              <Badge tone="danger">{lng}</Badge>
              <code>{k}</code>
            </div>
          ))}
        </div>
      ))}

      {r.varMismatch.length > 0 && (
        <div>
          <div style={sectionTitle}>variable mismatches — {r.varMismatch.length}</div>
          {r.varMismatch.map((v, i) => (
            <div key={i} style={{ ...row, cursor: 'pointer' }} onClick={() => onSelect(v.key)}>
              <Badge tone="danger">{v.lng}</Badge>
              <code>{v.key}</code>
              <span style={{ color: 'var(--color-muted-foreground)' }}>
                {r.ref}: {v.refVars.length ? v.refVars.map((x) => `{{${x}}}`).join(' ') : '—'}
                {'  vs  '}
                {v.vars.length ? v.vars.map((x) => `{{${x}}}`).join(' ') : '—'}
              </span>
            </div>
          ))}
        </div>
      )}

      {r.source && r.source.missingInCode.length > 0 && (
        <div>
          <div style={sectionTitle}>
            keys used in code, absent from {r.ref} — {r.source.missingInCode.length}
          </div>
          {r.source.missingInCode.map((m, i) => (
            <div key={i} style={row}>
              <code style={{ flex: 'none' }}>{m.key}</code>
              <span style={{ color: 'var(--color-muted-foreground)' }}>
                {m.file}:{m.line}
              </span>
            </div>
          ))}
        </div>
      )}

      {Object.entries(r.extra).map(([lng, keys]) => (
        <div key={lng}>
          <div style={sectionTitle}>
            stale in {lng} (not in {r.ref}) — {keys.length}
          </div>
          {keys.map((k) => (
            <div key={k} style={row}>
              <Badge tone="warning">{lng}</Badge>
              <code>{k}</code>
            </div>
          ))}
        </div>
      ))}

      {r.source && r.source.hardcoded.length > 0 && (
        <div>
          <div style={sectionTitle}>
            hardcoded JSX text (heuristic) — {r.source.hardcoded.length}
          </div>
          {r.source.hardcoded.slice(0, 100).map((h, i) => (
            <div key={i} style={row}>
              <Badge tone="warning">text</Badge>
              <span style={{ minWidth: 0, wordBreak: 'break-word' }}>&ldquo;{h.text}&rdquo;</span>
              <span style={{ color: 'var(--color-muted-foreground)', flex: 'none' }}>
                {h.file}:{h.line}
              </span>
            </div>
          ))}
        </div>
      )}

      {r.source && r.source.dynamicKeys > 0 && (
        <div style={{ marginTop: 12, color: 'var(--color-muted-foreground)' }}>
          {r.source.dynamicKeys} dynamic t() call{r.source.dynamicKeys === 1 ? '' : 's'} the scanner
          cannot verify — those are what the runtime tabs are for.
        </div>
      )}
    </div>
  );
}
