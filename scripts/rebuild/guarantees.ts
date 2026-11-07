// Parses Appendix D of docs/design/redesign.md into docs/rebuild/guarantees.tsv.
// usage: bun scripts/rebuild/guarantees.ts [design-doc] [out.tsv]
//   columns: id status owner-package with-packages enforcer doc test-name
// Prints counts per status and per owner and checks them against the totals the appendix states.
import { readFileSync, writeFileSync } from 'node:fs';

export type Status = 'kept' | 'split' | 'removed';
export interface Row {
  id: string;
  status: Status;
  owner: string;
  with: string[];
  enforcer: string;
  doc: string;
  test: string;
  guarantee: string;
  section: string;
  notes: string;
  removedPart: string;
  keptByRaw: string;
}

/** The 31 subsystems (§8) plus the declared non-package owners. */
export const PACKAGES = [
  'kernel',
  'gate',
  'vault',
  'ferrets',
  'asks',
  'access',
  'connections',
  'updates',
  'terminals',
  'browsers',
  'claude-code',
  'codex',
  'logins',
  'runtimes',
  'accounts',
  'conversation',
  'agenda',
  'projects',
  'board',
  'packs',
  'warden',
  'usage',
  'lessons',
  'voice',
  'catalogs',
  'mcp',
  'skills',
  'shells',
  'layouts',
  'onboarding',
  'tidy',
] as const;
export const NON_PACKAGE = ['fy-shell', 'repo-tooling'] as const;

// Owner words in the table -> package id. Order matters only for overlapping prefixes (none overlap).
const WORDS: [RegExp, string][] = [
  [/Claude Code \/ Codex/, 'claude-code,codex'],
  [/\bKernel\b/, 'kernel'],
  [/\bGate\b/, 'gate'],
  [/\bVault\b/, 'vault'],
  [/\bFerrets\b/, 'ferrets'],
  [/\bAsks\b/, 'asks'],
  [/\bAccess\b/, 'access'],
  [/\bConnections\b/, 'connections'],
  [/\bTerminals\b/, 'terminals'],
  [/\bBrowsers\b/, 'browsers'],
  [/\bAccounts\b/, 'accounts'],
  [/\bConversation\b/, 'conversation'],
  [/\bAgenda\b/, 'agenda'],
  [/\bCatalogs\b/, 'catalogs'],
  [/\bMCP\b/, 'mcp'],
  [/\bSkills\b/, 'skills'],
  [/\bVoice\b/, 'voice'],
  [/\bLogins\b/, 'logins'],
  [/\bUsage\b/, 'usage'],
  [/`fy` (?:shell|CLI)/, 'fy-shell'],
  [/Repo tooling/, 'repo-tooling'],
];

export function normaliseOwner(raw: string): { owner: string; with: string[]; workers: string[] } {
  const workers: string[] = [];
  if (/link-store Worker/.test(raw)) workers.push('worker:catalogs-link-store');
  else if (/relay Worker/.test(raw)) workers.push('worker:relay');
  const cleaned = raw; // the design counts "on the Kernel session layer" and "+ relay Worker" as a second named package (411 fixture rows)
  const hits: { at: number; ids: string[] }[] = [];
  for (const [re, ids] of WORDS) {
    const m = re.exec(cleaned);
    if (m) hits.push({ at: m.index, ids: ids.split(',') });
  }
  hits.sort((a, b) => a.at - b.at);
  let ids = hits.flatMap(h => h.ids);

  // "Terminals ... (with Accounts rules, Vault)" etc: all named packages are collected in order of appearance.
  ids = [...new Set(ids)];
  if (ids.length === 0 && workers.length) ids = ['connections'];
  if (ids.length === 0) throw new Error(`cannot map owner: ${raw}`);
  const [owner, ...rest] = ids;
  return { owner: owner!, with: [...rest, ...workers], workers };
}

