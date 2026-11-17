import type { FerretSummary } from '../../../contract/index.ts';
import type { ICellColour } from './ports.ts';

/** The one state a ferret leaves only by a resume; `ps` hides it unless asked for everything. */
export const TERMINAL_STATUSES: readonly string[] = ['stopped'];

/** `hadi` → `Hadi`, `mary-jane` → `Mary-Jane`: how every surface shows a first name. */
export function displayName(callsign: string): string {
  return callsign
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join('-');
}

function headline(view: FerretSummary): string {
  return [
    `${view.name} (${view.id})`,
    view.state,
    view.harness,
    view.runtime === undefined ? '' : `runtime=${view.runtime}`,
    view.login === undefined ? '' : `login=${view.login}`,
    view.pack === undefined ? '' : `pack=${view.pack}`,
    view.parent === undefined ? '' : `parent=${view.parent}`,
    view.role,
  ]
    .filter(part => part !== '')
    .join('  ');
}

/**
 * Why a stopped ferret ended, as lines a person reads, when nobody chose it to: the terminal vanished, a signal or a
 * non-zero exit ended the agent, or the harness left on its own; and what the harness said last, when the caller read
 * it (`lastWords`: the stored last screen, read through its gated, re-masked route; it is never on the record).
 * A stop, a `signal done` and a launch that never ran say nothing here (the state already does). Empty for a live ferret.
 */
function endedLines(view: FerretSummary, lastWords: string | undefined): string[] {
  const why = endedWhy(view);
  if (why === undefined) return [];
  const words =
    lastWords === undefined ? [] : [`  its last words:`, ...lastWords.split('\n').map(line => `    ${line}`)];
  return [`  ended: ${why}`, ...words];
}

/** The short reason a stopped ferret's end was nobody's choice, or `undefined` (a live ferret, a stop, a finish). */
function endedWhy(view: FerretSummary): string | undefined {
  const cause = view.cause;
  if (view.state !== 'stopped' || cause === undefined) return undefined;
  switch (cause.kind) {
    case 'tmux_crashed':
      return 'its terminal server crashed';
    case 'terminal_gone':
      return 'its terminal ended and how it ended was not recorded';
    case 'signal':
      return `the agent was killed by signal ${cause.signal}`;
    case 'agent_crashed':
      return `the agent exited with code ${cause.exitCode}`;
    case 'clean_exit':
      return 'the agent exited on its own (exit code 0)';
    default:
      return undefined;
  }
}

/** The `ps` STATE cell: the state, and for an end nobody chose, why in a few words. */
function stateCell(view: FerretSummary): string {
  const cause = view.cause;
  if (endedWhy(view) === undefined || cause === undefined) return view.state;
  switch (cause.kind) {
    case 'signal':
      return `${view.state} (signal ${cause.signal})`;
    case 'agent_crashed':
      return `${view.state} (exit ${cause.exitCode})`;
    case 'clean_exit':
      return `${view.state} (exited)`;
    case 'tmux_crashed':
      return `${view.state} (terminal crashed)`;
    default:
      return `${view.state} (terminal gone)`;
  }
}

/** The single-ferret detail block printed by `status`, `start`, `resume` and `rename --json`-less answers. */
export function renderFerret(view: FerretSummary, lastWords?: string): string[] {
  return [
    headline(view),
    `  ${view.folder}`,
    `  ${view.state} since ${view.stateAt}; started ${view.createdAt}`,
    ...endedLines(view, lastWords),
  ];
}

const TABLE_HEADER = ['TEAMMATE', 'ID', 'STATE', 'HARNESS', 'RUNTIME', 'ROLE', 'PACK', 'PARENT'] as const;

/** The PIN column's mark: this ferret is pinned to the top of the sidebar. */
const PINNED_MARK = '*';

/** A listed ferret, with the pin mark the fleet list may carry. */
export type ListedFerret = FerretSummary;

/**
 * The `ps` table.
 *
 * Column widths are measured from the data — fixed widths misalign the moment a value outgrows them — and the
 * variable-length column sits last, where it is never padded. A leading PIN column marks the pinned ferrets and
 * appears only while one is listed, so a fleet with no pins reads exactly as it always has. A running ferret with no
 * runtime of its own is the cell a reader must notice, painted amber after padding.
 */
export function renderSessionTable(views: readonly ListedFerret[], colour: ICellColour): string[] {
  const showPins = views.some(view => view.pinnedAt !== undefined);
  const header: readonly string[] = showPins ? ['PIN', ...TABLE_HEADER] : TABLE_HEADER;
  const rows = views.map(view => [
    ...(showPins ? [view.pinnedAt === undefined ? '' : PINNED_MARK] : []),
    view.name,
    view.id,
    stateCell(view),
    view.harness,
    view.runtime ?? '-',
    view.role,
    view.pack ?? '-',
    view.parent ?? '-',
  ]);
  const runtimeColumn = header.indexOf('RUNTIME');
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map(cells => (cells[column] ?? '').length)),
  );
  const render = (cells: readonly string[], amber: boolean): string =>
    cells
      .map((cell, column) => {
        const padded = column === cells.length - 1 ? cell : cell.padEnd(widths[column] ?? 0);
        return column === runtimeColumn && amber ? colour.amber(padded) : padded;
      })
      .join('  ');
  return [
    render(header, false),
    ...rows.map((cells, index) => {
      const view = views[index];
      return render(cells, view !== undefined && view.runtime === undefined && !TERMINAL_STATUSES.includes(view.state));
    }),
  ];
}
