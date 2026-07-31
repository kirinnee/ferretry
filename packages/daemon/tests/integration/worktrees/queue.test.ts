import { describe, it } from 'bun:test';
import should from 'should';
import { WorktreeOperationQueue } from '../../../src/adapters/worktrees/index.ts';

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 1));

describe('WorktreeOperationQueue', () => {
  it('should run operations on one repository strictly one at a time', async () => {
    // Arrange — two sessions racing on the same repository is how a callsign or branch collides.
    const events: string[] = [];
    const subject = new WorktreeOperationQueue();
    const operation = async (label: string) => {
      events.push(`${label}:start`);
      await settle();
      events.push(`${label}:end`);
      return label;
    };

    // Act
    const actual = await Promise.all([
      subject.run('/repo/.git', () => operation('first')),
      subject.run('/repo/.git', () => operation('second')),
    ]);

    // Assert
    should(actual).deepEqual(['first', 'second']);
    should(events).deepEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('should treat equivalent paths to one Git directory as the same queue', async () => {
    // Arrange
    const events: string[] = [];
    const subject = new WorktreeOperationQueue();
    const operation = async (label: string) => {
      events.push(`${label}:start`);
      await settle();
      events.push(`${label}:end`);
    };

    // Act
    await Promise.all([
      subject.run('/repo/.git', () => operation('first')),
      subject.run('/repo/nested/../.git', () => operation('second')),
    ]);

    // Assert
    should(events).deepEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('should let unrelated repositories proceed concurrently', async () => {
    // Arrange
    const events: string[] = [];
    const subject = new WorktreeOperationQueue();
    const operation = async (label: string) => {
      events.push(`${label}:start`);
      await settle();
      events.push(`${label}:end`);
    };

    // Act
    await Promise.all([
      subject.run('/one/.git', () => operation('one')),
      subject.run('/two/.git', () => operation('two')),
    ]);

    // Assert
    should(events.slice(0, 2).sort()).deepEqual(['one:start', 'two:start']);
  });

  it('should keep serving a repository after an operation throws', async () => {
    // Arrange
    const subject = new WorktreeOperationQueue();

    // Act
    const failure = await subject
      .run('/repo/.git', () => Promise.reject(new Error('git worktree add failed')))
      .then(() => undefined)
      .catch((error: unknown) => error);
    const recovered = await subject.run('/repo/.git', () => Promise.resolve('next'));

    // Assert
    should((failure as Error | undefined)?.message).equal('git worktree add failed');
    should(recovered).equal('next');
  });

  it('should not retain a queue entry once a repository falls idle', async () => {
    // Arrange — a permanently growing map would be a slow leak in a long-lived daemon.
    const subject = new WorktreeOperationQueue();

    // Act
    await subject.run('/repo/.git', () => Promise.resolve('done'));
    const reentered = await subject.run('/repo/.git', () => Promise.resolve('again'));

    // Assert
    should(reentered).equal('again');
    should(Object.keys(subject)).not.containEql('/repo/.git');
  });
});
