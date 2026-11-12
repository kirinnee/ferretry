/**
 * `parity-ticks`: a `[x]` in `docs/design/rebuild-parity.tsv` means a TEST proves the row, never a declaration. For every
 * ticked row, of any kind, it fails when
 *   - the check cell is not a regular `*.test.ts` / `*.test.tsx` file under a `tests/` folder;
 *   - the row id is in no LIVE `test(` / `it(` title of that file (parsed; a describe's title, a comment, a string
 *     elsewhere, or a title under `.skip` / `.todo` / `.only` / `.failing`, or inside such a describe, does not count);
 *   - results are given (`--results <junit.xml|folder>`, as `guarantees` takes them, with `--tier unit|int`) and the
 *     id-titled test did not PASS in them. Without results it says so and passes that part;
 *   - (a route) descriptor-parity does not ALSO prove it: today's route is at the same path or moved (both halves
 *     recorded) and every field that differs is a recorded tightening (minimum up, caller any → person, a capability,
 *     `noStore`, `privilegedOnly` or a `catalog` resolver added). A record never blesses a loosening.
 * A status that says a row is "proved by test(s) <id>" (any row, ticked or not) fails when no live `test(` / `it(` title
 * in a tracked test file names that id.
 * `parity-ticks-known.tsv` (`id<TAB>reason`) lists rows that fail today. The ids it may hold are PINNED in
 * `FROZEN_IDS` below: an id not in that set fails, so the list can only shrink; an entry whose row passes (or is no
 * longer ticked) fails too, and so does a frozen id that is no longer listed (the two sets must be equal).
 *
 *   bun scripts/validate/parity-ticks.ts [--results <junit.xml|folder>] [--tier unit|int]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  type DescriptorRow,
  type FieldDiff,
  fieldDiffs,
  parity,
  rowsOf,
} from '../../packages/core/kernel/testing/parity.ts';
import { type AstNode, type Check, type Finding, parseFile, runMain, walk } from '../gen/lib/check.ts';
import {
  type ChangeRecord,
  PARITY_CHANGES,
  TODAY_ROUTES,
  isRestoredAct,
  isTightening,
  movedPairs,
  readChanges,
} from './descriptor-parity.ts';
import { type JunitCase, inTier, junitCases, resultFiles } from './guarantees.ts';
import { helperBinding, helperCallTitles } from './test-titles.ts';

export const LEDGER = 'docs/design/rebuild-parity.tsv';
export const KNOWN = 'scripts/validate/parity-ticks-known.tsv';

/** The ids `${KNOWN}` may list. It only shrinks: delete an id here when its row is fixed; never add one. */
export const FROZEN_IDS: ReadonlySet<string> = new Set([
  'S-0010',
  'S-0255',
  'S-0262',
  'S-0304',
  'S-0388',
  'T-0003',
  'T-0004',
  'T-0005',
  'T-0006',
  'T-0007',
  'T-0008',
  'T-0009',
  'T-0010',
  'T-0011',
  'T-0012',
  'T-0013',
  'T-0014',
  'T-0015',
  'T-0016',
  'T-0017',
  'T-0018',
  'T-0019',
  'T-0020',
  'T-0021',
  'T-0022',
  'T-0023',
  'T-0024',
  'T-0025',
  'T-0026',
  'T-0027',
  'T-0028',
  'T-0029',
  'T-0030',
  'T-0031',
  'V-0293',
  'V-0295',
  'V-0297',
  'V-0301',
  'V-0302',
]);

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
  readonly changes: ReadonlyMap<string, ChangeRecord>;
  readonly findings: readonly Finding[];
}

export function routeWorld(
  today: readonly DescriptorRow[],
  next: readonly DescriptorRow[],
  changes: ReadonlyMap<string, ChangeRecord>,
): RouteWorld {
  return { today, next, changes, findings: parity(today, next, changes).findings };
}

/** What descriptor-parity says of one route row: proven, or why not (the kind groups the reasons). */
export interface RouteStatus {
  readonly kind: 'proven' | 'unrecorded' | 'loosened' | 'missing' | 'unpaired' | 'claimed' | 'no-today';
  readonly text: string;
}

const proven: RouteStatus = { kind: 'proven', text: 'descriptor proven' };
const showDiffs = (diffs: readonly FieldDiff[]): string =>
  diffs.map(d => `${d.field} ${d.before} → ${d.after}`).join('; ');

