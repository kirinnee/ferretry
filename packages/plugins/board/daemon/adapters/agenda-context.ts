import type { AgendaBoardContext } from '@ferretry/core-asks/contract';
import { laneForTrigger as defaultLaneForTrigger } from '../../contract/lanes.ts';
import type { CardRef } from '../../contract/refs.ts';
import type { CardResponse } from '../../contract/wire.ts';

/** What Board's half of the agenda context reads, each from the world Board already built. */
export interface BoardAgendaContextSources {
  /** The card a ferret works on (`config.focusTask`); `null` for none. */
  readonly focusOf: (ferret: string) => Promise<CardRef | null>;
  /** One card with its lane set; `undefined` when it is not on the board. */
  readonly card: (id: CardRef['id']) => Promise<CardResponse | undefined>;
  /** Where the card's gate asks the owner. A read that fails THROWS: "not asking" would let a second ask through. */
  readonly asking: (id: CardRef['id']) => Promise<{ readonly ferret: string; readonly id: string } | undefined>;
  readonly machineId: () => string | undefined;
  readonly laneForTrigger?: typeof defaultLaneForTrigger;
}

/**
 * Board's half of `agenda.context:board` (the agenda's focus card, to-test lane and gate asks, docs/agenda.md): three
 * reads over what Board already holds. A card of another machine means nothing in this store, so it is not answered.
 */
export function boardAgendaContext(sources: BoardAgendaContextSources): AgendaBoardContext {
  const laneForTrigger = sources.laneForTrigger ?? defaultLaneForTrigger;
  const here = (ref: { readonly machineId?: string | undefined }): boolean =>
    ref.machineId === undefined || ref.machineId === sources.machineId();
  return {
    focusOf: async ferret => await sources.focusOf(ferret),
    // "To test" is the lane `release.published` enters (Released · to test), as the board's own lane facts say.
    inToTest: async ref => {
      if (!here(ref)) return false;
      const found = await sources.card(ref.id as CardRef['id']).catch(() => undefined);
      if (found === undefined || found.laneSet === null) return false;
      const lane = laneForTrigger(found.laneSet, found.card.workflow, 'release.published');
      return lane.ok && lane.value !== null && lane.value.id === found.card.laneId;
    },
    asking: async ref => {
      if (!here(ref)) return undefined;
      const found = await sources.asking(ref.id as CardRef['id']);
      return found === undefined ? undefined : { sessionId: found.ferret, id: found.id as never };
    },
  };
}
