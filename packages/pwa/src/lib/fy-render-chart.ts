/**
 * The `type: chart` payload, read: this package's own small chart language in, a bounded drawing plan out.
 *
 * IT IS NOT A CHART.JS CONFIG. An author writes what the chart SAYS — a kind, labels, series, a value
 * format — and never how it is painted. There is no key for a colour, a font, a callback or a plugin: a
 * series asks for a `tone` (a role the theme defines) or a palette slot, and the renderer resolves both
 * from the app's own tokens at draw time. So a chart follows the reader's theme by construction, and no
 * author string ever reaches Chart.js as anything but a label drawn with `fillText`.
 *
 * ONE READER, NEVER A THROW. {@link readChart} returns `{ ok: false, reason }` for anything it will not
 * draw — malformed YAML, an unknown key, a value off the schema, a cap exceeded — and the block then shows
 * its authored source as the ordinary code fence, the same quiet fallback every other type has.
 *
 * It parses with `yaml` (JSON is a YAML subset) with aliases refused, so no document expands past its
 * bytes, then with a strict zod schema: an unknown key is a refusal rather than something silently
 * ignored, which is how an author who wrote `color:` learns it does nothing. Pure — no DOM, no `Intl`
 * state beyond the formatters below, no network.
 */

import { parse } from 'yaml';
import { z } from 'zod';
import { FY_RENDER_LIMITS } from './fy-render-bounds.ts';
import { CHART_FORMATS, type ChartFormat } from './fy-render-chart-format.ts';
import { CHART_PALETTE_SLOTS } from './fy-render-palette.ts';

export { formatChartValue } from './fy-render-chart-format.ts';

const CHART_KINDS = ['line', 'bar', 'area', 'pie', 'doughnut', 'scatter', 'radar'] as const;
type ChartKind = (typeof CHART_KINDS)[number];

/** The theme roles a series may ask for by name. */
const CHART_TONES = ['accent', 'good', 'warn', 'bad', 'muted'] as const;
type ChartToneName = (typeof CHART_TONES)[number];

/** A series colour: a named role, or a 1-based palette slot. Never a colour value. */
export type ChartTone = ChartToneName | number;

interface ChartPoint {
  readonly x: number;
  readonly y: number;
}

interface ChartSeries {
  readonly name: string;
  readonly tone: ChartTone;
  /** A per-series override on a line, area or bar chart: a line over bars, or bars under a line. */
  readonly kind: 'line' | 'bar' | null;
  /** Category charts: one value per label, `null` for a gap. */
  readonly values: readonly (number | null)[];
  /** Scatter only. */
  readonly points: readonly ChartPoint[];
}

export interface ChartFrame {
  /** A step's own name, shown beside the step controls. `null` for a chart without frames. */
  readonly label: string | null;
  readonly title: string | null;
  readonly labels: readonly string[];
  readonly series: readonly ChartSeries[];
}

export interface ChartAxis {
  readonly label: string | null;
  readonly format: ChartFormat;
  /** ISO 4217, for `money`. */
  readonly currency: string;
  readonly min: number | null;
  readonly max: number | null;
}

export interface ChartSpec {
  readonly kind: ChartKind;
  readonly stacked: boolean;
  readonly horizontal: boolean;
  readonly x: ChartAxis;
  readonly y: ChartAxis;
  /** At least one. A chart without `frames` is one frame. */
  readonly frames: readonly ChartFrame[];
}

export type ChartReading =
  | { readonly ok: true; readonly spec: ChartSpec }
  | { readonly ok: false; readonly reason: string };

const L = FY_RENDER_LIMITS;

/** One line of text, inside a cap, with no control characters. */
const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing exactly the C0 controls and DEL
    .refine(value => !/[\u0000-\u001f\u007f]/u.test(value), 'must be one line of plain text');

/** A category label: YAML reads `2024` as a number, which is still a label. */
const label = z.union([text(L.chartLabelCharacters), z.number().transform(value => String(value))]);

const format = z.enum(CHART_FORMATS);
const tone = z.union([z.enum(CHART_TONES), z.number().int().min(1).max(CHART_PALETTE_SLOTS)]);
const finite = z.number();
const pair = z.tuple([finite, finite]).transform(([x, y]) => ({ x, y }));
const point = z.union([pair, z.strictObject({ x: finite, y: finite })]);

const series = z.strictObject({
  data: z.union([z.array(finite.nullable()).max(L.chartPoints), z.array(point).max(L.chartPoints)]),
  kind: z.enum(['line', 'bar']).optional(),
  name: text(L.chartLabelCharacters),
  tone: tone.optional(),
});
const seriesList = z.array(series).min(1).max(L.chartSeries);
const labels = z.array(label).max(L.chartLabels);

const axis = z.strictObject({
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/u, 'must be a three-letter ISO 4217 code')
    .optional(),
  format: format.optional(),
  label: text(L.chartLabelCharacters).optional(),
  max: finite.optional(),
  min: finite.optional(),
});

const xAxis = z.union([labels, axis.extend({ values: labels.optional() }).strict()]);

const frame = z.strictObject({
  label: text(L.chartLabelCharacters),
  series: seriesList.optional(),
  title: text(L.chartTitleCharacters).optional(),
  x: labels.optional(),
});

