import type { AgendaBoardContext, AgendaFerretsContext } from '../../contract/index.ts';
import { AgendaHomes, type HomeSession, NO_MACHINE_AGENDA } from '../lib/agenda/index.ts';
import type {
  AgendaCardLanes,
  AgendaFocusSource,
  AgendaGateAsking,
  AgendaSessionDirectory,
} from '../lib/agenda/service.ts';
import type { AgendaHomeResolver } from '../lib/agenda/home.ts';
import type { SubFerretDirectory } from '../lib/sub-ferret/index.ts';

/** Where one half of the context is read from: the `agenda.context:<key>` provider, or none while its plugin is off. */
export type AgendaContextSource = (
  key: 'ferrets' | 'board',
) => AgendaFerretsContext | AgendaBoardContext | 'unavailable';

/** What `AgendaService` takes beyond its repository: each reader looks the provider up again at every call. */
export interface BoundAgendaContext {
  readonly sessions: AgendaSessionDirectory;
  readonly subFerrets: SubFerretDirectory;
  readonly focus: AgendaFocusSource;
  readonly cards: AgendaCardLanes;
  readonly homes: AgendaHomeResolver;
  readonly gates: AgendaGateAsking;
}

/**
 * The agenda's lineage and card context, bound from `agenda.context` (docs/agenda.md). Each unavailable answer is the
 * SAFE side of its question, not the permissive one:
 *
 * - **which ferrets exist**: none does, so a write for an unknown ferret is refused (never "any well-formed id");
 * - **who started whom**: unreadable, said so ({@link SubFerretDirectory.readable}), so a raise is refused rather than
 *   put on the owner's agenda by a ferret that cannot be placed;
 * - **a card's gate**: it rejects, which the service reads as "asking", so no second ask gets through;
 * - **a focus card / the to-test lane**: Board being off leaves an item with the card it was raised with, which cannot
 *   widen anything.
 */
export function agendaContext(source: AgendaContextSource, warn: (message: string) => void): BoundAgendaContext {
  const ferrets = (): AgendaFerretsContext | undefined => {
    const found = source('ferrets');
    return found === 'unavailable' ? undefined : (found as AgendaFerretsContext);
  };
  const board = (): AgendaBoardContext | undefined => {
    const found = source('board');
    return found === 'unavailable' ? undefined : (found as AgendaBoardContext);
  };
  const homes = new AgendaHomes(
    {
      get: async (id): Promise<HomeSession | undefined> => await ferrets()?.get(id),
      all: async () => (await ferrets()?.all()) ?? [],
    },
    NO_MACHINE_AGENDA,
    { warn },
  );
  return {
    sessions: {
      has: async id =>
        (await ferrets()
          ?.has(id)
          .catch(() => false)) ?? false,
    },
    subFerrets: {
      leadOf: async id => await ferrets()?.leadOf(id),
      addressOf: async id => (await ferrets()?.addressOf(id)) ?? id,
      readable: async id => {
        const found = ferrets();
        if (found === undefined) return false;
        try {
          await found.leadOf(id);
          return true;
        } catch {
          return false;
        }
      },
    },
    focus: { focusOf: async id => (await board()?.focusOf(id)) ?? null },
    cards: {
      inToTest: async task =>
        (await board()
          ?.inToTest(task)
          .catch(() => false)) ?? false,
    },
    homes,
    gates: {
      asking: async task => {
        const found = board();
        if (found === undefined) throw new Error('the board cannot say whether the card is asking');
        return await found.asking(task);
      },
    },
  };
}
