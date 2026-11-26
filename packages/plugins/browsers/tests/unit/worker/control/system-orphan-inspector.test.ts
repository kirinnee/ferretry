import { describe, it } from 'bun:test';
import should from 'should';
import {
  type ProcessTable,
  systemOrphanChromeInspector,
} from '../../../../daemon/worker/control/adapters/profile-store.ts';

const profile = '/state/browser/profile';

/** A `/proc/<pid>/stat` line: the state, then `ticks` as the start time (field 22). */
const stat = (state: string, ticks: string, name = 'chrome (x)'): string =>
  `7 (${name}) ${state} ${Array.from({ length: 18 }, () => '0').join(' ')} ${ticks} 0 0`;

interface FakeTable extends ProcessTable {
  readonly events: string[];
  files: Record<string, string | NodeJS.ErrnoException>;
  killError?: NodeJS.ErrnoException;
}

/** A synthetic `/proc` and `kill`: nothing real is read or signalled. */
function fakeTable(files: Record<string, string | NodeJS.ErrnoException>): FakeTable {
  const table: FakeTable = {
    events: [],
    files,
    readText: file => {
      table.events.push(`read ${file}`);
      const found = table.files[file];
      if (found === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      if (typeof found !== 'string') throw found;
      return found;
    },
    kill: (pid, signal) => {
      table.events.push(`kill ${String(pid)} ${signal}`);
      if (table.killError !== undefined) throw table.killError;
    },
  };
  return table;
}

const live = (ticks: string, ...args: string[]): Record<string, string> => ({
  '/proc/sys/kernel/random/boot_id': 'boot-a\n',
  '/proc/7/stat': stat('S', ticks),
  '/proc/7/cmdline': args.join('\0'),
});

const ours = (identity: { startedAt: string; args: readonly string[] }): boolean =>
  identity.startedAt === 'boot-a:100' && identity.args.includes(`--user-data-dir=${profile}`);

describe('systemOrphanChromeInspector', () => {
  it('should read the identity and send the signal in one synchronous step, the kill right after the last read', () => {
    // Arrange
    const table = fakeTable(live('100', 'chrome', `--user-data-dir=${profile}`));
    const subject = systemOrphanChromeInspector(table);

    // Act
    const outcome = subject.signalIf(7, 'SIGTERM', ours);

    // Assert: a plain value (never a promise), and the kill is the very next thing after the identity re-read.
    should(outcome).equal('delivered');
    should(table.events.at(-1)).equal('kill 7 SIGTERM');
    should(table.events.at(-2)).equal('read /proc/7/stat');
  });

  it('should NOT signal when the process under the pid is a replacement with another start time', () => {
    // Arrange: the lease recorded start 100; the pid now answers with start 555.
    const table = fakeTable(live('555', 'chrome', `--user-data-dir=${profile}`));
    const subject = systemOrphanChromeInspector(table);

    // Act
    const outcome = subject.signalIf(7, 'SIGKILL', ours);

    // Assert
    should(outcome).equal('rejected');
    should(table.events.some(event => event.startsWith('kill'))).be.false();
  });

  it('should NOT signal when the same process no longer names this profile', () => {
    // Arrange
    const table = fakeTable(live('100', 'chrome', '--user-data-dir=/elsewhere'));

    // Act + Assert
    should(systemOrphanChromeInspector(table).signalIf(7, 'SIGTERM', ours)).equal('rejected');
    should(table.events.some(event => event.startsWith('kill'))).be.false();
  });

  it('should refuse, and not signal, when /proc cannot be trusted', () => {
    // Arrange: no boot id; a permission error; a start time that moved between the two reads.
    const noBoot = fakeTable({ '/proc/7/stat': stat('S', '100'), '/proc/7/cmdline': 'chrome' });
    const denied = fakeTable({
      ...live('100', `--user-data-dir=${profile}`),
      '/proc/7/stat': Object.assign(new Error('denied'), { code: 'EACCES' }),
    });
    const reads = fakeTable(live('100', `--user-data-dir=${profile}`));
    let statReads = 0;
    const flipping: ProcessTable = {
      kill: reads.kill,
      readText: file => {
        if (file !== '/proc/7/stat') return reads.readText(file);
        statReads += 1;
        return stat('S', statReads === 1 ? '100' : '101');
      },
    };

    // Act + Assert
    should(systemOrphanChromeInspector(noBoot).signalIf(7, 'SIGTERM', () => true)).equal('unreadable');
    should(systemOrphanChromeInspector(denied).signalIf(7, 'SIGTERM', () => true)).equal('unreadable');
    should(systemOrphanChromeInspector(flipping).signalIf(7, 'SIGTERM', () => true)).equal('unreadable');
    should([...noBoot.events, ...denied.events, ...reads.events].some(event => event.startsWith('kill'))).be.false();
  });

  it('should call a missing process and a zombie gone, without signalling', () => {
    // Arrange
    const missing = fakeTable({ '/proc/sys/kernel/random/boot_id': 'boot-a' });
    const zombie = fakeTable({ ...live('100', 'chrome'), '/proc/7/stat': stat('Z', '100') });

    // Act + Assert
    should(systemOrphanChromeInspector(missing).signalIf(7, 'SIGTERM', () => true)).equal('gone');
    should(systemOrphanChromeInspector(zombie).signalIf(7, 'SIGTERM', () => true)).equal('gone');
    should([...missing.events, ...zombie.events].some(event => event.startsWith('kill'))).be.false();
  });

  it('should report a process that vanished at the kill as gone, and a refused kill as denied', () => {
    // Arrange
    const vanished = fakeTable(live('100', `--user-data-dir=${profile}`));
    vanished.killError = Object.assign(new Error('no such process'), { code: 'ESRCH' });
    const refused = fakeTable(live('100', `--user-data-dir=${profile}`));
    refused.killError = Object.assign(new Error('not permitted'), { code: 'EPERM' });

    // Act + Assert
    should(systemOrphanChromeInspector(vanished).signalIf(7, 'SIGTERM', ours)).equal('gone');
    should(systemOrphanChromeInspector(refused).signalIf(7, 'SIGTERM', ours)).equal('denied');
  });

  it('should identify a live process by boot id and start time, and not a zombie', () => {
    // Arrange
    const subject = systemOrphanChromeInspector(fakeTable(live('100', 'chrome', `--user-data-dir=${profile}`)));
    const zombie = systemOrphanChromeInspector(
      fakeTable({ ...live('100', 'chrome'), '/proc/7/stat': stat('Z', '100') }),
    );

    // Act + Assert
    should(subject.identify(7)).deepEqual({ startedAt: 'boot-a:100', args: ['chrome', `--user-data-dir=${profile}`] });
    should(zombie.identify(7)).be.undefined();
  });
});
