import type { FerretSummary } from '../../../contract/index.ts';
import type { AgentPinService } from './service.ts';

/** A ferret as a pin-aware reader answers it: its summary, and `pinnedAt` while the owner has it pinned. */
export type PinnedFerret = FerretSummary & { readonly pinnedAt?: string };

/** The ferret reader the pin mark wraps: the registry's list and its one-reference lookup. */
export interface FerretReader {
  list(): Promise<readonly FerretSummary[]>;
  get(reference: string): Promise<FerretSummary | undefined>;
}

/** The same reader, answering each ferret with its pin mark. */
export interface PinnedFerretReader {
  list(): Promise<readonly PinnedFerret[]>;
  get(reference: string): Promise<PinnedFerret | undefined>;
}

/**
 * Keeps the ferret a mark made from one input ferret, so the same input with the same pin answers the same object:
 * a reader that hands out the same object while nothing moved lets the layers above recognise an unchanged fleet.
 * Held weakly by the input, so a ferret that moves on takes its remembered output with it.
 */
function pinMemo() {
  const made = new WeakMap<FerretSummary, { readonly pinnedAt: string; readonly ferret: PinnedFerret }>();
  return (input: FerretSummary, pinnedAt: string): PinnedFerret => {
    const known = made.get(input);
    if (known !== undefined && known.pinnedAt === pinnedAt) return known.ferret;
    const ferret = { ...input, pinnedAt };
    made.set(input, { pinnedAt, ferret });
    return ferret;
  };
}

/**
 * Puts `pinnedAt` on the ferrets the owner pinned, and leaves every other one as it is.
 *
 * It wraps the ferret reader, like the other derived marks, so the pin can ride the fleet list to every device the
 * owner has open without a request of its own. A pin list that cannot be read is "nothing pinned": the mark is a
 * preference, and a roster that fails to load because of it would be the worse defect.
 */
export function withPinned(reader: FerretReader, pins: Pick<AgentPinService, 'pinnedAt'>): PinnedFerretReader {
  const memo = pinMemo();
  const mark = (ferret: FerretSummary, pinned: ReadonlyMap<string, string>): PinnedFerret => {
    const pinnedAt = pinned.get(ferret.id);
    return pinnedAt === undefined ? ferret : memo(ferret, pinnedAt);
  };
  const pinned = async (): Promise<ReadonlyMap<string, string>> =>
    await pins.pinnedAt().catch((): ReadonlyMap<string, string> => new Map());
  return {
    list: async () => {
      const [ferrets, marks] = await Promise.all([reader.list(), pinned()]);
      return ferrets.map(ferret => mark(ferret, marks));
    },
    get: async reference => {
      const [ferret, marks] = await Promise.all([reader.get(reference), pinned()]);
      return ferret === undefined ? undefined : mark(ferret, marks);
    },
  };
}
