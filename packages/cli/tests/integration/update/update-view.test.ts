import { describe, it } from 'bun:test';
import should from 'should';
import type { z } from 'zod';
import { DAEMON_UPDATE_PATH, ProtocolDaemonUpdateView } from '../../../src/adapters/update/update-view';
import { FakeUpdateView } from '../../unit/update/fixtures';

describe('ProtocolDaemonUpdateView', () => {
  it('reads and validates the daemon’s update view', async () => {
    const body = await new FakeUpdateView([2]).view();
    const asked: string[] = [];
    const view = await new ProtocolDaemonUpdateView({
      request: <T>(path: string, schema: z.ZodType<T>) => {
        asked.push(path);
        return Promise.resolve(schema.parse(body));
      },
    }).view();
    should(view?.midTurn).equal(2);
    should(asked).deepEqual([DAEMON_UPDATE_PATH]);
  });

  it('answers nothing for a daemon that is down or too old', async () => {
    const view = await new ProtocolDaemonUpdateView({
      request: () => Promise.reject(new Error('unknown route')),
    }).view();
    should(view).be.undefined();
  });
});
