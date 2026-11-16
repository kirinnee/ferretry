import { describe, expect, test } from 'bun:test';
import { trustedRequesterPid } from '../../../../../daemon/modules/session-move.ts';

/** The pid that exempts a call from the move gate is honoured only from the session moving itself. */
describe('trustedRequesterPid', () => {
  const log = () => {
    const warnings: Array<[string, unknown]> = [];
    return { warnings, warn: (message: string, fields?: unknown) => void warnings.push([message, fields]) };
  };

  test('honours the pid of a session moving itself, without a word', () => {
    const logged = log();
    expect(trustedRequesterPid(logged, 'wren' as never, { requesterPid: 4242, movedBy: 'session:wren' })).toBe(4242);
    expect(logged.warnings).toEqual([]);
  });

  test('ignores the pid from the owner, another ferret, the Warden or a script, and says so', () => {
    for (const movedBy of ['owner', 'session:otter', 'warden', undefined]) {
      const logged = log();
      expect(
        trustedRequesterPid(logged, 'wren' as never, { requesterPid: 4242, ...(movedBy ? { movedBy } : {}) }),
      ).toBeUndefined();
      expect(logged.warnings).toEqual([
        [
          'a move named a requesting pid but is not a self-move; the pid is ignored and the gate sees every process',
          { session: 'wren', by: movedBy ?? 'owner', requesterPid: 4242 },
        ],
      ]);
    }
  });

  test('has nothing to say when no pid was sent', () => {
    const logged = log();
    expect(trustedRequesterPid(logged, 'wren' as never, { movedBy: 'owner' })).toBeUndefined();
    expect(logged.warnings).toEqual([]);
  });
});
