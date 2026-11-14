import type { AgendaBoardContext, AgendaFerretsContext } from '../../contract/index.ts';
import { AgendaHomes, type HomeSession } from '../lib/agenda/index.ts';
import { MACHINE_AGENDA_ID } from '../lib/protocol/agenda.ts';
import type {
  AgendaCardLanes,
  AgendaFocusSource,
  AgendaGateAsking,
  AgendaSessionDirectory,
} from '../lib/agenda/service.ts';
import type { AgendaHomeResolver } from '../lib/agenda/home.ts';
import type { Lineage, SubFerretDirectory } from '../lib/sub-ferret/index.ts';
import type { FerretReach } from '../lib/routes/ferret-reads.ts';

/** Deepest lead chain the lineage walk follows (Ferrets' own bound); a longer one is not a lineage. */
const MAX_LINEAGE_DEPTH = 16;

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
  /** Lineage and the Warden's own sessions, for what a ferret may read of a Warden notice. */
  readonly reach: FerretReach;
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
  /** One lookup of who started `id`: its answer carries both whether it could be read and the lead. */
  const lineageOf = async (id: string): Promise<Lineage> => {
    const found = ferrets();
    if (found === undefined) return { readable: false };
    try {
      return { readable: true, lead: await found.leadOf(id) };
    } catch {
      return { readable: false };
    }
  };
  const homes = new AgendaHomes(
    {
      get: async (id): Promise<HomeSession | undefined> => await ferrets()?.get(id),
      all: async () => (await ferrets()?.all()) ?? [],
    },
    // A notice with no owner home lands on the machine agenda (docs/agenda.md § The machine agenda); a gate item or a
    // follow-up never does (`AgendaHomes.of`, `notice`).
    { home: async () => MACHINE_AGENDA_ID },
    { warn },
  );
  return {
    sessions: {
      // The machine agenda is the daemon's own board, not a ferret: Ferrets knows no such session, and the owner's
      // machine routes and the Warden's standing notices write it. A ferret cannot reach it: an agent is confined to
      // its own session, and the ferret routes refuse its id.
      has: async id =>
        id === MACHINE_AGENDA_ID ||
        ((await ferrets()
          ?.has(id)
          .catch(() => false)) ??
          false),
    },
    subFerrets: {
      leadOf: async id => await ferrets()?.leadOf(id),
      addressOf: async id => (await ferrets()?.addressOf(id)) ?? id,
      readable: async id => (await lineageOf(id)).readable,
      lineage: async id => await lineageOf(id),
    },
    focus: { focusOf: async id => (await board()?.focusOf(id)) ?? null },
    cards: {
      inToTest: async task =>
        (await board()
          ?.inToTest(task)
          .catch(() => false)) ?? false,
    },
    homes,
    reach: {
      // The same rule as Ferrets' `mayTouch`: the ferret itself, or a ferret whose lead chain reaches it. A chain that
      // cannot be read is not a lineage.
      mayTouch: async (caller, target) => {
        const found = ferrets();
        if (found === undefined) return false;
        let current: string | undefined = target;
        for (let depth = 0; current !== undefined && depth <= MAX_LINEAGE_DEPTH; depth += 1) {
          if (current === caller) return true;
          current = await found.leadOf(current);
        }
        return false;
      },
      startedByWarden: async ferret => (await ferrets()?.get(ferret))?.origin === 'warden',
    },
    gates: {
      asking: async task => {
        const found = board();
        if (found === undefined) throw new Error('the board cannot say whether the card is asking');
        return await found.asking(task);
      },
    },
  };
}
