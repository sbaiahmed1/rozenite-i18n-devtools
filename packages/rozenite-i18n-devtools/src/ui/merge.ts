import type { InterpolationMissRecord, MissingKeyRecord } from '../shared/types';
import type { ScanReport } from '../node/scan-core';

/**
 * The merge layer behind the Issues tab: one list, deduped by WHAT is broken, no matter
 * how it was detected.
 *
 * The panel used to have a tab per detection mechanism (Missing = runtime event,
 * Interpolation = postProcessor, Files = disk scan). Users don't ask "what did the
 * postProcessor see" — they ask "what's broken". A key that is both missed at runtime and
 * absent from the reference JSON is ONE problem seen twice, and the double sighting is
 * signal (high confidence), not two rows.
 *
 * Deliberately NOT merged here: per-locale fallback gaps (key present in the reference,
 * absent in de). Those are translation debt, not code bugs — they belong to the Languages
 * tab, and putting them in Issues would repeat every gap once per locale. Same reasoning
 * as MissingKeyRecord vs LocaleCoverage in shared/types.ts: a silent fallback is not a
 * missing key.
 */
export type IssueKind = 'parse' | 'missing' | 'variables' | 'hardcoded' | 'stale';
export type IssueSeverity = 'error' | 'warning';

export type Issue = {
  /** Unique within the merged list. */
  id: string;
  kind: IssueKind;
  severity: IssueSeverity;
  /** What the row shows: the key, the hardcoded text, or the parse error message. */
  title: string;
  /** Set for key-shaped issues — clicking the row opens the key detail pane. */
  key?: string;
  ns?: string;
  /** For variables issues: the placeholder that never resolves. */
  variable?: string;
  sources: { runtime: boolean; files: boolean };
  /** Locales the problem was observed in (runtime) or diagnosed for (scan). */
  locales: string[];
  /** file:line references contributed by the static scan. */
  fileRefs: string[];
  /** One extra context line for the detail pane. */
  note?: string;
};

export type IssueCounts = {
  errors: number;
  warnings: number;
  byKind: Record<IssueKind | 'all', number>;
};

const KIND_ORDER: IssueKind[] = ['parse', 'missing', 'variables', 'hardcoded', 'stale'];

const addLocale = (issue: Issue, lng: string | undefined) => {
  if (lng && !issue.locales.includes(lng)) issue.locales.push(lng);
};

/**
 * Runtime records carry an explicit namespace; scan findings carry the literal the code
 * wrote, which may or may not be ns-prefixed. Index runtime issues under both spellings
 * so either form of the literal finds its row.
 */
const aliasesOf = (ns: string, key: string): string[] =>
  ns && ns !== 'translation' ? [`${ns}:${key}`, key] : [key, `translation:${key}`];

