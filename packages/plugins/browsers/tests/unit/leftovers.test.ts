import { describe, it } from 'bun:test';
import should from 'should';
import type { FerretId, SpawnPort, SpawnResult } from '@ferretry/kernel/contract';
import type { PaneBrowsers } from '@ferretry/plugin-terminals/contract';
import { fakeTerminals } from '@ferretry/plugin-terminals/contract/testing';
import { restrictSpawn } from '../../../../core/kernel/host/permissions.ts';
import { closeLeftoverBrowsers, spawnTerminate } from '../../daemon/leftovers.ts';
import manifest from '../../manifest.ts';

const FERRET = 'f1' as FerretId;

/**
 * A spawn port behind the manifest's real `permissions.spawn`, recording every program it runs; `gone` pids answer as
 * `kill` does for a process that already exited, `refused` pids as it does for one this user may not signal.
 */
function subject(read: PaneBrowsers | undefined, options: { gone?: number[]; refused?: number[] } = {}) {
  const ran: { readonly program: string; readonly args: readonly string[] }[] = [];
  const answer = (pid: number): SpawnResult => {
    if (options.gone?.includes(pid))
      return { exitCode: 1, signal: null, stdout: '', stderr: `kill: (${pid}) - No such process` };
    if (options.refused?.includes(pid))
      return { exitCode: 1, signal: null, stdout: '', stderr: `kill: (${pid}) - Operation not permitted` };
    return { exitCode: 0, signal: null, stdout: '', stderr: '' };
  };
  const base: SpawnPort = {
    run: async (program, args) => {
      ran.push({ program, args });
      return answer(Number(args.at(-1)));
    },
    runBytes: () => Promise.reject(new Error('no bytes are read')),
    start: () => {
      throw new Error('nothing is started');
    },
  };
  const spawn = restrictSpawn(manifest.id, manifest.permissions.spawn, base);
  const terminals = read === undefined ? undefined : fakeTerminals([], { browsers: { [FERRET]: read } });
  const close = async (): Promise<number> =>
    await closeLeftoverBrowsers(FERRET, { terminals: () => terminals, terminate: spawnTerminate(spawn) });
  return { ran, close };
}

const observed = (pids: readonly number[], toolCommandRunning = false): PaneBrowsers => ({
  kind: 'observed',
  toolCommandRunning,
  browsers: pids.map(pid => ({ pid })),
});

describe('closing the browsers left under a ferret’s pane (today’s closeLeftoverBrowsers)', () => {
  it('should SIGTERM each top-level browser Terminals found under the pane, through the declared kill', async () => {
    // Arrange
    const { ran, close } = subject(observed([701, 905]));

    // Act
    const closed = await close();

    // Assert
    should(closed).equal(2);
    should(ran).eql([
      { program: 'kill', args: ['-TERM', '701'] },
      { program: 'kill', args: ['-TERM', '905'] },
    ]);
  });

  it('should close nothing, and signal nothing, while a tool command runs under the pane (it may use that browser)', async () => {
    // Arrange
    const { ran, close } = subject(observed([701], true));

    // Act
    const closed = await close();

    // Assert
    should(closed).equal(0);
    should(ran).eql([]);
  });

  it('should signal only the pids of that pane’s browsers — never the ferret (no pane pid is ever listed) nor pid 1', async () => {
    // Arrange: a malformed read naming pid 1 and 0 is never passed to kill (those are "every process" to kill).
    const { ran, close } = subject(observed([1, 0, 701]));

    // Act
    const closed = await close();

    // Assert
    should(closed).equal(1);
    should(ran).eql([{ program: 'kill', args: ['-TERM', '701'] }]);
  });

  it('should not count a browser that exited between the look and the signal', async () => {
    // Arrange
    const { close } = subject(observed([701, 905]), { gone: [905] });

    // Act
    const closed = await close();

    // Assert
    should(closed).equal(1);
  });

  it('should throw when the pane cannot be read, signalling nothing', async () => {
    // Arrange
    const { ran, close } = subject({ kind: 'unobservable', reason: "This ferret's pane could not be read." });

    // Act
    const closing = close();

    // Assert
    await should(closing).be.rejectedWith("This ferret's pane could not be read.");
    should(ran).eql([]);
  });

  it('should throw when a signal is refused for any reason but "already gone"', async () => {
    // Arrange
    const { close } = subject(observed([701]), { refused: [701] });

    // Act
    const closing = close();

    // Assert
    await should(closing).be.rejectedWith(/could not be closed: kill: \(701\) - Operation not permitted/u);
  });

  it('should close nothing while Terminals is off: no pane can be read', async () => {
    // Arrange
    const { ran, close } = subject(undefined);

    // Act
    const closed = await close();

    // Assert
    should(closed).equal(0);
    should(ran).eql([]);
  });
});

describe('Browsers’ manifest for the leftover close', () => {
  it('should declare kill as a program it may run, and Terminals as an optional use (not a need)', () => {
    should(manifest.permissions.spawn).containEql('kill');
    should(Object.keys(manifest.uses)).containEql('terminals');
    should(Object.keys(manifest.needs)).not.containEql('terminals');
    // Acyclic: Browsers never reaches the Warden, which uses Browsers.
    should([...Object.keys(manifest.needs), ...Object.keys(manifest.uses)]).not.containEql('warden');
  });
});
