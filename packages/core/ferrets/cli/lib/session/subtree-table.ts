import type { FerretSummary } from '../../../contract/index.ts';

/** How long an ended descendant still shows (today's two hours). */
export const ENDED_WINDOW_MS = 2 * 60 * 60 * 1000;

/** One descendant row: lineage from the registry's `parent` links, never from the request (G24). */
export interface SubtreeRow {
  readonly id: string;
  readonly callsign: string;
  /** 1 for a direct helper, 2 for its helper, … */
  readonly depth: number;
  readonly state: 'live' | 'ended';
  readonly harness: string;
  readonly runtime?: string;
  readonly endedAt?: string;
}

export interface SubtreeView {
  readonly root: { readonly id: string; readonly callsign: string };
  readonly rows: readonly SubtreeRow[];
  readonly endedWindowMs: number;
}

/**
 * Every descendant of `rootId`, depth first, a helper's own helpers beneath it. A stopped one shows while it ended
 * inside the window (when the clock is known; with none, every ended one shows). The walk keeps a visited set, so a
 * malformed parent cycle cannot recurse forever.
 */
export function buildSubtree(fleet: readonly FerretSummary[], root: FerretSummary, nowMs?: number): SubtreeView {
  const children = new Map<string, FerretSummary[]>();
  for (const ferret of fleet) {
    if (ferret.parent === undefined) continue;
    children.set(ferret.parent, [...(children.get(ferret.parent) ?? []), ferret]);
  }
  const rows: SubtreeRow[] = [];
  const seen = new Set<string>([root.id]);
  const walk = (id: string, depth: number): void => {
    const kids = [...(children.get(id) ?? [])].sort(
      (left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );
    for (const kid of kids) {
      if (seen.has(kid.id)) continue;
      seen.add(kid.id);
      const ended = kid.state === 'stopped';
      const shown = !ended || nowMs === undefined || nowMs - Date.parse(kid.stateAt) <= ENDED_WINDOW_MS;
      if (shown)
        rows.push({
          id: kid.id,
          callsign: kid.name,
          depth,
          state: ended ? 'ended' : 'live',
          harness: kid.harness,
          ...(kid.runtime === undefined ? {} : { runtime: kid.runtime }),
          ...(ended ? { endedAt: kid.stateAt } : {}),
        });
      walk(kid.id, depth + 1);
    }
  };
  walk(root.id, 1);
  return { root: { id: root.id, callsign: root.name }, rows, endedWindowMs: ENDED_WINDOW_MS };
}

const HEADER: readonly string[] = ['SESSION', 'RUNTIME', 'STATE', 'HARNESS'];

/** `3m`, `2h`, `5d`: the coarsest whole unit, `now` under a minute. */
export function sinceLabel(nowMs: number, instant: string): string {
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

/** The table a lead reads: one line per descendant, a helper's own helpers indented beneath it. */
export function renderSubtreeTable(view: SubtreeView, nowMs: number | undefined): string[] {
  const count = view.rows.length;
  const title = `${view.root.callsign} (${view.root.id}): ${count} ${count === 1 ? 'descendant' : 'descendants'}`;
  if (count === 0) return [`${title}; ended ones show for ${Math.round(view.endedWindowMs / 60_000)}m`];
  const rows = view.rows.map(row => [
    `${'  '.repeat(row.depth - 1)}${row.callsign}`,
    row.runtime ?? '-',
    stateCell(row, nowMs),
    row.harness,
  ]);
  const widths = HEADER.map((title, column) =>
    Math.max(title.length, ...rows.map(cells => (cells[column] ?? '').length)),
  );
  const render = (cells: readonly string[]): string =>
    cells.map((cell, column) => (column === cells.length - 1 ? cell : cell.padEnd(widths[column] ?? 0))).join('  ');
  return [title, render(HEADER), ...rows.map(render)];
}
