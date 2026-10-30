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
 * What the started bundle costs in resident memory is a machine-dependent budget, so it is the realworld
 * tier's (tests/realworld/runtime/housekeeping-worker-bundle.test.ts).
 */
import { afterAll, beforeAll, describe, it } from 'bun:test';
import { resolve } from 'node:path';
import should from 'should';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

const ENTRY = resolve(import.meta.dir, '../../../bin/housekeeping.worker.ts');

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

let modules: readonly string[];

beforeAll(async () => {
  const outdir = await tempDirectory('fyd-housekeeping-bundle-');
  const built = (await Bun.build({ entrypoints: [ENTRY], target: 'bun', outdir, metafile: true } as Parameters<
    typeof Bun.build
  >[0])) as Awaited<ReturnType<typeof Bun.build>> & { readonly metafile: Metafile };
  if (!built.success) throw new Error(built.logs.map(String).join('\n'));
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

  it('should carry the store reader, both probes and the rollout index, so the diet is of the real program', () => {
    // Assert
    for (const needed of [
      'credential-store.ts',
      'anthropic-usage-probe.ts',
      'codex-usage-probe.ts',
      'credential-reads.ts',
      'node-codex-rollout-index.ts',
    ])
      should(modules.some(module => module.endsWith(needed))).be.true(needed);
  });
});
