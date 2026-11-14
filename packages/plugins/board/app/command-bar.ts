/**
 * BOARD IN THE COMMAND BAR (`shell.commands`): its place under "Go to", and — on a ferret's page — "Board for <ferret>"
 * (v4's `boardForFerretPaletteCommand`, S-0449): the board narrowed to that ferret's cards. The screens are addressed by
 * the shell's route table (`screenHref`), so nothing here spells another plugin's URL; the narrowing is the board's own
 * `?ferret=` filter (`board-model.ts`).
 */
import { type DestinationDecl, destinationCommands, type PluginCommandContext } from '@ferretry/app';
import type { CommandBarEntry } from '@ferretry/app/ui';
import { ferretNamer } from './lib/board-present.ts';

/** The words v4 found "Board for <ferret>" by besides its label and description. */
const BOARD_FOR_FERRET_KEYWORDS = ['board', 'for this ferret', 'cards', 'tasks', 'kanban', 'project', 'mine'] as const;

export const boardPlaces = destinationCommands('board', [
  {
    screen: 'board',
    label: 'Board',
    description: 'Every task on every machine as lanes: what is moving, stuck or waiting on you',
    keywords: ['kanban', 'tasks', 'cards', 'lanes', 'backlog', 'stale', 'to test', 'tree'],
    order: 30,
  },
] satisfies readonly DestinationDecl[]);

/** The ferrets' callsigns by id, best effort: the board names a ferret it cannot read by the start of its id. */
const readCallsigns = async (client: PluginCommandContext['client']): Promise<ReadonlyMap<string, string>> => {
  try {
    const rows = await client.call<readonly { readonly id: string; readonly name?: string }[]>('GET /v1/ferrets');
    return new Map(rows.flatMap(row => (row.name === undefined ? [] : [[row.id, row.name] as const])));
  } catch {
    return new Map();
  }
};

/**
 * "Board for <ferret>", offered only while the reader is on a ferret's page. The ferret's callsign is read once; until
 * it arrives the entry is named by the start of the ferret's id, and the bar is asked to list again.
 */
export const boardForFerretCommands = (context: PluginCommandContext) => {
  let callsigns: ReadonlyMap<string, string> | undefined;
  let asked = false;
  return (): readonly CommandBarEntry[] => {
    const { ferret } = context;
    if (ferret === undefined) return [];
    const board = context.screenHref(context.daemon, 'board', 'board');
    if (board === undefined) return [];
    if (!asked) {
      asked = true;
      void readCallsigns(context.client).then(read => {
        callsigns = read;
        context.changed();
      });
    }
    const name = ferretNamer(callsigns ?? new Map())(ferret);
    const href = `${board}?ferret=${encodeURIComponent(ferret)}`;
    return [
      {
        id: `board-for-ferret-${context.daemon}`,
        group: 'Go to',
        label: `Board for ${name}`,
        description: "Open the board filtered to this ferret's cards.",
        keywords: [...BOARD_FOR_FERRET_KEYWORDS],
        resting: true,
        // Right after the board itself.
        order: 31,
        run: () => context.navigate(href),
      },
    ];
  };
};
