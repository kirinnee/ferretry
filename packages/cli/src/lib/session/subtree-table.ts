import type { SubtreeRow, SubtreeView } from '@ferretry/protocol';
import type { ICellColour } from './ports.ts';

const HEADER: readonly string[] = ['SESSION', 'MODEL', 'STATE', 'CARD', 'PR', 'LAST'];
const STATE_COLUMN = 2;

/** `3m`, `2h`, `5d`: the coarsest whole unit, `now` under a minute. */
export function sinceLabel(nowMs: number, instant: string): string {
  const ms = nowMs - Date.parse(instant);
  if (Number.isNaN(ms) || ms < 60_000) return 'now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** `#42 CI passing` for an open PR, `#42 merged` once CI no longer matters, `-` without one. */
export function prCell(pr: SubtreeRow['pr']): string {
  if (pr === undefined) return '-';
  const live = pr.state === 'open' || pr.state === 'unknown';
  return [`#${pr.number}`, pr.draft && live ? 'draft' : undefined, live ? `CI ${pr.checks}` : pr.state]
    .filter(part => part !== undefined)
    .join(' ');
}

const stateCell = (row: SubtreeRow, nowMs: number): string =>
  row.state === 'ended' && row.endedAt !== undefined ? `ended ${sinceLabel(nowMs, row.endedAt)}` : row.state;

const cardCell = (row: SubtreeRow): string =>
  row.card === undefined ? '-' : [row.card.ref, row.card.lane].filter(part => part !== undefined).join(' ');

const lastCell = (row: SubtreeRow, nowMs: number): string =>
  row.last === undefined ? '-' : `[${sinceLabel(nowMs, row.last.at)}] ${row.last.text}`;

/**
 * The table a lead reads: one line per descendant, a sub-ferret's own children indented beneath it, an ended
 * one marked with how long ago. A row that needs the owner is painted amber in its STATE cell.
 */
export function renderSubtreeTable(view: SubtreeView, nowMs: number, colour: ICellColour): string[] {
  const count = view.rows.length;
  const title = `${view.root.callsign} (${view.root.id}): ${count} ${count === 1 ? 'descendant' : 'descendants'}`;
  if (count === 0) return [`${title}; ended ones show for ${Math.round(view.endedWindowMs / 60_000)}m`];
  const rows = view.rows.map(row => [
    `${'  '.repeat(row.depth - 1)}${row.callsign}`,
    row.model,
    stateCell(row, nowMs),
    cardCell(row),
    prCell(row.pr),
    lastCell(row, nowMs),
  ]);
  const widths = HEADER.map((title, column) =>
    Math.max(title.length, ...rows.map(cells => (cells[column] ?? '').length)),
  );
  const render = (cells: readonly string[], amber: boolean): string =>
    cells
      .map((cell, column) => {
        const padded = column === cells.length - 1 ? cell : cell.padEnd(widths[column] ?? 0);
        return column === STATE_COLUMN && amber ? colour.amber(padded) : padded;
      })
      .join('  ');
  return [
    title,
    render(HEADER, false),
    ...rows.map((cells, index) => render(cells, view.rows[index]?.state === 'needs-you')),
  ];
}
