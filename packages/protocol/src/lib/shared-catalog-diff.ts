/**
 * "What changed" between two versions of a catalog item (docs/catalogs.md § What changed).
 *
 * ONE PURE FUNCTION, ONE OWNER. The daemon answers it for a publish preview and for a read of two versions, and
 * every reader (`fy`, the app) shows what it answered, so the screen and the write can never disagree.
 *
 * It compares what a person would READ, not the stored bytes: the two review lists of
 * {@link catalogItemReview}, matched by label. The review text is already shown with invisible and
 * text-direction characters marked (`revealHidden`), so a change that only swaps one for another is a visible
 * change here too, and a diff never draws a line a reader cannot see.
 *
 * Bounded, because a skill is up to 2 MiB and the answer is open to a ferret: a file whose shortest edit script
 * is longer than {@link CATALOG_DIFF_MAX_EDITS} lines is `tooLarge` (the full review still shows it whole), and
 * once {@link CATALOG_DIFF_MAX_LINES} lines of diff are out, the rest is `tooLarge` and the answer is `truncated`.
 *
 * Pure and total over items {@link SharedCatalogItemSchema} accepted.
 */
import { z } from 'zod';
import type { SharedCatalogItem } from './shared-catalog.ts';
import {
  type CatalogInstallWarning,
  CatalogInstallWarningSchema,
  type CatalogReviewEntry,
  catalogItemReview,
  catalogItemWarnings,
  isScriptFile,
  runsOnItsOwnPath,
} from './shared-catalog-review.ts';

/** Most lines of edit one file may need before it is not diffed (`tooLarge`). */
export const CATALOG_DIFF_MAX_EDITS = 4_000;

/** Most lines of diff one answer carries in all, hunks and whole added or removed files together. */
export const CATALOG_DIFF_MAX_LINES = 20_000;

/**
 * Work one answer may spend finding differences, in Myers steps (one diagonal visited, plus every line a run of equal
 * lines walks past), across ALL its files. Measured at about 28 ns a step on the development host, so 8 million is
 * about a quarter of a second of one core (a whole preview about 0.45 s): a preview is open to a ferret over a folder it
 * can write, so what a hostile skill can cost is a number, not "as long as it takes".
 */
export const CATALOG_DIFF_MAX_STEPS = 8_000_000;

/** Unchanged lines shown either side of a change. */
export const CATALOG_DIFF_CONTEXT = 3;

export const CatalogChangeLineSchema = z.strictObject({
  kind: z.enum(['context', 'add', 'remove']),
  text: z.string(),
});
export type CatalogChangeLine = z.infer<typeof CatalogChangeLineSchema>;

/** Unified-diff shaped: 1-based start lines, and the lines each side holds in this hunk. */
export const CatalogChangeHunkSchema = z.strictObject({
  beforeStart: z.number().int().min(1),
  beforeLines: z.number().int().min(0),
  afterStart: z.number().int().min(1),
  afterLines: z.number().int().min(0),
  lines: z.array(CatalogChangeLineSchema).readonly(),
});
export type CatalogChangeHunk = z.infer<typeof CatalogChangeHunkSchema>;

/** What deserves a second look: a command or address, a script, or a file a tool obeys on its own. */
export const CatalogChangeFlagSchema = z.enum(['command', 'script', 'runs-on-its-own']);
export type CatalogChangeFlag = z.infer<typeof CatalogChangeFlagSchema>;

export const CatalogChangeSchema = z.strictObject({
  label: z.string().min(1),
  change: z.enum(['added', 'removed', 'changed']),
  document: z.boolean(),
  /** A one-line entry's text before, or a removed file's whole text. */
  before: z.string().optional(),
  /** A one-line entry's text after, or an added file's whole text. */
  after: z.string().optional(),
  /** A changed file, line by line. */
  hunks: z.array(CatalogChangeHunkSchema).readonly().optional(),
  /** Too big to show as a diff: read the whole file in the full review. */
  tooLarge: z.literal(true).optional(),
  flag: CatalogChangeFlagSchema.optional(),
});
export type CatalogChange = z.infer<typeof CatalogChangeSchema>;

