/**
 * The SPEED half of `../../unit/parity/jobs.test.ts`: J-0172, a child still running at its deadline is killed at the
 * deadline, nowhere near the child's own thirty seconds. That it is killed with SIGKILL and the answer says so is unit's.
 */
import { expect, test } from 'bun:test';
import { milliseconds } from '@ferretry/std';
import { bunSpawn } from '../../../host/adapters/process.ts';

test('J-0172 a child still running at its deadline is gone within five seconds of starting', async () => {
  const spawn = bunSpawn({ PATH: process.env.PATH ?? '' });
  const started = Date.now();
  const answer = await spawn.runBytes(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); process.stdout.write(String(process.pid)); setInterval(() => {}, 1_000);"],
    // Long enough for a fresh `bun -e` to start and write its pid on a loaded runner; far inside the bound below.
    { timeout: milliseconds(2_000) },
  );
  const elapsed = Date.now() - started;
  const pid = Number(new TextDecoder().decode(answer.stdout));
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone, as it should be
    }
  }
  expect(answer.timedOut).toBe(true);
  expect(elapsed).toBeLessThan(5_000);
});
