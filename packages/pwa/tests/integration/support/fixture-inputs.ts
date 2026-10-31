/**
 * The cache key and the cache for the visual-test fixtures (`scripts/build-composer-integration-fixture.ts`,
 * `shell-css.ts`): a hash of every file a build can read, and a text store keyed by it.
 *
 * THE KEY IS RECOMPUTED ON EVERY ASK. It was once written to `inputs.hash` and read back, on the claim
 * that the run's temporary directory is its own — true under `scripts/test/swept.sh`, false for a local
 * harness run, where `tmpdir()` is a shared `/tmp` and that file outlived every edit: the next run served
 * the bundle of whatever sources first wrote it. Hashing is cheap once the reads run together (about
 * 40 ms for ~24 MB), so nothing is persisted that can go stale.
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type FixtureInputs = {
  readonly workspace: string;
  /** Globs relative to `workspace`. */
  readonly patterns: readonly string[];
  /** Environment values a build reads; an unset value and an empty one differ. */
  readonly env?: Readonly<Record<string, string | undefined>>;
};

/** Everything the scene bundle and the app stylesheet can read. */
export const sceneInputPatterns: readonly string[] = [
  'packages/*/src/**',
  'packages/*/package.json',
  'package.json',
  'bun.lock',
  'bunfig*.toml',
  'tsconfig*.json',
  'packages/pwa/tsconfig*.json',
  'packages/pwa/*.config.ts',
  'packages/pwa/index.html',
  'packages/pwa/harness/**',
  'packages/pwa/tests/support/**',
  'packages/pwa/tests/integration/support/**',
  'packages/pwa/tests/integration/fixtures/**',
  'packages/pwa/tests/unit/board-support.ts',
  'packages/pwa/scripts/build-composer-integration-fixture.ts',
  'Changelog.md',
];

/** Environment the bundler's output depends on. */
export const sceneInputEnv = (): Readonly<Record<string, string | undefined>> => ({
  NODE_ENV: process.env.NODE_ENV,
  BUN_VERSION: Bun.version,
});

/** A hash of the named environment and of every matching file, in a fixed order. */
export const hashFixtureInputs = async ({ workspace, patterns, env = {} }: FixtureInputs): Promise<string> => {
  const files = new Set<string>();
  for (const pattern of patterns)
    for await (const file of new Bun.Glob(pattern).scan({ cwd: workspace, onlyFiles: true })) files.add(file);
  const ordered = [...files].sort();
  const contents = await Promise.all(ordered.map(file => Bun.file(join(workspace, file)).arrayBuffer()));
  const hasher = new Bun.CryptoHasher('sha256');
  for (const name of Object.keys(env).sort()) {
    const value = env[name];
    hasher.update(`env\0${name}\0${value === undefined ? 'unset' : `set:${value}`}\0`);
  }
  ordered.forEach((file, at) => {
    const bytes = new Uint8Array(contents[at] ?? new ArrayBuffer(0));
    hasher.update(`file\0${file}\0${bytes.byteLength}\0`);
    hasher.update(bytes);
  });
  return hasher.digest('hex').slice(0, 24);
};

const staleAfterMs = 24 * 60 * 60 * 1000;

/** Removes sibling key directories untouched for a day: a changed input is a new key, so old ones only pile up. */
const pruneStale = async (parent: string, keep: string): Promise<void> => {
  const names = await readdir(parent).catch(() => []);
  await Promise.all(
    names.map(async name => {
      const path = join(parent, name);
      if (path === keep) return;
      const info = await stat(path).catch(() => undefined);
      if (info?.isDirectory() === true && Date.now() - info.mtimeMs > staleAfterMs)
        await rm(path, { recursive: true, force: true });
    }),
  );
};

/** `make()`'s text for `name` under `root`, from disk when this key already made it. A write lands through a rename. */
export const cachedText = async (root: string, name: string, make: () => Promise<string>): Promise<string> => {
  const path = join(root, name);
  const hit = await readFile(path, 'utf8').catch(() => undefined);
  if (hit !== undefined) return hit;
  const text = await make();
  await mkdir(root, { recursive: true });
  const partial = `${path}.${process.pid}.partial`;
  await writeFile(partial, text, 'utf8');
  await rename(partial, path);
  await pruneStale(join(root, '..'), root);
  return text;
};

/** The directory for one key, under the run's temporary directory unless `base` says otherwise. */
export const cacheRootFor = (key: string, base: string = tmpdir()): string => join(base, 'ferretry-fixture-cache', key);
