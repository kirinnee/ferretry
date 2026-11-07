import type { PackRow, PackTable } from '../../contract/index.ts';
import type { IPackGateway } from './gateway.ts';

/** Paints a cell amber; the identity when the terminal is not a person's. */
export interface ICellColour {
  amber(cell: string): string;
}

const HEADER: readonly string[] = ['FERRET', 'MODEL', 'STATE', 'CARD', 'LAST'];
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

const stateCell = (row: PackRow, nowMs: number): string =>
  row.state === 'ended' && row.endedAt !== undefined ? `ended ${sinceLabel(nowMs, row.endedAt)}` : row.state;

const cardCell = (row: PackRow): string =>
  row.card === undefined ? '-' : [row.card.ref, row.card.lane].filter(part => part !== undefined).join(' ');

const lastCell = (row: PackRow, nowMs: number): string =>
  row.last === undefined ? '-' : `[${sinceLabel(nowMs, row.last.at)}] ${row.last.text}`;

/**
 * The table a lead reads: one line per ferret below it, a helper's own children indented beneath it, an ended one
 * marked with how long ago. A row that needs the owner is painted amber in its STATE cell.
 */
export function renderPackTable(table: PackTable, nowMs: number, colour: ICellColour): string[] {
  const count = table.rows.length;
  const title = `${table.root.name} (${table.root.id}): ${count} ${count === 1 ? 'helper' : 'helpers'}`;
  if (count === 0) return [`${title}; ended ones show for ${Math.round(table.endedWindowMs / 60_000)}m`];
  const rows = table.rows.map(row => [
    `${'  '.repeat(row.depth - 1)}${row.name}`,
    row.model,
    stateCell(row, nowMs),
    cardCell(row),
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
    ...rows.map((cells, index) => render(cells, table.rows[index]?.state === 'needs-you')),
  ];
}

/** A caller mistake, said in one line: the verb prints it and exits with `exitCode` (2, a usage error; 1 is a failed operation). */
export class PackCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode = 2,
  ) {
    super(message);
    this.name = 'PackCommandError';
  }
}

/**
 * Shows a lead its pack as one table: `fy pack [<id>]` (docs/pack-mode.md § Checking on your helpers). It defaults to
 * the calling ferret; the owner, outside any pane, names one.
 */
export class PackTableController {
  constructor(
    private readonly gateway: Pick<IPackGateway, 'table'>,
    private readonly out: { success(message: string): void },
    /** The ferret this runs inside, when it does. */
    private readonly caller: string | undefined,
    private readonly nowMs: () => number,
    private readonly colour: ICellColour,
  ) {}

  async execute(id: string | undefined, flags: { json?: boolean } = {}): Promise<void> {
    const root = id?.trim() || this.caller?.trim();
    if (root === undefined || root === '')
      throw new PackCommandError(
        'name the ferret whose pack to show: pack <id> (it defaults to the calling ferret only inside a ferret)',
      );
    const table = await this.gateway.table(root);
    if (flags.json === true) {
      this.out.success(JSON.stringify(table, null, 2));
      return;
    }
    for (const line of renderPackTable(table, this.nowMs(), this.colour)) this.out.success(line);
  }
}
