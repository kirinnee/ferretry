import { describe, it } from 'bun:test';
import type { PathRoots } from '@ferretry/protocol';
import should from 'should';
import { parseFsUsageTrace, parseStraceTrace } from '../../../../src/lib/daemon/profile/syscall-trace.ts';

const roots: PathRoots = { home: '/home/kirin' };

describe('parseStraceTrace', () => {
  it('should count calls by name and path shape, busiest first', () => {
    // Arrange
    const input = [
      '1234 openat(AT_FDCWD, "/home/kirin/.ferretry/state/sessions/mvir1r5g-90731a4e/state.json", O_RDONLY) = 5',
      '1234 openat(AT_FDCWD, "/home/kirin/.ferretry/state/sessions/abcdef12-0a1b2c3d/state.json", O_RDONLY) = 5',
      '1234 stat("/proc/4242/stat", {st_mode=S_IFREG}) = 0',
    ].join('\n');

    // Act
    const actual = parseStraceTrace(input, 2, roots);

    // Assert
    should(actual.tool).equal('strace');
    should(actual.seconds).equal(2);
    should(actual.total).equal(3);
    should(actual.perSecond).equal(1.5);
    should(actual.top).deepEqual([
      { call: 'openat', path: '~/.ferretry/state/sessions/<session>/state.json', count: 2, perSecond: 1 },
      { call: 'stat', path: '/proc/<n>/stat', count: 1, perSecond: 0.5 },
    ]);
    should(actual.executions).deepEqual([]);
  });

  it('should strip [pid N] prefixes, bare pids and timestamps', () => {
    // Arrange
    const input = [
      '[pid  77] openat(AT_FDCWD, "/etc/hosts", O_RDONLY) = 3',
      '88 openat(AT_FDCWD, "/etc/hosts", O_RDONLY) = 3',
      '12:30:45 openat(AT_FDCWD, "/etc/hosts", O_RDONLY) = 3',
      '12:30:45.123456 openat(AT_FDCWD, "/etc/hosts", O_RDONLY) = 3',
    ].join('\n');

    // Act
    const actual = parseStraceTrace(input, 1, roots);

    // Assert
    should(actual.total).equal(4);
    should(actual.top).deepEqual([{ call: 'openat', path: '/etc/hosts', count: 4, perSecond: 4 }]);
  });

  it('should count an unfinished call but skip its resumption, signals, exits and blank lines', () => {
    // Arrange
    const input = [
      '1 read(3,  <unfinished ...>',
      '1 <... read resumed>"x", 1) = 1',
      '1 --- SIGCHLD {si_signo=SIGCHLD} ---',
      '1 +++ exited with 0 +++',
      '',
    ].join('\n');

    // Act
    const actual = parseStraceTrace(input, 1, roots);

    // Assert
    should(actual.total).equal(1);
    should(actual.top).deepEqual([{ call: 'read', path: '<fd>', count: 1, perSecond: 1 }]);
  });

  it('should count a call that names no path on its descriptor', () => {
    // Arrange
    const input = 'fstat(3, {st_mode=S_IFREG}) = 0';

    // Act
    const actual = parseStraceTrace(input, 4, roots);

    // Assert
    should(actual.top).deepEqual([{ call: 'fstat', path: '<fd>', count: 1, perSecond: 0.25 }]);
  });

  it.each([
    [
      'tmux with options',
      'execve("/usr/bin/tmux", ["tmux", "-u", "-S", "/tmp/sock", "capture-pane", "-p"], 0x7ffd /* 30 vars */) = 0',
      'tmux capture-pane',
    ],
    ['git -C', 'execve("/usr/bin/git", ["git", "-C", "/x", "status"], 0x1) = 0', 'git status'],
    ['no subcommand', 'execve("/bin/ps", ["ps", "-Ao", "pid=,comm="], 0x1) = 0', 'ps'],
    ['no argv list', 'execve("/usr/bin/true", 0x1) = 0', 'true'],
    ['no quoted program', 'execve(0x1) = -1', '<unknown>'],
    ['empty argv', 'execve("/usr/bin/env", [], 0x1) = 0', 'env'],
  ])('should label a started program by program and subcommand (%s)', (_name, line, expected) => {
    // Arrange
    const input = line;

    // Act
    const actual = parseStraceTrace(input, 1, roots);

    // Assert
    should(actual.executions).deepEqual([{ command: expected, count: 1 }]);
    should(actual.total).equal(1);
    should(actual.top).deepEqual([]);
  });

  it('should sort executions by count then name', () => {
    // Arrange
    const input = [
      'execve("/usr/bin/git", ["git", "status"], 0x1) = 0',
      'execve("/usr/bin/git", ["git", "status"], 0x1) = 0',
      'execve("/usr/bin/tmux", ["tmux", "kill-server"], 0x1) = 0',
      'execve("/usr/bin/ps", ["ps"], 0x1) = 0',
    ].join('\n');

    // Act
    const actual = parseStraceTrace(input, 1, roots);

    // Assert
    should(actual.executions).deepEqual([
      { command: 'git status', count: 2 },
      { command: 'ps', count: 1 },
      { command: 'tmux kill-server', count: 1 },
    ]);
  });

  it('should unescape quoted arguments and keep the top at 40 shapes', () => {
    // Arrange
    const lines = Array.from({ length: 45 }, (_, index) => `1 call${String(index).padStart(2, '0')}("/etc/a\\"b") = 0`);

    // Act
    const actual = parseStraceTrace(lines.join('\n'), 1, roots);

    // Assert
    should(actual.total).equal(45);
    should(actual.top).have.length(40);
    should(actual.top[0]?.call).equal('call00');
    should(actual.top[0]?.path).equal('/etc/a"b');
  });
});

