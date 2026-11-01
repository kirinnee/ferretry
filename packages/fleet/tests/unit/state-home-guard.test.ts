import { describe, it } from 'bun:test';
import should from 'should';
import {
  type FileIdentity,
  openedFileProblem,
  resolveStateHomes,
  type StateHomeDisk,
  StateHomeUnresolvedError,
  stateHomeHolding,
} from '../../src/lib/state-home-guard.ts';

const file = (inode: bigint, links = 1): FileIdentity => ({ kind: 'file', device: 7n, inode, links, size: 3 });

/** A disk that answers from two maps: where each path really is, and what is there (never followed). */
const disk = (real: Record<string, string>, entries: Record<string, FileIdentity>): StateHomeDisk => ({
  realpath: async path => {
    const found = real[path];
    if (found === undefined) throw new Error(`ENOENT ${path}`);
    return found;
  },
  identity: async path => entries[path],
});

describe('resolveStateHomes', () => {
  it('should keep each home as configured and as its real path, once each', async () => {
    // Arrange
    const homes = disk({ '/home/me/.fy': '/data/fy', '/data/fy': '/data/fy' }, {});

    // Act
    const resolved = await resolveStateHomes(['/home/me/.fy/', '/data/fy'], homes);

    // Assert
    should(resolved).deepEqual(['/home/me/.fy', '/data/fy']);
  });

  it('should fail closed when a home cannot be resolved', async () => {
    const error = await resolveStateHomes(['/missing'], disk({}, {})).then(
      () => undefined,
      (failure: unknown) => failure,
    );

    should(error).be.instanceOf(StateHomeUnresolvedError);
    should((error as Error).message).equal('the daemon’s state home cannot be resolved');
  });
});

describe('stateHomeHolding', () => {
  const homes = ['/home/me/.fy', '/data/fy'];

  it('should name the home that holds a path, the home itself included', () => {
    should(stateHomeHolding(homes, '/home/me/.fy')).equal('/home/me/.fy');
    should(stateHomeHolding(homes, '/home/me/.fy/api-token')).equal('/home/me/.fy');
    should(stateHomeHolding(homes, '/data/fy/state/secrets.key')).equal('/data/fy');
  });

  it('should count a child whose name starts with ".." as inside, never as outside', () => {
    should(stateHomeHolding(homes, '/home/me/.fy/..cache/api-token')).equal('/home/me/.fy');
    should(stateHomeHolding(homes, '/home/me/.fy/..')).be.undefined();
  });

  it('should hold nothing beside, above or under a name that only starts like a home', () => {
    should(stateHomeHolding(homes, '/home/me')).be.undefined();
    should(stateHomeHolding(homes, '/home/me/.fy-other/api-token')).be.undefined();
    should(stateHomeHolding(homes, '/home/me/project/a.txt')).be.undefined();
  });
});

describe('openedFileProblem', () => {
  it('should pass a regular file with one name that is still at its checked place', async () => {
    const problem = await openedFileProblem(
      '/w/a.txt',
      file(1n),
      disk({ '/w/a.txt': '/w/a.txt' }, { '/w/a.txt': file(1n) }),
    );

    should(problem).be.undefined();
  });

  it('should refuse a folder, a pipe or a link as not a file', async () => {
    const none = disk({}, {});
    const kinds = await Promise.all(
      (['directory', 'other', 'link'] as const).map(
        async kind => await openedFileProblem('/w/x', { ...file(1n), kind }, none),
      ),
    );

    should(kinds).deepEqual(['not-a-file', 'not-a-file', 'not-a-file']);
  });

  it('should see a file swapped for another, for a link, or removed after the open', async () => {
    // Arrange
    const opened = file(1n);
    const swapped = disk({ '/w/a.txt': '/w/a.txt' }, { '/w/a.txt': file(2n) });
    const relinked = disk({ '/w/a.txt': '/fy/api-token' }, { '/w/a.txt': { ...file(1n), kind: 'link' } });
    const removed = disk({}, {});
    const otherDevice = disk({ '/w/a.txt': '/w/a.txt' }, { '/w/a.txt': { ...file(1n), device: 8n } });

    // Act
    const problems = await Promise.all(
      [swapped, relinked, removed, otherDevice].map(async view => await openedFileProblem('/w/a.txt', opened, view)),
    );

    // Assert
    should(problems).deepEqual(['changed', 'changed', 'changed', 'changed']);
  });

  it('should decide a swap before a hard link, so a caller that tolerates hard links still learns of it', async () => {
    const linked = file(1n, 2);

    const swapped = await openedFileProblem('/w/a.txt', linked, disk({}, {}));
    const unchanged = await openedFileProblem(
      '/w/a.txt',
      linked,
      disk({ '/w/a.txt': '/w/a.txt' }, { '/w/a.txt': linked }),
    );

    should(swapped).equal('changed');
    should(unchanged).equal('hard-link');
  });
});
