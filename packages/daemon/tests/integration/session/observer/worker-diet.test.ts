/**
 * THE SESSION WORKER STAYS LEAN — and can never grow a storage handle.
 *
 * Measured (docs/design/session-workers.md §3.4): a bundled worker that carries only the observer, the
 * pane and transcript parsers and its tmux client costs ≈4 MB a thread; one that drags zod and the
 * protocol schemas in costs 15–19 MB. With up to eight threads, one careless import is +100 MB. And a
 * worker that could reach storage, the vault or the redactor could write documents or hold secrets on
 * a thread nobody audits. So the worker is bundled here the way the release compiles it, and refused
 * if any of that is inside.
 */
import { afterAll, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import should from 'should';

const ENTRY = join(import.meta.dir, '../../../../bin/session.worker.ts');
const RSS = join(import.meta.dir, '../../support/session-worker-rss.ts');
/** Bytes of the unminified bundle: about 160 KB today, and an order of magnitude under the 15 MB worker. */
const BUDGET_BYTES = 256 * 1024;
/**
 * Resident memory one BUNDLED worker adds — what the compiled binary ships. Measured 7.4 MB a thread on
 * Linux (Bun 1.3.13); run from source a worker costs ~67 MB, which is why this measures the bundle.
 */
const WORKER_MEMORY_BUDGET_MB = 15;
const WORKERS = 5;
/**
 * Every process this file starts is killed by then. A test's own timeout cannot end a child, and a
 * child it waits on forever is a run that never finishes: a deadline here is a failure that says why.
 */
const CHILD_DEADLINE_MS = 30_000;

/** Runs `argv` to its end, or kills it at {@link CHILD_DEADLINE_MS}, and throws unless it exited 0. */
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

const scratch: string[] = [];
afterAll(async () => {
  for (const directory of scratch.splice(0)) await rm(directory, { recursive: true, force: true });
});

/** Module paths that must never be in a session worker. */
const FORBIDDEN: readonly RegExp[] = [
  /node_modules\/[^ ]*zod/u,
  /node_modules\//u,
  /storage/u,
  /vault/u,
  /secret/u,
  /redact/u,
  /sqlite/u,
  /packages\/protocol\//u,
];

/**
 * The worker as `bun build` bundles it. In a child process, because `Bun.build` called from inside the
 * test runner cannot resolve the daemon's relative imports (Bun 1.3.13).
 */
async function bundled(): Promise<{ readonly text: string; readonly modules: readonly string[] }> {
  const text = await run([process.execPath, 'build', ENTRY, '--target=bun'], 'bun build');
  // Bun marks each bundled module with a `// <path>` line: the bundle's own table of contents.
  const modules = [...text.matchAll(/^\/\/ (\S+\.(?:ts|js|mjs|cjs))$/gmu)].map(match => match[1] as string);
  return { text, modules };
}

describe('the session worker bundle', () => {
  it('should carry no zod, no protocol schemas, no storage, no vault and no redactor', async () => {
    // Act
    const { text, modules } = await bundled();

    // Assert
    should(modules.length).be.above(10);
    for (const module of modules)
      for (const pattern of FORBIDDEN)
        should(pattern.test(module)).equal(false, `${module} must not be in a session worker (${String(pattern)})`);
    should(text.includes('bun:sqlite')).be.false();
    should(text.includes('$ZodType')).be.false();
  });

  it('should stay inside its byte budget', async () => {
    // Act
    const { text } = await bundled();

    // Assert
    should(text.length).be.below(BUDGET_BYTES);
  });

  it(`should cost at most ${WORKER_MEMORY_BUDGET_MB} MB of resident memory a thread, bundled as it ships`, async () => {
    // Arrange — the bundle on disk, as the compiled binary embeds it.
    const directory = await mkdtemp(join(tmpdir(), 'fy-worker-diet-'));
    scratch.push(directory);
    const outfile = join(directory, 'session.worker.js');
    await run([process.execPath, 'build', ENTRY, '--target=bun', '--outfile', outfile], 'bun build');

    // Act — in a process of its own (see `support/session-worker-rss.ts`): this one never hosts the threads.
    const out = await run(
      [process.execPath, RSS, pathToFileURL(outfile).href, String(WORKERS)],
      'measuring the workers',
    );
    const { perWorkerMb } = JSON.parse(out) as { perWorkerMb: number };

    // Assert
    should(perWorkerMb).be.below(WORKER_MEMORY_BUDGET_MB);
  }, 60_000);
});