export const CatalogChangesSchema = z.strictObject({
  /** What changed, the entries that deserve a second look first. */
  entries: z.array(CatalogChangeSchema).max(512).readonly(),
  /** How many entries are exactly the same on both sides. */
  unchanged: z.number().int().min(0),
  /** Warnings the later version has and the earlier did not. */
  newWarnings: z.array(CatalogInstallWarningSchema).readonly(),
  /** Warnings the earlier version had and the later no longer does. */
  goneWarnings: z.array(CatalogInstallWarningSchema).readonly(),
  /** Some entry was left as `tooLarge` because the answer ran out of lines. */
  truncated: z.literal(true).optional(),
});
export type CatalogChanges = z.infer<typeof CatalogChangesSchema>;

// ── Myers' shortest edit script, over lines ──────────────────────────────────────────────────────

/** What is left of {@link CATALOG_DIFF_MAX_STEPS}; below zero means it ran out. */
export interface DiffBudget {
  remaining: number;
}

export const newDiffBudget = (): DiffBudget => ({ remaining: CATALOG_DIFF_MAX_STEPS });

interface Edit {
  readonly kind: 'context' | 'add' | 'remove';
  readonly text: string;
}

/**
 * The lines edited to turn `before` into `after`, or `undefined` when that takes more than `limit` single-line
 * edits. Common leading and trailing lines are set aside first, so a small change in a big file is cheap.
 *
 * Stops at once (`undefined`) when the two lengths differ by more than `limit` (the script is at least that long),
 * and when `budget` runs out.
 *
 * The trace keeps, for each step `d`, the furthest-reaching x for diagonals -d, -d+2 … d, so at the bound it
 * holds about `limit² / 2` numbers and no more.
 */
export function lineEdits(
  before: readonly string[],
  after: readonly string[],
  limit: number,
  budget: DiffBudget = newDiffBudget(),
): readonly Edit[] | undefined {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  )
    tail += 1;
  const a = before.slice(head, before.length - tail);
  const b = after.slice(head, after.length - tail);
  const middle = middleEdits(a, b, limit, budget);
  if (middle === undefined) return undefined;
  return [
    ...before.slice(0, head).map((text): Edit => ({ kind: 'context', text })),
    ...middle,
    ...before.slice(before.length - tail).map((text): Edit => ({ kind: 'context', text })),
  ];
}

function middleEdits(
  a: readonly string[],
  b: readonly string[],
  limit: number,
  budget: DiffBudget,
): readonly Edit[] | undefined {
  const n = a.length;
  const m = b.length;
  if (Math.abs(n - m) > limit) return undefined;
  const max = Math.min(n + m, limit);
  const offset = max + 1;
  const furthest = new Int32Array(2 * max + 3);
  // trace[d][(k + d) / 2]: the x reached on diagonal k after d edits.
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found === -1; d += 1) {
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && (furthest[offset + k - 1] as number) < (furthest[offset + k + 1] as number))
          ? (furthest[offset + k + 1] as number)
          : (furthest[offset + k - 1] as number) + 1;
      let y = x - k;
      let walked = 1;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
        walked += 1;
      }
      budget.remaining -= walked;
      if (budget.remaining < 0) return undefined;
      furthest[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found === -1) {
      const snapshot = new Int32Array(d + 1);
      for (let index = 0; index <= d; index += 1) snapshot[index] = furthest[offset - d + 2 * index] as number;
      trace.push(snapshot);
    }
  }
  if (found === -1) return undefined;

  const reversed: Edit[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d -= 1) {
    const previous = trace[d - 1] as Int32Array;
    const at = (diagonal: number): number => previous[(diagonal + d - 1) / 2] as number;
    const k = x - y;
    const fromK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const fromX = at(fromK);
    const fromY = fromX - fromK;
    while (x > fromX && y > fromY) {
      reversed.push({ kind: 'context', text: a[x - 1] as string });
      x -= 1;
      y -= 1;
    }
    if (x === fromX) {
      reversed.push({ kind: 'add', text: b[y - 1] as string });
      y -= 1;
    } else {
      reversed.push({ kind: 'remove', text: a[x - 1] as string });
      x -= 1;
    }
  }
  return reversed.toReversed();
}

