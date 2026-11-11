/**
 * `after-merge` (the 5.0 merge bar, docs/rebuild/merge-bar.md): the after-merge list may only go DOWN.
 *
 * `docs/rebuild/after-merge.json` is the committed baseline of what 5.0 merged without: open parity rows, ports-pending
 * lines, missing Appendix D tests, and named items with an owner each. Findings when:
 *
 * - a baseline count grew, an item was added or the end date moved later, against the base ref
 *   (default `origin/rebuild/5.0`, or `file:<path>`, like `ports-pending`);
 * - the tree holds more than the baseline says (open parity rows, ports-pending lines, missing id-named tests);
 * - an item has no id, no words or no owner, or two items share an id.
 *
 * A count that went down needs no edit here: the baseline is a ceiling, and lowering it is how the list is closed.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Check, type Finding, runMain } from '../gen/lib/check.ts';
import { check as guarantees } from './guarantees.ts';
import { readPending } from './ports-pending.ts';

export const AFTER_MERGE_JSON = 'docs/rebuild/after-merge.json';
const PARITY_TSV = 'docs/design/rebuild-parity.tsv';
const CHECK = 'after-merge';
/** The one `guarantees` finding this count is about: a kept row with no id-named test. */
const MISSING_TEST = / has no test named "/;

/**
 * Items that may enter the list although it only goes down: each was moved from before merge to after it by a named
 * owner decision, never by a builder. Delete the entry once the base lists the id, so a closed item cannot come back.
 */
export const OWNER_MOVED_ITEMS: readonly { readonly id: string; readonly decision: string }[] = [
  { id: 'differential-harness', decision: '!A481: the harness moves after merge for the Wednesday merge' },
  {
    id: 'imports-descriptor-darwin',
    decision:
      'britnee 2026-11-10: the imports descriptor read ships with its darwin run after merge (no paid macOS run)',
  },
  {
    id: 'kernel-roots-int-coverage',
    decision: 'britnee 2026-11-10: the roots.ts ~70% integration gap goes in followups as after-merge',
  },
  {
    id: 'followups-sweep-after-merge',
    decision: 'britnee 2026-11-10: the rest of the followups sweep moves to after merge, owner gustavo',
  },
  {
    id: 'links-keep-history-parse-worker',
    decision: 'lizzette 2026-11-11: links/keep/history/parse worker move after merge (card &F3447)',
  },
  {
    id: 'coverage-lag',
    decision: '!A484: the coverage lag (12 unit batches + 40 int files, #32 CI-only proof) moves after merge',
  },
];

export const COUNT_NAMES = ['parityOpen', 'portsPendingLines', 'guaranteesMissing'] as const;
export type CountName = (typeof COUNT_NAMES)[number];
export type Counts = Readonly<Record<CountName, number>>;

export interface AfterMergeItem {
  readonly id: string;
  readonly what: string;
  readonly owner: string;
}

export interface AfterMerge {
  readonly format: 1;
  /** The one end date (YYYY-MM-DD) the list is due by. */
  readonly end: string;
  readonly counts: Counts;
  readonly items: readonly AfterMergeItem[];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Parses the baseline; a shape it cannot read throws a sentence naming `where`. */
export function parseAfterMerge(source: string, where: string): AfterMerge {
  const value = JSON.parse(source) as { format?: unknown; end?: unknown; counts?: unknown; items?: unknown };
  if (value.format !== 1) throw new Error(`${where}: format is not 1`);
  if (typeof value.end !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.end))
    throw new Error(`${where}: "end" is not a YYYY-MM-DD date`);
  const given = value.counts as Record<string, unknown> | undefined;
  if (typeof given !== 'object' || given === null || Array.isArray(given))
    throw new Error(`${where}: "counts" is not an object`);
  const counts = {} as Record<CountName, number>;
  for (const name of COUNT_NAMES) {
    const count = given[name];
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0)
      throw new Error(`${where}: "counts.${name}" is not a whole number`);
    counts[name] = count;
  }
  if (!Array.isArray(value.items)) throw new Error(`${where}: "items" is not a list`);
  const items = value.items.map(item => {
    const row = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    return { id: text(row.id), what: text(row.what), owner: text(row.owner) };
  });
  return { format: 1, end: value.end, counts, items };
}

/**
 * The base baseline: a git ref's committed file, or `file:<path>`; undefined when the base has none yet. A base that
 * was NAMED (`--base`, or CI's `FY_CHECK_BASE`) but is not in this clone throws: comparing against nothing there
 * would pass the very change the rule exists to stop. The unnamed default may be absent (a local clone without it).
 */
