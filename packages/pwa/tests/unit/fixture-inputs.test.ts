import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  cacheRootFor,
  cachedText,
  hashFixtureInputs,
  sceneInputPatterns,
} from '../integration/support/fixture-inputs.ts';

let workspace = '';

const put = async (file: string, text: string): Promise<void> => {
  await mkdir(dirname(join(workspace, file)), { recursive: true });
  await writeFile(join(workspace, file), text, 'utf8');
};

const key = async (env?: Record<string, string | undefined>): Promise<string> =>
  await hashFixtureInputs({ workspace, patterns: sceneInputPatterns, ...(env === undefined ? {} : { env }) });

const inputs = [
  'packages/pwa/src/App.tsx',
  'packages/protocol/src/index.ts',
  'packages/pwa/tests/integration/fixtures/composer-editor-scene.tsx',
  'packages/pwa/tests/integration/support/shell-css.ts',
  'packages/pwa/tests/support/sessions.ts',
  'packages/pwa/tests/unit/board-support.ts',
  'packages/pwa/harness/main.tsx',
  'packages/pwa/index.html',
  'packages/pwa/tailwind.config.ts',
  'packages/pwa/vite.config.ts',
  'packages/pwa/tsconfig.json',
  'packages/pwa/package.json',
  'packages/pwa/scripts/build-composer-integration-fixture.ts',
  'package.json',
  'bun.lock',
  'Changelog.md',
];

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'fy-fixture-inputs-'));
  for (const file of inputs) await put(file, `// ${file}\n`);
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe('hashFixtureInputs', () => {
  it('is stable while no input changes', async () => {
    expect(await key()).toBe(await key());
  });

  for (const file of inputs)
    it(`misses the cache when ${file} changes`, async () => {
      const before = await key();
      await put(file, `// ${file}\nchanged\n`);
      expect(await key()).not.toBe(before);
    });

  it('sees an edit that keeps the size and the modified time', async () => {
    const file = 'packages/pwa/src/App.tsx';
    const when = new Date('2026-01-01T00:00:00Z');
    await put(file, 'const a = 1;\n');
    await utimes(join(workspace, file), when, when);
    const before = await key();
    await put(file, 'const a = 2;\n');
    await utimes(join(workspace, file), when, when);
    expect(await key()).not.toBe(before);
  });

  it('sees a new or a removed input', async () => {
    const before = await key();
    await put('packages/pwa/src/New.tsx', 'export {};\n');
    const added = await key();
    expect(added).not.toBe(before);
    await rm(join(workspace, 'packages/pwa/src/New.tsx'));
    expect(await key()).toBe(before);
  });

  it('does not tell a moved byte from a moved file name', async () => {
    await put('packages/pwa/src/a.ts', 'bc');
    const first = await key();
    await rm(join(workspace, 'packages/pwa/src/a.ts'));
    await put('packages/pwa/src/ab.ts', 'c');
    expect(await key()).not.toBe(first);
  });

  it('ignores a file no build can read', async () => {
    const before = await key();
    await put('packages/pwa/tests/unit/some-feature.test.ts', 'it("x", () => {});\n');
    await put('docs/notes.md', 'notes\n');
    expect(await key()).toBe(before);
  });

  it('misses when an environment value the build reads changes, and tells unset from empty', async () => {
    const unset = await key({ NODE_ENV: undefined });
    const empty = await key({ NODE_ENV: '' });
    const production = await key({ NODE_ENV: 'production' });
    expect(new Set([unset, empty, production]).size).toBe(3);
  });

  it('matches at least one file of every pattern in the real workspace', async () => {
    const real = resolve(import.meta.dir, '../../../..');
    for (const pattern of sceneInputPatterns) {
      const seen = await Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: real, onlyFiles: true }));
      expect({ pattern, matches: seen.length > 0 }).toEqual({ pattern, matches: true });
    }
  });
});

describe('cachedText', () => {
  it('serves a hit for the same key and makes a new one for a changed input', async () => {
    const base = join(workspace, 'cache');
    let made = 0;
    const make = async (): Promise<string> => `build ${++made}`;

    const first = cacheRootFor(await key(), base);
    expect(await cachedText(first, 'app.js', make)).toBe('build 1');
    expect(await cachedText(cacheRootFor(await key(), base), 'app.js', make)).toBe('build 1');

    await put('packages/pwa/src/App.tsx', 'export const App = 2;\n');
    expect(await cachedText(cacheRootFor(await key(), base), 'app.js', make)).toBe('build 2');
    expect(made).toBe(2);
  });

  it('keeps the previous key until it is a day stale, then removes it', async () => {
    const base = join(workspace, 'cache');
    const old = cacheRootFor('0'.repeat(24), base);
    await cachedText(old, 'app.js', async () => 'old');
    const recent = cacheRootFor('1'.repeat(24), base);
    await cachedText(recent, 'app.js', async () => 'recent');
    expect(await readdir(join(base, 'ferretry-fixture-cache'))).toHaveLength(2);

    const longAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(old, longAgo, longAgo);
    await cachedText(cacheRootFor('2'.repeat(24), base), 'app.js', async () => 'new');
    expect((await readdir(join(base, 'ferretry-fixture-cache'))).sort()).toEqual(['1'.repeat(24), '2'.repeat(24)]);
  });
});
