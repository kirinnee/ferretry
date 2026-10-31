import { describe, it } from 'bun:test';
import { reviveRuling, type SessionView } from '@ferretry/protocol';
import should from 'should';
import { withRevive } from '../../../../src/lib/session/resume/revive-view.ts';
import { sessionView } from '../../runtime/mounts/support.ts';

const view = (id: string, status: SessionView['state']['status']): SessionView => sessionView(id, {}, { status });

const reader = withRevive({
  list: async () => [view('a', 'running'), view('b', 'stopped'), view('c', 'kill_failed')],
  get: async id => (id === 'none' ? undefined : view(id, 'failed')),
});

describe('withRevive', () => {
  it('stamps the shared verdict on every view of a list, and on nothing else', async () => {
    const listed = await reader.list();
    should(listed.map(item => item.revive)).deepEqual([
      reviveRuling('running'),
      reviveRuling('stopped'),
      reviveRuling('kill_failed'),
    ]);
    should(listed[0]?.revive?.revivable).be.false();
    should(listed[1]?.revive?.revivable).be.true();
    should(listed[0]?.state.status).equal('running');
  });

  it('stamps the one view it reads, and answers nothing for an unknown reference', async () => {
    should((await reader.get('x'))?.revive).deepEqual(reviveRuling('failed'));
    should(await reader.get('none')).be.undefined();
  });
});
