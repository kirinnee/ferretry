import { describe, it } from 'bun:test';
import should from 'should';
import {
  type HypermediaFacts,
  hypermediaNote,
  SessionHypermediaError,
  SessionHypermediaService,
} from '../../../../src/lib/session/hypermedia/service.ts';

const AT = '2026-10-19T00:00:00.000Z';

function service(facts: HypermediaFacts | undefined) {
  const writes: Array<readonly [string, boolean, string]> = [];
  const subject = new SessionHypermediaService({
    facts: async () => facts,
    write: async (id, enabled, at) => {
      writes.push([id, enabled, at]);
    },
    now: () => AT,
  });
  return { subject, writes };
}

describe('SessionHypermediaService', () => {
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
      note: 'Hypermedia is off. This ferret is running, so it takes effect when the ferret restarts.',
    });
    should(on).deepEqual({
      restartRequired: false,
      note: 'Hypermedia is on; this ferret is not running, so it takes effect at its next launch.',
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
    should(outcome).deepEqual({ restartRequired: false, note: 'Hypermedia was already on.' });
    should(legacy.writes).deepEqual([['s1', true, AT]]);
  });

  it('should refuse a session that does not exist and write nothing', async () => {
    // Arrange
    const missing = service(undefined);

    // Act
    const refused = await missing.subject.set('ghost', true).catch((error: unknown) => error);

    // Assert
    should(refused).be.instanceOf(SessionHypermediaError);
    should((refused as SessionHypermediaError).reason).equal('not-found');
    should(missing.writes).be.empty();
    should(hypermediaNote(false, false, false)).equal('Hypermedia was already off.');
  });
});
