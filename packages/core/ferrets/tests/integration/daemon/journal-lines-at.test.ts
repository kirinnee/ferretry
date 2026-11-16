/**
 * `journalLinesAt` reads the journal lines at some positions in one pass and holds only those. A read that fails part
 * way keeps what it had already read and leaves every later position absent, so the caller refuses those positions
 * rather than answering from a half-read journal.
 */
import { describe, it } from 'bun:test';
import type { StatePort } from '@ferretry/kernel/contract';
import should from 'should';
import { journalLinesAt } from '../../../daemon/adapters/storage/journal-read.ts';
import { parseSessionId } from '../../../daemon/lib/session-id.ts';

const A = parseSessionId('journal-at-a');

/** A state port whose journal yields `records`, then (when `fault` is given) throws it. */
function journalOf(records: readonly unknown[], fault?: Error): StatePort {
  return {
    lines: () =>
      (async function* () {
        for (const record of records) yield record;
        if (fault !== undefined) throw fault;
      })(),
  } as unknown as StatePort;
}

describe('journalLinesAt', () => {
  it('should keep the records read before a fault and leave every later position absent', async () => {
    // Arrange — the third read fails, so only positions 0 and 1 were ever reached.
    const state = journalOf(['first', 'second'], new Error('disk fell over'));

    // Act
    const found = await journalLinesAt(state, A, new Set([0, 1, 3]));

    // Assert
    should([...found.entries()]).eql([
      [0, 'first'],
      [1, 'second'],
    ]);
    should(found.has(3)).be.false();
  });

  it('should answer only the asked positions from a journal that reads to its end', async () => {
    const state = journalOf(['a', 'b', 'c', 'd']);

    const found = await journalLinesAt(state, A, new Set([1, 2]));

    should([...found.entries()]).eql([
      [1, 'b'],
      [2, 'c'],
    ]);
  });

  it('should read nothing when no position is asked for', async () => {
    const found = await journalLinesAt(journalOf(['a'], new Error('never read')), A, new Set());

    should(found.size).equal(0);
  });
});
