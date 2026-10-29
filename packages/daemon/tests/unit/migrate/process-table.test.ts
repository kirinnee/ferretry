import { describe, it } from 'bun:test';
import should from 'should';
import {
  descendantsOf,
  inventoryProcesses,
  parseElapsed,
  parseProcessTable,
} from '../../../src/lib/migrate/process-table.ts';

const table = [
  '  100     1   999 /bin/harness',
  '  200   100   420 zsh',
  '  300   200   400 git commit -m work',
  '  400     1    10 unrelated',
  'malformed',
].join('\n');

describe('migration process inventory decisions', () => {
  it('should parse only valid rows and preserve command metadata', () => {
    // Act
    const actual = parseProcessTable(table);

    // Assert
    should(actual).deepEqual([
      { pid: 100, ppid: 1, startedSecondsAgo: 999, argv: '/bin/harness' },
      { pid: 200, ppid: 100, startedSecondsAgo: 420, argv: 'zsh' },
      { pid: 300, ppid: 200, startedSecondsAgo: 400, argv: 'git commit -m work' },
      { pid: 400, ppid: 1, startedSecondsAgo: 10, argv: 'unrelated' },
    ]);
    should(parseProcessTable('  1 0 3 init\n  2 x 3 bad')).deepEqual([]);
  });

  it('should read every shape of the elapsed column both procps and BSD ps print', () => {
    // Act
    const actual = ['05', '01:02', '59:59', '00:00', '1:02:03', '01-00:00:00', '1-02:03:04', '100-23:59:59'].map(
      parseElapsed,
    );

    // Assert
    should(actual).deepEqual([5, 62, 3599, 0, 3723, 86_400, 93_784, 8_726_399]);
  });

  it('should refuse an elapsed column that is not a duration', () => {
    // Act
    const actual = ['', '-', '1-', '-5', '1:2:3:4', 'a:01', '1d', '1-2-3'].map(parseElapsed);

    // Assert
    should(actual).deepEqual(Array(8).fill(undefined));
  });

  it('should parse a BSD ps table whose columns are padded and whose etime is a clock', () => {
    // Arrange
    const bsd = [
      '  100     1    1-02:03:04 /bin/harness --flag',
      ' 4567   100       05:09   node  server.js  ',
      '12345  4567          07 sleep 1',
      '    5     1       01:02 launchd',
      '  300   100       x:y bad elapsed',
      '  400   100  05:09',
    ].join('\n');

    // Act
    const actual = parseProcessTable(bsd);

    // Assert
    should(actual).deepEqual([
      { pid: 100, ppid: 1, startedSecondsAgo: 93_784, argv: '/bin/harness --flag' },
      { pid: 4567, ppid: 100, startedSecondsAgo: 309, argv: 'node  server.js' },
      { pid: 12_345, ppid: 4567, startedSecondsAgo: 7, argv: 'sleep 1' },
      { pid: 5, ppid: 1, startedSecondsAgo: 62, argv: 'launchd' },
    ]);
  });

  it('should walk only the requested descendant tree and survive cycles', () => {
    // Arrange
    const rows = [...parseProcessTable(table), { pid: 100, ppid: 300, startedSecondsAgo: 1, argv: 'cycle' }];

    // Act
    const actual = descendantsOf(100, rows);

    // Assert
    should(actual.map(row => row.pid)).deepEqual([200, 300]);
  });

  it('should attach cwd and classify commands as process inventory', () => {
    // Act
    const actual = inventoryProcesses(parseProcessTable(table).slice(1, 3), new Map([[300, '/work/repository']]));

    // Assert
    should(actual).deepEqual([
      { pid: 200, ppid: 100, argv: 'zsh', startedSecondsAgo: 420, cwd: undefined, verdict: 'safe_to_kill' },
      {
        pid: 300,
        argv: 'git commit -m work',
        startedSecondsAgo: 400,
        cwd: '/work/repository',
        verdict: 'destructive_to_interrupt',
        ppid: 200,
      },
    ]);
  });
});
