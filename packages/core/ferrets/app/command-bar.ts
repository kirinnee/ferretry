/**
 * FERRETS IN THE COMMAND BAR (`shell.commands`): its two places under "Go to" — the ferret list and "New ferret" — and
 * the ferrets themselves as results, as v4's palette listed its sessions: the recent ones at rest ("where was I"), every
 * one found by what it was called, what it was asked to do and where it works. The list is read once per opening of the
 * bar, over this half's own client; a ferret opens on Conversation's chat, addressed by the shell's route table.
 */
import { type DestinationDecl, destinationCommands, type PluginCommandContext } from '@ferretry/app';
import type { CommandBarEntry } from '@ferretry/app/ui';
import type { FerretSummary } from '../contract/index.ts';
import { readFerretList } from './features/list/list-wire.ts';
import { ferretDirectory, isStopped } from './features/list/list-model.ts';
import { displayCallsign } from './lib/callsign.ts';
import { ferretTitles } from './lib/ferret-title.ts';

/** How many ferrets the bar offers with nothing typed (v4's `RECENT_SESSION_COUNT`). */
const RECENT_FERRET_COUNT = 6;

/** The group the ferrets are listed under. */
const FERRETS_GROUP = 'Ferrets';

/** v4 listed the new-session door last, after every other place. */
const NEW_FERRET_ORDER = 1100;

const ferretPlaces = destinationCommands('ferrets', [
  {
    screen: 'ferrets',
    label: 'Ferrets',
    description: 'Every ferret on this machine, grouped by project',
    keywords: ['sessions', 'fleet', 'dashboard', 'home', 'teammates', 'list'],
    order: 5,
  },
  {
    screen: 'new-ferret',
    label: 'New ferret',
    description: 'Start an agent in a working directory',
    keywords: ['new session', 'new', 'start', 'spawn', 'launch', 'create', 'teammate', 'agent'],
    order: NEW_FERRET_ORDER,
  },
] satisfies readonly DestinationDecl[]);

const activityAt = (ferret: FerretSummary): number => {
  const parsed = Date.parse(ferret.stateAt);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
};

/** Live work first, newest life-sign first inside that, then the stopped ones: v4's "recent sessions" order. */
const recentFirst = (ferrets: readonly FerretSummary[]): readonly FerretSummary[] =>
  [...ferrets].sort(
    (left, right) => Number(isStopped(left)) - Number(isStopped(right)) || activityAt(right) - activityAt(left),
  );

/** One ferret as a bar entry; `rank` is its place in the recent order and decides which ones show at rest. */
const ferretEntry = (
  ferret: FerretSummary,
  rank: number,
  context: Pick<PluginCommandContext, 'daemon' | 'screenHref' | 'navigate'>,
): CommandBarEntry | undefined => {
  const href = context.screenHref(context.daemon, 'conversation', 'chat', { ferret: ferret.id });
  if (href === undefined) return undefined;
  const { title, ferret: callsign } = ferretTitles(ferret);
  const directory = ferretDirectory(ferret);
  return {
    id: `ferret-${context.daemon}-${ferret.id}`,
    group: FERRETS_GROUP,
    label: title,
    // The callsign under a task title; a ferret with no task already shows its callsign as the title.
    description: callsign ?? directory,
    ...(callsign === null ? {} : { detail: directory }),
    keywords: [
      ferret.name,
      displayCallsign(ferret.name),
      ferret.id,
      ferret.folder,
      ferret.label ?? '',
      ferret.title ?? '',
    ].filter(word => word !== ''),
    resting: rank < RECENT_FERRET_COUNT,
    order: rank,
    ...(isStopped(ferret) ? { muted: true } : {}),
    run: () => context.navigate(href),
  };
};

/** The ferrets as results over one daemon: read on the first listing, listed again when the answer arrives. */
const ferretResults = (context: PluginCommandContext) => {
  let ferrets: readonly FerretSummary[] | undefined;
  let asked = false;
  return (): readonly CommandBarEntry[] => {
    if (!asked) {
      asked = true;
      // A failed read lists no ferrets; the bar's places stand regardless.
      readFerretList(context.client).then(
        read => {
          ferrets = read.ferrets;
          context.changed();
        },
        () => {
          ferrets = [];
          context.changed();
        },
      );
    }
    return recentFirst(ferrets ?? []).flatMap((ferret, rank) => {
      const entry = ferretEntry(ferret, rank, context);
      return entry === undefined ? [] : [entry];
    });
  };
};

/** `shell.commands`: the places, then the ferrets (two sources: one answers at once, the other when the list is read). */
export const ferretsCommands = (context: PluginCommandContext) => [ferretPlaces(context), ferretResults(context)];
