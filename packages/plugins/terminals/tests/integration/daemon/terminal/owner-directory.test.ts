import { describe, it } from 'bun:test';
import type { FerretsApi, FerretSummary } from '@ferretry/core-ferrets/contract';
import type { FerretId } from '@ferretry/kernel/contract';
import should from 'should';
import { FerretTerminalOwnerDirectory } from '../../../../daemon/adapters/terminal/owner-directory.ts';

const AT = '2026-01-01T00:00:00.000Z';

/** A ferret as the Ferrets port summarises one; only its name and state matter to who holds terminals. */
function ferret(id: string, name: string, state: string): FerretSummary {
  return {
    id,
    name,
    role: 'worker',
    harness: 'claude-code',
    runner: 'tmux',
    folder: '/home/dev/repo',
    state,
    createdAt: AT,
    stateAt: AT,
  } as unknown as FerretSummary;
}

/** The Ferrets port, holding exactly the ferrets given; `fails` names one whose lookup throws. */
function ferrets(held: readonly FerretSummary[], fails: ReadonlySet<string> = new Set()): Pick<FerretsApi, 'get'> {
  return {
    get: async (id: FerretId) => {
      if (fails.has(id)) throw new Error('ferrets unreadable');
      return held.find(entry => entry.id === id);
    },
  };
}

describe('FerretTerminalOwnerDirectory', () => {
  it('should place a stopped ferret as finished, labelled by its name', async () => {
    // Arrange
    const sut = new FerretTerminalOwnerDirectory(ferrets([ferret('s-1', 'fitzgerald', 'stopped')]));

    // Act
    const standing = await sut.standing('s-1');

    // Assert
    should(standing).deepEqual({ standing: 'finished', status: 'stopped', label: 'fitzgerald' });
  });

  it('should call a working ferret live, labelled by its name', async () => {
    // Arrange
    const sut = new FerretTerminalOwnerDirectory(ferrets([ferret('s-1', 'Fix the bug', 'working')]));

    // Act
    const standing = await sut.standing('s-1');

    // Assert
    should(standing).deepEqual({ standing: 'live', status: 'working', label: 'Fix the bug' });
  });

  it('should call a ferret Ferrets does not hold gone, and one that is not even an id gone too', async () => {
    // Arrange
    const sut = new FerretTerminalOwnerDirectory(ferrets([]));

    // Act
    const missing = await sut.standing('s-9');
    const malformed = await sut.standing('NOT AN ID');

    // Assert
    should(missing).deepEqual({ standing: 'gone', status: 'removed', label: 's-9' });
    should(malformed).deepEqual({ standing: 'gone', status: 'removed', label: 'NOT AN ID' });
  });

  it('should call a ferret whose lookup fails gone, labelled by its id', async () => {
    // Arrange
    const sut = new FerretTerminalOwnerDirectory(ferrets([ferret('s-1', 'fitzgerald', 'working')], new Set(['s-1'])));

    // Act
    const standing = await sut.standing('s-1');

    // Assert
    should(standing).deepEqual({ standing: 'gone', status: 'removed', label: 's-1' });
  });
});

describe('FerretTerminalOwnerDirectory and a live ferret that is only idle', () => {
  it('should call every state live except stopped, so no idle or starting ferret loses its shells', async () => {
    // Arrange
    const states = ['starting', 'working', 'idle', 'stopped'] as const;
    const sut = new FerretTerminalOwnerDirectory(ferrets(states.map(state => ferret(`s-${state}`, state, state))));

    // Act
    const standings = await Promise.all(
      states.map(async state => ({ state, standing: (await sut.standing(`s-${state}`)).standing })),
    );

    // Assert
    should(standings.filter(entry => entry.standing === 'finished').map(entry => entry.state)).deepEqual(['stopped']);
    should(standings.filter(entry => entry.standing === 'live').map(entry => entry.state)).deepEqual([
      'starting',
      'working',
      'idle',
    ]);
  });
});
