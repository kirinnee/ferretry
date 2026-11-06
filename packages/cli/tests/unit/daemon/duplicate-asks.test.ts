import { describe, it } from 'bun:test';
import type { HealthView } from '@ferretry/protocol';
import should from 'should';
import { duplicateAskLines, duplicateAskReport } from '../../../src/lib/daemon/duplicate-asks';

describe('duplicate ask lines', () => {
  const pair = {
    kind: 'card' as const,
    members: [
      { sessionId: 'lead', id: 'A1' },
      { sessionId: 'peer', id: 'A2' },
    ],
    why: 'not closed: a gate the owner answered',
  };

  it('should say nothing for an older daemon, and say so when there are none', () => {
    should(duplicateAskLines(undefined)).deepEqual([]);
    should(duplicateAskLines([])).deepEqual(['no duplicate asks on the agendas']);
  });

  it('should say how many, and no more, when the daemon sent only the count', () => {
    should(duplicateAskLines(undefined, 0)).deepEqual([]);
    should(duplicateAskLines(undefined, 2)).deepEqual([
      "2 possible duplicate asks left open (the details are for the daemon's host)",
    ]);
  });

  it('should name each possible duplicate and where it is open', async () => {
    should(duplicateAskLines([pair])).deepEqual([
      '1 possible duplicate ask left open (the daemon closes only the ones it can prove):',
      '  !A1 on lead and !A2 on peer: card — not closed: a gate the owner answered',
    ]);
    const report = await duplicateAskReport({ probe: () => Promise.resolve({ duplicateAsks: [pair] } as HealthView) });
    should(report).have.length(2);
  });
});

describe('duplicate ask report', () => {
  it('should say nothing when the daemon does not answer', async () => {
    should(await duplicateAskReport({ probe: () => Promise.resolve(undefined) })).deepEqual([]);
  });
});
