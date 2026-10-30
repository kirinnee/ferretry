/**
 * Asserts a memory budget; the outcome depends on the machine's allocator and Bun build, not the code.
 *
 * The housekeeping worker is bundled exactly as the release compiles it, started, and the resident
 * memory it adds must stay inside its budget (docs/design/housekeeping-worker.md §4 PR 2). The module
 * diet that makes the budget reachable is the integration tier's, and deterministic.
 */
import { afterAll, beforeAll, describe, it } from 'bun:test';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import should from 'should';
import { cleanupTempDirectories, tempDirectory } from '../../integration/support/repository.ts';

const ENTRY = resolve(import.meta.dir, '../../../bin/housekeeping.worker.ts');
const RSS = resolve(import.meta.dir, '../../integration/support/worker-rss.ts');
/** The memory budget for the bundled worker (§4 PR 2). Measured 15–19 MB on Linux, Bun 1.3.13. */
const RSS_BUDGET_MB = 25;

let bundle: string;

beforeAll(async () => {
  const outdir = await tempDirectory('fyd-housekeeping-bundle-');
  const built = await Bun.build({ entrypoints: [ENTRY], target: 'bun', outdir });
  if (!built.success) throw new Error(built.logs.map(String).join('\n'));
  bundle = join(outdir, 'housekeeping.worker.js');
});

afterAll(async () => {
  await cleanupTempDirectories();
});

describe('the bundled housekeeping worker', () => {
  it(`should add no more than ${String(RSS_BUDGET_MB)} MB of resident memory once started`, async () => {
    // Act — three fresh processes, and the smallest reading: resident memory is noisy, never low.
    const readings: number[] = [];
    for (let run = 0; run < 3; run += 1) {
      const child = Bun.spawn([process.execPath, RSS, pathToFileURL(bundle).href], { stdout: 'pipe', stderr: 'pipe' });
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (code !== 0) throw new Error(`measuring the worker failed: ${err}`);
      readings.push((JSON.parse(out) as { addedMb: number }).addedMb);
    }

    // Assert
    should(Math.min(...readings)).be.belowOrEqual(RSS_BUDGET_MB);
  }, 60_000);
});
