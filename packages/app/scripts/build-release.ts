/**
 * The release half of `bun run build`: builds the service worker into `dist/` and writes the signed
 * release's file list. Runs after `vite build`, so it sees exactly what Pages will publish.
 *
 *   [PWA_RELEASE_SEQUENCE=<n>] bun run scripts/build-release.ts [distDirectory] [--sequence <n>]
 *     [--public-key <pem>] [--commit <sha>] [--created-at <iso>]
 *
 * `--sequence` (or `PWA_RELEASE_SEQUENCE`) is what ORDERS releases, and only CI chooses it:
 * `pwa-pages.yaml` passes its own run number, a counter GitHub owns and only ever raises. Without it the release is sequence 0, which
 * every deployed release outranks — a local build can never displace a real one. The other flags exist
 * for `tests/integration/release-worker.test.ts`, which signs with a throwaway key and needs several
 * DIFFERENT releases from one checkout; a real build compiles in the committed
 * `packages/app/release-signing-key.pub` and names the release by the repository.
 *
 * Writes three files:
 *   - `sw.verified.js`         the worker (`src/worker/service-worker.ts`) with the committed public key,
 *                              the app's rewrites and its header rules compiled in — and no plugin code;
 *   - `release-manifest.json`  every file in `dist/` and the SHA-256 of its bytes;
 *   - `release-manifest.sig`   the UNSIGNED marker. Only `scripts/ci/sign-pwa-release.sh`, holding
 *                              the key, replaces it with a signature.
 *
 * DETERMINISTIC: the release is named by the repository (`VERSION`, the commit, the commit's own
 * time) and the sequence CI passes, never by the clock or the machine, and files are listed in one
 * fixed order — so two builds of one commit and one run write the same list. See
 * `docs/pwa-release-signing.md`.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isBuiltin } from 'node:module';
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
} from '../src/release/manifest.ts';
import { parseReleaseHeaders } from '../src/release/headers.ts';
import { sha256Base64Url } from '../src/release/verification.ts';
import type { BunPlugin } from 'bun';

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

/**
 * Which hosted app this build belongs to is decided in ONE place, `scripts/ci/hosted-app-origin.sh`: it names the
 * release public key (and the next-key file) to compile in, from the same `FY_HOSTED_APP_ORIGIN` switch that sets the
 * app's and the daemon's origin. Ordinary builds get `release-signing-key.pub`.
 */
