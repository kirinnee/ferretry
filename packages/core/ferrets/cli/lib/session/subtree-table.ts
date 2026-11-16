import type { SubtreeRow, SubtreeView } from '../../../contract/index.ts';

const HEADER: readonly string[] = ['FERRET', 'MODEL', 'STATE', 'CARD', 'PR', 'LAST'];

/** `3m`, `2h`, `5d`: the coarsest whole unit, `now` under a minute. */
function sinceLabel(nowMs: number, instant: string): string {
  const ms = nowMs - Date.parse(instant);
  if (Number.isNaN(ms) || ms < 60_000) return 'now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

const stateCell = (row: SubtreeRow, nowMs: number | undefined): string =>
  row.state === 'ended' && row.endedAt !== undefined
    ? nowMs === undefined
      ? `ended ${row.endedAt}`
      : `ended ${sinceLabel(nowMs, row.endedAt)}`
    : row.state;

/** `#42 CI passing` for an open PR, `#42 merged` once CI no longer matters, `-` without one. */
export function prCell(pr: SubtreeRow['pr']): string {
  if (pr === undefined) return '-';
  const live = pr.state === 'open' || pr.state === 'unknown';
  return [`#${pr.number}`, pr.draft && live ? 'draft' : undefined, live ? `CI ${pr.checks}` : pr.state]
    .filter(part => part !== undefined)
    .join(' ');
}

const cardCell = (row: SubtreeRow): string =>
  row.card === undefined ? '-' : [row.card.ref, row.card.lane].filter(part => part !== undefined).join(' ');

/** The table a lead reads: one line per descendant, a helper's own helpers indented beneath it. */
export function renderSubtreeTable(view: SubtreeView, nowMs: number | undefined): string[] {
  const count = view.rows.length;
  const title = `${view.root.name} (${view.root.id}): ${count} ${count === 1 ? 'descendant' : 'descendants'}`;
  if (count === 0) return [`${title}; ended ones show for ${Math.round(view.endedWindowMs / 60_000)}m`];
  const rows = view.rows.map(row => [
    `${'  '.repeat(row.depth - 1)}${row.name}`,
    row.model ?? '-',
    stateCell(row, nowMs),
    cardCell(row),
    prCell(row.pr),
    row.last === undefined ? '-' : `[${sinceLabel(nowMs ?? Date.parse(view.at), row.last.at)}] ${row.last.text}`,
  ]);
  const widths = HEADER.map((title, column) =>
    Math.max(title.length, ...rows.map(cells => (cells[column] ?? '').length)),
  );
  const render = (cells: readonly string[]): string =>
    cells.map((cell, column) => (column === cells.length - 1 ? cell : cell.padEnd(widths[column] ?? 0))).join('  ');
  return [title, render(HEADER), ...rows.map(render)];
}
