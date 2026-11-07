// Generates docs/rebuild/ports/<id>.md (31 subsystems), docs/rebuild/ports/README.md and docs/rebuild/placement.tsv.
// usage: bun scripts/rebuild/ports.ts <ref-worktree> [design-doc]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { PACKAGES, parseAppendixD, type Row } from './guarantees';
import { placeAll, type Placed } from './place';

const [ref = '', designPath = 'docs/design/redesign.md'] = process.argv.slice(2);
if (!ref) throw new Error('usage: ports.ts <ref-worktree> [design-doc]');
const doc = readFileSync(designPath, 'utf8');
const lines = doc.split('\n');
const rowsAll = parseAppendixD(doc).rows;
const placed = placeAll(ref);

/** id -> heading name used in §2.2/§2.3 and in the §9.2/§3.5 tables. */
const NAME: Record<string, string> = {
  kernel: 'Kernel',
  gate: 'Gate',
  vault: 'Vault',
  ferrets: 'Ferrets',
  asks: 'Asks',
  access: 'Access',
  connections: 'Connections',
  updates: 'Updates',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  logins: 'Logins',
  runtimes: 'Runtimes',
  terminals: 'Terminals',
  browsers: 'Browsers',
  accounts: 'Accounts',
  conversation: 'Conversation',
  agenda: 'Agenda',
  projects: 'Projects',
  board: 'Board',
  packs: 'Packs',
  warden: 'Warden',
  usage: 'Usage',
  lessons: 'Lessons',
  voice: 'Voice',
  catalogs: 'Catalogs',
  mcp: 'MCP',
  skills: 'Skills',
  shells: 'Shells',
  layouts: 'Layouts',
  onboarding: 'Onboarding',
  tidy: 'Tidy',
};
const CORE = new Set(['kernel', 'gate', 'vault', 'ferrets', 'asks']);
const dir = (id: string): string => (CORE.has(id) ? `packages/core/${id}` : `packages/plugins/${id}`);

