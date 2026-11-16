/**
 * The watchdog thread is real in every case here. A process whose loop has STOPPED is ended in its own child
 * process; these also prove the half that runs on the loop, and that a loop which keeps beating is never ended.
 */
import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { workerLoopWatchdog } from '../../../host/adapters/loop-watchdog.ts';

describe('workerLoopWatchdog', () => {
  test('leaves a process whose loop keeps beating alone, and stops cleanly', async () => {
    // A limit a healthy loop never reaches, checked often.
    const watchdog = workerLoopWatchdog({ limitMs: 60_000, nowMs: () => Date.now(), checkMs: 10, prefix: 'fyd ' });
    // The same label twice, then a different one, then a label longer than the shared buffer.
    watchdog.beat(['analytics ingest']);
    watchdog.beat(['analytics ingest']);
    await Bun.sleep(50);
    watchdog.beat(['turn watcher', 'self-check']);
    watchdog.beat(['x'.repeat(5_000)]);
    await Bun.sleep(50);
    watchdog.stop();
    expect(process.pid).toBeGreaterThan(0);
  });

  test('ends a process whose loop stops beating, saying what was running first', async () => {
    // A tiny program: start the watchdog, beat once with a label, then block for a minute.
    const program = `
      import { workerLoopWatchdog } from ${JSON.stringify(resolve(import.meta.dir, '../../../host/adapters/loop-watchdog.ts'))};
      const watchdog = workerLoopWatchdog({ limitMs: 500, nowMs: () => Date.now(), checkMs: 50, prefix: 'fyd ' });
      watchdog.beat(['boot: state:board']);
      // The watchdog is a thread on the real clock with no seam: this pause lets it start before the block.
      await Bun.sleep(100);
      const until = Date.now() + 60_000;
      while (Date.now() < until) {}
    `;
    const child = Bun.spawn({ cmd: [process.execPath, '--eval', program], stderr: 'pipe', stdout: 'ignore' });
    const stderr = new Response(child.stderr).text();
    // The test's own timeout is the safety net; a watchdog that never fires leaves the child to be killed here.
    await child.exited.finally(() => child.kill());
    const said = await stderr;
    expect(child.signalCode).toBe('SIGKILL');
    expect(said).toMatch(/^fyd \S+ ! watchdog: the event loop has not run for \d+s \(during boot: state:board\)/mu);
  }, 30_000);
});