/** The edits grouped into hunks of changed lines with {@link CATALOG_DIFF_CONTEXT} unchanged lines either side. */
export function hunksOf(edits: readonly Edit[]): readonly CatalogChangeHunk[] {
  const near = new Array<boolean>(edits.length).fill(false);
  let since = Number.POSITIVE_INFINITY;
  edits.forEach((edit, index) => {
    since = edit.kind === 'context' ? since + 1 : 0;
    if (since <= CATALOG_DIFF_CONTEXT) near[index] = true;
  });
  let until = Number.POSITIVE_INFINITY;
  for (let index = edits.length - 1; index >= 0; index -= 1) {
    until = (edits[index] as Edit).kind === 'context' ? until + 1 : 0;
    if (until <= CATALOG_DIFF_CONTEXT) near[index] = true;
  }

  const hunks: CatalogChangeHunk[] = [];
  let beforeSeen = 0;
  let afterSeen = 0;
  let open: { lines: CatalogChangeLine[]; beforeStart: number; afterStart: number } | undefined;
  const close = (): void => {
    if (open === undefined) return;
    hunks.push({
      beforeStart: open.beforeStart,
      beforeLines: open.lines.filter(line => line.kind !== 'add').length,
      afterStart: open.afterStart,
      afterLines: open.lines.filter(line => line.kind !== 'remove').length,
      lines: open.lines,
    });
    open = undefined;
  };
  edits.forEach((edit, index) => {
    if (near[index] === true) {
      open ??= { lines: [], beforeStart: beforeSeen + 1, afterStart: afterSeen + 1 };
      open.lines.push({ kind: edit.kind, text: edit.text });
    } else close();
    if (edit.kind !== 'add') beforeSeen += 1;
    if (edit.kind !== 'remove') afterSeen += 1;
  });
  close();
  return hunks;
}

// ── The comparison ───────────────────────────────────────────────────────────────────────────────

const SKILL_FILE_PREFIX = 'Skill file ';

const filesOf = (item: SharedCatalogItem): ReadonlyMap<string, string> =>
  new Map(item.kind === 'skill' ? item.skill.files.map(file => [file.path, file.content]) : []);

/** What deserves a second look about an entry, from either side it exists on. */
function flagOf(label: string, sides: readonly ReadonlyMap<string, string>[]): CatalogChange['flag'] {
  if (label === 'Starts' || label === 'Reaches' || label.startsWith('Environment ')) return 'command';
  if (!label.startsWith(SKILL_FILE_PREFIX)) return undefined;
  const path = label.slice(SKILL_FILE_PREFIX.length);
  if (runsOnItsOwnPath(path)) return 'runs-on-its-own';
  return sides.some(side => side.has(path) && isScriptFile({ path, content: side.get(path) as string }))
    ? 'script'
    : undefined;
}

const CARRIAGE_RETURN_MARK = '⟨U+000D⟩';

/** A line's end is where a CRLF becomes an LF, so a carriage return there is written out like any hidden character. */
const textLines = (text: string): readonly string[] =>
  text.split('\n').map(line => (line.endsWith('\r') ? `${line.slice(0, -1)}${CARRIAGE_RETURN_MARK}` : line));

const warningKey = (warning: CatalogInstallWarning): string => JSON.stringify([warning.code, warning.text]);

const warningsMissingFrom = (
  warnings: readonly CatalogInstallWarning[],
  other: readonly CatalogInstallWarning[],
): readonly CatalogInstallWarning[] => {
  const seen = new Set(other.map(warningKey));
  return warnings.filter(warning => !seen.has(warningKey(warning)));
};

