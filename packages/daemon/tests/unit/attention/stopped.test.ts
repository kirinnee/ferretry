import { describe, it } from 'bun:test';
import { type AttentionItem, AttentionItemSchema } from '@ferretry/protocol';
import should from 'should';
import { decoratedSummary, ownerTurnItems, TurnChanges } from '../../../src/lib/attention/stopped.ts';

const NOW = '2026-10-23T10:00:00.000Z';

const item = (id: string, extra: Record<string, unknown> = {}): AttentionItem =>
  AttentionItemSchema.parse({
    id,
    source: 'agent-raised',
    sourceRef: null,
    subject: `Ask ${id}`,
    why: 'Because.',
    waitingSince: NOW,
    howToResolve: 'Pick one.',
    ask: { kind: 'open-question' },
    raisedBy: 'agent',
    raisedBySession: 's1',
    raisedByName: 'Ada',
    ...extra,
  });

const summary = { count: 1, updatedAt: NOW } as never;

describe('ownerTurnItems', () => {
  it('should keep the items waiting on the owner, and drop notices, ferret-turn items and resolved ones', () => {
    // Arrange
    const items = [item('A1'), item('A2', { notice: true }), item('A3', { waitingOn: 'ferret', askedAt: NOW })];

    // Act
    const owner = ownerTurnItems(items);

    // Assert
    should(owner.map(entry => entry.id)).deepEqual(['A1']);
  });
});

describe('decoratedSummary', () => {
  it('should add nothing to a summary of a ferret that works without an agenda', () => {
    // Arrange + Act
    const decorated = decoratedSummary(summary, [item('A1')], false, undefined);

    // Assert
    should(decorated).deepEqual(summary);
  });

  it('should say agenda mode, and stopped only when idle with an item on the owner', () => {
    // Arrange + Act
    const stopped = decoratedSummary(summary, [item('A1')], true, NOW);
    const idleWithNothing = decoratedSummary(summary, [item('A1', { notice: true })], true, NOW);
    const idleOnTheFerret = decoratedSummary(summary, [item('A1', { waitingOn: 'ferret', askedAt: NOW })], true, NOW);
    const working = decoratedSummary(summary, [item('A1')], true, undefined);

    // Assert
    should(stopped).have.properties({ agendaMode: true, stopped: true });
    should(idleWithNothing).not.have.property('stopped');
    should(idleOnTheFerret).not.have.property('stopped');
    should(working).have.property('agendaMode', true);
    should(working).not.have.property('stopped');
  });

  it('should leave an absent summary absent, whatever the mode', () => {
    // Arrange + Act + Assert
    should(decoratedSummary(undefined, [], true, NOW)).be.undefined();
  });
});

describe('TurnChanges', () => {
  it('should call a session never seen moved, and the same signature after it not', () => {
    // Arrange
    const changes = new TurnChanges();

    // Act + Assert
    should(changes.moved('s1', 'working:1')).be.true();
    should(changes.moved('s1', 'working:1')).be.false();
    should(changes.moved('s1', 'your-turn:2')).be.true();
  });

  it('should not call a primed session moved until its signature differs', () => {
    // Arrange
    const changes = new TurnChanges();
    changes.prime('s1', 'your-turn:2');

    // Act + Assert
    should(changes.moved('s1', 'your-turn:2')).be.false();
    should(changes.moved('s1', 'working:3')).be.true();
  });
});
