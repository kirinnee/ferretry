import { describe, it } from 'bun:test';
import type { SpawnPort, SpawnResult } from '@ferretry/kernel/contract';
import should from 'should';
import { KernelProcessProbe, type ProcessHostFacts } from '../../../../daemon/adapters/moves/process-inventory.ts';
import { parseProcessTable } from '../../../../daemon/lib/moves/process-table.ts';

/**
 * The host's own `ps`, read and PARSED. Linux (procps) and macOS (BSD) disagree on keywords —
 * `etimes` exists on only one — so this is the test that fails on the platform whose `ps` refuses the
 * arguments. It touches nothing but `ps` and runs unchanged in the macOS Containment job.
 *
 * The kernel's spawn port is stood in for by a real process spawn (tests drive real processes where the point is the
 * process); the probe is told there is no procfs so it asks `ps`, whatever the platform.
 */
const realPs: Pick<SpawnPort, 'run'> = {
  run: async (program, args): Promise<SpawnResult> => {
    const child = Bun.spawn([Bun.which(program) ?? program, ...args], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { exitCode, signal: null, stdout, stderr };
  },
};

describe('the host process table', () => {
  it('should list this very process, with a parent and an elapsed time, through the real ps', async () => {
    // Arrange
    const host = { platform: globalThis.process.platform } as ProcessHostFacts;
    const probe = new KernelProcessProbe(
      realPs,
      host,
      { nowMs: () => Date.now() },
      {
        procfs: false,
      },
    );

    // Act
    const read = await probe.processTable();

    // Assert
    if (read.kind !== 'read') throw new Error(`expected a read, got: ${read.reason}`);
    const own = parseProcessTable(read.stdout).find(row => row.pid === globalThis.process.pid);
    if (own === undefined) throw new Error('the reader must appear in the table it just read');
    should(own.ppid).equal(globalThis.process.ppid);
    should(own.startedSecondsAgo).be.a.Number();
    should(own.startedSecondsAgo).be.within(0, 86_400);
    should(own.argv).not.equal('');
  });
});
