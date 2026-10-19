import { describe, it } from 'bun:test';
import should from 'should';
import {
  packSwitchNote,
  type PackSwitchFacts,
  SessionPackError,
  SessionPackService,
} from '../../../../src/lib/session/pack/service.ts';

const AT = '2026-10-19T00:00:00.000Z';

function service(facts: PackSwitchFacts | undefined) {
  const writes: Array<readonly [string, boolean, string]> = [];
  const subject = new SessionPackService({
    facts: async () => facts,
    write: async (id, enabled, at) => {
      writes.push([id, enabled, at]);
    },
    now: () => AT,
  });
  return { subject, writes };
}

describe('SessionPackService', () => {
  it('should record the switch and ask for a restart only when a running ferret changes', async () => {
    // Arrange
    const running = service({ enabled: true, running: true });
    const stopped = service({ enabled: false, running: false });

    // Act
    const off = await running.subject.set('s1', false);
    const on = await stopped.subject.set('s2', true);

    // Assert
    should(off).deepEqual({
      restartRequired: true,
      note: 'Pack mode is off. This ferret is running, so it is told when it restarts; it can start no sub-ferret from now.',
    });
    should(on).deepEqual({
      restartRequired: false,
      note: 'Pack mode is on; this ferret is not running, so it takes effect at its next launch.',
    });
    should([...running.writes, ...stopped.writes]).deepEqual([
      ['s1', false, AT],
      ['s2', true, AT],
    ]);
  });

  it('should read a ferret from before the switch as on, so turning it on changes nothing', async () => {
    // Arrange
    const legacy = service({ enabled: undefined, running: true });

    // Act
    const outcome = await legacy.subject.set('s1', true);

    // Assert
    should(outcome).deepEqual({ restartRequired: false, note: 'Pack mode was already on.' });
    should(legacy.writes).deepEqual([['s1', true, AT]]);
  });

  it('should still write when the switch is unchanged, so the launch environment is made to agree', async () => {
    // Arrange
    const same = service({ enabled: false, running: true });

    // Act
    const outcome = await same.subject.set('s1', false);

    // Assert
    should(outcome.restartRequired).be.false();
    should(same.writes).deepEqual([['s1', false, AT]]);
  });

  it('should refuse a session that does not exist and write nothing', async () => {
    // Arrange
    const missing = service(undefined);

    // Act
    const refused = await missing.subject.set('ghost', true).catch((error: unknown) => error);

    // Assert
    should(refused).be.instanceOf(SessionPackError);
    should((refused as SessionPackError).reason).equal('not-found');
    should((refused as SessionPackError).name).equal('SessionPackError');
    should((refused as SessionPackError).message).equal('no session ghost');
    should(missing.writes).be.empty();
  });
});

describe('packSwitchNote', () => {
  it('should say what the ferret will be told and when', () => {
    // Arrange / Act
    const notes = [
      packSwitchNote(true, false, true),
      packSwitchNote(false, false, false),
      packSwitchNote(true, true, true),
      packSwitchNote(false, true, true),
      packSwitchNote(false, true, false),
    ];

    // Assert
    should(notes).deepEqual([
      'Pack mode was already on.',
      'Pack mode was already off.',
      'Pack mode is on. This ferret is running, so it is told when it restarts.',
      'Pack mode is off. This ferret is running, so it is told when it restarts; it can start no sub-ferret from now.',
      'Pack mode is off; this ferret is not running, so it takes effect at its next launch.',
    ]);
  });
});
