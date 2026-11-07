/**
 * `descriptor-parity` (§7.1, §7.9): a route, socket, member route or agent tool differs from today's table, until the
 * change is recorded with a reason. Today's table is `scripts/gen/today/routes.json`, extracted from the 4.x
 * reference checkout by `scripts/gen/today/extract.ts`. Deliberate changes are lines of
 * `scripts/validate/descriptor-parity-changes.tsv`: `table<TAB>key<TAB>change<TAB>reason`, where `change` is
 * `removed` (today has it, 5.0 does not), `added` (5.0 only) or `changed` (fields differ).
 *
 * Compared fields are today's descriptor, field for field: `minimum`, `caller`, `ferretDoor` (presence),
 * `privilegedOnly`, `unlockExempt`, `capability` (name, axis, narrowing), `consultsGrants`, `wardenRemedy`,
 * `noStore`, `compress`, `precedence`, `available` (presence), and for member routes `member` and `catalog`. The new
 * `audit` and `guard` fields have no counterpart today and are not compared. A field today's extractor could not
 * resolve (`unresolved:…`) is not compared and is counted in the output.
 *
 *   bun scripts/validate/descriptor-parity.ts [--report]   (--report prints every difference as a table and exits 0)
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Manifest } from '../../packages/core/kernel/manifest/index.ts';
import { type Check, type Finding, runMain } from '../gen/lib/check.ts';

export type Table = 'route' | 'socket' | 'member' | 'tool';

export interface DescriptorRow {
  readonly table: Table;
  readonly key: string;
  readonly [field: string]: unknown;
}

export const TODAY_ROUTES = 'scripts/gen/today/routes.json';
export const PARITY_CHANGES = 'scripts/validate/descriptor-parity-changes.tsv';

export const COMPARED = [
  'minimum',
  'caller',
  'ferretDoor',
  'privilegedOnly',
  'unlockExempt',
  'capability',
  'consultsGrants',
  'wardenRemedy',
  'noStore',
  'compress',
  'precedence',
  'available',
  'member',
  'catalog',
] as const;

/** One manifest's descriptors in the fixture's row shape. */
export function rowsOf(manifest: Manifest): DescriptorRow[] {
  const rows: DescriptorRow[] = [];
  const common = (d: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const field of COMPARED) {
      const value = d[field];
      if (value === undefined || value === false) continue;
      if (field === 'ferretDoor' || field === 'available') out[field] = true;
      else if (field === 'capability') {
        const c = value as { capability: string; axis: string; narrowing?: true };
        out[field] = { capability: c.capability, axis: c.axis, ...(c.narrowing === true ? { narrowing: true } : {}) };
      } else out[field] = value;
    }
    return out;
  };
  for (const r of manifest.actions?.routes ?? []) rows.push({ table: 'route', key: r.key, ...common(r as never) });
  for (const s of manifest.actions?.sockets ?? []) rows.push({ table: 'socket', key: s.key, ...common(s as never) });
  for (const m of manifest.actions?.memberRoutes ?? []) rows.push({ table: 'member', key: m.key, ...common(m as never) });
  for (const t of manifest.actions?.agentTools ?? []) rows.push({ table: 'tool', key: t.name, ...common(t as never) });
  return rows;
}

const canonical = (value: unknown): string =>
  value === undefined || value === false
    ? '∅'
    : typeof value === 'object' && value !== null
      ? JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))))
      : String(value);

export interface ParityResult {
  readonly findings: readonly Finding[];
  readonly unresolved: number;
}

export function parity(
  today: readonly DescriptorRow[],
  next: readonly DescriptorRow[],
  changes: ReadonlyMap<string, { readonly change: string; readonly reason: string }>,
): ParityResult {
  const check = 'descriptor-parity';
  const keyOf = (row: DescriptorRow): string => `${row.table}\t${row.key}`;
  const todayBy = new Map(today.map(row => [keyOf(row), row] as const));
  const nextBy = new Map(next.map(row => [keyOf(row), row] as const));
  const findings: Finding[] = [];
  let unresolved = 0;
  const recorded = (key: string, change: string): boolean => changes.get(key)?.change === change;
  for (const [key, was] of todayBy) {
    const now = nextBy.get(key);
    const where = `${was.table} ${was.key}`;
    if (now === undefined) {
      if (!recorded(key, 'removed')) findings.push({ check, where, message: `today has it; 5.0 declares no ${was.table} ${was.key}` });
      continue;
    }
    const diffs: string[] = [];
    for (const field of COMPARED) {
      const before = was[field];
      if (typeof before === 'string' && before.startsWith('unresolved:')) {
        unresolved++;
        continue;
      }
      const after = now[field];
      if (canonical(before) !== canonical(after)) diffs.push(`${field} ${canonical(before)} → ${canonical(after)}`);
    }
    if (diffs.length > 0 && !recorded(key, 'changed')) findings.push({ check, where, message: diffs.join('; ') });
  }
  for (const [key, now] of nextBy)
    if (!todayBy.has(key) && !recorded(key, 'added'))
      findings.push({ check, where: `${now.table} ${now.key}`, message: 'new in 5.0; record it with a reason' });
  for (const [key, { change }] of changes) {
    const inToday = todayBy.has(key);
    const inNext = nextBy.has(key);
    const stale = (change === 'removed' && inNext) || (change === 'added' && (inToday || !inNext)) || (change === 'changed' && !(inToday && inNext));
    if (stale) findings.push({ check, where: key.replace('\t', ' '), message: `recorded as ${change} but that no longer holds; remove the line` });
  }
  return { findings, unresolved };
}

export function readChanges(text: string): Map<string, { change: string; reason: string }> {
  const out = new Map<string, { change: string; reason: string }>();
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    const [table, key, change, reason] = line.split('\t');
    if (table === undefined || key === undefined || change === undefined || reason === undefined || reason.trim() === '')
      throw new Error(`${PARITY_CHANGES}: "${line}" is not table<TAB>key<TAB>change<TAB>reason`);
    out.set(`${table}\t${key}`, { change, reason });
  }
  return out;
}

export const check: Check = {
  name: 'descriptor-parity',
  summary: "every route, socket and tool matches today's descriptor or records why not",
  async run(ctx) {
    const fixture = join(ctx.root, TODAY_ROUTES);
    if (!existsSync(fixture))
      return [{ check: 'descriptor-parity', where: TODAY_ROUTES, message: "today's table is missing; run scripts/gen/today/extract.ts" }];
    const today = (JSON.parse(readFileSync(fixture, 'utf8')) as { rows: DescriptorRow[] }).rows;
    const changesFile = join(ctx.root, PARITY_CHANGES);
    const changes = existsSync(changesFile) ? readChanges(readFileSync(changesFile, 'utf8')) : new Map();
    const model = await ctx.model();
    const next = model.loaded.flatMap(s => rowsOf(s.manifest));
    const result = parity(today, next, changes);
    if (result.unresolved > 0) console.error(`descriptor-parity: ${result.unresolved} unresolved field(s) in today's table were not compared`);
    if (process.argv.includes('--report')) {
      for (const finding of result.findings) console.log(`${finding.where}\t${finding.message}`);
      return [];
    }
    return result.findings;
  },
};

if (import.meta.main) await runMain(check, process.argv.slice(2).filter(arg => arg !== '--report'));
