import { describe, it } from 'bun:test';
import should from 'should';
import type { FerretId, SpawnPort, SpawnResult } from '@ferretry/kernel/contract';
import type { PaneBrowser, PaneBrowsers, PaneBrowserStill } from '@ferretry/plugin-terminals/contract';
import { fakeTerminals } from '@ferretry/plugin-terminals/contract/testing';
import { restrictSpawn } from '../../../../core/kernel/host/permissions.ts';
import type { LeftoverBrowsersClosed } from '../../contract/index.ts';
import { closeLeftoverBrowsers, spawnTerminate } from '../../daemon/leftovers.ts';
import manifest from '../../manifest.ts';

const FERRET = 'f1' as FerretId;

/**
 * A spawn port behind the manifest's real `permissions.spawn`, recording every program it runs (with its environment);
 * `gone` pids answer as `kill` does for a process that already exited, `refused` pids as it does for one this user
 * may not signal — each in a locale that is NOT English, so nothing but the exit code can be read.
 */
function subject(
  read: PaneBrowsers | undefined,
  options: {
    gone?: number[];
    refused?: number[];
    /** How Terminals re-proves each browser; absent: the fake's (still when listed with the same start). */
    still?: (browser: PaneBrowser, asked: number) => PaneBrowserStill | Promise<PaneBrowserStill>;
    /** Terminals goes off after this many re-proofs. */
    offAfter?: number;
  } = {},
) {
  const ran: { readonly program: string; readonly args: readonly string[]; readonly env?: unknown }[] = [];
  const reproved: PaneBrowser[] = [];
  /** Every re-proof and kill, in the order they happened. */
  const order: string[] = [];
  const answer = (pid: number): SpawnResult => {
    if (options.gone?.includes(pid))
      return { exitCode: 1, signal: null, stdout: '', stderr: `kill: (${pid}) - Aucun processus de ce type` };
    if (options.refused?.includes(pid))
      return { exitCode: 1, signal: null, stdout: '', stderr: `kill: (${pid}) - Opération non permise` };
    return { exitCode: 0, signal: null, stdout: '', stderr: '' };
  };
  const base: SpawnPort = {
    run: async (program, args, spawnOptions) => {
      ran.push({ program, args, ...(spawnOptions?.env === undefined ? {} : { env: spawnOptions.env }) });
      order.push(`${program} ${args.at(-1)}`);
      return answer(Number(args.at(-1)));
    },
    runBytes: () => Promise.reject(new Error('no bytes are read')),
    start: () => {
      throw new Error('nothing is started');
    },
  };
  const spawn = restrictSpawn(manifest.id, manifest.permissions.spawn, base);
  const terminals =
    read === undefined
      ? undefined
      : fakeTerminals([], {
          browsers: { [FERRET]: read },
          ...(options.still === undefined
            ? {}
            : {
                still: async (_ferret: FerretId, browser: PaneBrowser) => {
                  reproved.push(browser);
                  order.push(`prove ${browser.pid}:${browser.start}`);
                  return await options.still!(browser, reproved.length);
                },
              }),
        });
  const current = () => (options.offAfter !== undefined && reproved.length >= options.offAfter ? undefined : terminals);
  const close = async (): Promise<LeftoverBrowsersClosed> =>
    await closeLeftoverBrowsers(FERRET, { terminals: current, terminate: spawnTerminate(spawn) });
  return { ran, reproved, order, close };
}

const startOf = (pid: number): number => pid * 1_000;
const observed = (pids: readonly number[], toolCommandRunning = false): PaneBrowsers => ({
  kind: 'observed',
  toolCommandRunning,
  browsers: pids.map(pid => ({ pid, start: startOf(pid) })),
});
const kill = (pid: number) => ({ program: 'kill', args: ['-TERM', String(pid)], env: { LC_ALL: 'C' } });