/** An entry before its flag and the lines it costs are known. */
interface Compared {
  readonly change: CatalogChange;
  readonly lines: number;
}

function compare(
  label: string,
  before: CatalogReviewEntry | undefined,
  after: CatalogReviewEntry | undefined,
  flag: CatalogChange['flag'],
  budget: DiffBudget,
): Compared | undefined {
  const flagged = flag === undefined ? {} : { flag };
  if (before === undefined && after !== undefined)
    return {
      change: { label, change: 'added', document: after.document, after: after.text, ...flagged },
      lines: after.document ? textLines(after.text).length : 0,
    };
  if (after === undefined && before !== undefined)
    return {
      change: { label, change: 'removed', document: before.document, before: before.text, ...flagged },
      lines: before.document ? textLines(before.text).length : 0,
    };
  if (before === undefined || after === undefined || before.text === after.text) return undefined;
  if (!before.document && !after.document)
    return {
      change: { label, change: 'changed', document: false, before: before.text, after: after.text, ...flagged },
      lines: 0,
    };
  const edits =
    budget.remaining < 0
      ? undefined
      : lineEdits(textLines(before.text), textLines(after.text), CATALOG_DIFF_MAX_EDITS, budget);
  if (edits === undefined)
    return { change: { label, change: 'changed', document: true, tooLarge: true, ...flagged }, lines: 0 };
  const hunks = hunksOf(edits);
  return {
    change: { label, change: 'changed', document: true, hunks, ...flagged },
    lines: hunks.reduce((total, hunk) => total + hunk.lines.length, 0),
  };
}

/** The same entry with its text left out, because the answer has no lines left for it. */
function leftOut(change: CatalogChange): CatalogChange {
  return {
    label: change.label,
    change: change.change,
    document: change.document,
    tooLarge: true,
    ...(change.flag === undefined ? {} : { flag: change.flag }),
  };
}

/**
 * What a person would read differently in `after` than in `before`: entries added, removed and changed (the ones
 * that deserve a second look first), how many are the same, and the warnings that appeared or went away.
 *
 * ONE `budget` covers every file: once it runs out, each file still to be compared is `tooLarge` without being
 * read, and the answer says `truncated`.
 */
export function catalogItemChanges(
  before: SharedCatalogItem,
  after: SharedCatalogItem,
  budget: DiffBudget = newDiffBudget(),
): CatalogChanges {
  const earlier = new Map(catalogItemReview(before).map(entry => [entry.label, entry]));
  const later = new Map(catalogItemReview(after).map(entry => [entry.label, entry]));
  const sides = [filesOf(before), filesOf(after)];
  const labels = [...later.keys(), ...[...earlier.keys()].filter(label => !later.has(label))];

  const compared: Compared[] = [];
  let unchanged = 0;
  for (const label of labels) {
    const found = compare(label, earlier.get(label), later.get(label), flagOf(label, sides), budget);
    if (found === undefined) unchanged += 1;
    else compared.push(found);
  }
  const ordered = [
    ...compared.filter(found => found.change.flag !== undefined),
    ...compared.filter(found => found.change.flag === undefined),
  ];

  let remaining = CATALOG_DIFF_MAX_LINES;
  let truncated = budget.remaining < 0;
  const entries = ordered.map(found => {
    if (found.lines <= remaining) {
      remaining -= found.lines;
      return found.change;
    }
    truncated = true;
    return leftOut(found.change);
  });

  const warningsBefore = catalogItemWarnings(before);
  const warningsAfter = catalogItemWarnings(after);
  return {
    entries,
    unchanged,
    newWarnings: warningsMissingFrom(warningsAfter, warningsBefore),
    goneWarnings: warningsMissingFrom(warningsBefore, warningsAfter),
    ...(truncated ? { truncated: true as const } : {}),
  };
}
