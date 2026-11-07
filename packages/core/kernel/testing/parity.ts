import type { Manifest } from '../manifest/types.ts';

/** One difference: where (`route GET /v1/x`) and what differs. */
/** @public Parity finding shape, consumed by the ports to come. */
export interface Finding {
  readonly check: string;
  readonly where: string;
  readonly message: string;
}

/**
 * The descriptor-parity harness (§7.1): a manifest's routes, sockets, member routes and tools in the row shape of
 * today's table (`scripts/gen/today/routes.json`), and the comparison the `descriptor-parity` check runs. A plugin
 * port can assert its own parity in its tests with the same two functions.
 */
export type Table = 'route' | 'socket' | 'member' | 'tool';

export interface DescriptorRow {
  readonly table: Table;
  readonly key: string;
  readonly [field: string]: unknown;
}

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
  for (const m of manifest.actions?.memberRoutes ?? [])
    rows.push({ table: 'member', key: m.key, ...common(m as never) });
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
      if (!recorded(key, 'removed'))
        findings.push({ check, where, message: `today has it; 5.0 declares no ${was.table} ${was.key}` });
      continue;
    }
    const diffs: string[] = [];
    // Today an agent tool is an MCP wrapper in `fy` with no descriptor of its own: only its presence is compared.
    if (was.table === 'tool') continue;
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
    const stale =
      (change === 'removed' && (inNext || !inToday)) ||
      (change === 'added' && (inToday || !inNext)) ||
      (change === 'changed' && !(inToday && inNext));
    if (stale)
      findings.push({
        check,
        where: key.replace('\t', ' '),
        message: `recorded as ${change} but that no longer holds; remove the line`,
      });
  }
  return { findings, unresolved };
}