/** REMOVED rows name no owner. Assigned by hand from the row text (documented in docs/rebuild/ports/README.md). */
export const REMOVED_OWNER: Record<string, string> = {
  G69: 'access',
  G70: 'access',
  G71: 'access',
  G72: 'access',
  G104: 'gate',
  G142: 'access',
  G168: 'access',
  P67: 'gate',
  P129: 'access',
  I181: 'accounts',
  I189: 'accounts',
  I194: 'accounts',
  I209: 'accounts',
  I219: 'accounts',
  S55: 'gate',
  S56: 'gate',
  S69: 'accounts',
  S71: 'accounts',
  S72: 'accounts',
  S74: 'accounts',
  S75: 'accounts',
  S133: 'accounts',
  R175: 'connections',
  R176: 'connections',
  R177: 'connections',
  R178: 'connections',
  R179: 'connections',
  R180: 'connections',
  R181: 'connections',
  R191: 'connections',
  R611: 'catalogs',
};

/**
 * The owner IS the enforcer (§3.9 guarantee-owner; lead decision 2026-11-07). Rows the table assigns to one package
 * whose enforcer lives in another are moved to the enforcer, with the reason. Tests live with the enforcer.
 */
export const OWNER_OVERRIDE: Record<string, { owner: string; reason: string }> = {
  R238: { owner: 'kernel', reason: 'enforced by the kernel session layer (pre-auth device proof cost)' },
  R241: { owner: 'kernel', reason: 'enforced by the kernel session layer' },
  R244: { owner: 'kernel', reason: 'enforced by the kernel session layer' },
  R245: { owner: 'kernel', reason: 'enforced by the kernel session layer' },
  R247: { owner: 'kernel', reason: 'enforced by the kernel session layer' },
  R540: { owner: 'kernel', reason: 'enforced by the kernel session layer' },
  R572: { owner: 'kernel', reason: 'enforced by the kernel session layer' },
  P24: { owner: 'connections', reason: 'enforced by the Connections relay client (browser carrier walk)' },
  P29: { owner: 'connections', reason: 'enforced by the Connections relay client (browser carrier walk)' },
  P30: { owner: 'connections', reason: 'enforced by the Connections relay client (browser carrier walk)' },
  P31: { owner: 'connections', reason: 'enforced by the Connections relay client (browser carrier walk)' },
  P135: { owner: 'connections', reason: 'enforced by the Connections relay client (browser carrier walk)' },
  R570: { owner: 'connections', reason: 'enforced by the Connections relay client (browser carrier walk)' },
  R582: { owner: 'connections', reason: 'enforced by the Connections relay client (browser carrier walk)' },
  R633: { owner: 'connections', reason: 'enforced by the Connections relay client (browser carrier walk)' },
  P28: { owner: 'app-shell', reason: 'enforced by the app shell device store' },
  R575: { owner: 'app-shell', reason: 'enforced by the app shell device store' },
  G167: {
    owner: 'agenda',
    reason: 'POST /v1/push/seen moved to Agenda (DECISIONS-1 #4); Agenda computes the seen outcome',
  },
};

const cells = (line: string): string[] =>
  line
    .replace(/^\|/, '')
    .replace(/\|\s*$/, '')
    .split(/(?<!\\)\|/)
    .map(c => c.trim().replace(/\\\|/g, '|'));