/** Judges a differing pair: unrecorded, a recorded loosening, or a recorded tightening (proven). */
function judge(was: DescriptorRow, now: DescriptorRow, recorded: boolean): RouteStatus {
  const diffs = fieldDiffs(was, now);
  if (diffs.length === 0) return proven;
  if (!recorded) return { kind: 'unrecorded', text: `route changed with no record: ${showDiffs(diffs)}` };
  const loose = diffs.filter(d => !isTightening(d, was, now) && !isRestoredAct(d, now));
  return loose.length === 0
    ? proven
    : { kind: 'loosened', text: `a recorded change is not a tightening: ${showDiffs(loose)}` };
}

export function routeStatus(row: Pick<LedgerRow, 'what'>, world: RouteWorld): RouteStatus {
  const socket = row.what.startsWith('WS ');
  const key = socket ? row.what.slice(3) : row.what;
  const was = world.today.find(
    r => (socket ? r.table === 'socket' : r.table === 'route' || r.table === 'member') && r.key === key,
  );
  if (was === undefined) return { kind: 'no-today', text: `today's table has no route ${row.what}` };
  const table = was.table;
  const wasKey = `${table}\t${key}`;
  const exact = world.next.find(r => r.table === table && r.key === key);
  if (exact !== undefined) return judge(was, exact, world.changes.get(wasKey)?.change === 'changed');
  // Not at today's path: it must have moved, both halves recorded, to a path that differs only by params and the
  // words design §1.4 replaced.
  const recorded = world.changes.get(wasKey);
  if (recorded?.change !== 'removed')
    return { kind: 'missing', text: `route missing: 5.0 declares no ${table} ${key}` };
  const { pairs, claimed, broken } = movedPairs(world.today, world.next, world.changes);
  const pair = pairs.find(p => p.was === was);
  if (pair === undefined)
    return {
      kind: 'unpaired',
      text: `route removed in 5.0 (recorded), ${broken.get(wasKey) ?? 'no single counterpart derivable'}: ${recorded.reason}`,
    };
  const now = pair.now;
  if (claimed.has(`${now.table}\t${now.key}`))
    return { kind: 'claimed', text: `${now.key} is claimed by more than one removed route` };
  return judge(was, now, world.changes.get(`${now.table}\t${now.key}`)?.change === 'moved-changed');
}

/** `undefined` when descriptor-parity proves the route; otherwise why it cannot. */
export const routeProblem = (row: Pick<LedgerRow, 'what'>, world: RouteWorld): string | undefined => {
  const status = routeStatus(row, world);
  return status.kind === 'proven' ? undefined : status.text;
};

// ─── the test that names a row ───────────────────────────────────────────────────────────────────────────────────

const SUITE = new Set(['test', 'it', 'describe']);
// A modifier after which the title is not a live test: skipped, todo, focused, or expected to throw.
const DEAD = new Set(['skip', 'todo', 'only', 'failing', 'skipIf', 'todoIf']);

/** `test.skip`, `describe.each(rows)`, `it.if(x)` → the base name and every modifier on the way. */
function callee(node: unknown): { base: string; mods: string[] } | undefined {
  const n = node as AstNode | undefined;
  if (n === undefined) return undefined;
  if (n.type === 'Identifier') return { base: n.name as string, mods: [] };
  if (n.type === 'CallExpression') return callee(n.callee);
  if (n.type === 'MemberExpression' && n.computed !== true) {
    const inner = callee(n.object);
    const prop = (n.property as AstNode).name;
    return inner === undefined || typeof prop !== 'string'
      ? undefined
      : { base: inner.base, mods: [...inner.mods, prop] };
  }
  return undefined;
}

/** `.if(false)` with a literal false: the test never runs (a computed condition cannot be judged here; CI's JUnit does). */
function isOff(node: unknown): boolean {
  const n = node as AstNode | undefined;
  if (n === undefined) return false;
  if (n.type === 'CallExpression') {
    const c = n.callee as AstNode;
    const arg = (n.arguments as AstNode[])[0];
    if (c.type === 'MemberExpression' && c.computed !== true && (c.property as AstNode).name === 'if')
      return arg?.type === 'Literal' && arg.value === false;
    return isOff(c);
  }
  return n.type === 'MemberExpression' && n.computed !== true ? isOff(n.object) : false;
}

const titleOf = (node: unknown): string | undefined => {
  const n = node as AstNode | undefined;
  if (n?.type === 'Literal' && typeof n.value === 'string') return n.value;
  // An expression between the parts is joined with an alphanumeric sentinel that breaks an id token: `R-00${x}23` is not R-0023.
  if (n?.type === 'TemplateLiteral')
    return (n.quasis as { value: { cooked?: string; raw: string } }[])
      .map(q => q.value.cooked ?? q.value.raw)
      .join('X');
  return undefined;
};

/** The calls whose title is a CASE: the thing that runs, so the thing that can go red. A describe only groups. */
const CASE = new Set(['test', 'it']);

