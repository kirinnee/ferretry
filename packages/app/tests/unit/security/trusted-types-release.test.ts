/**
 * The dev server's `/@fs` address of Voice's workers is a development allowance: a Vite PRODUCTION build must not
 * accept it (nor carry its pattern), while the same source in dev mode still does.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

const source = join(import.meta.dir, '../../../src/security/trusted-types.ts');
const out = mkdtempSync(join(tmpdir(), 'fy-tt-release-'));
afterAll(() => rmSync(out, { recursive: true, force: true }));

const DEV_URL = '/@fs/home/dev/ferretry/packages/plugins/voice/app/worker/parakeet-worker.ts?worker_file&type=module';
const RELEASE_URL = '/assets/parakeet-worker-abc123.js';

/** `trusted-types.ts` through `vite build` for one mode, as the file the build wrote. */
const built = async (mode: 'production' | 'development'): Promise<string> => {
  const dir = join(out, mode);
  // Vite takes DEV from NODE_ENV when one is set (as `vite build` sets it); bun test sets `test`.
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = mode;
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    mode,
    root: out,
    build: {
      outDir: dir,
      emptyOutDir: true,
      minify: mode === 'production',
      lib: { entry: source, formats: ['es'], fileName: 'trusted-types' },
    },
  }).finally(() => {
    if (before === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = before;
  });
  const chunks = (Array.isArray(result) ? result : [result]).flatMap(r => ('output' in r ? r.output : []));
  return join(dir, chunks[0]!.fileName);
};

describe('a Vite production build of the trusted-types policy', () => {
  it('rejects the dev server /@fs address of a speech worker and does not carry its pattern', async () => {
    const file = await built('production');
    expect(readFileSync(file, 'utf8')).not.toContain('/@fs');
    const mod = (await import(pathToFileURL(file).href)) as typeof import('../../../src/security/trusted-types.ts');
    expect(mod.isWorkerScriptUrl(DEV_URL)).toBe(false);
    expect(() => mod.trustedWorkerUrl(DEV_URL)).toThrow(TypeError);
    expect(mod.isWorkerScriptUrl(RELEASE_URL)).toBe(true);
  }, 60_000);

  it('accepts it in a Vite development-mode build', async () => {
    const file = await built('development');
    const mod = (await import(pathToFileURL(file).href)) as typeof import('../../../src/security/trusted-types.ts');
    expect(mod.isWorkerScriptUrl(DEV_URL)).toBe(true);
  }, 60_000);
});