export function parseAppendixD(markdown: string): { rows: Row[]; gaps: number; stated: Record<string, number> } {
  const start = markdown.indexOf('## Appendix D.');
  const d2 = markdown.indexOf('#### D.2');
  const body = markdown.slice(start, d2);
  const stated = { total: 1215, kept: 1158, split: 26, removed: 31 };
  let doc = '';
  const rows: Row[] = [];
  for (const line of body.split('\n')) {
    const h = /^\*\*([a-z-]+\.md)\*\*$/.exec(line);
    if (h) {
      doc = h[1]!;
      continue;
    }
    if (!/^\| [A-Z]+\d+ /.test(line)) continue;
    const c = cells(line);
    if (c.length !== 4) throw new Error(`row with ${c.length} cells: ${line.slice(0, 80)}`);
    const [id, guarantee, section, keptBy] = c as [string, string, string, string];
    let status: Status;
    let ownerRaw = '';
    let enforcer = '-';
    let notes = '';
    let test = '';
    let removedPart = '';
    if (keptBy.startsWith('REMOVED')) {
      status = 'removed';
      test = '-';
      removedPart = keptBy;
    } else if (keptBy.startsWith('SPLIT')) {
      status = 'split';
      const m = /^SPLIT\. Kept: (.*) · ([^·]+?) · test `([^`]+)`\. Removed: (.*)$/.exec(keptBy);
      if (!m) throw new Error(`unparsable SPLIT ${id}: ${keptBy}`);
      ownerRaw = m[2]!;
      test = m[3]!;
      removedPart = m[4]!;
    } else {
      status = 'kept';
      const segs = keptBy.split(' · ');
      const t = /^test `([^`]+)`$/.exec(segs[segs.length - 1]!);
      if (!t) throw new Error(`no test in ${id}: ${keptBy}`);
      test = t[1]!;
      ownerRaw = segs[0]!;
      if (segs.length === 3) enforcer = segs[1]!;
      else if (segs.length === 4) {
        enforcer = segs[1]!;
        notes = segs[2]!;
      } else throw new Error(`unexpected segments in ${id}: ${keptBy}`);
    }
    let owner: string;
    let w: string[] = [];
    if (status === 'removed') {
      owner = REMOVED_OWNER[id] ?? '';
      if (!owner) throw new Error(`no owner for removed ${id}`);
    } else {
      const n = normaliseOwner(ownerRaw);
      owner = n.owner;
      // A second PACKAGE is a co-owner only where the table says so: kept rows carry the "integration fixture" note
      // exactly then (411 rows); SPLIT rows carry no notes, so every package named counts. Workers are always recorded.
      const others = n.with.filter(x => !x.startsWith('worker:'));
      const co = status === 'split' || /integration fixture/.test(notes) ? others : [];
      w = [...co, ...n.workers];
      if (id === 'R662' || id === 'R675') w = ['connections']; // "pairing refused by carrier tag": the tag is Connections'
      const ovr = OWNER_OVERRIDE[id];
      if (ovr) {
        w = [...new Set([owner, ...w].filter(x => x !== ovr.owner))];
        owner = ovr.owner;
      }
    }
    rows.push({
      id,
      status,
      owner,
      with: w,
      enforcer,
      doc: doc.replace(/\.md$/, ''),
      test,
      guarantee,
      section,
      notes,
      removedPart,
      keptByRaw: keptBy,
    });
  }
  const gapsText = markdown.slice(d2);
  const gaps = (gapsText.match(/^\| [a-z-]+\.md +\|/gm) ?? []).length;
  return { rows, gaps, stated };
}

if (import.meta.main) {
  const [src = 'docs/design/redesign.md', out = 'docs/rebuild/guarantees.tsv'] = process.argv.slice(2);
  const { rows, gaps } = parseAppendixD(readFileSync(src, 'utf8'));
  const tsv = [
    'id\tstatus\towner\twith\tenforcer\tdoc\ttest',
    ...rows.map(r =>
      [r.id, r.status, r.owner, r.with.join(',') || '-', r.enforcer.replace(/\t/g, ' '), r.doc, r.test].join('\t'),
    ),
  ];
  writeFileSync(out, tsv.join('\n') + '\n');
  const by = (f: (r: Row) => string): string => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(f(r), (m.get(f(r)) ?? 0) + 1);
    return [...m]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
  };
  const st = { kept: 0, split: 0, removed: 0 };
  for (const r of rows) st[r.status]++;
  console.log(
    `rows ${rows.length} (stated 1215); kept ${st.kept}/1158 split ${st.split}/26 removed ${st.removed}/31; declared gaps ${gaps} (stated 161)`,
  );
  console.log('ids unique:', new Set(rows.map(r => r.id)).size === rows.length);
  console.log(
    'per status:',
    by(r => r.status),
  );
  console.log(
    'per owner:',
    by(r => r.owner),
  );
  console.log(
    'rows with co-owners:',
    rows.filter(r => r.with.some(x => !x.startsWith('worker:'))).length,
    ' integration-fixture notes:',
    rows.filter(r => /integration fixture/.test(r.notes)).length,
    ' rows with workers:',
    rows.filter(r => r.with.some(x => x.startsWith('worker:'))).length,
  );
  console.log(
    'per doc:',
    by(r => r.doc),
  );
  console.log(
    'tests named != id:',
    rows
      .filter(r => r.status !== 'removed' && r.test !== r.id)
      .map(r => `${r.id}->${r.test}`)
      .join(' ') || 'none',
  );
}
