import { describe, it } from 'bun:test';
import type { BoardTask } from '@ferretry/protocol';
import should from 'should';
import type { LaneSets } from '../../../../src/lib/board/graph.ts';
import { sessionsOnOpenCards } from '../../../../src/lib/session/archive/open-cards.ts';

/** A card as far as the rule reads it: who owns and holds it, whether it was dropped and in which lane. */
function card(owner: string, assignee: string | null, laneId: string, dropped = false): BoardTask {
  return { owner, assignee, laneId, projectId: 'p', dropped: dropped ? { at: 'x' } : null } as unknown as BoardTask;
}

const laneSets = new Map([
  [
    'p',
    {
      lanes: [
        { id: 'todo', category: 'backlog' },
        { id: 'doing', category: 'active' },
        { id: 'shipped', category: 'shipped' },
        { id: 'done', category: 'closed' },
      ],
    },
  ],
]) as unknown as LaneSets;

describe('the sessions on open cards', () => {
  it('should name the owner and the assignee of a card still in flight', () => {
    const sessions = sessionsOnOpenCards([card('lead', 'worker', 'doing')], laneSets);
    should([...sessions].sort()).deepEqual(['lead', 'worker']);
  });

  it('should ignore closed, shipped and dropped cards', () => {
    const sessions = sessionsOnOpenCards(
      [card('a', 'b', 'done'), card('c', null, 'shipped'), card('d', null, 'doing', true)],
      laneSets,
    );
    should([...sessions]).deepEqual([]);
  });

  it('should keep a card whose lane it cannot read', () => {
    const sessions = sessionsOnOpenCards([card('a', null, 'gone')], laneSets);
    should([...sessions]).deepEqual(['a']);
    should([...sessionsOnOpenCards([card('b', null, 'doing')], new Map())]).deepEqual(['b']);
  });
});
