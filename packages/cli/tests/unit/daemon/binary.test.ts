import { describe, it } from 'bun:test';
import should from 'should';
import { DaemonBinaryUnavailableError, resolveDaemonBinaryPath } from '../../../src/lib/daemon/binary';

function resolve(
  pinned: string | undefined,
  found: string | undefined,
  executable: (path: string) => boolean = () => true,
): ReturnType<typeof resolveDaemonBinaryPath> {
  return resolveDaemonBinaryPath({ daemonName: 'fyd', pinned, found, executable });
}

describe('daemon binary resolution', () => {
  it('should prefer a pinned executable over anything on PATH', () => {
    // Act
    const actual = resolve('/opt/fyd-0.175.3', '/usr/local/bin/fyd');

    // Assert — the pin is how an operator runs a build that is not the installed one, so it wins.
    should(actual).deepEqual({ path: '/opt/fyd-0.175.3', source: 'FY_DAEMON_BIN' });
  });

  it.each([
    { name: 'unset', pinned: undefined },
    { name: 'empty', pinned: '' },
    { name: 'whitespace', pinned: '   ' },
  ])('should fall back to PATH when the pin is $name', ({ pinned }) => {
    // Act
    const actual = resolve(pinned, '/usr/local/bin/fyd');

    // Assert
    should(actual).deepEqual({ path: '/usr/local/bin/fyd', source: 'PATH' });
  });

  it('should trim a pinned path so a trailing newline is not part of the executable', () => {
    // Act — `FY_DAEMON_BIN="$(which fyd)"` in a script is exactly how this arrives.
    const actual = resolve('  /opt/fyd  ', undefined);

    // Assert
    should(actual.path).equal('/opt/fyd');
  });

  it('should name the remedy when this host has no daemon at all', () => {
    // Act + Assert
    should(() => resolve(undefined, undefined))
      .throw(DaemonBinaryUnavailableError)
      .and.throw(/cannot find fyd on PATH — install it or point FY_DAEMON_BIN at the executable/u);
  });

  it.each([
    { name: 'a bare name', pinned: 'fyd' },
    { name: 'a path relative to the cwd', pinned: './build/fyd' },
    { name: 'a parent-relative path', pinned: '../fyd' },
  ])('should refuse $name, which a user service could never launch', ({ pinned }) => {
    // Act + Assert — `systemd` fails a unit whose `ExecStart` is not absolute with 203/EXEC, and
    // `launchd` behaves the same way. Discovering that at the next boot, with nobody watching, is
    // the failure this refusal exists to move forward to the moment somebody typed the command.
    should(() => resolve(pinned, '/usr/local/bin/fyd'))
      .throw(DaemonBinaryUnavailableError)
      .and.throw(/must be an absolute path for a user service to launch it/u);
  });

  it('should refuse a pin that no longer names an executable file', () => {
    // Act + Assert — a `FY_DAEMON_BIN` left over from a build directory that has since been deleted
    // otherwise surfaces as "the daemon did not become ready", a minute later, blaming the daemon.
    should(() => resolve('/tmp/deleted-build/fyd', undefined, () => false))
      .throw(DaemonBinaryUnavailableError)
      .and.throw(/FY_DAEMON_BIN names \/tmp\/deleted-build\/fyd, which is not an executable file/u);
  });

  it('should ask about the path it actually chose, not the one it passed over', () => {
    // Arrange
    const asked: string[] = [];

    // Act
    resolve('/opt/fyd', '/usr/local/bin/fyd', path => {
      asked.push(path);
      return true;
    });

    // Assert
    should(asked).deepEqual(['/opt/fyd']);
  });

  it('should name which input was relative, because only one of them can be fixed', () => {
    // Act
    let caught: unknown;
    try {
      resolve('build/fyd', undefined);
    } catch (error) {
      caught = error;
    }

    // Assert
    should((caught as Error).message).containEql('FY_DAEMON_BIN is build/fyd');
  });
});
