/**
 * `parity-ticks`: a `[x]` in `docs/design/rebuild-parity.tsv` means a test (or, for a route, descriptor-parity) proves
 * the row. It fails when a ticked row
 *   - has an empty check cell, or a check path that does not exist;
 *   - (not a route) has a check FILE that never mentions the row id (`F-0019`), so the file cannot be the row's test;
 *   - (a route) is not proven by descriptor-parity: today's route exists in 5.0 with the same method and path and no
 *     unrecorded difference, or moved to another path with both halves recorded in descriptor-parity-changes.tsv and
 *     the same descriptor fields.
 * `parity-ticks-known.tsv` (`id<TAB>reason`) lists rows that fail today and are being fixed; each is skipped, and an
 * entry whose row passes (or is no longer ticked) fails so the list can only shrink.
 *
 *   bun scripts/validate/parity-ticks.ts
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { COMPARED, type DescriptorRow, parity, rowsOf } from '../../packages/core/kernel/testing/parity.ts';
import { type Check, type Finding, runMain } from '../gen/lib/check.ts';
import { PARITY_CHANGES, TODAY_ROUTES, readChanges } from './descriptor-parity.ts';

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export const LEDGER = 'docs/design/rebuild-parity.tsv';
export const KNOWN = 'scripts/validate/parity-ticks-known.tsv';

export interface LedgerRow {
  readonly id: string;
  readonly kind: string;
  readonly what: string;
  readonly name5: string;
  readonly check: string;
  readonly status: string;
}

export function readLedger(text: string): LedgerRow[] {
  const [, ...lines] = text.trimEnd().split('\n');
  return lines.map(line => {
    const v = line.split('\t');
    return {
      id: v[0] ?? '',
      kind: v[1] ?? '',
      what: v[2] ?? '',
      name5: v[6] ?? '',
      check: v[8] ?? '',
      status: v[9] ?? '',
    };
  });
}

export const isTicked = (row: LedgerRow): boolean => row.status.startsWith('[x]');

export function readKnown(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    const [id, reason] = line.split('\t');
    if (id === undefined || reason === undefined || reason.trim() === '')
      throw new Error(`${KNOWN}: "${line}" is not id<TAB>reason`);
    out.set(id, reason);
  }
  return out;
}

export interface RouteWorld {
  readonly today: readonly DescriptorRow[];
  readonly next: readonly DescriptorRow[];
  readonly changes: ReadonlyMap<string, { readonly change: string; readonly reason: string }>;
  readonly findings: readonly Finding[];
}

export function routeWorld(
  today: readonly DescriptorRow[],
  next: readonly DescriptorRow[],
  changes: ReadonlyMap<string, { readonly change: string; readonly reason: string }>,
): RouteWorld {
  return { today, next, changes, findings: parity(today, next, changes).findings };
}

// The words design §1.4 replaced in a path, as the descriptor-parity-changes records name them.
const RENAMED: Readonly<Record<string, string>> = {
  sessions: 'ferrets',
  tasks: 'cards',
  imports: 'links',
  learning: 'lessons',
};

const shape = (key: string): string =>
  key
    .split('/')
    .map(part => (part.startsWith(':') ? ':' : (RENAMED[part] ?? part)))
    .join('/');

/** `undefined` when descriptor-parity proves the route; otherwise why it cannot. */
export function routeProblem(row: Pick<LedgerRow, 'what' | 'name5'>, world: RouteWorld): string | undefined {
  const socket = row.what.startsWith('WS ');
  const key = socket ? row.what.slice(3) : row.what;
  const was = world.today.find(
    r => (socket ? r.table === 'socket' : r.table === 'route' || r.table === 'member') && r.key === key,
  );
  if (was === undefined) return `today's table has no route ${row.what}`;
  const table = was.table;
  const wasKey = `${table}\t${key}`;
  const exact = world.next.find(r => r.table === table && r.key === key);
  if (exact !== undefined) {
    const found = world.findings.filter(f => f.where === `${table} ${key}`);
    return found.length === 0 ? undefined : `route changed with no record: ${found.map(f => f.message).join('; ')}`;
  }
  // Not at today's path: it must have moved, both halves recorded, to a path that differs only by params and the
  // words design §1.4 replaced, with today's descriptor fields.
  const recorded = world.changes.get(wasKey);
  if (recorded?.change !== 'removed') return `route missing: 5.0 declares no ${table} ${key}`;
  const wanted = new Set([shape(key), shape(socket ? row.name5.replace(/^WS /, '') : row.name5)]);
  const moved = world.next.filter(
    r => r.table === table && wanted.has(shape(r.key)) && world.changes.get(`${table}\t${r.key}`)?.change === 'added',
  );
  if (moved.length !== 1) return `route removed in 5.0 (recorded), no single counterpart derivable: ${recorded.reason}`;
  const now = moved[0] as DescriptorRow;
  const differs = COMPARED.filter(
    f =>
      !(typeof was[f] === 'string' && (was[f] as string).startsWith('unresolved:')) &&
      !same(was[f] === false ? undefined : was[f], now[f] === false ? undefined : now[f]),
  );
  return differs.length === 0 ? undefined : `moved to ${now.key} with a changed descriptor: ${differs.join(', ')}`;
}

