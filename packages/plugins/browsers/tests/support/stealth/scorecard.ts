import type { Reading } from './scorers.ts';

/** What one run saw on one check page. */
export interface Observation {
  readonly check: string;
  readonly reading: Reading;
}

/** One observation, with the layer (Browser mode) and run number it came from. */
export interface Entry {
  readonly mode: string;
  readonly run: number;
  readonly observation: Observation;
}

type Value = number | string | boolean;

/** A check's verdict over all the runs of a layer: the median, never the best. */
interface CheckCard {
  readonly check: string;
  /** `unreadable` when no run produced a score: a page nobody could read is never a pass. */
  readonly verdict: 'pass' | 'fail' | 'unreadable';
  readonly runs: number;
  readonly passes: number;
  readonly unreadable: number;
  /** The median of each number the scorer reported (the commonest value of a word or a flag). */
  readonly numbers: Readonly<Record<string, Value>>;
  /** Every named test that failed in at least one run. */
  readonly failed: readonly string[];
  /** Why the runs that could not be read could not (distinct reasons). */
  readonly reasons: readonly string[];
}

interface LayerCard {
  readonly mode: string;
  readonly checks: readonly CheckCard[];
  /** Checks whose verdict is `pass`, over every check in the layer. */
  readonly passed: number;
  readonly total: number;
  readonly score: number;
}

export interface Scorecard {
  readonly label: string;
  readonly layers: readonly LayerCard[];
}

/** The middle of the sorted values (the lower middle of an even count, so it is always a value that was seen). */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted[Math.floor((sorted.length - 1) / 2)];
  if (middle === undefined) throw new Error('the median of nothing is not a number');
  return middle;
}

function commonest(values: readonly Value[]): Value {
  const counts = new Map<Value, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (best === undefined) throw new Error('the commonest of nothing is not a value');
  return best[0];
}

function cardFor(check: string, observations: readonly Observation[]): CheckCard {
  const scored = observations.flatMap(({ reading }) => (reading.kind === 'scored' ? [reading] : []));
  const unreadable = observations.flatMap(({ reading }) => (reading.kind === 'unreadable' ? [reading.reason] : []));
  const passes = scored.filter(reading => reading.pass).length;
  const keys = [...new Set(scored.flatMap(reading => Object.keys(reading.numbers)))].sort();
  const numbers: Record<string, Value> = {};
  for (const key of keys) {
    const seen = scored.flatMap(reading => (key in reading.numbers ? [reading.numbers[key] as Value] : []));
    numbers[key] = seen.every(value => typeof value === 'number') ? median(seen as number[]) : commonest(seen);
  }
  const verdict = scored.length === 0 ? 'unreadable' : passes * 2 > observations.length ? 'pass' : 'fail';
  return {
    check,
    verdict,
    runs: observations.length,
    passes,
    unreadable: unreadable.length,
    numbers,
    failed: [...new Set(scored.flatMap(reading => reading.failed))].sort(),
    reasons: [...new Set(unreadable)].sort(),
  };
}

/** Fold every run's observations into one card per layer; the suite score of a layer is passes over checks. */
export function scorecard(label: string, entries: readonly Entry[]): Scorecard {
  const modes = [...new Set(entries.map(entry => entry.mode))];
  return {
    label,
    layers: modes.map(mode => {
      const here = entries.filter(entry => entry.mode === mode);
      const ids = [...new Set(here.map(entry => entry.observation.check))];
      const checks = ids.map(id =>
        cardFor(
          id,
          here.filter(entry => entry.observation.check === id).map(entry => entry.observation),
        ),
      );
      const passed = checks.filter(card => card.verdict === 'pass').length;
      return { mode, checks, passed, total: checks.length, score: checks.length === 0 ? 0 : passed / checks.length };
    }),
  };
}

const cell = (card: CheckCard | undefined): string => {
  if (card === undefined) return '-';
  const word = card.verdict === 'unreadable' ? 'COULD NOT READ' : card.verdict.toUpperCase();
  return `${word} (${String(card.passes)}/${String(card.runs)})`;
};

/** A plain-text table: one row per check, one column per layer, then each layer's suite score. */
export function renderTable(card: Scorecard): string {
  const ids = [...new Set(card.layers.flatMap(layer => layer.checks.map(each => each.check)))];
  const header = ['check', ...card.layers.map(layer => layer.mode)];
  const rows = ids.map(id => [id, ...card.layers.map(layer => cell(layer.checks.find(each => each.check === id)))]);
  const footer = ['SUITE SCORE', ...card.layers.map(layer => `${String(layer.passed)}/${String(layer.total)}`)];
  const all = [header, ...rows, footer];
  const widths = header.map((_, column) => Math.max(...all.map(row => (row[column] ?? '').length)));
  const line = (row: readonly string[]): string =>
    row.map((text, column) => text.padEnd(widths[column] ?? 0)).join('  ');
  return [
    `scorecard: ${card.label}`,
    line(header),
    line(widths.map(width => '-'.repeat(width))),
    ...rows.map(line),
    line(footer),
  ].join('\n');
}