describe('closing the browsers left under a ferret’s pane (today’s closeLeftoverBrowsers)', () => {
  it('should SIGTERM each top-level browser Terminals found and re-proved under the pane, through the declared kill', async () => {
    // Arrange
    const { ran, close } = subject(observed([701, 905]));

    // Act
    const closed = await close();

    // Assert
    should(closed).eql({ closed: 2, leftAlone: [] });
    should(ran).eql([kill(701), kill(905)]);
  });

  it('should re-prove each pid immediately before its kill, by its pid AND start', async () => {
    // Arrange
    const { order, close } = subject(observed([701, 905]), { still: () => ({ still: true }) });

    // Act
    await close();

    // Assert
    should(order).eql(['prove 701:701000', 'kill 701', 'prove 905:905000', 'kill 905']);
  });

  it('should leave alone, and report not-proved, a pid whose start changed between the look and the kill', async () => {
    // Arrange: the fake re-proves only the pid with the start Terminals listed; 905 is now another process.
    const { ran, close } = subject(observed([701, 905]), {
      still: browser => (browser.pid === 905 ? { still: false, why: 'not-proved' } : { still: true }),
    });

    // Act
    const closed = await close();

    // Assert
    should(closed).eql({ closed: 1, leftAlone: [{ pid: 905, why: 'not-proved' }] });
    should(ran).eql([kill(701)]);
  });

  it('should never signal a pid the fake Terminals listed with another start (the default re-proof)', async () => {
    // Arrange: a reader asking about pid 701 with a start Terminals never listed.
    const terminals = fakeTerminals([], { browsers: { [FERRET]: observed([701]) } });
    const lied: PaneBrowsers = { kind: 'observed', toolCommandRunning: false, browsers: [{ pid: 701, start: 1 }] };
    const ran: string[] = [];

    // Act
    const closed = await closeLeftoverBrowsers(FERRET, {
      terminals: () => ({ ...terminals, paneBrowsers: async () => lied }),
      terminate: async pid => {
        ran.push(String(pid));
        return 'sent';
      },
    });

    // Assert
    should(closed).eql({ closed: 0, leftAlone: [{ pid: 701, why: 'not-proved' }] });
    should(ran).eql([]);
  });

  it('should leave alone, and report, a pid the re-proof says is gone', async () => {
    // Arrange
    const { ran, close } = subject(observed([701, 905]), {
      still: browser => (browser.pid === 701 ? { still: false, why: 'gone' } : { still: true }),
    });

    // Act
    const closed = await close();

    // Assert
    should(closed).eql({ closed: 1, leftAlone: [{ pid: 701, why: 'gone' }] });
    should(ran).eql([kill(905)]);
  });

  it('should leave alone, as not-proved, a pid whose re-proof throws, and still try the rest', async () => {
    // Arrange
    const { ran, close } = subject(observed([701, 905]), {
      still: browser => {
        if (browser.pid === 701) throw new Error('the pane could not be walked');
        return { still: true };
      },
    });

    // Act
    const closed = await close();

    // Assert
    should(closed).eql({ closed: 1, leftAlone: [{ pid: 701, why: 'not-proved' }] });
    should(ran).eql([kill(905)]);
  });

  it('should leave alone, as not-proved, every pid once Terminals goes off before its re-proof', async () => {
    // Arrange: Terminals answers the look and one re-proof, then is off.
    const { ran, close } = subject(observed([701, 905]), { still: () => ({ still: true }), offAfter: 1 });

    // Act
    const closed = await close();

    // Assert
    should(closed).eql({ closed: 1, leftAlone: [{ pid: 905, why: 'not-proved' }] });
    should(ran).eql([kill(701)]);
  });

  it('should close nothing, and report each browser tool-running, while a tool command runs under the pane', async () => {
    // Arrange
    const { ran, reproved, close } = subject(observed([701], true), { still: () => ({ still: true }) });

    // Act
    const closed = await close();

    // Assert
    should(closed).eql({ closed: 0, leftAlone: [{ pid: 701, why: 'tool-running' }] });
    should(ran).eql([]);
    should(reproved).eql([]);
  });

  it('should never signal pid 1 or below, or what is not a pid, and report each as invalid-pid', async () => {
    // Arrange: a malformed read naming pid 1, 0 and NaN is never passed to kill (those are "every process" to kill).
    const read: PaneBrowsers = {
      kind: 'observed',
      toolCommandRunning: false,
      browsers: [
        { pid: 1, start: 1 },
        { pid: 0, start: 1 },
        { pid: Number.NaN, start: 1 },
        { pid: 701, start: startOf(701) },
      ],
    };
    const { ran, close } = subject(read);

    // Act
    const closed = await close();

    // Assert
    should(closed).eql({
      closed: 1,
      leftAlone: [
        { pid: 1, why: 'invalid-pid' },
        { pid: 0, why: 'invalid-pid' },
        { pid: -1, why: 'invalid-pid' },
      ],
    });
    should(ran).eql([kill(701)]);
  });

  it('should report a proved pid whose signal does not land as signal-refused, by exit code alone, and try the rest', async () => {
    // Arrange: `kill` fails in a French locale for 701; nothing but its exit code is read.
    const { ran, close } = subject(observed([701, 905]), { refused: [701] });

    // Act
    const closed = await close();

    // Assert
    should(closed).eql({ closed: 1, leftAlone: [{ pid: 701, why: 'signal-refused' }] });
    should(ran).eql([kill(701), kill(905)]);
  });

  it('should run kill in the C locale and judge it by exit code, never by its message', async () => {
    // Arrange
    const { ran, close } = subject(observed([701, 905]), { gone: [701], refused: [905] });

    // Act
    const closed = await close();

    // Assert: a kill that failed after a TRUE re-proof is refused, whatever its words said.
    should(closed).eql({
      closed: 0,
      leftAlone: [
        { pid: 701, why: 'signal-refused' },
        { pid: 905, why: 'signal-refused' },
      ],
    });
    should(ran.every(run => JSON.stringify(run.env) === JSON.stringify({ LC_ALL: 'C' }))).be.true();
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

  it('should close nothing while Terminals is off: no pane can be read', async () => {
    // Arrange
    const { ran, close } = subject(undefined);

    // Act
    const closed = await close();

    // Assert
    should(closed).eql({ closed: 0, leftAlone: [] });
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
