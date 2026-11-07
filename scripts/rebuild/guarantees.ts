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
  R518: { owner: 'ferrets', reason: "enforced by Ferrets' `GET /v1/events` stream (`fleet-events.ts` and its frame service); R519 stays the app client's" },
  R520: { owner: 'ferrets', reason: "enforced by Ferrets' `GET /v1/events` stream (`fleet-events.ts` and its frame service); R519 stays the app client's" },
  R521: { owner: 'ferrets', reason: "enforced by Ferrets' `GET /v1/events` stream (`fleet-events.ts` and its frame service); R519 stays the app client's" },
  R522: { owner: 'ferrets', reason: "enforced by Ferrets' `GET /v1/events` stream (`fleet-events.ts` and its frame service); R519 stays the app client's" },
  R523: { owner: 'ferrets', reason: "enforced by Ferrets' `GET /v1/events` stream (`fleet-events.ts` and its frame service); R519 stays the app client's" },
  R524: { owner: 'ferrets', reason: "enforced by Ferrets' `GET /v1/events` stream (`fleet-events.ts` and its frame service); R519 stays the app client's" },
  R525: { owner: 'ferrets', reason: "enforced by Ferrets' `GET /v1/events` stream (`fleet-events.ts` and its frame service); R519 stays the app client's" },
  R36: { owner: 'connections', reason: "enforced by Connections' direct carrier (admission, per-address bounds, caps, reservation, heartbeat)" },
  R37: { owner: 'connections', reason: "enforced by Connections' direct carrier (admission, per-address bounds, caps, reservation, heartbeat)" },
  R38: { owner: 'connections', reason: "enforced by Connections' direct carrier (admission, per-address bounds, caps, reservation, heartbeat)" },
  R39: { owner: 'connections', reason: "enforced by Connections' direct carrier (admission, per-address bounds, caps, reservation, heartbeat)" },
  R86: { owner: 'connections', reason: "enforced by Connections' direct carrier (admission, per-address bounds, caps, reservation, heartbeat)" },
  R88: { owner: 'app-shell', reason: "enforced by the app's browser session client (packages/app/src/session)" },
  R89: { owner: 'app-shell', reason: "enforced by the app's browser session client (packages/app/src/session)" },
  R506: { owner: 'app-shell', reason: "enforced by the app's browser session client (packages/app/src/session)" },
  R507: { owner: 'app-shell', reason: "enforced by the app's browser session client (packages/app/src/session)" },
  R519: { owner: 'app-shell', reason: "enforced by the app's browser session client (packages/app/src/session)" },
  R530: { owner: 'app-shell', reason: "enforced by the app's browser session client (packages/app/src/session)" },
  R531: { owner: 'app-shell', reason: "enforced by the app's browser session client (packages/app/src/session)" },
  R532: { owner: 'app-shell', reason: "enforced by the app's browser session client (packages/app/src/session)" },
  R567: { owner: 'app-shell', reason: "enforced by the app's browser session client (packages/app/src/session)" },
  R568: { owner: 'app-shell', reason: "enforced by the app's browser session client (packages/app/src/session)" },
  R112: { owner: 'conversation', reason: "enforced by Conversation's send ledger (app/chat/send-ledger.ts)" },
  S67: { owner: 'catalogs', reason: "the missing-secret judgement against a published fleet is Catalogs'" },
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
  I98: {
    owner: 'vault',
    reason:
      'enforced by the Vault sign-in lock (`LoginObserver.pageSteer`, `steerOf`); Browsers tells it what a page did',
  },
  G27: {
    owner: 'browsers',
    reason:
      "`POST /v1/system/open-url` is Browsers' (lead ruling guarantees-reown): its `OpenUrlService` validates the address, rations it and records `link.opened`; Gate keeps the `privilegedOnly` carrier check (G26) as a co-owner",
  },
  G56: {
    owner: 'access',
    reason:
      "the remote turn-off warning is Access's app half (`COARSE_SWITCH_ALSO_STOPS` in `app/lib/grants.ts`); the lead ruling named the app shell, but the shell holds no grants screen and cannot import a plugin, so the owner is the package that serves it; Gate keeps the grants contract as a co-owner",
  },
  G59: {
    owner: 'access',
    reason:
      "the `secrets` turn-off control is Access's app half (`remoteRevokeWarning`, `app/lib/grants.ts`); see G56 for why Access and not the app shell; Gate keeps the grants contract as a co-owner",
  },
  G95: {
    owner: 'access',
    reason:
      "the prompt gate is Access's app half (`StepUpGate`, `app/lib/step-up-gate.ts`, and `distinctDaemonName`, `app/shell-pairing.ts`, whose clause is OPEN until the step-up dialog is mounted: see OPEN_CLAUSES); see G56 for why Access and not the app shell; Gate keeps the step-up policy as a co-owner",
  },
  G33: {
    owner: 'conversation',
    reason:
      "the composer action is Conversation's (design D2 #7, lead ruling port-conversation r1 #5): it acts on the draft Conversation holds; Terminals types it and Gate checks terminal/use, so both stay co-owners",
  },
  G164: {
    owner: 'conversation',
    reason:
      "the log and work searches are Conversation's (lead ruling, port-conversation r2 #8): it matches on scrubbed text and cuts every snippet from it; the Kernel logs and the Vault redaction stay co-owners",
  },
  G66: {
    owner: 'catalogs',
    reason:
      "the download-link routes are Catalogs' (Gate R2 ruling): its handlers refuse a ferret every act but list and read (403 forbidden); Gate's descriptor check stays a co-owner",
  },
  G167: {
    owner: 'agenda',
    reason: 'POST /v1/push/seen moved to Agenda (DECISIONS-1 #4); Agenda computes the seen outcome',
  },
  G76: {
    owner: 'access',
    reason:
      "per-device unlocks are Access's `state/unlocks.json` (`StateUnlockLedger`, read back by `StepUpService.restore`); Gate keeps the unlock policy",
  },
  G86: {
    owner: 'access',
    reason:
      "the standing-rule options route is Access's `POST /v1/step-up/options` (`stepUpRoutes`): it answers only the device the stage waits on; Gate keeps the step-up policy",
  },
  G102: {
    owner: 'access',
    reason:
      "the passkey registration window is Access's (`StepUpService.registrationOptions`/`register`/`reopenRegistration`); Gate keeps the step-up policy",
  },
  G137: {
    owner: 'access',
    reason:
      "a full code needs a device holding everything: Access's `pairingRoutes` mint refuses it from the device half (`DeviceGrantService`); Gate keeps the daemon-wide half",
  },
  G141: {
    owner: 'access',
    reason:
      "the kept half is Access's device document (`StatePairingRepository`, `DevicesFile`): malformed grants fail the document closed and every write carries grants; Gate keeps the daemon-wide half",
  },
};