export function readBase(root: string, ref: string, named: boolean): AfterMerge | undefined {
  if (ref.startsWith('file:')) {
    const file = ref.slice(5);
    return existsSync(file) ? parseAfterMerge(readFileSync(file, 'utf8'), file) : undefined;
  }
  const known = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: root });
  if (known.status !== 0) {
    if (named)
      throw new Error(`the base ${ref} is not in this clone, so nothing proves the list did not grow; fetch it`);
    return undefined;
  }
  const shown = spawnSync('git', ['show', `${ref}:${AFTER_MERGE_JSON}`], { cwd: root, encoding: 'utf8' });
  if (shown.status !== 0) return undefined;
  return parseAfterMerge(shown.stdout, `${ref}:${AFTER_MERGE_JSON}`);
}

/** Parity rows still open in the generated parity table: a status that starts with `[ ]`, note or not. */
export function parityOpen(root: string): number {
  const file = join(root, PARITY_TSV);
  if (!existsSync(file)) return 0;
  const [header = '', ...rows] = readFileSync(file, 'utf8').split('\n');
  const status = header.split('\t').indexOf('status');
  if (status < 0) throw new Error(`${PARITY_TSV}: no "status" column`);
  return rows.filter(row => (row.split('\t')[status] ?? '').startsWith('[ ]')).length;
}

/** Every open-gap line `ports-pending.json` states. */
export function portsPendingLines(root: string): number {
  return Object.values(readPending(root).reasons).reduce((sum, lines) => sum + lines.length, 0);
}

/** The pure rule: the baseline against its base, and the tree against the baseline. */
export function afterMergeFindings(head: AfterMerge, base: AfterMerge | undefined, actual: Counts): Finding[] {
  const findings: Finding[] = [];
  const at = (message: string): void => {
    findings.push({ check: CHECK, where: AFTER_MERGE_JSON, message });
  };
  const seen = new Set<string>();
  for (const [index, item] of head.items.entries()) {
    const name = item.id === '' ? `item ${index + 1}` : item.id;
    if (item.id === '') at(`${name} has no id`);
    if (item.what === '') at(`${name} does not say what is left`);
    if (item.owner === '') at(`${name} has no owner; every after-merge item keeps one`);
    if (item.id !== '' && seen.has(item.id)) at(`${item.id} is listed twice`);
    seen.add(item.id);
  }
  for (const name of COUNT_NAMES)
    if (actual[name] > head.counts[name])
      at(`${name} is ${actual[name]} in the tree but the baseline is ${head.counts[name]}; the list may only go down`);
  if (base === undefined) return findings;
  for (const name of COUNT_NAMES)
    if (head.counts[name] > base.counts[name])
      at(`counts.${name} grew from ${base.counts[name]} to ${head.counts[name]}; the list may only go down`);
  const before = new Set(base.items.map(item => item.id));
  for (const item of head.items)
    if (item.id !== '' && !before.has(item.id) && !OWNER_MOVED_ITEMS.some(moved => moved.id === item.id))
      at(`${item.id} was added; the list may only go down`);
  if (head.end > base.end) at(`the end date moved from ${base.end} to ${head.end}; only the owner moves it`);
  return findings;
}

export const check: Check = {
  name: CHECK,
  summary: 'the 5.0 after-merge list (docs/rebuild/after-merge.json) only goes down',
  async run(ctx) {
    const file = join(ctx.root, AFTER_MERGE_JSON);
    if (!existsSync(file)) return [];
    try {
      const head = parseAfterMerge(readFileSync(file, 'utf8'), AFTER_MERGE_JSON);
      const base = readBase(ctx.root, ctx.base ?? 'origin/rebuild/5.0', ctx.base !== undefined);
      const found = await guarantees.run({
        ...ctx,
        packageId: undefined,
        tier: undefined,
        strict: true,
        existenceOnly: true,
      });
      return afterMergeFindings(head, base, {
        parityOpen: parityOpen(ctx.root),
        portsPendingLines: portsPendingLines(ctx.root),
        guaranteesMissing: found.filter(finding => MISSING_TEST.test(finding.message)).length,
      });
    } catch (error) {
      return [
        { check: CHECK, where: AFTER_MERGE_JSON, message: error instanceof Error ? error.message : String(error) },
      ];
    }
  },
};

if (import.meta.main) await runMain(check, process.argv.slice(2));
