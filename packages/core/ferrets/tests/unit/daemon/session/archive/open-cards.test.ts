import { describe, it } from 'bun:test';
import should from 'should';
import { sessionsOnOpenCards } from '../../../../../daemon/lib/session/archive/open-cards.ts';
import type { LaneCategory, OpenCardStanding } from '../../../../../daemon/lib/session/peers/board.ts';

/** The lanes of project `p`, as Board resolves a card's lane to its category. */
const lanes: Readonly<Record<string, LaneCategory>> = {
  todo: 'backlog',
  doing: 'active',
  shipped: 'shipped',
  done: 'closed',
};

/** A card as far as the rule reads it: who owns and holds it, whether it was dropped and in which lane. */
function card(
  owner: string,
  assignee: string | null,
  laneId: string,
  dropped = false,
  laneSet: Readonly<Record<string, LaneCategory>> | undefined = lanes,
): OpenCardStanding {
  return { owner, assignee, dropped: dropped ? { at: 'x' } : null, category: laneSet?.[laneId] };
}

describe('the sessions on open cards', () => {
  it('should name the owner and the assignee of a card still in flight', () => {
    const sessions = sessionsOnOpenCards([card('lead', 'worker', 'doing')]);
    should([...sessions].sort()).deepEqual(['lead', 'worker']);
  });

  it('should ignore closed, shipped and dropped cards', () => {
    const sessions = sessionsOnOpenCards([
      card('a', 'b', 'done'),
      card('c', null, 'shipped'),
      card('d', null, 'doing', true),
    ]);
    should([...sessions]).deepEqual([]);
  });

  it('should keep a card whose lane it cannot read', () => {
    const sessions = sessionsOnOpenCards([card('a', null, 'gone')]);
    should([...sessions]).deepEqual(['a']);
    should([...sessionsOnOpenCards([card('b', null, 'doing', false, undefined)])]).deepEqual(['b']);
  });
});