/**
 * A clause of a kept row that is NOT delivered yet, and the item that delivers it (review guarantees-reown r1 #4). The
 * row stays with its owner; the ledger and the port brief carry the clause as an OPEN note beside it, so a green row is
 * not read as a finished one.
 */
export const OPEN_CLAUSES: Record<string, string> = {
  G95: "OPEN: 'Same-named machines are told apart by address' is ported as a helper (distinctDaemonName, tested) but is not shown on screen until the item that mounts Access's StepUpDialog passes it as machineName; nothing mounts the dialog yet, so that clause stays unticked",
};

/**
 * Appendix D rows the ledger splits into one row per ROUTE (lead ruling guarantees-reown: each route is owned by the
 * plugin that serves it, and each has its own test named with its id). The appendix keeps its one row; the ledger
 * (`guarantees.tsv`) carries these instead, so the appendix totals (1,215 = 1,158 + 26 + 31) still hold.
 */
export const ROW_SPLITS: Record<string, readonly { id: string; owner: string; route: string; what: string }[]> = {
  G128: [
    {
      id: 'G128a',
      owner: 'accounts',
      route: 'POST /v1/ferrets/:ferretId/task-plans/:planId/revoke',
      what: 'plan revoke',
    },
    { id: 'G128b', owner: 'accounts', route: 'POST /v1/sign-in-rules/:id/narrow', what: 'sign-in rule narrow' },
    { id: 'G128c', owner: 'accounts', route: 'DELETE /v1/sign-in-rules/:id', what: 'sign-in rule revoke' },
    {
      id: 'G128d',
      owner: 'accounts',
      route: 'POST /v1/accounts/:id/sign-in-rules/revoke',
      what: 'revoking every sign-in rule of an account',
    },
    { id: 'G128e', owner: 'accounts', route: 'DELETE /v1/copy-rules/:ruleId', what: 'paste-rule delete' },
    { id: 'G128f', owner: 'accounts', route: 'DELETE /v1/copy-rules/stages/:stage', what: 'paste-rule drop' },
    { id: 'G128g', owner: 'accounts', route: 'PUT /v1/accounts/defaults', what: 'removing a default account' },
    { id: 'G128h', owner: 'access', route: 'DELETE /v1/pair/devices/:deviceId', what: 'device revoke' },
    { id: 'G128i', owner: 'access', route: 'PATCH /v1/pair/devices/:deviceId/grants', what: 'device grants `PATCH`' },
  ],
};

/** The ledger's rows: the Appendix D rows, with every {@link ROW_SPLITS} row replaced by its per-route rows. */
export function ledgerRows(appendix: readonly Row[]): Row[] {
  return appendix.flatMap(row => {
    const open = OPEN_CLAUSES[row.id];
    const parts = ROW_SPLITS[row.id];
    if (parts === undefined)
      return [open === undefined ? row : { ...row, notes: [row.notes, open].filter(note => note !== '').join('; ') }];
    return parts.map(part => ({
      ...row,
      id: part.id,
      owner: part.owner,
      with: [...new Set([row.owner, ...row.with].filter(x => x !== part.owner))],
      test: part.id,
      guarantee: `${part.what} (\`${part.route}\`) is a narrowing: never needs a step-up beyond today's. ${row.guarantee}`,
    }));
  });
}

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
  const parsed = parseAppendixD(readFileSync(src, 'utf8'));
  const { gaps } = parsed;
  const rows = ledgerRows(parsed.rows);
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
  for (const r of parsed.rows) st[r.status]++;
  console.log(
    `appendix rows ${parsed.rows.length} (stated 1215); kept ${st.kept}/1158 split ${st.split}/26 removed ${st.removed}/31; declared gaps ${gaps} (stated 161); ledger rows ${rows.length} (${rows.length - parsed.rows.length} more from ROW_SPLITS)`,
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
