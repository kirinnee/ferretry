import { describe, it } from 'bun:test';
import should from 'should';
import { BunProcessProbe } from '../../../src/adapters/migrate/bun-process-inventory.ts';
import { parseProcessTable } from '../../../src/lib/migrate/process-table.ts';

/**
 * The host's own `ps`, read and PARSED. Linux (procps) and macOS (BSD) disagree on keywords —
 * `etimes` exists on only one — so this is the test that fails on the platform whose `ps` refuses the
 * arguments. It touches nothing but `ps` and runs unchanged in the macOS Containment job.
 */
describe('the host process table', () => {
  it('should list this very process, with a parent and an elapsed time, through the real ps', async () => {
    // Arrange
    const executable = Bun.which('ps');
    if (!executable) throw new Error('ps executable is required for this isolated integration test');

    // Act
    const read = await new BunProcessProbe(executable).processTable();

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