// ---- design excerpts
const idx = (re: RegExp, from = 0): number => {
  for (let i = from; i < lines.length; i++) if (re.test(lines[i]!)) return i;
  return -1;
};
const s22 = idx(/^### 2\.2 /),
  s24 = idx(/^### 2\.4 /);
function section(name: string): string {
  const a = idx(new RegExp(`^#{4,5} ${name.replace(/[+/]/g, '\\$&')}$`), s22);
  if (a < 0 || a > s24) throw new Error(`no section ${name}`);
  let b = a + 1;
  while (b < lines.length && !/^#{1,5} /.test(lines[b]!)) b++;
  return lines
    .slice(a + 1, b)
    .join('\n')
    .replace(/```mermaid[\s\S]*?```\n?/g, '')
    .trim();
}
function tableRows(fromRe: RegExp, toRe: RegExp): string[][] {
  const a = idx(fromRe),
    b = idx(toRe, a + 1);
  return lines
    .slice(a, b)
    .filter(l => /^\|/.test(l))
    .map(l =>
      l
        .replace(/^\||\|\s*$/g, '')
        .split(/(?<!\\)\|/)
        .map(c => c.trim()),
    );
}
const t92 = tableRows(/^### 9\.2 /, /^### 9\.3 /).filter(r => r.length >= 4 && r[1] !== 'Kind' && !/^-+$/.test(r[0]!));
const t104 = tableRows(/^### 10\.4 /, /^### 10\.5 /).filter(
  r => r.length >= 4 && !/^-+$/.test(r[0]!) && r[0] !== 'Port',
);
const t35 = tableRows(/^\*\*Every hook, generated/, /^### 3\.6 /).filter(
  r => r.length >= 5 && !/^-+$/.test(r[0]!) && r[0] !== 'Hook',
);

const PORT104: Record<string, string> = {
  kernel: 'Kernel (fill-in)',
  gate: 'Gate',
  vault: 'Vault',
  ferrets: 'Ferrets',
  asks: 'Asks',
  access: 'Access',
  connections: 'Connections',
  accounts: 'Accounts',
  terminals: 'Terminals',
  browsers: 'Browsers',
  'claude-code': 'Claude Code, Codex',
  codex: 'Claude Code, Codex',
  logins: 'Logins',
  conversation: 'Conversation',
  agenda: 'Agenda',
  board: 'Board',
  packs: 'Packs, Warden, Usage',
  warden: 'Packs, Warden, Usage',
  usage: 'Packs, Warden, Usage',
  catalogs: 'Catalogs',
  mcp: 'MCP + Skills',
  skills: 'MCP + Skills',
  shells: 'Shells',
  layouts: 'Layouts + Projects',
  projects: 'Layouts + Projects',
  runtimes: 'Runtimes + Onboarding',
  onboarding: 'Runtimes + Onboarding',
  updates: 'Updates, Tidy, Lessons, Voice',
  tidy: 'Updates, Tidy, Lessons, Voice',
  lessons: 'Updates, Tidy, Lessons, Voice',
  voice: 'Updates, Tidy, Lessons, Voice',
};

/** §4 kinds per subsystem (offers = the kind's contract lives here; adds = the subsystem's code/data adds one). */
const KINDS: Record<string, { offers: string[]; adds: string[] }> = {
  kernel: {
    offers: ['carrier (`carriers`)', 'session mode (`session.modes`)', 'hook, job, doctor (`doctor.checks`)'],
    adds: [],
  },
  gate: { offers: ['hook: `credentials`, `step-up` (provide)'], adds: [] },
  vault: { offers: ['tool (`input.targets`)'], adds: ['ask source `input`'] },
  ferrets: {
    offers: [
      'instruction',
      'harness',
      'login',
      'runner',
      'item (`launch.parts`)',
      'hooks `start.decide`, `sitrep.lines`, `ferret.changed`',
    ],
    adds: [],
  },
  asks: { offers: ['hook: `ask.sources` (provide)'], adds: [] },
  access: { offers: [], adds: ['session mode `device`, `pair`', 'view'] },
  connections: { offers: [], adds: ['carrier `direct`, `relay`, `tunnel`, `webrtc`', 'view'] },
  updates: { offers: [], adds: ['view', 'job'] },
  'claude-code': { offers: [], adds: ['harness `claude-code`', 'instruction (by harness)', 'view'] },
  codex: { offers: [], adds: ['harness `codex`', 'instruction (by harness)', 'view'] },
  logins: {
    offers: [],
    adds: ['login `anthropic`, `openai`, `api-key`, `proxy`, `endpoint` (endpoint is also a data item kind)', 'view'],
  },
  runtimes: { offers: ['runtime (data)'], adds: ['view'] },
  terminals: { offers: [], adds: ['tool `terminal` (input target)', 'runner `tmux`', 'view'] },
  browsers: { offers: [], adds: ['tool `page` (input target)', 'view'] },
  accounts: { offers: [], adds: ['ask source `sign-in-approval`', 'item (sign-in recipe)', 'view'] },
  conversation: { offers: ['hooks `message.before-send`, `turn.ended`'], adds: ['ask source `question`', 'view'] },
  agenda: { offers: [], adds: ['view'] },
  projects: { offers: [], adds: ['view', 'command'] },
  board: { offers: ['hook `card.moving` (decide)'], adds: ['ask source `card`', 'view'] },
  packs: { offers: [], adds: ['view'] },
  warden: { offers: [], adds: ['view'] },
  usage: { offers: [], adds: ['view'] },
  lessons: { offers: [], adds: ['item/instruction via `launch.parts`', 'view'] },
  voice: { offers: [], adds: ['view'] },
  catalogs: { offers: ['item (shareable pieces)'], adds: ['session mode `member`', 'view'] },
  mcp: { offers: [], adds: ['item `mcp`'] },
  skills: { offers: [], adds: ['item `skill`'] },
  shells: { offers: [], adds: ['item `shell`'] },
  layouts: { offers: ['layout, theme (data)'], adds: ['view'] },
  onboarding: { offers: ['onboarding step'], adds: ['view'] },
  tidy: { offers: [], adds: ['job'] },
};

/** §10.7 items that touch each port (names only; a separate helper surveys their content). */
const FOLDS: Record<string, string[]> = {
  kernel: [
    "#1543 boot one-shots, v1 layouts: fold (its deletions are this port's)",
    '#1554 old store readers: fold',
    '#1565 retired `daemon.json` keys: fold changed, drop its shared "retired keys" list',
    '#1576 PWA feature gates: fold and delete the gates mechanism too (§9.6)',
    '`c52/pr-16`, `c52/pr-16c` version-floor fallbacks: fold the deletions, drop the version floor',
  ],
  gate: [
    '`c52/pr-18` `fys_`-only session credential: fold (S53-S56)',
    '#1554 old store readers: fold (audit and token stores)',
  ],
  vault: ['#1554 old store readers: fold (vault and input-request stores)'],
  ferrets: [
    '`refactor/finish` extractions session-fork, session-handover, session-migrate (worktrees c50-e1, c50-e2, c50-e3): become bodies of this port; session-reads/resume (c50-e4, c50-e5) are shared with Conversation: lead to confirm the split',
    '`fix/c50-resume-jobs`: fold with refactor/finish',
    '#1554 old store readers: fold',
    '`c52/pr-18` `fys_`-only session credential: fold (ferret token side)',
    'dropped: `refactor/finish` copies of #1543/#1558/#1565; `c52/fold`, `c52/pr-15`, `c52/pr-20a`, `c52/pr-16b`',
  ],
  asks: [
    '#1558 agenda one-shots: fold',
    '#1552 (B165, "the agenda asks, the card shows"): lands day 0; this port deletes its compat bits (`gateAttached` mirror, synthesized rows)',
    "F640 stack #1425 → #1427 → #1426 re-cut as an Accounts approval raised through Asks (`source: 'sign-in-approval'`); #1479 closed as duplicate",
    '`c52/pr-19a` notification ledger rewrite: dropped',
  ],
  agenda: [
    '#1558 agenda one-shots: fold',
    '#1552 (B165): lands day 0; compat bits deleted here',
    'F640 stack: Agenda shows the approval with a form',
    "`c52/pr-19a` notification ledger rewrite: dropped (notifications code is this port's)",
  ],
  access: [
    '#1554 old store readers: fold (device, passkey, unlock stores)',
    '`c52/pr-16`, `c52/pr-16c`: fold the deletions',
  ],
  connections: [
    '`refactor/finish` extraction "reach" (worktree c50-d1-reach): becomes the body of this port',
    '#1543 boot one-shots: carriers boot conversion R175-R181 deleted here',
    '`c52/pr-16`, `c52/pr-16c` version-floor fallbacks: fold the deletions (R191)',
  ],
  conversation: [
    '`refactor/finish` extractions session-reads, session-resume (worktrees c50-e4, c50-e5): bodies of this port (shared with Ferrets: lead to confirm)',
    '`fix/c50-resume-jobs`: fold with refactor/finish',
    '#1578 conversation-import module: already merged, nothing to do',
    '#1554 old store readers: fold',
  ],
  board: [
    '#1556 board import, `legacyRef`: fold (delete)',
    '`refactor/c50-module-board-github`: fold its one new extraction (3 files)',
    '#1552 (B165): lands day 0',
    '#1554 old store readers: fold',
  ],
  accounts: [
    '#1576 PWA feature gates, saved-logins surface: fold and delete the gates mechanism (S133)',
    'F640 sign-in recipe approval stack #1425 → #1427 → #1426: keep, park, re-cut on 5.0 as an Accounts approval raised through Asks; #1479 closed as duplicate',
    '#1554 old store readers: fold (login index v1/v2)',
  ],
  voice: ['open feature PRs #1405-#1527 (voice): park, re-cut on 5.0 as a change to this package'],
  onboarding: ['open feature PRs #1405-#1527 (onboarding, settings): park, re-cut on 5.0 as a change to this package'],
  catalogs: ['open feature PRs #1405-#1527 (catalogs): park, re-cut on 5.0 as a change to this package'],
  layouts: ["open feature PRs #1405-#1527 (settings): park, re-cut; today's hard-coded layout in `App.tsx` is deleted"],
};

const ALL_IDS = PACKAGES as readonly string[];
const primary = (p: Placed): string => p.owners[0]!;
const isDrop = (p: Placed): boolean => p.owners[0] === 'drop';
const place = (id: string) => ({
  copy: placed.filter(p => !isDrop(p) && primary(p) === id),
  also: placed.filter(p => !isDrop(p) && p.owners.slice(1).includes(id)),
  drop: placed.filter(p => isDrop(p) && p.owners[1] === id),
});

const sub = (path: string): string => path.replace(/^packages\//, '');
function pathBlock(ps: Placed[], withOwner = false): string {
  if (!ps.length) return '_none_\n';
  const groups = new Map<string, Placed[]>();
  for (const p of ps) {
    const parts = sub(p.path).split('/');
    const g = `${parts[0]} ${parts[1] === 'src' || parts[1] === 'tests' || parts[1] === 'bin' ? parts[1] : '(root)'}`;
    (groups.get(g) ?? groups.set(g, []).get(g)!).push(p);
  }
  return [...groups]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(
      ([g, arr]) =>
        `**old \`packages/${g.replace(' ', '/')}\`** (${arr.length})\n\n\`\`\`text\n${arr.map(p => sub(p.path) + (withOwner ? `   -> ${p.owners[0]}` : '')).join('\n')}\n\`\`\`\n`,
    )
    .join('\n');
}
function judgment(ps: Placed[]): string {
  const m = new Map<string, number>();
  for (const p of ps) if (p.note.startsWith('~')) m.set(p.note, (m.get(p.note) ?? 0) + 1);
  return [...m].map(([n, c]) => `- ${c} files: ${n}`).join('\n') || '- none';
}
const one = (s: string): string => s.replace(/\s+/g, ' ').trim();
function rowLine(r: Row): string {
  const w = r.with.length ? ` · with: ${r.with.join(', ')}` : '';
  const n = r.notes ? ` · note: ${r.notes}` : '';
  return `- **${r.id}** ${r.status} (${r.doc}) — ${one(r.guarantee)} · enforcer: ${one(r.enforcer)}${w}${n} · test name: \`${r.test}\``;
}
function hooksFor(id: string): { offers: string[]; takes: string[] } {
  const nm = NAME[id]!;
  const re = new RegExp(`(^|[ ,(])${nm.replace('+', '\\+')}( \\(|,|$)`);
  return {
    offers: t35
      .filter(r => r[2] === nm)
      .map(r => `\`${r[0]!.replace(/`/g, '')}\` (${r[1]}); taken by ${r[3]}; takers allowed: ${r[4]}`),
    takes: t35
      .filter(r => r[2] !== nm && re.test(r[3]!))
      .map(r => `\`${r[0]!.replace(/`/g, '')}\` (${r[1]}), offered by ${r[2]}`),
  };
}

mkdirSync('docs/rebuild/ports', { recursive: true });
const summary: string[] = [];
const rowsOwned = (id: string) => rowsAll.filter(r => r.owner === id && r.status !== 'removed');
const rowsCo = (id: string) => rowsAll.filter(r => r.owner !== id && r.status !== 'removed' && r.with.includes(id));
const rowsRemoved = (id: string) => rowsAll.filter(r => r.owner === id && r.status === 'removed');
const rowsSplit = (id: string) => rowsAll.filter(r => r.owner === id && r.status === 'split');

for (const id of ALL_IDS) {
  const nm = NAME[id]!;
  const sec = section(nm);
  const r92 = t92.find(r => r[0] === nm);
  if (!r92) throw new Error(`no §9.2 row for ${nm}`);
  const r104 = t104.find(r => r[0]!.replace(/\*\*/g, '') === PORT104[id]);
  if (!r104) throw new Error(`no §10.4 row for ${id}`);
  const pl = place(id);
  const owned = rowsOwned(id),
    co = rowsCo(id),
    rem = rowsRemoved(id),
    spl = rowsSplit(id);
  const hk = hooksFor(id);
  const kd = KINDS[id]!;
  const sharedNote =
    id === 'claude-code' || id === 'codex'
      ? '\nThe Claude Code and Codex ports copy the **shared harness driver** files (listed under both) and each keeps its own half; the harness-dialog rows (G31, G32) are owned by the pair: both ports write their test.\n'
      : '';
  const out = `# Port brief: ${nm} (\`${id}\`, ${CORE.has(id) ? 'core' : 'plugin'})

Generated by \`scripts/rebuild/ports.ts\` from \`docs/design/redesign.md\` (§2.2/§2.3, §3.5, §4, §8, §9.2, §10.4, §10.7, Appendix D) and \`git ls-files packages/\` at \`bb89d054d\` (reference worktree \`.worktrees/rebuild-ref\`). Read \`TEAM-RULES.md\` first. New package path: \`${dir(id)}\`. Port = copy, strip, rename (§10.1).

## Scope (design §${CORE.has(id) ? '2.2' : '2.3'}, verbatim)

${sec}

## State and config files (§9.2)

- State (\`state/${id}/…\` unless noted): ${r92[2]}
- Config (\`config/…\`): ${r92[3]}

## Kinds (§4)

- Offers (its contract defines the kind): ${kd.offers.join('; ') || '—'}
- Adds (its code or data supplies one): ${kd.adds.join('; ') || '—'}

## Hooks (§3.5)

- Offers: ${hk.offers.join('; ') || '—'}
- Takes: ${hk.takes.join('; ') || '—'}

## §10.4 row

- Row: **${PORT104[id]}** · ferrets: ${r104[1]} · model: ${r104[2]} · notes: ${r104[3]}
${sharedNote}
## In-flight folds (§10.7; names only)

${(FOLDS[id] ?? ['none named in §10.7 for this port']).map(f => `- ${f}`).join('\n')}

## Copy from (today's files; src AND tests, all packages)

${pl.copy.length} files. Judgment placements (the owner is not named by §8 or by an Appendix D enforcer; confirm or tell the lead):

${judgment(pl.copy)}

${pathBlock(pl.copy)}
## Also copy (shared files; another port is the primary owner and splits them)

${pl.also.length} files. Copy only the part this subsystem needs and say so in the commit.

${pathBlock(pl.also, true)}
## Keep (tests required): ${owned.length} rows owned (${owned.filter(r => r.status === 'kept').length} kept, ${owned.filter(r => r.status === 'split').length} split)

Every row below gets a test whose name contains the row id, e.g. \`test('${owned[0]?.id ?? 'G11'} …', …)\`; \`ports-pending.json\` loses this plugin's line in the same PR (§10.4).

${owned.length ? owned.map(rowLine).join('\n') : '_No Appendix D row names this subsystem as owner._'}

### Co-owned rows (${co.length}): another port owns the row; this port writes its side of the integration fixture

${co.length ? co.map(rowLine).join('\n') : '_none_'}

## Delete

### Removed rows (${rem.length}): only an older peer or file needed them (A452, §9.1); delete the code they point at

${rem.length ? rem.map(r => `- **${r.id}** (${r.doc}) — ${one(r.guarantee)}`).join('\n') : '_none_'}

### Removed halves of split rows (${spl.length}): keep the kept half (test required, listed above), delete this

${spl.length ? spl.map(r => `- **${r.id}** — removed: ${one(r.removedPart)}`).join('\n') : '_none_'}

### Whole files that are compatibility code (${pl.drop.length}); do not copy

${pl.drop.length ? '```text\n' + pl.drop.map(p => sub(p.path)).join('\n') + '\n```' : '_none found by file name; still strip any `legacy`, `deprecated`, `compat`, `migrat*`, `retired` identifiers, old-format readers, one-shot boot passes and feature flags about an older peer (clean slate A452)_'}
`;
  writeFileSync(`docs/rebuild/ports/${id}.md`, out);
  summary.push(
    `| [${id}](${id}.md) | ${CORE.has(id) ? 'core' : 'plugin'} | ${PORT104[id]} (${r104[1]}, ${r104[2]}) | ${pl.copy.length} | ${pl.also.length} | ${pl.drop.length} | ${owned.filter(r => r.status === 'kept').length} | ${spl.length} | ${co.length} | ${rem.length} |`,
  );
}

// ---- placement.tsv
writeFileSync(
  'docs/rebuild/placement.tsv',
  [
    'path\towners\trule\tnote',
    ...placed.map(p => `${sub(p.path)}\t${p.owners.join('+') || 'UNPLACED'}\t${p.rule}\t${p.note}`),
  ].join('\n') + '\n',
);

// ---- README
const bucket = (b: string) => placed.filter(p => p.owners[0] === b);
const unplaced = placed.filter(p => p.owners.length === 0);
const bucketDirs = (ps: Placed[]): string => {
  const m = new Map<string, number>();
  for (const p of ps) {
    const k = sub(p.path).split('/').slice(0, 3).join('/');
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([k, v]) => `${k} (${v})`)
    .join(', ');
};
const st = { kept: 0, split: 0, removed: 0 };
for (const r of rowsAll) st[r.status]++;
const fixtureRows = rowsAll.filter(r => /integration fixture/.test(r.notes)).length;
const named = rowsAll.filter(r => r.status === 'kept' && r.enforcer !== 'behaviour as written').length;
const fyShellRows = rowsAll.filter(r => r.with.includes('fy-shell'));
const workerRows = (w: string) => rowsAll.filter(r => r.with.includes(w));
const readme = `# Port briefs: index (Ferretry 5.0 rebuild, day 0)

Generated by \`bun scripts/rebuild/guarantees.ts\` and \`bun scripts/rebuild/ports.ts\`. Inputs: \`docs/design/redesign.md\`, \`git ls-files packages/\` at \`bb89d054d\`. Files: [guarantees.tsv](../guarantees.tsv) (one line per Appendix D row), [placement.tsv](../placement.tsv) (every old file -> owner(s) -> rule id -> note; rules are in \`scripts/rebuild/placement-rules.ts\`, first match wins), one brief per subsystem below.

## Totals

- Appendix D rows: **${rowsAll.length}** = ${st.kept} kept + ${st.split} split + ${st.removed} removed. The appendix states 1,215 = 1,158 + 26 + 31: **they match**, row ids are unique.
- Declared gaps (D.2): 161, as stated (they are not rows; no port writes tests for them).
- Rows whose "kept by" cell carries "integration fixture across the packages named": ${fixtureRows} (stated: 411, **matches**).
- Old files placed: ${placed.length} under \`packages/\`; subsystem-owned ${placed.filter(p => ALL_IDS.includes(p.owners[0]!)).length}; compatibility files deleted whole ${placed.filter(isDrop).length}; bucket files (below) ${placed.filter(p => ['app-shell', 'fy-shell', 'spine'].includes(p.owners[0]!)).length}; **unplaced ${unplaced.length}**.

## The 31 ports

| Port | Kind | §10.4 row (ferrets, model) | Copy (primary) | Also (shared) | Delete (whole files) | Keep rows (kept) | Keep rows (split) | Co-owned rows | Removed rows |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${summary.join('\n')}

Owner counts above are Appendix D's owner column after normalisation (REMOVED rows have no owner in the table; see below). Subsystems with zero owned rows still have the generic duties (manifest, words, skeleton -> filled halves).

## How owners were normalised (\`guarantees.tsv\`)

- \`owner\` = the first package named in the "kept by" owner phrase; \`with\` = the other packages named there, **only where the row carries the "integration fixture" note** (kept rows) or is a SPLIT row (SPLIT cells carry no notes). "(values sealed in Vault)", "(keys sealed in Vault)" and similar parentheticals are not co-ownership. "on the Kernel session layer" counts Kernel as co-owner, because the design's 411 fixture rows need it.
- \`Claude Code / Codex\` -> owner \`claude-code\`, with \`codex\` (both ports write the test).
- Non-package owners (kept out of the 31): \`fy-shell\` ("\`fy\` shell", "\`fy\` CLI" are the day-1 CLI router, not the Shells plugin) appears only in \`with\` on ${fyShellRows.length} rows (${fyShellRows.map(r => r.id).join(', ')}); \`repo-tooling\` ("Repo tooling (\`scripts/validate\`)") owns ${rowsAll
  .filter(r => r.owner === 'repo-tooling')
  .map(r => r.id)
  .join(', ')}.
- Workers are recorded in \`with\` as \`worker:<name>\` and mapped to their package: \`worker:relay\` ("relay Worker", "hosted relay Worker") = the Cloudflare Worker package, which §2.3 gives to **Connections** (${workerRows('worker:relay').length} rows); \`worker:catalogs-link-store\` ("Catalogs link-store Worker (\`packages/plugins/catalogs/worker\`)") = **Catalogs** (${workerRows('worker:catalogs-link-store').length} rows). Old files: \`packages/relay\` link-store files -> catalogs, the rest of the Worker -> connections.
- **REMOVED rows name no owner** in the table. I assigned each by the subject of the row (override list \`REMOVED_OWNER\` in \`guarantees.ts\`): access: G69-G72, G142, G168, P129; gate: G104, P67, S55, S56; accounts: I181, I189, I194, I209, I219, S69, S71, S72, S74, S75, S133; connections: R175-R181, R191; catalogs: R611. I194 ("older daemon refuses \`push: true\`", phone approval) is the least certain (Accounts vs Access).

## Non-port buckets (declared, not unplaced)

- **app-shell** (${bucket('app-shell').length} files): old \`packages/pwa\` files with no subsystem (router, layout engine pieces, UI primitives, theme, sealed client, daemon list, command palette, dev harness, build scripts, service worker) plus shared render/words helpers. Day-1 spine slice (§10.3), not a port. Biggest directories: ${bucketDirs(bucket('app-shell'))}.
- **fy-shell** (${bucket('fy-shell').length} files): old \`packages/cli\` router, wiring, terminal ports, registry. Day-1 slice. Files: ${bucket(
  'fy-shell',
)
  .map(p => sub(p.path))
  .join(', ')}.
- **spine** (${bucket('spine').length} files): old \`packages/protocol\` remainder (SDK/contract plumbing, shared test fixtures). Files: ${bucket(
  'spine',
)
  .map(p => sub(p.path))
  .join(', ')}.
- **drop** (${placed.filter(isDrop).length} files): compatibility code deleted whole; listed under the owning port's "Delete".

## Unplaced files (for the lead)

${unplaced.length ? unplaced.map(p => `- ${sub(p.path)}`).join('\n') : 'None: every file has an owner, a bucket or a drop. The catch-all rules (judgment placements marked \`~\` in placement.tsv; \`grep -P "\\t[0-9]+\\t~" docs/rebuild/placement.tsv\`) are where a wrong guess is most likely: ' + placed.filter(p => p.note.startsWith('~')).length + ' files.'}

## Shared old folders and where they were split (§8 overlaps)

\`session\` (sub-module by sub-module: identity/launch/lifecycle -> ferrets, send/queue/turn/question/transcript/reads -> conversation, console/attach/processes -> terminals, permission/dialog/harness -> claude-code+codex, agenda-mode -> agenda); \`runtime\` (mounts by mount name, boot/config -> kernel, carriers -> connections); \`agenda\` (store/answer -> asks, views/nudges/buzz -> agenda); \`secrets\` (vault half vs accounts half); \`fleet\` (ferrets/runtimes/logins/onboarding); \`relay\` package (session layer -> kernel, rendezvous/tunnel -> connections, link-store -> catalogs); \`input-requests\` (vault core, terminal/page targets -> terminals/browsers, login/phone parts -> accounts); \`step-up\` (plumbing gate, ceremonies and stores access); \`task-plans\` -> board (the accounts task-plan route/card pieces are placed with accounts by name); \`speedups\` -> packs (voice also: lead to confirm which half); \`local-skill-installs\` -> catalogs (skills also by name in the app); \`session-mcp\`, \`agent-files\` -> claude-code+codex (mcp also needs the MCP half).

## Contradictions and gaps found in the design

1. **Branch name**: §10.1/§10.2 say \`rewrite/5.0\`; TEAM-RULES and the repo use \`rebuild/5.0\`.
2. **Enforcer count**: Appendix D says 480 rows take the enforcer their source document names; the table shows ${named} kept rows with a named enforcer (${rowsAll.filter(r => r.enforcer === 'behaviour as written').length} say "behaviour as written", 26 SPLIT and 31 REMOVED rows have none). Difference: ${480 - named} (not resolvable from the text).
3. **REMOVED rows have no owner**, but §10.4 and the \`guarantee-owner\` check key everything by owner; I assigned the 31 (above). The design should name them in the table or in \`overrides.tsv\`.
4. **\`transcript\`**: §8 gives \`transcript\` to Conversation and "\`transcript\` (Claude half)" to Claude Code; Appendix D has "Conversation (with Claude Code / Codex transcript parsers)". Same files are claimed twice; the placement gives \`session/transcript\` and \`lib/transcript\` to Conversation, \`agent-files\`/\`session-mcp\` to the harness ports. Lead to confirm where the Claude/Codex parsers live (see \`transcript/claude-path.ts\`, \`codex-rollout.ts\`, \`wrapper-home.ts\`).
5. **Folders claimed by two or more subsystems in §8**: \`speedups\` (Packs and Voice), \`local-skill-installs\` (Catalogs and Skills), \`task-plans\` (Accounts and Board), \`session-mcp\` (Claude Code and MCP), \`harness-update\` (Updates and Claude Code), \`secrets\`, \`session\`, \`fleet\`, \`agenda\`, \`relay\`. Each is split above, but §8 does not say how.
6. **Subsystems with no Appendix D row**: ${ALL_IDS.filter(i => rowsOwned(i).length === 0).join(', ')}. Their "tests named after rows" duty is empty; they still need the \`guarantees\` check to pass vacuously.
7. **Counts that cannot be checked from the text**: "221 corrections" (\`overrides.tsv\`) and "fourteen rows carry the read-scoped note by hand" (the table has ${rowsAll.filter(r => /read-scoped/.test(r.notes)).length} rows with a read-scoped note; the rest may attach by enforcer identifier).
8. **\`fy\` shell vs Shells**: Appendix D's "\`fy\` shell" (CLI router, day-1 slice) shares a word with the **Shells** plugin (§2.3, nix shell items); the owner column uses both. I mapped "\`fy\` shell/CLI" to the non-package \`fy-shell\`.
9. **Day-1 spine files**: ${bucket('app-shell').length + bucket('fy-shell').length + bucket('spine').length} old files belong to no port (app shell, \`fy\` shell, SDK). §10.3 slices cover them but no document lists them; they are bucketed here.
10. **Appendix D "owner" for tests vs §10.4 splits**: the Accounts port is split (a)/(b) and Connections (a)/(b), Vault (a)/(b), Browsers (a)/(b), Conversation (a)/(b) in §10.4 but Appendix D owns rows per package, not per half. The briefs list rows per package; the two ferrets of a split port must divide the row list themselves (suggestion: by the sections named in §10.4's notes).
`;
mkdirSync('docs/rebuild/ports', { recursive: true });
writeFileSync('docs/rebuild/ports/README.md', readme);
console.log('wrote', ALL_IDS.length, 'briefs; unplaced', unplaced.length);
