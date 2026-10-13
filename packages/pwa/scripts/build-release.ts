/**
 * The release half of `bun run build`: builds the service worker into `dist/` and writes the signed
 * release's file list. Runs after `vite build`, so it sees exactly what Pages will publish.
 *
 *   bun run scripts/build-release.ts [distDirectory] [--public-key <pem>] [--commit <sha>] [--created-at <iso>]
 *
 * The flags exist for `tests/integration/release-worker.test.ts`, which signs with a throwaway key
 * and needs two DIFFERENT releases from one checkout. A real build passes none of them: it compiles in
 * the committed `packages/pwa/release-signing-key.pub` and names the release by the repository.
 *
 * Writes three files:
 *   - `sw.verified.js`         the worker (`src/worker/service-worker.ts`), with the committed public
 *                              key and the app's rewrites compiled in;
 *   - `release-manifest.json`  every file in `dist/` and the SHA-256 of its bytes;
 *   - `release-manifest.sig`   the UNSIGNED marker. Only `scripts/ci/sign-pwa-release.sh`, holding
 *                              the key, replaces it with a signature.
 *
 * DETERMINISTIC: the release is named by the repository (`VERSION`, the commit, and the commit's own
 * time), never by the clock or the machine, and files are listed in one fixed order — so two builds
 * of one commit write the same list. See `docs/pwa-release-signing.md`.
 */
import { spawnSync } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import {
  RELEASE_MANIFEST_FILE,
  RELEASE_SIGNATURE_FILE,
  RELEASE_WORKER_FILE,
  ReleaseManifestSchema,
  UNLISTED_RELEASE_FILES,
  UNSIGNED_RELEASE_SIGNATURE,
  parseReleaseRewrites,
  releaseKeyFromPem,
  serializeReleaseManifest,
} from '../src/lib/release-manifest.ts';
import { sha256Base64Url } from '../src/lib/release-verification.ts';

const packageRoot = resolve(import.meta.dir, '..');
const repositoryRoot = resolve(packageRoot, '../..');
const fail = (message: string): never => {
  throw new Error(`❌ ${message}`);
};

const git = (...args: string[]): string => {
  const result = spawnSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' });
  if (result.status !== 0) fail(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
};

const listFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter(entry => entry.isFile())
    .map(entry => relative(directory, join(entry.parentPath, entry.name)).split(sep).join('/'));
};

export const COMMITTED_RELEASE_KEY = join(packageRoot, 'release-signing-key.pub');

/** The arguments that are neither a `--flag` nor a flag's value. */
export const positionals = (args: readonly string[]): string[] =>
  args.filter((arg, index) => !arg.startsWith('--') && !(args[index - 1] ?? '').startsWith('--'));

/** The argument after `flag`, or `fallback`. */
export const flagValue = (args: readonly string[], flag: string, fallback: string): string => {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : (args[index + 1] ?? fail(`${flag} needs a value`));
};

export interface ReleaseIdentity {
  readonly commit?: string;
  readonly createdAt?: string;
}

export const buildRelease = async (
  distDirectory: string,
  publicKeyFile = COMMITTED_RELEASE_KEY,
  identity: ReleaseIdentity = {},
): Promise<void> => {
  const key = releaseKeyFromPem(await readFile(publicKeyFile, 'utf8'));
  if (key === null) fail(`${publicKeyFile} is not one Ed25519 public key`);
  const rewrites = parseReleaseRewrites(await readFile(join(packageRoot, 'public/_redirects'), 'utf8'));

  const worker = await Bun.build({
    entrypoints: [join(packageRoot, 'src/worker/service-worker.ts')],
    format: 'esm',
    minify: true,
    splitting: false,
    target: 'browser',
    define: {
      __FY_RELEASE_KEY__: JSON.stringify(key),
      __FY_RELEASE_REWRITES__: JSON.stringify(rewrites),
    },
  });
  if (!worker.success) fail(`the service worker did not build:\n${worker.logs.join('\n')}`);
  const [output] = worker.outputs;
  if (output === undefined || worker.outputs.length !== 1) return fail('the service worker must build to one file');
  await writeFile(join(distDirectory, RELEASE_WORKER_FILE), await output.text(), 'utf8');

  const files: Record<string, string> = {};
  for (const path of (await listFiles(distDirectory)).sort()) {
    if (UNLISTED_RELEASE_FILES.includes(path)) continue;
    files[path] = await sha256Base64Url(new Uint8Array(await readFile(join(distDirectory, path))));
  }

  const nextKeyPem = await readFile(join(packageRoot, 'release-signing-key.next.pub'), 'utf8').catch(() => null);
  const nextKey = nextKeyPem === null ? null : releaseKeyFromPem(nextKeyPem);
  if (nextKeyPem !== null && nextKey === null) fail('packages/pwa/release-signing-key.next.pub is not one Ed25519 key');

  const manifest = ReleaseManifestSchema.parse({
    version: (await readFile(join(repositoryRoot, 'VERSION'), 'utf8')).trim(),
    commit: identity.commit ?? git('rev-parse', 'HEAD'),
    createdAt: new Date(identity.createdAt ?? git('log', '-1', '--format=%cI')).toISOString(),
    worker: RELEASE_WORKER_FILE,
    files,
    ...(nextKey === null ? {} : { nextKey }),
  });
  await writeFile(join(distDirectory, RELEASE_MANIFEST_FILE), serializeReleaseManifest(manifest), 'utf8');
  await writeFile(join(distDirectory, RELEASE_SIGNATURE_FILE), `${UNSIGNED_RELEASE_SIGNATURE}\n`, 'utf8');
  console.log(`✅ ${Object.keys(files).length} release files listed for ${manifest.version} (${manifest.commit})`);
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const [distDirectory] = positionals(args);
  const commit = flagValue(args, '--commit', '');
  const createdAt = flagValue(args, '--created-at', '');
  await buildRelease(
    resolve(distDirectory ?? join(packageRoot, 'dist')),
    resolve(flagValue(args, '--public-key', COMMITTED_RELEASE_KEY)),
    { ...(commit === '' ? {} : { commit }), ...(createdAt === '' ? {} : { createdAt }) },
  );
}
