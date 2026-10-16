import { describe, it } from 'bun:test';
import should from 'should';
import { sessionAddressCandidates } from '../../../src/adapters/session/session-address-candidates.ts';
import { parseSessionId, type SessionId } from '../../../src/lib/index.ts';

const ANIYA = parseSessionId('mvb0sw7d-27f71326');
const BROKEN = parseSessionId('lzz00000-00000000');
const BARE = parseSessionId('lzz11111-11111111');

/** Three sessions: a named running agent, one whose documents throw, and one with junk documents. */
const storage = {
  listSessions: () => [{ id: ANIYA }, { id: BROKEN }, { id: BARE }],
  readConfig: async (id: SessionId) => {
    if (id === BROKEN) throw new Error('unreadable');
    return id === ANIYA ? { teammate: 'aniya' } : { teammate: '   ' };
  },
  readState: async (id: SessionId) => {
    if (id === BROKEN) throw new Error('unreadable');
    return id === ANIYA ? { status: 'running' } : null;
  },
} as unknown as Parameters<typeof sessionAddressCandidates>[0];

describe('the sessions a name could address', () => {
  it('should list every session, with the name and status its documents hold and by id when they hold none', async () => {
    // Act
    const candidates = await sessionAddressCandidates(storage);

    // Assert — an unreadable session is still addressable by its id, and a blank name is no name.
    should(candidates).deepEqual([{ id: ANIYA, name: 'aniya', status: 'running' }, { id: BROKEN }, { id: BARE }]);
  });
});