/**
 * Every title of a LIVE `test(` / `it(` (and, with `cases: false`, `describe(`) call in a file: none of its own or its
 * describes' modifiers is dead. A row is proved by a CASE title (the default): an id only in a describe's title is
 * proved by nothing that runs, and moving it there leaves a ticked row nothing can turn red.
 */
export function liveTitles(file: string, cases = true): string[] {
  const out: string[] = [];
  const suites = cases ? CASE : SUITE;
  const { program } = parseFile(file);
  // The one helper (`test-titles.ts`): a call of it runs one case per id, live unless a describe around it is dead.
  const binding = cases ? helperBinding(program, file) : undefined;
  walk(program, (node, parents) => {
    if (node.type !== 'CallExpression') return;
    const helped = helperCallTitles(node, binding);
    if (helped !== undefined) {
      if (!parents.some(deadDescribe)) out.push(...helped);
      return;
    }
    const own = callee(node.callee);
    if (own === undefined || !suites.has(own.base) || own.mods.some(m => DEAD.has(m)) || isOff(node.callee)) return;
    const title = titleOf((node.arguments as unknown[])[0]);
    if (title === undefined) return;
    if (!parents.some(deadDescribe)) out.push(title);
  });
  return out;
}

/** A `describe.skip(...)` / `describe.todo(...)` / `describe.if(false)` around a call: nothing inside it runs. */
function deadDescribe(p: AstNode): boolean {
  if (p.type !== 'CallExpression') return false;
  const c = callee(p.callee);
  return c !== undefined && c.base === 'describe' && (c.mods.some(m => DEAD.has(m)) || isOff(p.callee));
}

/** The row id as a whole token (`R-0023` is not inside `R-00231`). */
export const namesRow = (text: string, id: string): boolean =>
  new RegExp(`(?<![A-Za-z0-9-])${id}(?![0-9A-Za-z])`).test(text);

export interface TickContext {
  readonly root: string;
  readonly world: () => RouteWorld;
  /** The JUnit cases of the reports given; undefined when none were. */
  readonly results?: readonly JunitCase[];
  readonly tier?: 'unit' | 'int';
}

