/**
 * `descriptor-parity` (§7.1, §7.9): a route, socket, member route or agent tool differs from today's table, until the
 * change is recorded with a reason. Today's table is `scripts/gen/today/routes.json`, extracted from the 4.x
 * reference checkout by `scripts/gen/today/extract.ts`. Deliberate changes are lines of
 * `scripts/validate/descriptor-parity-changes.tsv`: `table<TAB>key<TAB>change<TAB>reason`, where `change` is
 * `moved` (a `removed` that names its 5.0 key, `table<TAB>old<TAB>moved<TAB>new<TAB>reason`: the new key must exist
 * with the same method and be recorded `added` or `moved-changed`, one old key per new key, and the pair is judged
 * exactly like a derived one, so a record never blesses a loosening),
 * `removed` (today has it, 5.0 does not), `added` (5.0 only), `changed` (fields differ) or `moved-changed` (a 5.0-only route
 * that replaces a removed one and differs from it as the reason says; a moved pair that differs with no such record fails).
 *
 * Compared fields are today's descriptor, field for field: `minimum`, `caller`, `ferretDoor` (presence),
 * `privilegedOnly`, `unlockExempt`, `capability` (name, axis, narrowing), `consultsGrants`, `wardenRemedy`,
 * `noStore`, `compress`, `precedence`, `available` (presence), and for member routes `member` and `catalog`. An agent
 * tool is compared by presence only: today it is an MCP wrapper in `fy` with no descriptor of its own. The new
 * `audit` and `guard` fields have no counterpart today and are not compared. A field today's extractor could not
 * resolve (`unresolved:…`) is not compared and is counted in the output.
 *
 *   bun scripts/validate/descriptor-parity.ts [--report]   (--report prints every difference as a table and exits 0)
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type DescriptorRow,
  type FieldDiff,
  fieldDiffs,
  parity,
  rowsOf,
} from '../../packages/core/kernel/testing/parity.ts';
import { type Check, type Finding, runMain } from '../gen/lib/check.ts';

export const TODAY_ROUTES = 'scripts/gen/today/routes.json';
export const PARITY_CHANGES = 'scripts/validate/descriptor-parity-changes.tsv';

// ─── moved routes ────────────────────────────────────────────────────────────────────────────────────────────────

// The words design §1.4 replaced in a path, as the descriptor-parity-changes records name them.
const RENAMED: Readonly<Record<string, string>> = {
  sessions: 'ferrets',
  tasks: 'cards',
  imports: 'links',
  learning: 'lessons',
};

/** A path with its params and the replaced words collapsed, so a moved route and today's compare equal. */
export const shape = (key: string): string =>
  key
    .split('/')
    .map(part => (part.startsWith(':') ? ':' : (RENAMED[part] ?? part)))
    .join('/');

const MINIMUM_RANK: Readonly<Record<string, number>> = { none: 0, authenticated: 1, operator: 2, 'admin-token': 3 };

/**
 * A difference that can only REFUSE more callers than today: minimum rank up, caller any → person, a capability
 * added, `noStore` or `privilegedOnly` added, a `catalog` resolver added (it names where the handler already read the
 * catalog from). Anything else is not one, so a record can never bless a loosening.
 */
export function isTightening(diff: FieldDiff, was: DescriptorRow, now: DescriptorRow): boolean {
  switch (diff.field) {
    case 'minimum':
      return (
        (MINIMUM_RANK[String(now.minimum)] ?? -1) >
        (MINIMUM_RANK[String(was.minimum ?? 'none')] ?? Number.MAX_SAFE_INTEGER)
      );
    case 'caller':
      return (was.caller === undefined || was.caller === 'any') && now.caller === 'person';
    case 'capability':
    case 'noStore':
    case 'privilegedOnly':
    case 'catalog':
      return diff.before === '∅' && diff.after !== '∅';
    default:
      return false;
  }
}

export interface MovedPair {
  readonly was: DescriptorRow;
  readonly now: DescriptorRow;
}

/** One record of the changes file; `to` is the 5.0 key an explicit `moved` record names. */
export interface ChangeRecord {
  readonly change: string;
  readonly reason: string;
  readonly to?: string | undefined;
}

const methodOf = (key: string): string => /^([A-Z]+) /.exec(key)?.[1] ?? '';

/**
 * Each route recorded `removed` paired with its 5.0 counterpart: the one a `moved` record names (it wins over any
 * derivation), else the one recorded `added` that differs from it only by params and the words design §1.4 replaced.
 * A removed route with no such counterpart is not paired; `claimed` lists the 5.0 routes more than one removed route
 * maps onto, and `broken` maps a removed key (`table<TAB>key`) to why its explicit `moved` record names no valid route.
 */
