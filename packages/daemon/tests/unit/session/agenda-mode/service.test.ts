import { describe, it } from 'bun:test';
import should from 'should';
import {
  type AgendaModeFacts,
  agendaModeNote,
  SessionAgendaModeError,
  SessionAgendaModeService,
} from '../../../../src/lib/session/agenda-mode/service.ts';

function world(facts: AgendaModeFacts | undefined) {
  const writes: Array<readonly [string, boolean, string]> = [];
  const service = new SessionAgendaModeService({
    facts: async () => facts,
    write: async (sessionId, enabled, at) => {
      writes.push([sessionId, enabled, at]);
    },
    now: () => '2026-10-29T10:00:00.000Z',
  });
  return { service, writes };
}

describe('SessionAgendaModeService', () => {
  it('should read the switch without a restart', async () => {
    // Arrange
    const { service } = world({ enabled: true, running: true });

    // Act
    const outcome = await service.get('s1');

    // Assert
    should(outcome).deepEqual({ enabled: true, restartRequired: false, note: 'Agenda mode is on.' });
  });

  it('should need a restart only when a running ferret is changed', async () => {
    // Arrange
    const running = world({ enabled: false, running: true });
    const stopped = world({ enabled: false, running: false });

    // Act
    const live = await running.service.set('s1', true);
    const idle = await stopped.service.set('s1', true);

    // Assert
    should(live.restartRequired).be.true();
    should(idle.restartRequired).be.false();
    should(running.writes).deepEqual([['s1', true, '2026-10-29T10:00:00.000Z']]);
  });

  it('should say a switch already in place was already so, and need no restart', async () => {
    // Arrange
    const { service } = world({ enabled: true, running: true });

    // Act
    const outcome = await service.set('s1', true);

    // Assert
    should(outcome.restartRequired).be.false();
    should(outcome.note).equal('Agenda mode was already on.');
  });

  it('should refuse a session that does not exist, and write nothing', async () => {
    // Arrange
    const { service, writes } = world(undefined);

    // Act + Assert
    await should(service.set('ghost', true)).be.rejectedWith(SessionAgendaModeError);
    await should(service.get('ghost')).be.rejectedWith(SessionAgendaModeError);
    should(writes).be.empty();
  });

  it('should word the note by what is on, whether it changed and whether the ferret runs', () => {
    // Arrange + Act + Assert
    should(agendaModeNote(false, true, false)).match(/next launch/u);
    should(agendaModeNote(false, true, true)).match(/restarts/u);
    should(agendaModeNote(true, false, true)).equal('Agenda mode was already on.');
  });
});