/** Why the check cell is not a passing test that names the row, or `undefined`. */
export function testProblem(row: LedgerRow, tc: TickContext): string | undefined {
  const check = row.check.trim();
  if (check === '') return 'empty check cell';
  if (!/(?:^|\/)tests\//.test(check) || !/\.test\.tsx?$/.test(check))
    return `check is not a *.test.ts(x) file under a tests/ folder: ${check}`;
  const path = join(tc.root, check);
  if (!existsSync(path)) return `check path does not exist: ${check}`;
  if (!statSync(path).isFile()) return `check path is not a regular file: ${check}`;
  if (!liveTitles(path).some(title => namesRow(title, row.id)))
    return `no live test() or it() title in ${check} names ${row.id} (a describe() title, a comment, a string elsewhere, or a skipped, todo or only title does not count)`;
  if (tc.results === undefined || (tc.tier !== undefined && inTier(check, tc.tier) === false)) return undefined;
  const mine = tc.results.filter(
    c => (c.file === check || c.file.endsWith(`/${check}`)) && namesRow(c.fullName, row.id),
  );
  // The rule of `guarantees`: a test passed when ANY run of it passed (a quarantined flake rescued on rerun is a pass);
  // it failed only when no run passed and one failed.
  if (mine.some(c => c.status === 'passed')) return undefined;
  if (mine.some(c => c.status === 'failed')) return `the test naming ${row.id} FAILED in the results: ${check}`;
  return `no passing run of a test naming ${row.id} in the results (skipped or not run): ${check}`;
}

/** The reason one ticked row fails, or `undefined`. A route must be proven by a test AND by descriptor-parity. */
export function tickProblem(row: LedgerRow, tc: TickContext): string | undefined {
  const test = testProblem(row, tc);
  const route = row.kind === 'R' ? routeProblem(row, tc.world()) : undefined;
  if (test === undefined) return route;
  return route === undefined ? test : `${test}; ${route}`;
}

export function tickFindings(
  rows: readonly LedgerRow[],
  tc: TickContext,
  known: ReadonlyMap<string, string>,
  frozen: ReadonlySet<string> = FROZEN_IDS,
): Finding[] {
  const out: Finding[] = [];
  const ticked = new Set<string>();
  for (const row of rows) {
    if (!isTicked(row)) continue;
    ticked.add(row.id);
    const problem = tickProblem(row, tc);
    const listed = known.has(row.id);
    if (listed && !frozen.has(row.id))
      out.push({
        check: 'parity-ticks',
        where: row.id,
        message: `listed in ${KNOWN} but not in FROZEN_IDS: the list may only shrink; prove the row instead`,
      });
    else if (problem !== undefined && !listed) out.push({ check: 'parity-ticks', where: row.id, message: problem });
    if (problem === undefined && listed)
      out.push({ check: 'parity-ticks', where: row.id, message: `passes now; remove it from ${KNOWN} and FROZEN_IDS` });
  }
  // The two sets are equal: an id frozen but no longer listed would let a regression be re-added to the list.
  for (const id of frozen)
    if (!known.has(id))
      out.push({
        check: 'parity-ticks',
        where: id,
        message: `in FROZEN_IDS but not listed in ${KNOWN}: delete it from FROZEN_IDS (the two sets must be equal)`,
      });
  for (const id of known.keys())
    if (!ticked.has(id))
      out.push({
        check: 'parity-ticks',
        where: id,
        message: `not a ticked row; remove it from ${KNOWN} and FROZEN_IDS`,
      });
  return out;
}

/** A status that says a row is proved by a test: `proved by its tests J-0052`, `proved by test V-0001, V-0002`. */
const PROVED_BY = /proved by (?:its |the )?tests? ((?:[A-Z]-\d{4}(?:,? |\b))+)/;

/**
 * A row's status that names the test proving it (the `removed by design … proved by its tests J-0052` text) must name
 * one that exists: some tracked `*.test.ts(x)` file holds a LIVE `test(` / `it(` title naming each id. A status is
 * prose nothing else reads, so without this a skipped or deleted test leaves the claim standing.
 */
export function statusProofFindings(
  rows: readonly LedgerRow[],
  files: readonly string[],
  read: (file: string) => string,
  titlesOf: (file: string) => string[],
): Finding[] {
  const out: Finding[] = [];
  const cache = new Map<string, readonly string[]>();
  const named = (id: string): boolean =>
    files.some(file => {
      // A tracked file deleted in the working tree is not a naming file: skip it, never crash the gate.
      const text = (() => {
        try {
          return read(file);
        } catch {
          return undefined;
        }
      })();
      if (text === undefined || !text.includes(id)) return false;
      const titles = cache.get(file) ?? titlesOf(file);
      cache.set(file, titles);
      return titles.some(title => namesRow(title, id));
    });
  for (const row of rows) {
    const claimed = PROVED_BY.exec(row.status)?.[1]?.match(/[A-Z]-\d{4}/g) ?? [];
    for (const id of claimed)
      if (!named(id))
        out.push({
          check: 'parity-ticks',
          where: row.id,
          message: `its status says it is proved by test ${id}, but no live test() or it() title in a tracked test file names ${id} (skipped, todo, only, untitled or deleted)`,
        });
  }
  return out;
}

const trackedTests = (root: string): string[] =>
  execFileSync('git', ['-C', root, 'ls-files', '--', '*.test.ts', '*.test.tsx'], { encoding: 'utf8' })
    .split('\n')
    .filter(file => file !== '');

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
  summary:
    'every [x] in the parity ledger points at a passing test that names its row (and, for a route, descriptor-parity agrees)',
  async run(ctx) {
    const ledger = join(ctx.root, LEDGER);
    if (!existsSync(ledger)) return [{ check: 'parity-ticks', where: LEDGER, message: 'the parity ledger is missing' }];
    const rows = readLedger(readFileSync(ledger, 'utf8'));
    const knownFile = join(ctx.root, KNOWN);
    const known = existsSync(knownFile) ? readKnown(readFileSync(knownFile, 'utf8')) : new Map<string, string>();
    const world = await loadWorld(ctx.root, ctx.model);
    const files = ctx.results === undefined ? undefined : resultFiles(ctx.root, ctx.results);
    if (ctx.results !== undefined && files === undefined)
      return [
        {
          check: 'parity-ticks',
          where: 'results',
          message: 'no JUnit report found at --results, so no test is proven to pass',
        },
      ];
    if (files === undefined)
      console.error(
        'parity-ticks: not verified against results (no --results given); titles are checked, passes are not',
      );
    const results = files?.flatMap(file => junitCases(readFileSync(file, 'utf8')));
    return [
      ...tickFindings(
        rows,
        {
          root: ctx.root,
          world: () => world,
          ...(results === undefined ? {} : { results }),
          ...(ctx.tier === undefined ? {} : { tier: ctx.tier }),
        },
        known,
      ),
      ...statusProofFindings(
        rows,
        trackedTests(ctx.root),
        file => readFileSync(join(ctx.root, file), 'utf8'),
        file => liveTitles(join(ctx.root, file)),
      ),
    ];
  },
};

if (import.meta.main) await runMain(check, process.argv.slice(2));
