import { describe, it } from 'bun:test';
import should from 'should';
import { deliverStopSignal } from '../../../src/adapters/migrate/process-signals.ts';

/**
 * The one OS edge the Warden's job stopper signals through, against a real child it started itself — never
 * any other process.
 */
describe('deliverStopSignal', () => {
  it('should stop a running child, and answer not delivered for a pid that is no process', async () => {
    // Arrange
    const child = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' });

    // Act
    const delivered = deliverStopSignal(child.pid, 'SIGTERM');
    const code = await child.exited;
    // A pid above every platform's ceiling (Linux 4194304, macOS 99999): never a live process, so never a reused one.
    const gone = deliverStopSignal(4_194_305, 'SIGTERM');

    // Assert
    should(delivered).be.true();
    should(child.signalCode).equal('SIGTERM');
    should(code).not.equal(0);
    should(gone).be.false();
  });
});
