import { describe, it } from 'bun:test';
import should from 'should';
import { sessionAddressCandidates } from '../../../../src/adapters/session/session-address-candidates.ts';
import { parseSessionId, type SessionId } from '../../../../src/lib/session-id.ts';

const LIVE = parseSessionId('live-1');
const OLD = parseSessionId('old-1');
const NAMELESS = parseSessionId('old-2');

const live = {
  listSessions: () => [{ id: LIVE }] as never,
  readConfig: async (id: SessionId) => ({ teammate: id === LIVE ? 'aniya' : 'nobody' }) as never,
  readState: async () => ({ status: 'running' }) as never,
};

describe('the sessions a name could address, once some are archived', () => {
  it('should still address an archived session by the name it answered to, with no read of its documents', async () => {
    let reads = 0;
    const candidates = await sessionAddressCandidates({
      ...live,
      readConfig: async (id: SessionId) => {
        reads += 1;
        return await live.readConfig(id);
      },
      listArchivedSessions: () =>
        [
          { id: OLD, name: 'mika', status: 'completed' },
          { id: NAMELESS, status: 'failed' },
        ] as never,
    });

    should(candidates).deepEqual([
      { id: LIVE, name: 'aniya', status: 'running' },
      { id: OLD, name: 'mika', status: 'completed' },
      { id: NAMELESS, status: 'failed' },
    ]);
    should(reads).equal(1);
  });

  it('should list only the live sessions for a storage that archives nothing', async () => {
    should(await sessionAddressCandidates(live)).deepEqual([{ id: LIVE, name: 'aniya', status: 'running' }]);
  });
});
