/**
 * Asserts a memory budget; the outcome depends on the machine's allocator and Bun build, not the code.
 *
 * Resident memory one BUNDLED session worker adds — what the compiled binary ships. Measured 7.4 MB a
 * thread on Linux (Bun 1.3.13); run from source a worker costs ~67 MB, which is why this measures the
 * bundle. The deterministic half of the diet (which modules the bundle carries, its byte size) is the
 * integration tier's: tests/integration/session/observer/worker-diet.test.ts.
 */
import { afterAll, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import should from 'should';

const ENTRY = join(import.meta.dir, '../../../../bin/session.worker.ts');
const RSS = join(import.meta.dir, '../../../integration/support/session-worker-rss.ts');
const WORKER_MEMORY_BUDGET_MB = 15;
const WORKERS = 5;
/** Every child is killed by then; a wedged measurement fails saying so instead of holding the runner. */
const CHILD_DEADLINE_MS = 30_000;

const scratch: string[] = [];
afterAll(async () => {
  for (const directory of scratch.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function run(argv: readonly string[], what: string): Promise<string> {
  const child = Bun.spawn([...argv], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: CHILD_DEADLINE_MS,
    killSignal: 'SIGKILL',
  });
  const [text, errors, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (child.signalCode === 'SIGKILL')
    throw new Error(`${what} was still running after ${String(CHILD_DEADLINE_MS)} ms: ${errors}`);
  if (code !== 0) throw new Error(`${what} failed (${String(code)}): ${errors}`);
  return text;
}

describe('the session worker bundle', () => {
  it(`should cost at most ${WORKER_MEMORY_BUDGET_MB} MB of resident memory a thread, bundled as it ships`, async () => {
    // Arrange — the bundle on disk, as the compiled binary embeds it.
    const directory = await mkdtemp(join(tmpdir(), 'fy-worker-diet-'));
    scratch.push(directory);
    const outfile = join(directory, 'session.worker.js');
    await run([process.execPath, 'build', ENTRY, '--target=bun', '--outfile', outfile], 'bun build');

    // Act — in a process of its own: this one never hosts the threads.
    const out = await run(
      [process.execPath, RSS, pathToFileURL(outfile).href, String(WORKERS)],
      'measuring the workers',
    );
    const { perWorkerMb } = JSON.parse(out) as { perWorkerMb: number };

    // Assert
    should(perWorkerMb).be.below(WORKER_MEMORY_BUDGET_MB);
  }, 60_000);
});
