import { afterAll, describe, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import should from 'should';
import {
  INTERRUPTED_BOOT_EXIT_CODE,
  releaseAcquired,
  type SignalTarget,
  terminationGate,
} from '../../../src/adapters/runtime/termination-gate.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';
import { waitFor } from '../support/wait-for.ts';

const GATE = JSON.stringify(resolve(import.meta.dir, '../../../src/adapters/runtime/termination-gate.ts'));

/** A child that opens the gate, says it is ready for a signal, and either keeps "booting" or serves. */
const program = (marker: string, serve: boolean): string => `
  import { writeFile } from 'node:fs/promises';
  import { terminationGate } from ${GATE};
  const gate = terminationGate(
    async () => { await writeFile(${JSON.stringify(marker)}, 'released during boot'); },
    code => process.exit(code),
  );
  if (${String(serve)}) {
    const stopped = gate.untilShutdown();
    process.stdout.write('ready\\n');
    await stopped;
    await writeFile(${JSON.stringify(marker)}, 'stopped while serving');
    process.exit(0);
  }
  process.stdout.write('ready\\n');
  await new Promise(() => undefined);
`;

async function run(serve: boolean): Promise<{ code: number; marker: string }> {
  const marker = join(await tempDirectory('fyd-gate-'), 'marker');
  const child = Bun.spawn([process.execPath, '-e', program(marker, serve)], { stdout: 'pipe', stderr: 'ignore' });
  const reader = child.stdout.getReader();
  let seen = '';
  while (!seen.includes('ready')) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += new TextDecoder().decode(value);
  }
  child.kill('SIGTERM');
  const code = await child.exited;
  return { code, marker: await readFile(marker, 'utf8').catch(() => '') };
}

/** A signal target a test fires by hand. */
function scriptedTarget(): SignalTarget & { fire(signal: 'SIGINT' | 'SIGTERM'): void } {
  const listeners = new Map<string, () => void>();
  return {
    once: (signal, listener) => listeners.set(signal, listener),
    fire: signal => listeners.get(signal)?.(),
  };
}

afterAll(async () => {
  await cleanupTempDirectories();
});

describe('terminationGate with real signals', () => {
  it('should release what a boot acquired and exit 143 when signalled before it serves', async () => {
    // Act
    const actual = await run(false);

    // Assert
    should(actual).deepEqual({ code: INTERRUPTED_BOOT_EXIT_CODE, marker: 'released during boot' });
  }, 20_000);

  it('should end the wait of a serving daemon, which then stops in its own order', async () => {
    // Act
    const actual = await run(true);

    // Assert
    should(actual).deepEqual({ code: 0, marker: 'stopped while serving' });
  }, 20_000);
});

describe('terminationGate edges', () => {
  it('should run the early release once however many signals arrive, and exit even when it fails', async () => {
    // Arrange
    const target = scriptedTarget();
    const exits: number[] = [];
    let releases = 0;
    terminationGate(
      async () => {
        releases += 1;
        throw new Error('a cleanup failed');
      },
      code => exits.push(code),
      target,
    );

    // Act
    target.fire('SIGTERM');
    target.fire('SIGINT');
    await waitFor(() => exits.length > 0, 'the gate to exit');
    // Everything the gate does after an exit is a microtask already queued: one macrotask turn drains it,
    // so a second release or exit would be counted here.
    await new Promise<void>(resolve => setImmediate(resolve));

    // Assert
    should(releases).equal(1);
    should(exits).deepEqual([INTERRUPTED_BOOT_EXIT_CODE]);
  });

  it('should exit 143 once the early release has finished', async () => {
    // Arrange
    const target = scriptedTarget();
    const order: string[] = [];
    terminationGate(
      async () => {
        order.push('released');
      },
      code => order.push(`exit ${String(code)}`),
      target,
    );

    // Act
    target.fire('SIGTERM');
    await waitFor(() => order.length >= 2, 'the early release to finish and the gate to exit');

    // Assert
    should(order).deepEqual(['released', `exit ${String(INTERRUPTED_BOOT_EXIT_CODE)}`]);
  });

  it('should release what a boot still running registers during the early release, before it exits', async () => {
    // Arrange — the boot goes on after the signal and registers the session observer's release while
    // the first cleanup is still running, which is where a stop in the boot's `finishing` stretch lands.
    const target = scriptedTarget();
    const order: string[] = [];
    const cleanups: Array<() => void | Promise<void>> = [];
    cleanups.push(async () => {
      order.push('first');
      cleanups.push(() => {
        order.push('registered meanwhile');
      });
    });
    cleanups.push(() => {
      throw new Error('a cleanup failed');
    });
    terminationGate(
      async () => await releaseAcquired(cleanups),
      code => order.push(`exit ${String(code)}`),
      target,
    );

    // Act
    target.fire('SIGTERM');
    await waitFor(() => order.some(entry => entry.startsWith('exit')), 'the gate to exit');

    // Assert
    should(order).deepEqual(['first', 'registered meanwhile', `exit ${String(INTERRUPTED_BOOT_EXIT_CODE)}`]);
    should(cleanups).be.empty();
  });

  it('should release a cleanup the boot registers after the release emptied the list, before it exits', async () => {
    // Arrange — the release has looked for the last time and found nothing; a boot continuation queued
    // just behind that look (the observer armed after a later await) registers before the gate exits.
    const target = scriptedTarget();
    const order: string[] = [];
    const cleanups: Array<() => void | Promise<void>> = [];
    let registeredLate = false;
    terminationGate(
      async () => {
        await releaseAcquired(cleanups);
        if (registeredLate) return;
        registeredLate = true;
        queueMicrotask(() =>
          cleanups.push(() => {
            order.push('registered after the release');
          }),
        );
      },
      code => order.push(`exit ${String(code)}`),
      target,
      () => cleanups.length > 0,
    );

    // Act
    target.fire('SIGTERM');
    await waitFor(() => order.some(entry => entry.startsWith('exit')), 'the gate to exit');

    // Assert
    should(order).deepEqual(['registered after the release', `exit ${String(INTERRUPTED_BOOT_EXIT_CODE)}`]);
    should(cleanups).be.empty();
  });

  it('should hold released() until an early release has finished, and have it settled when none started', async () => {
    // Arrange
    const target = scriptedTarget();
    const order: string[] = [];
    const { promise: finish, resolve } = Promise.withResolvers<void>();
    const gate = terminationGate(
      async () => {
        await finish;
        order.push('released');
      },
      code => order.push(`exit ${String(code)}`),
      target,
    );
    await gate.released();
    order.push('unwound, nothing to wait for');

    // Act
    target.fire('SIGTERM');
    const unwound = gate.released().then(() => order.push('boot unwound'));
    await new Promise<void>(settle => setImmediate(settle));
    order.push('before the release finished');
    resolve();
    await unwound;

    // Assert
    should(order).deepEqual([
      'unwound, nothing to wait for',
      'before the release finished',
      'released',
      `exit ${String(INTERRUPTED_BOOT_EXIT_CODE)}`,
      'boot unwound',
    ]);
  });

  it('should resolve the wait on SIGINT too once serving, running no early release', async () => {
    // Arrange
    const target = scriptedTarget();
    let released = false;
    const gate = terminationGate(
      async () => {
        released = true;
      },
      () => undefined,
      target,
    );
    const stopped = gate.untilShutdown();

    // Act
    target.fire('SIGINT');
    await stopped;

    // Assert
    should(released).be.false();
  });
});
