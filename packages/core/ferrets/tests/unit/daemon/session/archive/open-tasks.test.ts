import { describe, it } from 'bun:test';
import should from 'should';
import { sessionsOnOpenTasks } from '../../../../../daemon/lib/session/archive/open-tasks.ts';
import type { LaneCategory, OpenTaskStanding } from '../../../../../daemon/lib/session/peers/board.ts';

/** The lanes of project `p`, as Board resolves a task's lane to its category. */
const lanes: Readonly<Record<string, LaneCategory>> = {
  todo: 'backlog',
  doing: 'active',
  shipped: 'shipped',
  done: 'closed',
};

/** A task as far as the rule reads it: who owns and holds it, whether it was dropped and in which lane. */
function task(
  owner: string,
  assignee: string | null,
  laneId: string,
  dropped = false,
  laneSet: Readonly<Record<string, LaneCategory>> | undefined = lanes,
): OpenTaskStanding {
  return { owner, assignee, dropped: dropped ? { at: 'x' } : null, category: laneSet?.[laneId] };
}

describe('the sessions on open cards', () => {
  it('should name the owner and the assignee of a card still in flight', () => {
    const sessions = sessionsOnOpenTasks([task('lead', 'worker', 'doing')]);
    should([...sessions].sort()).deepEqual(['lead', 'worker']);
  });

  it('should ignore closed, shipped and dropped cards', () => {
    const sessions = sessionsOnOpenTasks([
      task('a', 'b', 'done'),
      task('c', null, 'shipped'),
      task('d', null, 'doing', true),
    ]);
    should([...sessions]).deepEqual([]);
  });

  it('should keep a card whose lane it cannot read', () => {
    const sessions = sessionsOnOpenTasks([task('a', null, 'gone')]);
    should([...sessions]).deepEqual(['a']);
    should([...sessionsOnOpenTasks([task('b', null, 'doing', false, undefined)])]).deepEqual(['b']);
  });
});
