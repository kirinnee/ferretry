import type { InflightVerdict } from './verdict.ts';

/** Screaming labels for the two verdicts a reader must not skim past. */
export const verdictLabels: Readonly<Record<InflightVerdict, string>> = {
  safe_to_kill: 'safe',
  re_armable: 're-armable',
  destructive_to_interrupt: 'DESTRUCTIVE',
  unknown: 'UNKNOWN',
};

/** Coarse human age. Unknown ages render as `?` rather than as a confident zero. */
export function age(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return '?';
  if (seconds < 90) return `${seconds}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

/** Collapses a command to one bounded line so a long argv cannot break the layout. */
export function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Escapes a value for a markdown table cell, where a bare pipe would start a new column. */
export function escapeCell(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
}