const hostedApp = (flag: '--key-file' | '--next-key-file'): string => {
  const result = spawnSync(join(repositoryRoot, 'scripts/ci/hosted-app-origin.sh'), [flag], { encoding: 'utf8' });
  if (result.status !== 0) fail(`scripts/ci/hosted-app-origin.sh ${flag} failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
};

const COMMITTED_RELEASE_KEY = hostedApp('--key-file');
const NEXT_RELEASE_KEY = hostedApp('--next-key-file');

/**
 * NO PLUGIN CODE RUNS IN THE RELEASE WORKER. Code evaluated in the worker's realm could rewrite the globals the release
 * check serves through (`Response`, `crypto.subtle`, `caches`, …) before any event arrives, and no list of names can
 * stop that — so the worker compiles `src/worker/service-worker.ts` and the shell's own modules only, and the build
 * REFUSES any `packages/{core,plugins}/<id>/app/worker.ts` and any resolved input outside the shell allowlist and zod.
 * A plugin that needs worker behaviour (push, notification
 * taps) asks for it as declarative data the worker interprets, through its own contract — later; none does today.
 */
export async function pluginWorkerFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const group of ['packages/core', 'packages/plugins']) {
    const entries = await readdir(join(root, group), { withFileTypes: true }).catch(() => []);
    const ids = entries
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort();
    for (const id of ids) {
      const file = join(root, group, id, 'app/worker.ts');
      if (await Bun.file(file).exists()) found.push(relative(root, file).split(sep).join('/'));
    }
  }
  return found;
}

/** Fails the build when any plugin ships worker code (see {@link pluginWorkerFiles}). */
export async function refusePluginWorkers(root: string): Promise<void> {
  const found = await pluginWorkerFiles(root);
  if (found.length > 0)
    fail(
      `no plugin code may run in the signed service worker; remove ${found.join(', ')} (a plugin needing worker behaviour asks for it as declarative data in its contract)`,
    );
}

/** Guard the resolved graph, including transitive imports and symlinks, before any worker bytes are emitted. */
export function workerInputGuard(root = packageRoot, inputs?: Set<string>): BunPlugin {
  const app = realpathSync(root);
  const zod = realpathSync(resolve(Bun.resolveSync('zod/package.json', packageRoot), '..'));
  const allowed = ['worker', 'release', 'router', 'storage'].map(directory => join(app, 'src', directory) + sep);
  // The kernel contract's push envelope and notification filter document, each by its own subpath: the one declaration of
  // what a push says and of the device's filter, shared with the plugins that send and write them. They import zod and each
  // other and nothing else; the contract barrel, which does import more, is not an allowed input.
  const contracts = ['push-envelope', 'notification-filter'].map(name =>
    realpathSync(Bun.resolveSync(`@ferretry/kernel/contract/${name}`, packageRoot)),
  );
  return {
    name: 'shell-worker-inputs',
    setup(build) {
      build.onResolve({ filter: /.*/u }, args => {
        if (isBuiltin(args.path) || args.path.startsWith('bun:')) {
          throw new Error(`no plugin code may run in the signed service worker: refused input ${args.path}`);
        }
        return undefined;
      });
      build.onLoad({ filter: /.*/u }, args => {
        const path = realpathSync(args.path);
        if (
          !allowed.some(directory => path.startsWith(directory)) &&
          !path.startsWith(zod + sep) &&
          !contracts.includes(path)
        ) {
          throw new Error(`no plugin code may run in the signed service worker: refused input ${path}`);
        }
        inputs?.add(path);
        return undefined;
      });
    },
  };
}

/** The arguments that are neither a `--flag` nor a flag's value. */
const positionals = (args: readonly string[]): string[] =>
  args.filter((arg, index) => !arg.startsWith('--') && !(args[index - 1] ?? '').startsWith('--'));

/** The argument after `flag`, or `fallback`. */
const flagValue = (args: readonly string[], flag: string, fallback: string): string => {
  const index = args.indexOf(flag);
  return index === -1 ? fallback : (args[index + 1] ?? fail(`${flag} needs a value`));
};

interface ReleaseIdentity {
  readonly sequence: number;
  readonly commit?: string;
  readonly createdAt?: string;
}

const buildRelease = async (
  distDirectory: string,
  publicKeyFile = COMMITTED_RELEASE_KEY,
  identity: ReleaseIdentity,
): Promise<void> => {
  const pem = await readFile(publicKeyFile, 'utf8').catch(() => null);
  if (pem === null) {
    return fail(
      `${publicKeyFile} is not committed: a build for this hosted app signs with it ` +
        '(scripts/local/setup-pwa-release-v5.sh makes the key; its public half is committed on the branch that deploys it)',
    );
  }
  const key = releaseKeyFromPem(pem);
  if (key === null) return fail(`${publicKeyFile} is not one Ed25519 public key`);
  const rewrites = parseReleaseRewrites(await readFile(join(packageRoot, 'public/_redirects'), 'utf8'));
  const headers = parseReleaseHeaders(await readFile(join(packageRoot, 'public/_headers'), 'utf8'));
  if (headers.length === 0) fail('public/_headers names no header rules');

  await refusePluginWorkers(repositoryRoot);
  const worker = await Bun.build({
    entrypoints: [join(packageRoot, 'src/worker/service-worker.ts')],
    format: 'esm',
    minify: true,
    splitting: false,
    target: 'browser',
    plugins: [workerInputGuard()],
    define: {
      __FY_RELEASE_KEY__: JSON.stringify(key),
      __FY_RELEASE_REWRITES__: JSON.stringify(rewrites),
      __FY_RELEASE_HEADERS__: JSON.stringify(headers),
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

  const nextKeyPem = await readFile(NEXT_RELEASE_KEY, 'utf8').catch(() => null);
  const nextKey = nextKeyPem === null ? null : releaseKeyFromPem(nextKeyPem);
  if (nextKeyPem !== null && nextKey === null) fail(`${NEXT_RELEASE_KEY} is not one Ed25519 key`);

  const manifest = ReleaseManifestSchema.parse({
    // The release this app ships from (`release.json`, §10.6): the app ships from the release, not from `main`.
    version: (JSON.parse(await readFile(join(repositoryRoot, 'release.json'), 'utf8')) as { version: string }).version,
    commit: identity.commit ?? git('rev-parse', 'HEAD'),
    sequence: identity.sequence,
    createdAt: new Date(identity.createdAt ?? git('log', '-1', '--format=%cI')).toISOString(),
    worker: RELEASE_WORKER_FILE,
    files,
    ...(nextKey === null ? {} : { nextKey }),
  });
  await writeFile(join(distDirectory, RELEASE_MANIFEST_FILE), serializeReleaseManifest(manifest), 'utf8');
  await writeFile(join(distDirectory, RELEASE_SIGNATURE_FILE), `${UNSIGNED_RELEASE_SIGNATURE}\n`, 'utf8');
  console.log(
    `✅ ${Object.keys(files).length} release files listed for ${manifest.version} #${manifest.sequence} (${manifest.commit})`,
  );
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const [distDirectory] = positionals(args);
  const commit = flagValue(args, '--commit', '');
  const createdAt = flagValue(args, '--created-at', '');
  const sequence = flagValue(args, '--sequence', process.env.PWA_RELEASE_SEQUENCE ?? '0');
  if (!/^(0|[1-9]\d*)$/u.test(sequence)) fail('--sequence must be a whole number');
  await buildRelease(
    resolve(distDirectory ?? join(packageRoot, 'dist')),
    resolve(flagValue(args, '--public-key', COMMITTED_RELEASE_KEY)),
    {
      sequence: Number(sequence),
      ...(commit === '' ? {} : { commit }),
      ...(createdAt === '' ? {} : { createdAt }),
    },
  );
}
