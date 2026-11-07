import { describe, it } from 'bun:test';
import type { TerminalHolder } from '../../../../contract/index.ts';
import should from 'should';
import type { TerminalOwnerStanding } from '../../../../daemon/lib/terminal/contracts.ts';
import {
  describeCapacity,
  groupTerminalHolders,
  isReclaimable,
  standingOfSessionStatus,
} from '../../../../daemon/lib/terminal/holders.ts';

const holder = (overrides: Partial<TerminalHolder>): TerminalHolder => ({
  sessionId: 's-1',
  label: 'fitzgerald',
  standing: 'finished',
  status: 'stopped',
  count: 1,
  ...overrides,
});

describe('where a terminal owner stands', () => {
  it('should treat a completed or stopped session as finished', () => {
    // Arrange / Act
    const completed = standingOfSessionStatus('completed');
    const stopped = standingOfSessionStatus('stopped');

    // Assert
    should(completed).deepEqual({ standing: 'finished', status: 'completed' });
    should(stopped).deepEqual({ standing: 'finished', status: 'stopped' });
  });

  it('should treat a session the daemon does not hold as gone', () => {
    // Arrange / Act
    const gone = standingOfSessionStatus(undefined);

    // Assert
    should(gone).deepEqual({ standing: 'gone', status: 'removed' });
  });

  it('should treat every other status as live, so a revivable ferret keeps its shells', () => {
    // Arrange / Act
    const standings = ['running', 'idle', 'stalled', 'failed', 'launching'].map(standingOfSessionStatus);

    // Assert
    should(standings.every(entry => entry.standing === 'live')).equal(true);
  });

  it('should reclaim only the terminals of finished and gone owners', () => {
    // Arrange / Act / Assert
    should([isReclaimable('finished'), isReclaimable('gone'), isReclaimable('live')]).deepEqual([true, true, false]);
  });
});

describe('who holds the terminals', () => {
  const standings = new Map<string, TerminalOwnerStanding>([
    ['a', { standing: 'finished', status: 'stopped', label: 'fitzgerald' }],
    ['b', { standing: 'live', status: 'running', label: 'aime' }],
    ['c', { standing: 'gone', status: 'removed', label: 'selma' }],
  ]);

  it('should group by owner, largest first, equal holders in label order', () => {
    // Arrange
    const records = ['a', 'a', 'a', 'b', 'c'].map(ownerId => ({ ownerId }));

    // Act
    const holders = groupTerminalHolders(records, standings);

    // Assert
    should(holders.map(entry => [entry.label, entry.count])).deepEqual([
      ['fitzgerald', 3],
      ['aime', 1],
      ['selma', 1],
    ]);
  });

  it('should call an owner nobody could place live and unknown, by its id', () => {
    // Arrange / Act
    const holders = groupTerminalHolders([{ ownerId: 'mystery' }], new Map());

    // Assert
    should(holders).deepEqual([
      { sessionId: 'mystery', label: 'mystery', standing: 'live', status: 'unknown', count: 1 },
    ]);
  });
});

describe('the refusal when the machine is full', () => {
  it('should name who holds the slots, finished holders first, and what to do about it', () => {
    // Arrange
    const holders = [
      holder({ sessionId: 'b', label: 'aime', standing: 'live', status: 'running', count: 2 }),
      holder({ sessionId: 'a', label: 'fitzgerald', count: 6 }),
    ];

    // Act
    const message = describeCapacity(8, holders);

    // Assert
    should(message).equal(
      'global terminal capacity reached: 8 terminals open: 6 by fitzgerald (stopped), 2 by aime (running). ' +
        'Close the finished ones in Settings or with `fy terminal close --all-finished`.',
    );
  });

  it('should only suggest closing one when every holder is live', () => {
    // Arrange
    const holders = [holder({ label: 'aime', standing: 'live', status: 'running', count: 3 })];

    // Act
    const message = describeCapacity(3, holders);

    // Assert
    should(message).equal(
      'global terminal capacity reached: 3 terminals open: 3 by aime (running). Close one you no longer need.',
    );
  });

  it('should still refuse plainly when nobody could say who holds them', () => {
    // Arrange / Act
    const message = describeCapacity(24, []);

    // Assert
    should(message).equal('global terminal capacity reached: 24 terminals open.');
  });
});
