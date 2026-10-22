/**
 * WHAT THE HOUSEKEEPING WORKER SHIPS, AND WHAT IT COSTS (docs/design/housekeeping-worker.md §2.4 rule 6,
 * §4 PR 2).
 *
 * The worker program is bundled exactly as the release compiles it — every `bin/*.worker.ts` is an entry
 * of its own — and the bundle's module list is held to a diet: it reads credential stores and makes the
 * free usage reads, so it must carry no SQLite, no session storage, no secret vault or redactor (a thread
 * that never holds the vault can never become a seventh holder of it, docs/secrets.md), and none of the
 * protocol's or the account model's schemas, which would cost every daemon their memory for nothing.
 * zod is allowed: the passive usage file is parsed with it.
 *
 * Then the bundle is started, and the resident memory it adds must stay inside its budget.
 */
import { afterAll, beforeAll, describe, it } from 'bun:test';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import should from 'should';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

const ENTRY = resolve(import.meta.dir, '../../../bin/housekeeping.worker.ts');
const RSS = resolve(import.meta.dir, '../support/worker-rss.ts');
/** The memory budget for the bundled worker (§4 PR 2). Measured 15–19 MB on Linux, Bun 1.3.13. */
const RSS_BUDGET_MB = 25;

/** Modules the worker must never carry, by what their path or specifier says. */
const FORBIDDEN: readonly [string, RegExp][] = [
  ['SQLite', /bun:sqlite/u],
  ['session storage', /session-storage|daemon-storage|sqlite-index/u],
  ['the secret vault, its store or the redactor', /\/secrets\/|secret-redactor|redact/u],
  ['the protocol schemas', /packages\/protocol\//u],
  ['the account model schema or fleet config', /fleet\/src\/lib\/(account\/schema|config|manifest|wrappers)\.ts/u],
];

interface Metafile {
  readonly inputs: Record<string, { readonly imports: readonly { readonly path: string }[] }>;
}

let bundle: string;
let modules: readonly string[];

beforeAll(async () => {
  const outdir = await tempDirectory('fyd-housekeeping-bundle-');
  const built = (await Bun.build({ entrypoints: [ENTRY], target: 'bun', outdir, metafile: true } as Parameters<
    typeof Bun.build
  >[0])) as Awaited<ReturnType<typeof Bun.build>> & { readonly metafile: Metafile };
  if (!built.success) throw new Error(built.logs.map(String).join('\n'));
  bundle = join(outdir, 'housekeeping.worker.js');
  modules = Object.entries(built.metafile.inputs).flatMap(([file, input]) => [
    file,
    ...input.imports.map(entry => entry.path),
  ]);
});

afterAll(async () => {
  await cleanupTempDirectories();
});

describe('the bundled housekeeping worker', () => {
  for (const [name, pattern] of FORBIDDEN) {
    it(`should not carry ${name}`, () => {
      // Assert
      should(modules.filter(module => pattern.test(module))).deepEqual([]);
    });
  }

  it('should carry the store reader and both probes, so the diet is of the real program', () => {
    // Assert
    for (const needed of [
      'credential-store.ts',
      'anthropic-usage-probe.ts',
      'codex-usage-probe.ts',
      'credential-reads.ts',
    ])
      should(modules.some(module => module.endsWith(needed))).be.true(needed);
  });

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
