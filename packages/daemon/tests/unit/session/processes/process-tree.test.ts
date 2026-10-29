import { describe, it } from 'bun:test';
import should from 'should';
import {
  classifyStreamLink,
  parseProcStat,
  parsePsDetailTable,
} from '../../../../src/adapters/session/processes/index.ts';

/**
 * THE PURE PARTS OF THE PROCESS-TREE ADAPTERS: reading `/proc/<pid>/stat`, naming what a descriptor's
 * link points at, and reading `ps` output in the `LC_ALL=C TZ=UTC0` format the macOS reader asks for.
 */

/** A `/proc/<pid>/stat` line: `pid (comm) state ppid …` with user and system ticks at their real places. */
function statLine(comm: string, state: string, ppid: number, utime: number, stime: number): string {
  const afterComm = [state, ppid, 100, 100, 0, -1, 4_194_304, 10, 0, 0, 0, utime, stime, 0, 0, 20, 0, 1, 0, 9_999];
  return `4242 (${comm}) ${afterComm.join(' ')} 123456 7890\n`;
}

describe('parseProcStat', () => {
  it('should read state, parent and the sum of user and system ticks', () => {
    // Act
    const parsed = parseProcStat(statLine('sleep', 'S', 77, 150, 25));

    // Assert
    should(parsed).deepEqual({ comm: 'sleep', state: 'S', ppid: 77, cpuTicks: 175 });
  });

  it('should find the end of a name that contains spaces and parentheses', () => {
    // Act
    const parsed = parseProcStat(statLine('Web Content (2) x', 'R', 5, 1, 2));

    // Assert
    should(parsed).deepEqual({ comm: 'Web Content (2) x', state: 'R', ppid: 5, cpuTicks: 3 });
  });

  it('should refuse a line with no parenthesised name or too few fields', () => {
    // Assert
    should(parseProcStat('')).be.undefined();
    should(parseProcStat('4242 sleep S 1')).be.undefined();
    should(parseProcStat('4242 (sleep) S 1 2')).be.undefined();
  });

  it('should refuse a non-numeric parent field', () => {
    // Assert
    should(parseProcStat(statLine('x', 'S', Number.NaN, 1, 1))).be.undefined();
  });
});

describe('classifyStreamLink', () => {
  const regular = async () => true;
  const notRegular = async () => false;

  it('should name the null device, pipes and sockets without touching the file system', async () => {
    // Arrange
    const forbidden = async (): Promise<boolean> => {
      throw new Error('the file system must not be consulted');
    };

    // Act
    const results = [
      await classifyStreamLink('/dev/null', forbidden),
      await classifyStreamLink('pipe:[123456]', forbidden),
      await classifyStreamLink('socket:[987]', forbidden),
    ];

    // Assert
    should(results).deepEqual([{ kind: 'null' }, { kind: 'pipe' }, { kind: 'socket' }]);
  });

  it('should recognise a pty, a tty and the console as the terminal', async () => {
    // Act
    const results = await Promise.all(
      ['/dev/pts/3', '/dev/tty', '/dev/ttyS0', '/dev/console'].map(link => classifyStreamLink(link, regular)),
    );

    // Assert
    should(results.map(result => result.kind)).deepEqual(['terminal', 'terminal', 'terminal', 'terminal']);
    should(results[0]).deepEqual({ kind: 'terminal', path: '/dev/pts/3' });
  });

  it('should treat a deleted file as unreadable, never as a file', async () => {
    // Act
    const result = await classifyStreamLink('/tmp/out.log (deleted)', regular);

    // Assert
    should(result).deepEqual({ kind: 'other', description: 'a deleted file' });
  });

  it('should return a file only when an absolute path is confirmed to be a regular file', async () => {
    // Act
    const file = await classifyStreamLink('/tmp/claude-1/tasks/abc.output', regular);
    const device = await classifyStreamLink('/dev/zero', notRegular);

    // Assert
    should(file).deepEqual({ kind: 'file', path: '/tmp/claude-1/tasks/abc.output' });
    should(device).deepEqual({ kind: 'other', description: 'not a regular file' });
  });

  it('should describe a non-path link as the kernel wrote it, and never confirm a relative path', async () => {
    // Act
    const anonymous = await classifyStreamLink('anon_inode:[eventpoll]', regular);
    const relative = await classifyStreamLink('relative/out.log', regular);

    // Assert
    should(anonymous).deepEqual({ kind: 'other', description: 'anon_inode:[eventpoll]' });
    should(relative).deepEqual({ kind: 'other', description: 'relative/out.log' });
  });
});

describe('parsePsDetailTable', () => {
  const epoch = (iso: string): number => Date.parse(iso) / 1000;

  it('should read pid, parent, start, state, CPU time, memory and the full argument list', () => {
    // Arrange — `ps -Ao pid=,ppid=,lstart=,state=,time=,rss=,args=` under LC_ALL=C TZ=UTC0
    const table = [
      '  412   300 Thu Oct 29 10:15:30 2026 S      0:01.50  20480 /bin/zsh -c eval \'echo "a  b"\' < /dev/null',
      ' 5001   412 Thu Oct  1 08:00:05 2026 R+  1:02:03.25 1048576 node server.js --port 3000',
      '',
    ].join('\n');

    // Act
    const rows = parsePsDetailTable(table);

    // Assert
    should(rows).deepEqual([
      {
        pid: 412,
        ppid: 300,
        start: epoch('2026-10-29T10:15:30Z'),
        startedAtMs: epoch('2026-10-29T10:15:30Z') * 1000,
        argv: '/bin/zsh -c eval \'echo "a  b"\' < /dev/null',
        state: 'S',
        cpuSeconds: 1.5,
        rssBytes: 20_480 * 1024,
      },
      {
        pid: 5001,
        ppid: 412,
        start: epoch('2026-10-01T08:00:05Z'),
        startedAtMs: epoch('2026-10-01T08:00:05Z') * 1000,
        argv: 'node server.js --port 3000',
        state: 'R+',
        cpuSeconds: 3_723.25,
        rssBytes: 1_048_576 * 1024,
      },
    ]);
  });

  it('should read a day count in the CPU time', () => {
    // Arrange
    const table = ' 900 1000 Mon Oct 12 00:00:00 2026 S 2-03:04:05.00 1 daemon';

    // Act
    const [row] = parsePsDetailTable(table);

    // Assert
    should(row?.cpuSeconds).equal(2 * 86_400 + 3 * 3_600 + 4 * 60 + 5);
  });

  it('should leave init and pid 1 out, and skip the header, blank and malformed lines', () => {
    // Arrange
    const table = [
      'PID PPID STARTED S TIME RSS ARGS',
      '    1     0 Thu Oct 29 09:00:00 2026 Ss 0:03.00 4096 /sbin/launchd',
      ' 77 1 not a date S 0:00.00 1 broken',
      ' 88 1 Thu Oct 29 09:00:01 2026 S 0:00.00 notanumber broken',
      'garbage',
      ' 99 1 Thu Oct 29 09:00:02 2026 S 0:00.10 8 good',
    ].join('\n');

    // Act
    const rows = parsePsDetailTable(table);

    // Assert
    should(rows.map(row => [row.pid, row.argv])).deepEqual([[99, 'good']]);
  });

  it('should return no CPU figure when the time column cannot be read', () => {
    // Arrange
    const table = ' 55 1 Thu Oct 29 09:00:02 2026 S ??:?? 8 odd';

    // Act
    const [row] = parsePsDetailTable(table);

    // Assert
    should(row?.pid).equal(55);
    should(row?.cpuSeconds).be.undefined();
  });
});
