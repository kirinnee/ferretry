import { describe, it } from 'bun:test';
import should from 'should';
import { StorageImportSessions } from '../../../src/adapters/board-import/index.ts';

const sessions = (ids: readonly string[], candidates: { id: string; name?: string; teammate?: string }[] = []) =>
  new StorageImportSessions(
    () => ids,
    async () => candidates as never,
  );

describe('StorageImportSessions', () => {
  it('should list the session ids the daemon holds', async () => {
    should(await sessions(['s1', 's2']).list()).eql(['s1', 's2']);
  });

  it('should say whether a string is a held session id', async () => {
    const held = sessions(['s1']);
    should(await held.exists('s1')).equal(true);
    should(await held.exists('s9')).equal(false);
  });

  it('should resolve an assignee to a session by id', async () => {
    should(await sessions([], [{ id: 's1', name: 'Ada' }]).resolveAssignee('s1')).equal('s1');
  });

  it('should resolve an assignee by teammate callsign', async () => {
    should(await sessions([], [{ id: 's1', teammate: 'ossy' }]).resolveAssignee('ossy')).equal('s1');
  });

  it('should resolve to null when nothing, or more than one session, answers to the string', async () => {
    const held = sessions(
      [],
      [
        { id: 's1', name: 'Ada' },
        { id: 's2', name: 'Ada' },
      ],
    );
    should(await held.resolveAssignee('Ada')).equal(null);
    should(await held.resolveAssignee('nobody')).equal(null);
  });
});
