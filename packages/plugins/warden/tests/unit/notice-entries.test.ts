import { describe, it } from 'bun:test';
import should from 'should';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { AsksWardenAgenda, NoticeEntries } from '../../daemon/asks.ts';
import {
  type WardenEscalationRaise,
  wardenEscalationSourceRef,
  wardenFleetEscalationSourceRef,
} from '../../daemon/lib/escalation.ts';

const raiseOf = (sessionId: string, sourceRef: string): WardenEscalationRaise => ({
  sessionId,
  anomalyKind: 'sus_thinking',
  subjectKey: `${sessionId}|sus_thinking`,
  source: 'agent-raised',
  sourceRef,
  title: 'Looks stuck',
  subject: `${sessionId} looks stuck thinking`,
  why: 'no transcript growth',
  premise: 'p',
  context: 'c',
  howToResolve: 'Look at it.',
  waitingSince: '2026-11-07T12:00:00.000Z',
  notice: true,
  ping: true,
  reason: 'needs_human',
});

describe('a warden notice about one ferret', () => {
  it('should raise one ask per ferret when two ferrets are stuck the same way', async () => {
    // Arrange
    const asks = new FakeAsks();
    const agenda = new AsksWardenAgenda(asks, new NoticeEntries());
    const ref = wardenEscalationSourceRef('sus_thinking');

    // Act
    const first = await agenda.raise('f1', raiseOf('f1', ref));
    const second = await agenda.raise('f2', raiseOf('f2', ref));
    const again = await agenda.raise('f2', raiseOf('f2', ref));

    // Assert
    should(first).equal('created');
    should(second).equal('created');
    should(again).equal('unchanged');
    should((await agenda.board('f1'))?.items.map(item => item.sourceRef)).eql([ref]);
    should((await agenda.board('f2'))?.items.map(item => item.sourceRef)).eql([ref]);
  });

  it('should clear only the ferret whose reason went away', async () => {
    // Arrange
    const asks = new FakeAsks();
    const agenda = new AsksWardenAgenda(asks, new NoticeEntries());
    const ref = wardenEscalationSourceRef('sus_thinking');
    await agenda.raise('f1', raiseOf('f1', ref));
    await agenda.raise('f2', raiseOf('f2', ref));

    // Act
    const cleared = await agenda.resolveSource('f1', 'agent-raised', ref, 'gone');

    // Assert
    should(cleared).equal(true);
    should((await agenda.board('f1'))?.items).eql([]);
    should((await agenda.board('f2'))?.items.map(item => item.sourceRef)).eql([ref]);
  });

  it('should keep a machine-wide notice one ask whatever board it lands on', async () => {
    // Arrange
    const asks = new FakeAsks();
    const agenda = new AsksWardenAgenda(asks, new NoticeEntries());
    const ref = wardenFleetEscalationSourceRef('sus_thinking', 'login-a');

    // Act
    const first = await agenda.raise('f1', raiseOf('f1', ref));
    const second = await agenda.raise('f2', raiseOf('f2', ref));

    // Assert
    should(first).equal('created');
    should(second).equal('unchanged');
  });

  it('should read the notice back from its entry, even in a fresh process', () => {
    // Arrange
    const ref = wardenEscalationSourceRef('sus_thinking', 'child-1');
    const entry = new NoticeEntries().entryOf(ref, 'f1');

    // Act
    const read = new NoticeEntries().refOf(entry);

    // Assert
    should(entry).equal(`f.f1.${ref}`);
    should(read).equal(ref);
  });
});