export function movedPairs(
  today: readonly DescriptorRow[],
  next: readonly DescriptorRow[],
  changes: ReadonlyMap<string, ChangeRecord>,
): {
  readonly pairs: readonly MovedPair[];
  readonly claimed: ReadonlyMap<string, readonly string[]>;
  readonly broken: ReadonlyMap<string, string>;
} {
  const pairs: MovedPair[] = [];
  const claims = new Map<string, string[]>();
  const broken = new Map<string, string>();
  const claim = (was: DescriptorRow, now: DescriptorRow): void => {
    pairs.push({ was, now });
    claims.set(`${now.table}	${now.key}`, [...(claims.get(`${now.table}	${now.key}`) ?? []), was.key]);
  };
  for (const was of today) {
    const record = changes.get(`${was.table}	${was.key}`);
    if (was.table === 'tool' || record?.change !== 'removed') continue;
    if (record.to !== undefined) {
      const target = next.find(r => r.table === was.table && r.key === record.to);
      const kind = changes.get(`${was.table}	${record.to}`)?.change ?? '';
      const why =
        target === undefined
          ? `5.0 declares no ${was.table} ${record.to}`
          : methodOf(target.key) !== methodOf(was.key)
            ? `${record.to} changes the method of ${was.key}`
            : ['added', 'moved-changed'].includes(kind)
              ? undefined
              : `${record.to} is not recorded added or moved-changed`;
      if (why === undefined && target !== undefined) claim(was, target);
      else broken.set(`${was.table}	${was.key}`, `moved record names ${record.to}, but ${why}`);
      continue;
    }
    const wanted = shape(was.key);
    const found = next.filter(
      r =>
        r.table === was.table &&
        shape(r.key) === wanted &&
        ['added', 'moved-changed'].includes(changes.get(`${r.table}	${r.key}`)?.change ?? ''),
    );
    if (found.length !== 1) continue;
    claim(was, found[0] as DescriptorRow);
  }
  return { pairs, claimed: new Map([...claims].filter(([, keys]) => keys.length > 1)), broken };
}

/**
 * The moved routes `parity()` cannot compare (a move is a `removed` plus an `added`): a pair whose descriptor differs
 * with no `moved-changed` record on the 5.0 route, a record with nothing to record, and a 5.0 route two removed routes
 * collapse onto.
 */
export function movedFindings(
  today: readonly DescriptorRow[],
  next: readonly DescriptorRow[],
  changes: ReadonlyMap<string, ChangeRecord>,
): Finding[] {
  const check = 'descriptor-parity';
  const { pairs, claimed, broken } = movedPairs(today, next, changes);
  const out: Finding[] = [];
  for (const [key, message] of broken) out.push({ check, where: key.replace('	', ' '), message });
  for (const { was, now } of pairs) {
    const diffs = fieldDiffs(was, now);
    const recorded = changes.get(`${now.table}	${now.key}`)?.change === 'moved-changed';
    const where = `${was.table} ${was.key}`;
    if (diffs.length > 0 && !recorded)
      out.push({
        check,
        where,
        message: `moved to ${now.key} with no record of: ${diffs.map(d => `${d.field} ${d.before} → ${d.after}`).join('; ')}`,
      });
    if (diffs.length === 0 && recorded)
      out.push({
        check,
        where: `${now.table} ${now.key}`,
        message: 'recorded moved-changed but it equals its pair; record it as added',
      });
  }
  for (const [key, from] of claimed)
    out.push({
      check,
      where: key.replace('	', ' '),
      message: `claimed by ${from.length} removed routes: ${from.join(', ')}`,
    });
  return out;
}

export function readChanges(text: string): Map<string, ChangeRecord> {
  const out = new Map<string, ChangeRecord>();
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    const cells = line.split('\t');
    const [table, key, kind] = cells;
    // `moved` is a `removed` that names its 5.0 key: table<TAB>old<TAB>moved<TAB>new<TAB>reason.
    const explicit = kind === 'moved';
    const to = explicit ? cells[3] : undefined;
    const reason = explicit ? cells[4] : cells[3];
    if (
      table === undefined ||
      key === undefined ||
      kind === undefined ||
      reason === undefined ||
      reason.trim() === '' ||
      (explicit && (to === undefined || to.trim() === ''))
    )
      throw new Error(
        `${PARITY_CHANGES}: "${line}" is not table<TAB>key<TAB>change<TAB>reason (or table<TAB>old<TAB>moved<TAB>new<TAB>reason)`,
      );
    if (out.has(`${table}\t${key}`))
      throw new Error(`${PARITY_CHANGES}: ${table} ${key} is recorded twice (a later line would shadow the first)`);
    out.set(`${table}\t${key}`, { change: explicit ? 'removed' : kind, reason, to });
  }
  return out;
}

export const check: Check = {
  name: 'descriptor-parity',
  summary: "every route, socket and tool matches today's descriptor or records why not",
  async run(ctx) {
    const fixture = join(ctx.root, TODAY_ROUTES);
    if (!existsSync(fixture))
      return [
        {
          check: 'descriptor-parity',
          where: TODAY_ROUTES,
          message: "today's table is missing; run scripts/gen/today/extract.ts",
        },
      ];
    const today = (JSON.parse(readFileSync(fixture, 'utf8')) as { rows: DescriptorRow[] }).rows;
    const changesFile = join(ctx.root, PARITY_CHANGES);
    const changes = existsSync(changesFile) ? readChanges(readFileSync(changesFile, 'utf8')) : new Map();
    const model = await ctx.model();
    const next = model.loaded.flatMap(s => rowsOf(s.manifest));
    const result = parity(today, next, changes);
    const findings = [...result.findings, ...movedFindings(today, next, changes)];
    if (result.unresolved > 0)
      console.error(`descriptor-parity: ${result.unresolved} unresolved field(s) in today's table were not compared`);
    if (process.argv.includes('--report')) {
      for (const finding of findings) console.log(`${finding.where}\t${finding.message}`);
      return [];
    }
    return findings;
  },
};

if (import.meta.main)
  await runMain(
    check,
    process.argv.slice(2).filter(arg => arg !== '--report'),
  );
