import { instantFromEpochMs } from '@ferretry/std';
import type { RawWork, WorkSource } from '@ferretry/plugin-conversation/contract';
import type { Card, LaneSet } from '../../contract/index.ts';
import type { LaneSets } from '../lib/board/index.ts';

/** What Board reads of itself to hand its cards over: every card as stored, with the lanes of each board. */
export interface BoardCards {
  snapshot(): Promise<{ readonly cards: readonly Card[]; readonly laneSets: LaneSets }>;
}

const joined = (texts: readonly (string | null | undefined)[]): string =>
  texts.filter((text): text is string => typeof text === 'string' && text.trim().length > 0).join('\n');

const instantMs = (at: string): number => {
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : 0;
};

/**
 * A card as work for the search (today's `cardDocument`). Old closed work is kept: the index decides what its window
 * hides, so a query can still ask for all of it. A card on a board whose lanes cannot be read stands as open under its
 * lane id: findable beats hidden.
 *
 * THE FIELDS ARE A WHITELIST, as they were: the text the owner already reads on the card. Nothing is indexed by walking
 * the card, so a field added to it later is not searchable until it is named here on purpose. Conversation scrubs every
 * text before it indexes or shows it.
 */
export const cardWork = (card: Card, laneSet: LaneSet | undefined): RawWork => {
  const lane = laneSet?.lanes.find(candidate => candidate.id === card.laneId);
  const state = card.dropped !== null ? 'dropped' : lane?.category === 'closed' ? 'closed' : 'open';
  const updatedAtMs = instantMs(card.dropped?.at ?? card.history.at(-1)?.at ?? card.createdAt);
  const notes = card.history.flatMap(event => (event.type === 'note' ? [event.text] : []));
  return {
    key: `card:${card.id}`,
    kind: 'card',
    updatedAtMs,
    identity: {
      kind: 'card',
      id: card.id,
      project: card.projectId,
      ferret: card.owner,
      title: card.title,
      state,
      standing: state === 'dropped' ? 'Dropped' : (lane?.name ?? card.laneId),
      updatedAt: instantFromEpochMs(updatedAtMs),
    },
    fields: [
      ['id', card.id],
      ['title', card.title],
      ['summary', card.summary],
      ['ask', joined([card.ask.text, ...card.clarifications.map(clarification => clarification.text)])],
      ['premise', card.premise],
      ['context', card.context],
      ['brief', card.brief],
      ['howToTest', card.howToTest],
      [
        'progress',
        joined(card.progress === undefined ? [] : [card.progress.now, card.progress.doneSoFar, card.progress.next]),
      ],
      ['note', joined(notes)],
    ],
  };
};

/**
 * Board's cards as a work source, handed to Conversation through `search.sources` so `fy search` and `search_work` find
 * them. The store hands back fresh card objects on every read, so a piece of work is kept as the same object while its
 * text and standing read the same: the search re-indexes by identity.
 */
export class BoardWorkSource implements WorkSource {
  readonly id = 'board';
  private readonly kept = new Map<string, { readonly signature: string; readonly work: RawWork }>();

  constructor(private readonly board: BoardCards) {}

  async list(): Promise<readonly RawWork[]> {
    const { cards, laneSets } = await this.board.snapshot();
    const present = new Set<string>();
    const works = cards.map(card => {
      const work = cardWork(card, laneSets.get(card.projectId));
      const signature = JSON.stringify([work.identity, work.updatedAtMs, work.fields]);
      present.add(work.key);
      const before = this.kept.get(work.key);
      if (before?.signature === signature) return before.work;
      this.kept.set(work.key, { signature, work });
      return work;
    });
    for (const key of [...this.kept.keys()]) if (!present.has(key)) this.kept.delete(key);
    return works;
  }
}
