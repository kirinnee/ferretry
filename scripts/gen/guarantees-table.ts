/**
 * Builds `docs/rebuild/guarantees.tsv` from Appendix D of `docs/design/redesign.md`: one line per guarantee row with
 * its status, owner package (resolved from the "kept by" column against manifest titles), the other packages it
 * names, and the enforcer text. The `guarantees` and `guarantee-owner` checks read the TSV, never the prose.
 *
 *   bun scripts/gen/guarantees-table.ts [--root <dir>] [--check]
 *
 * Columns: id · status (kept|split|removed) · deferred (`5.0.1` or empty) · owner · also · enforcer · doc
 * `--check` exits 1 when the committed TSV differs from a fresh extraction.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadManifests, loadWorkspace } from './lib/workspace.ts';

export interface GuaranteeRow {
  readonly id: string;
  readonly status: 'kept' | 'split' | 'removed';
  readonly deferred: string;
  readonly owner: string;
  readonly also: readonly string[];
  readonly enforcer: string;
  readonly doc: string;
}

export const GUARANTEES_TSV = 'docs/rebuild/guarantees.tsv';
const HEADER = ['id', 'status', 'deferred', 'owner', 'also', 'enforcer', 'doc'];

/** Titles to ids, longest title first so `Claude Code` wins over a shorter prefix. */
export function titleIndex(titles: ReadonlyMap<string, string>): readonly (readonly [string, string])[] {
  return [...titles].sort((a, b) => b[0].length - a[0].length);
}

/** Every package id named in an owner phrase, in order of appearance. */
export function idsIn(phrase: string, index: readonly (readonly [string, string])[]): string[] {
  const hits: { at: number; id: string }[] = [];
  for (const [title, id] of index) {
    const pattern = new RegExp(`(^|[^A-Za-z])${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z])`, 'g');
    for (const match of phrase.matchAll(pattern)) {
      const at = (match.index ?? 0) + (match[1]?.length ?? 0);
      if (!hits.some(hit => hit.at <= at && at < hit.at + 1)) hits.push({ at, id });
    }
  }
  const ordered: string[] = [];
  for (const hit of hits.sort((a, b) => a.at - b.at)) if (!ordered.includes(hit.id)) ordered.push(hit.id);
  return ordered;
}

function cells(line: string): string[] {
  return line
    .slice(1, line.endsWith('|') ? -1 : undefined)
    .split(/(?<!\\)\|/)
    .map(cell => cell.trim());
}

export function extractRows(markdown: string, index: readonly (readonly [string, string])[]): GuaranteeRow[] {
  const start = markdown.indexOf('## Appendix D.');
  const end = markdown.indexOf('#### D.2', start);
  const lines = markdown.slice(start, end === -1 ? undefined : end).split('\n');
  const rows: GuaranteeRow[] = [];
  let doc = '';
  for (const line of lines) {
    const heading = /^\*\*([a-z-]+\.md)\*\*/.exec(line);
    if (heading !== null) doc = heading[1] as string;
    if (!/^\| [A-Z]+[0-9]+[a-z]? /.test(line)) continue;
    const [id, , , keptBy = ''] = cells(line);
    const deferred = /deferred: (\d+\.\d+\.\d+)/.exec(keptBy)?.[1] ?? '';
    if (keptBy.startsWith('REMOVED')) {
      rows.push({ id: id as string, status: 'removed', deferred, owner: '', also: [], enforcer: '', doc });
      continue;
    }
    const split = keptBy.startsWith('SPLIT');
    const kept = split ? keptBy.replace(/^SPLIT\.\s*Kept:\s*/, '') : keptBy;
    const parts = kept.split(' · ');
    // A SPLIT row's kept text comes first; the owner is the first part that names a package.
    const ownerIndex = split ? parts.findIndex((part, at) => at > 0 && idsIn(part, index).length > 0) : 0;
    const ownerPhrase = parts[ownerIndex === -1 ? 0 : ownerIndex] ?? '';
    const ids = idsIn(ownerPhrase, index);
    const enforcer = (parts[(ownerIndex === -1 ? 0 : ownerIndex) + 1] ?? '').replace(/\s*test `[^`]+`.*$/, '').trim();
    rows.push({
      id: id as string,
      status: split ? 'split' : 'kept',
      deferred,
      owner: ids[0] ?? '',
      also: ids.slice(1),
      enforcer: enforcer.startsWith('test ') ? '' : enforcer,
      doc,
    });
  }
  return rows;
}

export function toTsv(rows: readonly GuaranteeRow[]): string {
  const clean = (text: string): string => text.replace(/[\t\n]/g, ' ');
  return `${[
    HEADER.join('\t'),
    ...rows.map(row =>
      [row.id, row.status, row.deferred, row.owner, row.also.join(','), clean(row.enforcer), row.doc].join('\t'),
    ),
  ].join('\n')}\n`;
}

export function parseTsv(text: string): GuaranteeRow[] {
  const [header, ...lines] = text.trimEnd().split('\n');
  if (header !== HEADER.join('\t')) throw new Error(`${GUARANTEES_TSV}: header is not ${HEADER.join(' ')}`);
  return lines.map(line => {
    const [id = '', status = '', deferred = '', owner = '', also = '', enforcer = '', doc = ''] = line.split('\t');
    if (status !== 'kept' && status !== 'split' && status !== 'removed')
      throw new Error(`${GUARANTEES_TSV}: ${id} has status "${status}"`);
    return { id, status, deferred, owner, also: also === '' ? [] : also.split(','), enforcer, doc };
  });
}

async function main(args: readonly string[]): Promise<number> {
  const rootAt = args.indexOf('--root');
  const root = rootAt === -1 ? join(import.meta.dir, '..', '..') : (args[rootAt + 1] as string);
  const ws = loadWorkspace(root);
  const { loaded } = await loadManifests(ws);
  const titles = new Map(loaded.map(s => [s.manifest.title, s.id] as const));
  // Owners that are not subsystems: repo tooling (tests under scripts/) and the two shells.
  titles.set('Repo tooling', 'repo');
  titles.set('`fy` shell', 'fy');
  titles.set('App shell', 'app');
  const rows = extractRows(readFileSync(join(root, 'docs/design/redesign.md'), 'utf8'), titleIndex(titles));
  const unowned = rows.filter(row => row.status !== 'removed' && row.owner === '');
  for (const row of unowned) console.error(`⚠️  ${row.id}: no owner package resolved`);
  const tsv = toTsv(rows);
  if (args.includes('--check')) {
    const current = readFileSync(join(root, GUARANTEES_TSV), 'utf8');
    if (current !== tsv) {
      console.error(`❌ ${GUARANTEES_TSV} differs from a fresh extraction of Appendix D`);
      return 1;
    }
    return 0;
  }
  writeFileSync(join(root, GUARANTEES_TSV), tsv);
  const count = (status: string): number => rows.filter(row => row.status === status).length;
  console.log(`${rows.length} rows: ${count('kept')} kept, ${count('split')} split, ${count('removed')} removed, ${unowned.length} unowned`);
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
