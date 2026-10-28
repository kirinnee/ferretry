/**
 * The `chart` value formats — the closed set an axis may name, and the only formatters a chart ever runs.
 *
 * APART FROM THE READER ON PURPOSE. The chart component prints its screen-reader table with these and is
 * in the main bundle; the reader (`fy-render-chart.ts`) carries a YAML parser and a schema library and is
 * fetched lazily with the engine, once a chart is near. Importing a formatter from the reader would pull
 * both into every page load. Pure: `Intl` and arithmetic.
 */

/** The value formats, a closed set: the renderer owns every formatter, so a payload never carries code. */
export const CHART_FORMATS = ['number', 'percent', 'money', 'duration', 'bytes'] as const;
export type ChartFormat = (typeof CHART_FORMATS)[number];

/** What a formatter needs to know about its axis. */
export interface ChartValueAxis {
  readonly format: ChartFormat;
  /** ISO 4217, for `money`. */
  readonly currency: string;
}

const DURATION_UNITS = [
  ['d', 86_400],
  ['h', 3_600],
  ['m', 60],
] as const;

/** Seconds, as a person says them: `450 ms`, `12.5 s`, `3m 20s`, `2h 5m`, `1d 3h`. */
const duration = (seconds: number, locale: string | undefined): string => {
  const sign = seconds < 0 ? '-' : '';
  const value = Math.abs(seconds);
  if (value < 1 && value > 0)
    return `${sign}${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value * 1000)} ms`;
  if (value < 60) return `${sign}${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)} s`;
  for (const [unit, size] of DURATION_UNITS) {
    if (value < size) continue;
    const whole = Math.floor(value / size);
    const index = DURATION_UNITS.findIndex(([name]) => name === unit);
    const next = DURATION_UNITS[index + 1];
    const rest = next === undefined ? Math.floor(value - whole * size) : Math.floor((value - whole * size) / next[1]);
    const restUnit = next === undefined ? 's' : next[0];
    return rest === 0 ? `${sign}${whole}${unit}` : `${sign}${whole}${unit} ${rest}${restUnit}`;
  }
  return `${sign}${value} s`;
};

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'] as const;

/** Binary units, because a file size a developer reads is a power of two. */
const bytes = (value: number, locale: string | undefined): string => {
  let scaled = Math.abs(value);
  let unit = 0;
  while (scaled >= 1024 && unit < BYTE_UNITS.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : 1;
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(scaled);
  return `${value < 0 ? '-' : ''}${number} ${BYTE_UNITS[unit]}`;
};

/**
 * A value as its axis says to show it. `compact` is for a tick, where a phone has room for `12K` and not
 * `12,345`; tooltips and the data table use the full form.
 *
 * `percent` takes the value AS a percentage — `42` is `42%` — because that is how an author writes one.
 */
export function formatChartValue(
  value: number | null,
  axis: ChartValueAxis,
  options: { readonly compact?: boolean; readonly locale?: string } = {},
): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const { locale } = options;
  const notation = options.compact === true && Math.abs(value) >= 10_000 ? 'compact' : 'standard';
  // A compact tick keeps three significant digits — `123K`, `1.23M` — which is what fits on a phone.
  const compact = notation === 'compact' ? { maximumSignificantDigits: 3 } : null;
  switch (axis.format) {
    case 'percent':
      return new Intl.NumberFormat(locale, { maximumFractionDigits: 1, notation, style: 'percent', ...compact }).format(
        value / 100,
      );
    case 'money':
      return new Intl.NumberFormat(locale, {
        currency: axis.currency,
        maximumFractionDigits: Math.abs(value) < 10 ? 2 : 0,
        notation,
        style: 'currency',
        ...compact,
      }).format(value);
    case 'duration':
      return duration(value, locale);
    case 'bytes':
      return bytes(value, locale);
    case 'number':
      return new Intl.NumberFormat(locale, { maximumFractionDigits: 2, notation, ...compact }).format(value);
  }
}
