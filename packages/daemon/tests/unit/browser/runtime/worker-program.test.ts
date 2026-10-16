import { describe, it } from 'bun:test';
import should from 'should';
import {
  BROWSER_WORKER_NAME,
  browserWorkerCandidates,
  releaseTargetSuffix,
  selectBrowserWorker,
} from '../../../../src/lib/index.ts';

const search = (present: readonly string[], overrides: Partial<Parameters<typeof selectBrowserWorker>[0]> = {}) =>
  selectBrowserWorker({
    executableDirectories: ['/opt/homebrew/bin', '/opt/homebrew/Caskroom/ferretry/3.48.0'],
    platform: 'darwin',
    arch: 'arm64',
    exists: path => present.includes(path),
    ...overrides,
  });

describe('browser worker program', () => {
  it('should name the release target suffix compile.sh gives each shipped platform, and none other', () => {
    // Act + Assert
    should(releaseTargetSuffix('darwin', 'arm64')).equal('darwin-arm64');
    should(releaseTargetSuffix('linux', 'arm64')).equal('linux-arm64');
    should(releaseTargetSuffix('linux', 'x64')).equal('linux-x64-baseline');
    should(releaseTargetSuffix('darwin', 'x64')).be.undefined();
    should(releaseTargetSuffix('win32', 'x64')).be.undefined();
  });

  it('should look for the installed name before the compile-output name, once per directory', () => {
    // Act
    const shipped = browserWorkerCandidates(['/usr/bin/', '/usr/bin', ''], 'linux', 'x64');
    const unshipped = browserWorkerCandidates(['/opt/fy'], 'win32', 'x64');

    // Assert
    should(shipped).deepEqual([
      `/usr/bin/${BROWSER_WORKER_NAME}`,
      `/usr/bin/${BROWSER_WORKER_NAME}-linux-x64-baseline`,
    ]);
    should(unshipped).deepEqual([`/opt/fy/${BROWSER_WORKER_NAME}`]);
  });

  it('should find the worker beside the daemon as resolved, not only as invoked', () => {
    // Arrange — a Homebrew cask: the daemon is invoked through a symlink whose directory holds no worker.
    const worker = `/opt/homebrew/Caskroom/ferretry/3.48.0/${BROWSER_WORKER_NAME}`;

    // Act + Assert
    should(search([worker])).deepEqual({ kind: 'executable', path: worker });
    should(search([`/opt/homebrew/bin/${BROWSER_WORKER_NAME}-darwin-arm64`])).deepEqual({
      kind: 'executable',
      path: `/opt/homebrew/bin/${BROWSER_WORKER_NAME}-darwin-arm64`,
    });
  });

  it('should honour the explicit overrides first, the source worker last', () => {
    // Act + Assert
    should(search([], { sourceOverride: ' /src/worker.ts ', binaryOverride: '/bin/w' })).deepEqual({
      kind: 'source',
      entry: '/src/worker.ts',
    });
    should(search([], { sourceOverride: ' ', binaryOverride: ' /bin/w ' })).deepEqual({
      kind: 'executable',
      path: '/bin/w',
    });
    should(search(['/repo/bin/browser-worker.ts'], { sourceEntry: '/repo/bin/browser-worker.ts' })).deepEqual({
      kind: 'source',
      entry: '/repo/bin/browser-worker.ts',
    });
  });

  it('should report a compiled daemon with no worker as missing, naming the fix', () => {
    // Act — a compiled daemon's source path does not exist on disk.
    const actual = search([], { sourceEntry: '/$bunfs/root/browser-worker.ts' });

    // Assert
    should(actual.kind).equal('missing');
    should(actual).have.property(
      'message',
      `This machine's Ferretry install has no browser worker (${BROWSER_WORKER_NAME} is missing beside the daemon); reinstall or upgrade Ferretry to get it.`,
    );
    should(search([]).kind).equal('missing');
  });
});
