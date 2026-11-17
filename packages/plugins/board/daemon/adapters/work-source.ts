import { instantFromEpochMs } from '@ferretry/std';
import type { RawWork, WorkSource } from '@ferretry/plugin-conversation/contract';
import type { Task, LaneSet } from '../../contract/index.ts';
import type { LaneSets } from '../lib/board/index.ts';

/** What Board reads of itself to hand its cards over: every card as stored, with the lanes of each board. */
export interface BoardTasks {
  snapshot(): Promise<{ readonly cards: readonly Task[]; readonly laneSets: LaneSets }>;
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
export const taskWork = (task: Task, laneSet: LaneSet | undefined): RawWork => {
  const lane = laneSet?.lanes.find(candidate => candidate.id === task.laneId);
  const state = task.dropped !== null ? 'dropped' : lane?.category === 'closed' ? 'closed' : 'open';
  const updatedAtMs = instantMs(task.dropped?.at ?? task.history.at(-1)?.at ?? task.createdAt);
  const notes = task.history.flatMap(event => (event.type === 'note' ? [event.text] : []));
  return {
    key: `card:${task.id}`,
    kind: 'card',
    updatedAtMs,
    identity: {
      kind: 'card',
      id: task.id,
      project: task.projectId,
      ferret: task.owner,
      title: task.title,
      state,
      standing: state === 'dropped' ? 'Dropped' : (lane?.name ?? task.laneId),
      updatedAt: instantFromEpochMs(updatedAtMs),
    },
    fields: [
      ['id', task.id],
      ['title', task.title],
      ['summary', task.summary],
      ['ask', joined([task.ask.text, ...task.clarifications.map(clarification => clarification.text)])],
      ['premise', task.premise],
      ['context', task.context],
      ['brief', task.brief],
      ['howToTest', task.howToTest],
      [
        'progress',
        joined(task.progress === undefined ? [] : [task.progress.now, task.progress.doneSoFar, task.progress.next]),
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
  /** Read on every search: the store is in memory and the identity-stable works make the re-index cheap, so a card made a moment ago is found. */
  readonly cheap = true;
  private readonly kept = new Map<string, { readonly signature: string; readonly work: RawWork }>();

  constructor(private readonly board: BoardTasks) {}

  async list(): Promise<readonly RawWork[]> {
    const { cards: tasks, laneSets } = await this.board.snapshot();
    const present = new Set<string>();
    const works = tasks.map(task => {
      const work = taskWork(task, laneSets.get(task.projectId));
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