const document = z.strictObject({
  frames: z.array(frame).min(1).max(L.chartFrames).optional(),
  horizontal: z.boolean().optional(),
  kind: z.enum(CHART_KINDS),
  series: seriesList,
  stacked: z.boolean().optional(),
  title: text(L.chartTitleCharacters).optional(),
  x: xAxis.optional(),
  y: axis.optional(),
});

type Document = z.infer<typeof document>;
type RawSeries = z.infer<typeof series>;

class Refusal extends Error {}

const axisOf = (raw: z.infer<typeof axis> | undefined): ChartAxis => ({
  currency: raw?.currency ?? 'USD',
  format: raw?.format ?? 'number',
  label: raw?.label ?? null,
  max: raw?.max ?? null,
  min: raw?.min ?? null,
});

const isPoint = (value: unknown): value is ChartPoint =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** One series, checked against the chart's kind: scatter needs points, every other kind needs values. */
const seriesOf = (raw: RawSeries, index: number, kind: ChartKind, labelCount: number | null): ChartSeries => {
  const where = `series "${raw.name}"`;
  const pointed = raw.data.length > 0 && raw.data.every(isPoint);
  if (kind === 'scatter' && raw.data.length > 0 && !pointed)
    throw new Refusal(`${where}: a scatter series is a list of [x, y] points`);
  if (kind !== 'scatter' && pointed) throw new Refusal(`${where}: only a scatter series is a list of points`);
  if (labelCount !== null && !pointed && raw.data.length > labelCount)
    throw new Refusal(`${where} has more values than the x axis has labels`);
  if (raw.kind !== undefined && !['line', 'bar', 'area'].includes(kind))
    throw new Refusal(`${where}: a per-series kind is only for line, area and bar charts`);
  return {
    kind: raw.kind ?? null,
    name: raw.name,
    points: pointed ? (raw.data as ChartPoint[]) : [],
    tone: raw.tone ?? (index % CHART_PALETTE_SLOTS) + 1,
    values: pointed ? [] : (raw.data as (number | null)[]),
  };
};

const longest = (list: readonly RawSeries[]): number =>
  list.reduce((most, entry) => Math.max(most, entry.data.length), 0);

/** Category labels: authored, or 1…n when a chart only has values. */
const labelsFor = (authored: readonly string[] | null, list: readonly RawSeries[]): string[] =>
  authored === null ? Array.from({ length: longest(list) }, (_, index) => String(index + 1)) : [...authored];

const build = (raw: Document): ChartSpec => {
  const { kind } = raw;
  if (raw.stacked === true && !['line', 'bar', 'area'].includes(kind))
    throw new Refusal('stacked is only for line, area and bar charts');
  if (raw.horizontal === true && kind !== 'bar') throw new Refusal('horizontal is only for bar charts');
  const xRaw = raw.x;
  const xLabels = xRaw === undefined ? null : Array.isArray(xRaw) ? xRaw : (xRaw.values ?? null);
  const xAxisRaw = xRaw === undefined || Array.isArray(xRaw) ? undefined : xRaw;
  if (kind === 'scatter' && xLabels !== null) throw new Refusal('a scatter chart has a numeric x axis, not labels');

  const frameOf = (
    label: string | null,
    title: string | null,
    authored: readonly string[] | null,
    list: readonly RawSeries[],
  ): ChartFrame => {
    const labels = kind === 'scatter' ? [] : labelsFor(authored, list);
    return {
      label,
      labels,
      series: list.map((entry, index) => seriesOf(entry, index, kind, kind === 'scatter' ? null : labels.length)),
      title,
    };
  };

  const title = raw.title ?? null;
  const frames =
    raw.frames === undefined
      ? [frameOf(null, title, xLabels, raw.series)]
      : raw.frames.map(entry =>
          frameOf(entry.label, entry.title ?? title, entry.x ?? xLabels, entry.series ?? raw.series),
        );

  const total = frames.reduce(
    (sum, entry) =>
      sum + entry.series.reduce((count, line) => count + Math.max(line.values.length, line.points.length), 0),
    0,
  );
  if (total > L.chartTotalPoints) throw new Refusal(`the chart draws more than ${L.chartTotalPoints} points`);

  return {
    frames,
    horizontal: raw.horizontal ?? false,
    kind,
    stacked: raw.stacked ?? false,
    x: axisOf(xAxisRaw),
    y: axisOf(raw.y),
  };
};

/** The first schema complaint, with where it was: enough for whoever reads the fallback's title. */
const firstIssue = (error: z.ZodError): string => {
  const issue = error.issues[0];
  if (issue === undefined) return 'The chart description is not valid';
  const where = issue.path.length === 0 ? 'chart' : issue.path.join('.');
  return `${where}: ${issue.message}`;
};

export function readChart(payload: string): ChartReading {
  if (new TextEncoder().encode(payload).byteLength > L.chartBytes)
    return { ok: false, reason: 'The chart description exceeds 64 KiB' };
  let parsed: unknown;
  try {
    parsed = parse(payload, { maxAliasCount: 0 });
  } catch {
    return { ok: false, reason: 'The chart description is not valid JSON or YAML' };
  }
  const checked = document.safeParse(parsed);
  if (!checked.success) return { ok: false, reason: firstIssue(checked.error) };
  try {
    return { ok: true, spec: build(checked.data) };
  } catch (error) {
    return { ok: false, reason: error instanceof Refusal ? error.message : 'The chart could not be drawn' };
  }
}
