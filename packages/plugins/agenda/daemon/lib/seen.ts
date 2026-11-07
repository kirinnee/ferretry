import type { Instant } from '@ferretry/std';
import { agendaAskBuzzTag, agendaStopBuzzTag, PUSH_SEEN_MAX_TAGS, type SeenFile } from '../../contract/index.ts';

/** `seen.json` over a store: when the owner last saw each ask. */
export interface SeenStore {
  read(): Promise<SeenFile>;
  update(change: (current: SeenFile) => SeenFile): Promise<void>;
}

export const emptySeen = (): SeenFile => ({ format: 1, seen: {} });

/** What the buzz ledger says about an ask the owner just opened, and what else still waits on the owner. */
export interface SeenFacts {
  /** The ask made a buzz of its own. */
  readonly askBuzzed: boolean;
  /** The ferret has made a stop buzz. */
  readonly stopBuzzed: boolean;
  /** Another ask on the ferret's board still waits on the owner, so the stop's line is still true. */
  readonly othersWaiting: boolean;
}

/**
 * The tags a clear of an opened ask names: the ask's own, and the ferret's stop line once no other ask keeps it true.
 * Nothing is cleared for an ask that never buzzed, which keeps a phone that must show something for every push from
 * collecting a "Handled" line for every ask a ferret ever closed. Tags only: never an endpoint, never ask words.
 */
export function tagsToClear(ferret: string, ask: string, facts: SeenFacts): readonly string[] {
  const tags: string[] = [];
  if (facts.askBuzzed) tags.push(agendaAskBuzzTag(ferret, ask));
  if (facts.stopBuzzed && !facts.othersWaiting) tags.push(agendaStopBuzzTag(ferret));
  return tags.slice(0, PUSH_SEEN_MAX_TAGS);
}

/** Records that the owner saw one ask, now. Idempotent for the same instant. */
export async function markSeen(store: SeenStore, ferret: string, ask: string, at: Instant): Promise<void> {
  await store.update(current => ({
    ...current,
    seen: { ...current.seen, [ferret]: { ...(current.seen[ferret] ?? {}), [ask]: at } },
  }));
}
