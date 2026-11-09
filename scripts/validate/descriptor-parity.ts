/**
 * `descriptor-parity` (§7.1, §7.9): a route, socket, member route or agent tool differs from today's table, until the
 * change is recorded with a reason. Today's table is `scripts/gen/today/routes.json`, extracted from the 4.x
 * reference checkout by `scripts/gen/today/extract.ts`. Deliberate changes are lines of
 * `scripts/validate/descriptor-parity-changes.tsv`: `table<TAB>key<TAB>change<TAB>reason`, where `change` is
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

/**
 * Each route recorded `removed` paired with the one recorded `added` that differs from it only by params and the words
 * design §1.4 replaced. A removed route with no single such counterpart is not paired (it moved to a plugin prefix);
 * `claimed` lists the 5.0 routes more than one removed route maps onto.
 */
export function movedPairs(
  today: readonly DescriptorRow[],
  next: readonly DescriptorRow[],
  changes: ReadonlyMap<string, { readonly change: string; readonly reason: string }>,
): { readonly pairs: readonly MovedPair[]; readonly claimed: ReadonlyMap<string, readonly string[]> } {
  const pairs: MovedPair[] = [];
  const claims = new Map<string, string[]>();
  for (const was of today) {
    if (was.table === 'tool' || changes.get(`${was.table}	${was.key}`)?.change !== 'removed') continue;
    const wanted = shape(was.key);
    const found = next.filter(
      r =>
        r.table === was.table &&
        shape(r.key) === wanted &&
        ['added', 'moved-changed'].includes(changes.get(`${r.table}	${r.key}`)?.change ?? ''),
    );
    if (found.length !== 1) continue;
    const now = found[0] as DescriptorRow;
    pairs.push({ was, now });
    claims.set(`${now.table}	${now.key}`, [...(claims.get(`${now.table}	${now.key}`) ?? []), was.key]);
  }
  return { pairs, claimed: new Map([...claims].filter(([, keys]) => keys.length > 1)) };
}

/**
 * The moved routes `parity()` cannot compare (a move is a `removed` plus an `added`): a pair whose descriptor differs
 * with no `moved-changed` record on the 5.0 route, a record with nothing to record, and a 5.0 route two removed routes
 * collapse onto.
 */
export function movedFindings(
  today: readonly DescriptorRow[],
  next: readonly DescriptorRow[],
  changes: ReadonlyMap<string, { readonly change: string; readonly reason: string }>,
): Finding[] {
  const check = 'descriptor-parity';
  const { pairs, claimed } = movedPairs(today, next, changes);
  const out: Finding[] = [];
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

export function readChanges(text: string): Map<string, { change: string; reason: string }> {
  const out = new Map<string, { change: string; reason: string }>();
  for (const line of text.split('\n')) {
    if (line.trim() === '' || line.startsWith('#')) continue;
    const [table, key, change, reason] = line.split('\t');
    if (
      table === undefined ||
      key === undefined ||
      change === undefined ||
      reason === undefined ||
      reason.trim() === ''
    )
      throw new Error(`${PARITY_CHANGES}: "${line}" is not table<TAB>key<TAB>change<TAB>reason`);
    if (out.has(`${table}\t${key}`))
      throw new Error(`${PARITY_CHANGES}: ${table} ${key} is recorded twice (a later line would shadow the first)`);
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
