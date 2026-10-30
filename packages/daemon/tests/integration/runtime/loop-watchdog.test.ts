import { describe, it } from 'bun:test';
import { resolve } from 'node:path';
import should from 'should';
import { WorkerLoopWatchdog } from '../../../src/adapters/runtime/loop-watchdog.ts';

/**
 * The watchdog thread is real in every case here. A process whose loop has STOPPED is ended in its own
 * child process (see `staged-boot.test.ts`, where a whole daemon is the subject); these prove the half
 * that runs on the loop, and that a loop which keeps beating is never ended.
 */
describe('WorkerLoopWatchdog', () => {
  it('should leave a process whose loop keeps beating alone, and stop cleanly', async () => {
    // Arrange — a limit a healthy loop never reaches, checked often.
    const watchdog = new WorkerLoopWatchdog({ limitMs: 60_000, checkMs: 10, prefix: 'fyd ' });

    // Act — the same label twice, then a different one, then a label longer than the shared buffer.
    // The two pauses only let the watchdog thread look while the loop is healthy. They assert nothing about
    // time, so they cannot fail a correct build: a longer pause could only make the check stricter.
    watchdog.beat(['analytics ingest']);
    watchdog.beat(['analytics ingest']);
    await Bun.sleep(50);
    watchdog.beat(['turn watcher', 'self-check']);
    watchdog.beat(['x'.repeat(5_000)]);
    await Bun.sleep(50);
    watchdog.stop();

    // Assert — still here.
    should(process.pid).be.a.Number();
  });

  it('should end a process whose loop stops beating, saying what was running first', async () => {
    // Arrange — a tiny program: start the watchdog, beat once with a label, then block for a minute.
    const program = `
      import { WorkerLoopWatchdog } from ${JSON.stringify(resolve(import.meta.dir, '../../../src/adapters/runtime/loop-watchdog.ts'))};
      const watchdog = new WorkerLoopWatchdog({ limitMs: 500, checkMs: 50, prefix: 'fyd ' });
      watchdog.beat(['session listing']);
      // The watchdog is a thread on the real clock with no seam: this pause lets it start before the block.
      await Bun.sleep(100);
      const until = Date.now() + 60_000;
      while (Date.now() < until) {}
    `;
    const child = Bun.spawn({ cmd: [process.execPath, '--eval', program], stderr: 'pipe', stdout: 'ignore' });

    // Act
    // The test's own timeout is the safety net; a watchdog that never fires leaves the child to be killed here.
    const stderr = new Response(child.stderr).text();
    await child.exited.finally(() => child.kill());
    const said = await stderr;

    // Assert
    should(child.signalCode).equal('SIGKILL');
    should(said).match(/^fyd \S+ ! watchdog: the event loop has not run for \d+s \(during session listing\)/mu);
  }, 30_000);
});
