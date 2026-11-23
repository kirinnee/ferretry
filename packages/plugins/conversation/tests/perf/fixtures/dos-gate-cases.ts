/**
 * THE INPUTS OF THE DURIAN GATE (`tests/perf/hypermedia-dos-gate.test.ts`), kept here and nowhere else: no commit message, PR body
 * or issue carries a payload. Every case is a chart or a message a reviewer or the gate's author wrote to make the parser (or the
 * expression evaluator under it) do far more work than its size suggests; the gate holds the pinned Durian to doing bounded work
 * on each. A case is data: a name, a text, and the time it may take.
 *
 * The first five are the five of the chart gate that gated the 0.6.1 re-pin (two reviewer charts, three scale-ups of them); the
 * rest are at the edges of the caps `UNTRUSTED_LIMITS` sets.
 */

const FENCE = '`'.repeat(3);
const fenced = (...body: readonly string[]): string => [`${FENCE}chart`, ...body, FENCE].join('\n');

/** 417 bytes: user functions calling user functions over a 10,000-item list. */
const functions = ((): string => {
  const defs = ['  a: range(1,10000)', '  h0(x): x+x'];
  for (let level = 1; level <= 14; level++) defs.push(`  h${level}(x): h${level - 1}(x)+h${level - 1}(x)`);
  return fenced('kind: line', 'let:', ...defs, '  b: h14(a)', 'x: a', 'series:', '  - name: s', '    data: b');
})();

/** Nested `fill`: `n` cubed values asked for from 100 bytes of text. */
const fill = (n: number): string =>
  fenced(
    'kind: line',
    'let:',
    `  big: fill(fill(fill(1,${n}),${n}),${n})+1`,
    'x: [1]',
    'series:',
    '  - name: s',
    '    data: big',
  );

/** Four of the deep definitions in one chart: the budget is the chart's, not each definition's. */
const fourDefs = ((): string => {
  const defs = ['  a: range(1,10000)', '  h0(x): x+x'];
  for (let level = 1; level <= 14; level++) defs.push(`  h${level}(x): h${level - 1}(x)+h${level - 1}(x)`);
  for (let at = 1; at <= 4; at++) defs.push(`  b${at}: h14(a)`);
  return fenced('kind: line', 'let:', ...defs, 'x: a', 'series:', '  - name: s', '    data: b1');
})();

/** Eight of the first chart in one message: the budget is the message's, not each chart's. */
const manyCharts = Array.from({ length: 8 }, () => functions).join('\n\n');

/** A chart whose one flow list has `values` numbers: its YAML is the size of the list. */
const listChart = (values: number): string =>
  fenced(
    'kind: line',
    'series:',
    '  - name: s',
    `    data: [${Array.from({ length: values }, (_, at) => at).join(', ')}]`,
  );

/** Neutral prose of about `bytes` bytes: sentences with emphasis, a link and a code span, in paragraphs. */
const prose = (bytes: number): string => {
  const paragraph =
    'A **bold** word and an _italic_ one, a [link](https://example.com/a) and `code`, then plain words to make a real sentence. ';
  const paragraphs: string[] = [];
  for (let size = 0; size < bytes; size += paragraph.length * 3 + 2) paragraphs.push(paragraph.repeat(3));
  return paragraphs.join('\n\n');
};

export interface DosCase {
  readonly name: string;
  readonly text: string;
  /** The most one parse may take, in milliseconds (the best of the runs). */
  readonly budgetMs: number;
}

/** The chart bar: the same 50 ms the Chromium test holds a message's read to. */
const CHART_MS = 50;

export const DOS_CASES: readonly DosCase[] = [
  { name: 'nested user functions (h14)', text: functions, budgetMs: CHART_MS },
  { name: 'nested fill 300^3', text: fill(300), budgetMs: CHART_MS },
  { name: 'nested fill 1000^3', text: fill(1000), budgetMs: CHART_MS },
  { name: 'four h14 definitions in one chart', text: fourDefs, budgetMs: CHART_MS },
  { name: 'eight h14 charts in one message', text: manyCharts, budgetMs: CHART_MS },
  // At the edges of UNTRUSTED_LIMITS: a chart whose YAML is just under the per-text node cap, and a message of four of them (over the page's).
  { name: 'one chart just under the YAML node cap', text: listChart(970), budgetMs: CHART_MS },
  {
    name: 'four charts just under the page YAML cap',
    text: Array.from({ length: 4 }, () => listChart(970)).join('\n\n'),
    budgetMs: CHART_MS,
  },
  // The largest message the chat reads at all (`MESSAGE_LIMITS`): ordinary prose, bounded by the worker's kill budget, not the chart bar.
  { name: 'ordinary prose at the message cap', text: prose(290_000), budgetMs: 250 },
];

/** The most memory (resident set, in MB) one parse may add. */
export const MAX_GROWTH_MB = 64;

/** What one read of a message did, as the worker reports it. */
export interface Read {
  readonly ms: number;
  readonly grewMb: number;
  readonly threw: boolean;
  readonly outcome: readonly string[];
}

/**
 * The gate's verdict on one read, pure: the lines a failing run prints, empty when it is within budget. It is its own function so the
 * test can prove the gate CAN fail (a gate that cannot is not one): see `hypermedia-dos-gate.test.ts`.
 */
export const overBudget = (read: Read, budgetMs: number): string[] => [
  ...(read.threw ? [`threw: ${read.outcome.join(' ')}`] : []),
  ...(read.ms >= budgetMs ? [`took ${read.ms.toFixed(1)} ms, over the ${budgetMs} ms budget`] : []),
  ...(read.grewMb >= MAX_GROWTH_MB ? [`grew ${read.grewMb.toFixed(0)} MB, over the ${MAX_GROWTH_MB} MB budget`] : []),
];
