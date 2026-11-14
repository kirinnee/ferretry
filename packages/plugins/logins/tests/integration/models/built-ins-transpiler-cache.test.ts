/**
 * The built-in catalogs survive Bun's shared runtime transpiler cache in the order that poisoned it (Nov 2026).
 *
 * Bun transpiles every module it loads while running a macro with macros switched off: a nested macro import is
 * silently dropped and its call left in place, and that output is cached under a key that ignores the macro mode.
 * When the presets service imported its built-ins as a macro, ANY process that loaded it inside a macro wrote such an
 * entry, and every later ordinary run of the same source on the machine threw "checkedBuiltInPresets is not defined"
 * (it broke every commit's `manifest-match`). This plays that order against a cache folder of its own — never the
 * machine's — and then constructs both services the way the daemon does.
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import should from 'should';

const LIB = resolve(import.meta.dir, '..', '..', '..', 'daemon', 'lib');
const PRESETS = join(LIB, 'provider-probe', 'presets.ts');
const MODELS = join(LIB, 'models', 'service.ts');

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** Runs one Bun program with this test's own transpiler cache. */
function run(file: string, cache: string): { code: number | null; out: string } {
  const child = Bun.spawnSync([process.execPath, file], {
    env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: cache },
    timeout: 120_000,
  });
  return { code: child.exitCode, out: `${child.stdout.toString()}\n${child.stderr.toString()}` };
}

describe('the built-in catalogs and the shared transpiler cache', () => {
  it('should construct both services after a macro has loaded their modules into the same cache', () => {
    // Arrange — a macro whose own imports are the two services, so Bun loads them with macros switched off.
    const folder = mkdtempSync(join(tmpdir(), 'logins-transpiler-cache-'));
    folders.push(folder);
    const cache = join(folder, 'cache');
    mkdirSync(cache);
    writeFileSync(
      join(folder, 'loads-services.ts'),
      `import * as presets from ${JSON.stringify(PRESETS)};\nimport * as models from ${JSON.stringify(MODELS)};\n` +
        'export function loaded(): number { return Object.keys(presets).length + Object.keys(models).length; }\n',
    );
    writeFileSync(
      join(folder, 'runs-macro.ts'),
      `import { loaded } from './loads-services.ts' with { type: ${JSON.stringify('macro')} };\nconsole.log(loaded());\n`,
    );
    writeFileSync(
      join(folder, 'constructs.ts'),
      `import { ProviderPresetService } from ${JSON.stringify(PRESETS)};\n` +
        `import { ModelCatalogService } from ${JSON.stringify(MODELS)};\n` +
        'const presets = new ProviderPresetService({ presets: async () => ({}) });\n' +
        'const models = new ModelCatalogService({ files: async () => ({}), presets: async () => [] });\n' +
        'console.log(`presets=${(await presets.presets()).length} models=${Object.keys(await models.catalogs()).length}`);\n',
    );

    // Act — the poisoning order: the macro run first, then an ordinary run reading the same cache.
    const macro = run(join(folder, 'runs-macro.ts'), cache);
    const cached = readdirSync(cache).length;
    const ordinary = run(join(folder, 'constructs.ts'), cache);

    // Assert
    should(macro.code).equal(0, macro.out);
    should(cached).be.above(0); // the cache was really in play
    should(ordinary.out).not.match(/is not defined/);
    should(ordinary.code).equal(0, ordinary.out);
    should(ordinary.out).match(/presets=[1-9]\d* models=[1-9]\d*/);
  }, 240_000);
});