export const mergeIssues = (
  missing: MissingKeyRecord[],
  interpolation: InterpolationMissRecord[],
  report: ScanReport | null,
): Issue[] => {
  const issues: Issue[] = [];

  // ---- parse errors: the scan could not even read a locale file. Always first.
  for (const [i, message] of (report?.parseErrors ?? []).entries()) {
    issues.push({
      id: `parse:${i}`,
      kind: 'parse',
      severity: 'error',
      title: message,
      sources: { runtime: false, files: true },
      locales: [],
      fileRefs: [],
    });
  }

  // ---- missing keys: runtime feed first, then fold the scan's code findings in.
  const missingByAlias = new Map<string, Issue>();
  for (const r of missing) {
    const issue: Issue = {
      id: `missing:${r.id}`,
      kind: 'missing',
      severity: 'error',
      title: r.key,
      key: r.key,
      ns: r.ns,
      sources: { runtime: true, files: false },
      locales: [...r.observedLocales].sort(),
      fileRefs: [],
    };
    issues.push(issue);
    for (const a of aliasesOf(r.ns, r.key)) {
      if (!missingByAlias.has(a)) missingByAlias.set(a, issue);
    }
  }
  for (const f of report?.source?.missingInCode ?? []) {
    const ref = `${f.file}:${f.line}`;
    const existing = missingByAlias.get(f.key);
    if (existing) {
      existing.sources.files = true;
      if (!existing.fileRefs.includes(ref)) existing.fileRefs.push(ref);
    } else {
      // Scan-only: the screen using this key has never rendered. Runtime cannot see it.
      const issue: Issue = {
        id: `missing:file:${f.key}`,
        kind: 'missing',
        severity: 'error',
        title: f.key,
        key: f.key,
        sources: { runtime: false, files: true },
        locales: [],
        fileRefs: [ref],
      };
      issues.push(issue);
      missingByAlias.set(f.key, issue);
    }
  }

  // ---- variables: runtime interpolation misses + the scan's {{var}} mismatches.
  const varByAlias = new Map<string, Issue>();
  for (const r of interpolation) {
    const issue: Issue = {
      id: `variables:${r.id}`,
      kind: 'variables',
      severity: 'error',
      title: r.key,
      key: r.key,
      ns: r.ns,
      variable: r.variable,
      sources: { runtime: true, files: false },
      locales: [...r.locales].sort(),
      fileRefs: [],
      note: `Rendered "${r.template}" with {{${r.variable}}} unresolved.`,
    };
    issues.push(issue);
    for (const a of aliasesOf(r.ns, r.key)) {
      varByAlias.set(`${a}#${r.variable}`, issue);
    }
  }
  for (const m of report?.varMismatch ?? []) {
    // A mismatch usually means the translation renamed or dropped a placeholder the
    // reference has. If runtime already saw that exact key+variable fail, corroborate the
    // row; otherwise it is a scan-only finding.
    const droppedVars = m.refVars.filter((v) => !m.vars.includes(v));
    const matched = droppedVars
      .map((v) => varByAlias.get(`${m.key}#${v}`))
      .filter((x): x is Issue => Boolean(x));
    if (matched.length > 0) {
      for (const issue of matched) {
        issue.sources.files = true;
        addLocale(issue, m.lng);
      }
      continue;
    }
    const show = (vars: string[]) => (vars.length ? vars.map((v) => `{{${v}}}`).join(' ') : '—');
    issues.push({
      id: `variables:mismatch:${m.lng}:${m.key}`,
      kind: 'variables',
      severity: 'error',
      title: m.key,
      key: m.key,
      variable: droppedVars[0],
      sources: { runtime: false, files: true },
      locales: [m.lng],
      fileRefs: [],
      note: `${report?.ref ?? 'reference'} has ${show(m.refVars)}, ${m.lng} has ${show(m.vars)}.`,
    });
  }

  // ---- hardcoded JSX text: scan-only, heuristic, warning.
  for (const h of report?.source?.hardcoded ?? []) {
    issues.push({
      id: `hardcoded:${h.file}:${h.line}`,
      kind: 'hardcoded',
      severity: 'warning',
      title: `“${h.text}”`,
      sources: { runtime: false, files: true },
      locales: [],
      fileRefs: [`${h.file}:${h.line}`],
      note: 'JSX text that never goes through i18n (heuristic).',
    });
  }

  // ---- stale keys: in some locale's JSON but not in the reference. One row per key,
  // with the set of locales carrying it — not one row per (locale, key).
  const staleByKey = new Map<string, Issue>();
  for (const [lng, keys] of Object.entries(report?.extra ?? {})) {
    for (const k of keys) {
      const existing = staleByKey.get(k);
      if (existing) {
        addLocale(existing, lng);
      } else {
        const issue: Issue = {
          id: `stale:${k}`,
          kind: 'stale',
          severity: 'warning',
          title: k,
          key: k,
          sources: { runtime: false, files: true },
          locales: [lng],
          fileRefs: [],
          note: `Not in ${report?.ref ?? 'the reference'} — either delete it or add the reference entry.`,
        };
        staleByKey.set(k, issue);
        issues.push(issue);
      }
    }
  }

  return issues.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'error' ? -1 : 1;
    const k = KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind);
    if (k !== 0) return k;
    return a.title.localeCompare(b.title);
  });
};

export const countIssues = (issues: Issue[]): IssueCounts => {
  const byKind: Record<IssueKind | 'all', number> = {
    all: issues.length,
    parse: 0,
    missing: 0,
    variables: 0,
    hardcoded: 0,
    stale: 0,
  };
  let errors = 0;
  let warnings = 0;
  for (const i of issues) {
    byKind[i.kind]++;
    if (i.severity === 'error') errors++;
    else warnings++;
  }
  return { errors, warnings, byKind };
};

/**
 * Gap list for one locale on the Languages tab: the union of what runtime saw falling
 * back (a capped sample) and what the scan found missing on disk. The scan side also
 * covers screens nobody has opened; the runtime side also covers lazily-loaded content
 * the scan's directory layout assumptions missed.
 */
export const localeGapKeys = (
  runtimeSample: string[],
  scanMissing: string[] | undefined,
): string[] => {
  const set = new Set(runtimeSample);
  for (const k of scanMissing ?? []) set.add(k);
  return [...set].sort();
};
