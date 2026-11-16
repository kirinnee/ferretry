/**
 * A release of a fixture site, built and signed the way `pwa-pages.yaml` builds and signs the real one:
 * the real `scripts/build-release.ts` writes `sw.verified.js` (from `src/worker/service-worker.ts`, with
 * the real `public/_headers` and `public/_redirects` compiled in) and the release list, and the REAL CI
 * signer (`scripts/ci/sign-pwa-release.sh`, openssl) signs it with a throwaway key made here.
 *
 * Both run in CHILD PROCESSES, never in the test runner — see `fy-render-integration-fixture.ts` for why
 * a build inside the runner wedges. Shared by every suite that drives the built worker in Chromium
 * (`release-worker.test.ts`, `notification-open.test.ts`).
 */
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

const packageRoot = resolve(import.meta.dir, '../../..');
const repositoryRoot = resolve(packageRoot, '../..');

/** Runs one command to completion, failing loudly with its output. */
export const run = (command: readonly string[], cwd = packageRoot, input?: Uint8Array): void => {
  const result = spawnSync(command[0] ?? '', command.slice(1), { cwd, encoding: 'utf8', input });
  if (result.status !== 0) throw new Error(`${command.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
};

const listFiles = async (directory: string): Promise<string[]> =>
  (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => relative(directory, join(entry.parentPath, entry.name)).split(sep).join('/'));

/** A throwaway ed25519 signing key, as PEM files under `directory`. */
export interface ReleaseKey {
  readonly pem: string;
  readonly pub: string;
}

export const releaseKey = async (directory: string, name: string): Promise<ReleaseKey> => {
  const pem = join(directory, `${name}.pem`);
  const pub = join(directory, `${name}.pub`);
  run(['openssl', 'genpkey', '-algorithm', 'ed25519', '-out', pem], directory);
  run(['openssl', 'pkey', '-in', pem, '-pubout', '-out', pub], directory);
  return { pem, pub };
};

export interface SignedReleaseOptions {
  /** Where the release is built: `<directory>/<name>/`. */
  readonly directory: string;
  readonly name: string;
  /** The site's own files, path → contents; `_headers` and `_redirects` are the app's, copied in. */
  readonly files: ReadonlyMap<string, string | Uint8Array>;
  readonly identity: { readonly commit: string; readonly sequence: number };
  readonly key: ReleaseKey;
  /** `false` leaves the release list unsigned, as a local build does. */
  readonly sign?: boolean;
}

/** Builds (and by default signs) one release; answers every file it serves, path → bytes. */
export const signedRelease = async (options: SignedReleaseOptions): Promise<Map<string, Uint8Array>> => {
  const dist = join(options.directory, options.name);
  await mkdir(dist, { recursive: true });
  for (const [path, contents] of options.files) {
    await mkdir(join(dist, path, '..'), { recursive: true });
    await writeFile(join(dist, path), contents);
  }
  // Pages configuration, as `vite build` copies it from `public/`; the signer checks it is the real one.
  for (const config of ['_headers', '_redirects'])
    await copyFile(join(packageRoot, 'public', config), join(dist, config));
  run([
    'bun',
    'run',
    'scripts/build-release.ts',
    dist,
    '--public-key',
    options.key.pub,
    '--commit',
    options.identity.commit,
    '--sequence',
    String(options.identity.sequence),
    '--created-at',
    '2026-10-01T00:00:00Z',
  ]);
  if (options.sign !== false) {
    run(
      [
        join(repositoryRoot, 'scripts/ci/sign-pwa-release.sh'),
        '--sequence',
        String(options.identity.sequence),
        '--commit',
        options.identity.commit,
        '--public-key',
        options.key.pub,
        dist,
      ],
      repositoryRoot,
      new Uint8Array(await readFile(options.key.pem)),
    );
  }
  const files = new Map<string, Uint8Array>();
  for (const path of await listFiles(dist)) files.set(path, new Uint8Array(await readFile(join(dist, path))));
  return files;
};
