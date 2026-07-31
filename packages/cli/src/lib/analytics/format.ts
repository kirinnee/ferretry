import type { AnalyticsMeasure } from '@ferretry/protocol';

/** Stands in for a value the index does not know. Never a zero — zero is a different fact. */
export const DASH = '—';

/** Column separator; two spaces read as a gap without drawing a grid. */
const COLUMN_GAP = '  ';

/** Compact magnitude: thousands, millions, billions. Integers below a thousand stay exact. */
export function compactNumber(value: number): string {
  const absolute = Math.abs(value);
  if (absolute < 1_000) return Number.isInteger(value) ? String(value) : value.toFixed(1);
  if (absolute < 1_000_000) return `${(value / 1_000).toFixed(1)}k`;
  if (absolute < 1_000_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  return `${(value / 1_000_000_000).toFixed(1)}b`;
}

/** Milliseconds as the largest unit that keeps the number small. */
export function duration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)}ms`;
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`;
}

/** A rate, with more precision where the number is small enough to need it. */
export function percent(value: number): string {
  return `${value.toFixed(Math.abs(value) >= 10 ? 1 : 2)}%`;
}

/** Micro-dollars as dollars, with enough decimals that a cheap run is not rounded to nothing. */
export function usdMicros(micros: number): string {
  const dollars = micros / 1_000_000;
  const magnitude = Math.abs(dollars);
  const decimals = magnitude >= 10 ? 2 : magnitude >= 0.1 ? 3 : 4;
  return `$${dollars.toFixed(decimals)}`;
}

/**
 * Render an aggregate cell, keeping incompleteness visible.
 *
 * kteam annotated only the fully-unknown case: a measure covering 3 of 40 sessions printed as a bare
 * number, indistinguishable from a complete one, so a partial sum or a wildly skewed average read as
 * fact. Any group short of its total is now suffixed `[known/total]`.
 */
export function measure(value: AnalyticsMeasure, format: (number: number) => string): string {
  const coverage = value.known < value.total ? `[${value.known}/${value.total}]` : '';
  if (value.value === null) return `${DASH}${coverage}`;
  return `${format(value.value)}${coverage}`;
}

/** A fixed-width table. The last column is never padded, so no row carries trailing blanks. */
export function renderTable(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = header.map((title, column) =>
    rows.reduce((widest, row) => Math.max(widest, row[column]?.length ?? 0), title.length),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, column) => (column === cells.length - 1 ? cell : cell.padEnd(widths[column] ?? cell.length)))
      .join(COLUMN_GAP);
  const rule = widths.map(width => '─'.repeat(width));
  return [line(header), line(rule), ...rows.map(line)].join('\n');
}
