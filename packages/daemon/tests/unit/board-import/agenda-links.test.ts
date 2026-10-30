import { describe, it } from 'bun:test';
import should from 'should';
import type { AgendaLedger } from '../../../src/lib/agenda/state-machine.ts';
import { linkAsksIn, unlinkedAsksOf } from '../../../src/lib/board-import/index.ts';

interface Row {
  readonly id: string;
  readonly lifecycle?: 'active' | 'addressed';
  readonly notice?: true;
  readonly task?: { id: string } | null;
}

const ledgerOf = (...rows: Row[]): AgendaLedger =>
  ({
    sessionId: 'lead',
    nextId: 9,
    updatedAt: 'before',
    entries: rows.map(row => ({
      lifecycle: row.lifecycle ?? 'active',
      origin: { kind: 'human' },
      item: {
        id: row.id,
        ...(row.notice === true ? { notice: true } : {}),
        ...(row.task === undefined ? {} : { task: row.task }),
      },
    })),
  }) as unknown as AgendaLedger;

describe('unlinkedAsksOf', () => {
  it('should be empty for a session with no ledger', () => {
    // Assert
    should(unlinkedAsksOf(null)).eql([]);
  });

  it('should list only open, non-notice items that name no card', () => {
    // Arrange
    const ledger = ledgerOf(
      { id: 'A1' },
      { id: 'A2', task: null },
      { id: 'A3', task: { id: 'F1' } },
      { id: 'A4', notice: true },
      { id: 'A5', lifecycle: 'addressed' },
    );

    // Act
    const asks = unlinkedAsksOf(ledger);

    // Assert
    should(asks).eql([{ id: 'A1' }, { id: 'A2' }]);
  });
});

describe('linkAsksIn', () => {
  it('should point the named items at their card, marking blocking ones', () => {
    // Arrange
    const ledger = ledgerOf({ id: 'A1' }, { id: 'A2' }, { id: 'A3' });

    // Act
    const result = linkAsksIn(
      ledger,
      [
        { id: 'A1', task: { id: 'F1' }, blocking: true },
        { id: 'A2', task: { id: 'F1' }, blocking: false },
      ],
      'now',
    );

    // Assert
    should(result.linked).equal(2);
    should(result.ledger.updatedAt).equal('now');
    const items = result.ledger.entries.map(entry => entry.item) as unknown as Record<string, unknown>[];
    should(items[0]).match({ id: 'A1', task: { id: 'F1' }, blockingNow: true });
    should(items[1]).match({ id: 'A2', task: { id: 'F1' } });
    should(items[1]).not.have.property('blockingNow');
    should(items[2]).not.have.property('task');
  });

  it('should leave the ledger as it is when nothing can be linked', () => {
    // Arrange
    const ledger = ledgerOf(
      { id: 'A1', task: { id: 'F9' } },
      { id: 'A2', notice: true },
      { id: 'A3', lifecycle: 'addressed' },
      { id: 'A4' },
    );

    // Act
    const result = linkAsksIn(
      ledger,
      [
        { id: 'A1', task: { id: 'F1' }, blocking: true },
        { id: 'A2', task: { id: 'F1' }, blocking: true },
        { id: 'A3', task: { id: 'F1' }, blocking: true },
        { id: 'A7', task: { id: 'F1' }, blocking: true },
      ],
      'now',
    );

    // Assert
    should(result.linked).equal(0);
    should(result.ledger).equal(ledger);
  });
});
