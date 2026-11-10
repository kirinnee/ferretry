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

/** The base baseline: a git ref's committed file, or `file:<path>`; undefined when the base has none yet. */
function readBase(root: string, ref: string): AfterMerge | undefined {
  if (ref.startsWith('file:')) {
    const file = ref.slice(5);
    return existsSync(file) ? parseAfterMerge(readFileSync(file, 'utf8'), file) : undefined;
  }
  const shown = spawnSync('git', ['show', `${ref}:${AFTER_MERGE_JSON}`], { cwd: root, encoding: 'utf8' });
  if (shown.status !== 0) return undefined;
  return parseAfterMerge(shown.stdout, `${ref}:${AFTER_MERGE_JSON}`);
}

/** Parity rows still open (`[ ]`) in the generated parity table. */
export function parityOpen(root: string): number {
  const file = join(root, PARITY_TSV);
  if (!existsSync(file)) return 0;
  const [header = '', ...rows] = readFileSync(file, 'utf8').split('\n');
  const status = header.split('\t').indexOf('status');
  if (status < 0) throw new Error(`${PARITY_TSV}: no "status" column`);
  return rows.filter(row => row.split('\t')[status] === '[ ]').length;
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
    if (item.id !== '' && !before.has(item.id)) at(`${item.id} was added; the list may only go down`);
  if (head.end > base.end) at(`the end date moved from ${base.end} to ${head.end}; only the owner moves it`);
  return findings;
}

export const check: Check = {
  name: CHECK,
  summary: 'the 5.0 after-merge list (docs/rebuild/after-merge.json) only goes down',
  async run(ctx) {
    const file = join(ctx.root, AFTER_MERGE_JSON);
    if (!existsSync(file)) return [];
    let head: AfterMerge;
    let base: AfterMerge | undefined;
    try {
      head = parseAfterMerge(readFileSync(file, 'utf8'), AFTER_MERGE_JSON);
      base = readBase(ctx.root, ctx.base ?? 'origin/rebuild/5.0');
    } catch (error) {
      return [
        { check: CHECK, where: AFTER_MERGE_JSON, message: error instanceof Error ? error.message : String(error) },
      ];
    }
    const missing = await guarantees.run({ ...ctx, packageId: undefined, strict: true, existenceOnly: true });
    return afterMergeFindings(head, base, {
      parityOpen: parityOpen(ctx.root),
      portsPendingLines: portsPendingLines(ctx.root),
      guaranteesMissing: missing.length,
    });
  },
};

if (import.meta.main) await runMain(check, process.argv.slice(2));