/** The reason one ticked row fails, or `undefined`. `world` is needed only when a route is ticked. */
export function tickProblem(row: LedgerRow, root: string, world: () => RouteWorld): string | undefined {
  if (row.kind === 'R') {
    if (row.check !== 'descriptor-parity') return `route check is "${row.check}", not descriptor-parity`;
    return routeProblem(row, world());
  }
  if (row.check.trim() === '') return 'empty check cell';
  const path = join(root, row.check);
  if (!existsSync(path)) return `check path does not exist: ${row.check}`;
  if (statSync(path).isFile() && !readFileSync(path, 'utf8').includes(row.id))
    return `check file never mentions ${row.id}: ${row.check}`;
  return undefined;
}

export function tickFindings(
  rows: readonly LedgerRow[],
  root: string,
  world: () => RouteWorld,
  known: ReadonlyMap<string, string>,
): Finding[] {
  const out: Finding[] = [];
  const ticked = new Set<string>();
  for (const row of rows) {
    if (!isTicked(row)) continue;
    ticked.add(row.id);
    const problem = tickProblem(row, root, world);
    const listed = known.has(row.id);
    if (problem !== undefined && !listed) out.push({ check: 'parity-ticks', where: row.id, message: problem });
    if (problem === undefined && listed)
      out.push({ check: 'parity-ticks', where: row.id, message: `passes now; remove it from ${KNOWN}` });
  }
  for (const id of known.keys())
    if (!ticked.has(id))
      out.push({ check: 'parity-ticks', where: id, message: `not a ticked row; remove it from ${KNOWN}` });
  return out;
}

export async function loadWorld(
  root: string,
  model: () => ReturnType<typeof import('../gen/registries.ts').buildModel>,
) {
  const today = (JSON.parse(readFileSync(join(root, TODAY_ROUTES), 'utf8')) as { rows: DescriptorRow[] }).rows;
  const changesFile = join(root, PARITY_CHANGES);
  const changes = existsSync(changesFile) ? readChanges(readFileSync(changesFile, 'utf8')) : new Map();
  const next = (await model()).loaded.flatMap(s => rowsOf(s.manifest));
  return routeWorld(today, next, changes);
}

export const check: Check = {
  name: 'parity-ticks',
  summary: 'every [x] in the parity ledger points at a test or descriptor-parity that proves it',
  async run(ctx) {
    const ledger = join(ctx.root, LEDGER);
    if (!existsSync(ledger)) return [{ check: 'parity-ticks', where: LEDGER, message: 'the parity ledger is missing' }];
    const rows = readLedger(readFileSync(ledger, 'utf8'));
    const knownFile = join(ctx.root, KNOWN);
    const known = existsSync(knownFile) ? readKnown(readFileSync(knownFile, 'utf8')) : new Map<string, string>();
    const world = await loadWorld(ctx.root, ctx.model);
    return tickFindings(rows, ctx.root, () => world, known);
  },
};

if (import.meta.main) await runMain(check, process.argv.slice(2));