describe('parseFsUsageTrace', () => {
  it('should count calls by name and path shape, busiest first', () => {
    // Arrange
    const input = [
      '12:00:00.100  open  F=5  (R___)  /Users/kirin/.ferretry/state/sessions/mvir1r5g-90731a4e/state.json  0.000012  fyd.123',
      '12:00:00.200  open  F=5  (R___)  /Users/kirin/.ferretry/state/sessions/abcdef12-0a1b2c3d/state.json  0.000012  fyd.123',
      '12:00:00.300  stat64  /etc/hosts  0.000003  fyd.123',
    ].join('\n');

    // Act
    const actual = parseFsUsageTrace(input, 2, { home: '/Users/kirin' });

    // Assert
    should(actual.tool).equal('fs_usage');
    should(actual.total).equal(3);
    should(actual.perSecond).equal(1.5);
    should(actual.top).deepEqual([
      { call: 'open', path: '~/.ferretry/state/sessions/<session>/state.json', count: 2, perSecond: 1 },
      { call: 'stat64', path: '/etc/hosts', count: 1, perSecond: 0.5 },
    ]);
  });

  it('should count a call with no path on its descriptor', () => {
    // Arrange
    const input = '12:00:00.100  fstat64  F=4  0.000001  fyd.123';

    // Act
    const actual = parseFsUsageTrace(input, 1, roots);

    // Assert
    should(actual.top).deepEqual([{ call: 'fstat64', path: '<fd>', count: 1, perSecond: 1 }]);
  });

  it.each([
    ['execve', '12:00:00.100  execve  /usr/bin/git  0.001  fyd.1', 'git'],
    ['posix_spawn', '12:00:00.100  posix_spawn  /usr/bin/tmux  0.001  fyd.1', 'tmux'],
    ['exec', '12:00:00.100  exec  /bin/ps  0.001  fyd.1', 'ps'],
    ['no path', '12:00:00.100  execve  F=4  0.001  fyd.1', '<unknown>'],
  ])('should label a started program by its name only (%s)', (_name, line, expected) => {
    // Arrange
    const input = line;

    // Act
    const actual = parseFsUsageTrace(input, 1, roots);

    // Assert
    should(actual.executions).deepEqual([{ command: expected, count: 1 }]);
    should(actual.top).deepEqual([]);
    should(actual.total).equal(1);
  });

  it('should skip lines that are not trace records', () => {
    // Arrange
    const input = [
      '',
      'short line',
      'not-a-time  open  /etc/hosts',
      '12:00:00.100  9bad  /etc/hosts',
      '12:00:00.100 =  /etc/hosts',
    ].join('\n');

    // Act
    const actual = parseFsUsageTrace(input, 1, roots);

    // Assert
    should(actual.total).equal(0);
    should(actual.top).deepEqual([]);
    should(actual.executions).deepEqual([]);
  });

  it('should keep the top at 40 shapes and order ties by name', () => {
    // Arrange
    const lines = Array.from(
      { length: 45 },
      (_, index) => `12:00:00.100  call${String(index).padStart(2, '0')}  /etc/hosts`,
    );

    // Act
    const actual = parseFsUsageTrace(lines.join('\n'), 1, roots);

    // Assert
    should(actual.top).have.length(40);
    should(actual.top[0]?.call).equal('call00');
  });

  it('should sort executions by count then name', () => {
    // Arrange
    const input = [
      '12:00:00.100  execve  /usr/bin/tmux',
      '12:00:00.100  execve  /usr/bin/git',
      '12:00:00.100  execve  /usr/bin/git',
    ].join('\n');

    // Act
    const actual = parseFsUsageTrace(input, 1, roots);

    // Assert
    should(actual.executions).deepEqual([
      { command: 'git', count: 2 },
      { command: 'tmux', count: 1 },
    ]);
  });
});
