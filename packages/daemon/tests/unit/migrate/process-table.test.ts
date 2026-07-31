import { describe, it } from 'bun:test';
import should from 'should';
import { descendantsOf, inventoryProcesses, parseProcessTable } from '../../../src/lib/migrate/process-table.ts';

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
      { pid: 200, argv: 'zsh', startedSecondsAgo: 420, cwd: undefined, verdict: 'safe_to_kill' },
      {
        pid: 300,
        argv: 'git commit -m work',
        startedSecondsAgo: 400,
        cwd: '/work/repository',
        verdict: 'destructive_to_interrupt',
      },
    ]);
  });
});
