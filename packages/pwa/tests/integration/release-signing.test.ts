/**
 * The CI signer refuses to sign anything the run did not decide: `scripts/ci/sign-pwa-release.sh`
 * runs `scripts/ci/check-pwa-release.sh` before it reads the key, and the deploy job runs the same
 * check before it uploads (`docs/pwa-release-signing.md`).
 *
 * WHY THIS MATTERS. The list is written by the untrusted `build` job, and a real signature makes its
 * trust fields permanent for every installed copy: an attacker's `nextKey` is as good as the stolen
 * key, a huge `sequence` freezes every install, and `_worker.js` / `_routes.json` / `functions/` are
 * Pages server code. Each case below hands the REAL scripts a release that is fine except for one
 * such field, and expects a refusal before anything is signed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const packageRoot = resolve(import.meta.dir, '../..');
const repositoryRoot = resolve(packageRoot, '../..');
const SEQUENCE = 41;
const COMMIT = 'abcdef1234567';

let workDirectory = '';
let key = { pem: '', pub: '', next: '', attacker: '' };
let counter = 0;

const run = (command: string[], input?: Uint8Array) =>
  spawnSync(command[0] ?? '', command.slice(1), { cwd: repositoryRoot, encoding: 'utf8', input });

const sha256 = (bytes: Uint8Array | string): string => new Bun.CryptoHasher('sha256').update(bytes).digest('base64url');

const spki = (pub: string): string => {
  const result = spawnSync('openssl', ['pkey', '-pubin', '-in', pub, '-outform', 'DER']);
  return Buffer.from(result.stdout).toString('base64url');
};

interface Scene {
  /** Files beside the list, by path. */
  readonly files: Record<string, string>;
  /** The list, before it is written; `files` is filled from the files unless set. */
  readonly manifest: Record<string, unknown>;
  /** Files written to `dist` but NOT listed. */
  readonly extra?: Record<string, string>;
  /** Overrides for `_headers` / `_redirects` in `dist`. */
  readonly config?: Record<string, string>;
}

const scene = (change: (base: Scene) => Scene = base => base): Scene =>
  change({
    files: { 'index.html': '<!doctype html>', 'sw.verified.js': 'self.x = 1;', 'assets/app-1.js': 'x()' },
    manifest: {
      version: '1.2.3',
      commit: COMMIT,
      sequence: SEQUENCE,
      createdAt: '2026-10-01T00:00:00.000Z',
      worker: 'sw.verified.js',
    },
  });

const writeScene = async (built: Scene): Promise<string> => {
  counter += 1;
  const dist = join(workDirectory, `dist-${counter}`);
  await mkdir(dist, { recursive: true });
  const all = { ...built.files, ...built.extra };
  for (const [path, body] of Object.entries(all)) {
    await mkdir(dirname(join(dist, path)), { recursive: true });
    await writeFile(join(dist, path), body);
  }
  for (const config of ['_headers', '_redirects']) {
    const override = built.config?.[config];
    if (override === undefined) await copyFile(join(packageRoot, 'public', config), join(dist, config));
    else await writeFile(join(dist, config), override);
  }
  const files = Object.fromEntries(Object.entries(built.files).map(([path, body]) => [path, sha256(body)]));
  await writeFile(join(dist, 'release-manifest.json'), `${JSON.stringify({ files, ...built.manifest }, null, 2)}\n`);
  await writeFile(join(dist, 'release-manifest.sig'), 'unsigned\n');
  return dist;
};

const sign = async (dist: string, nextPublicKey = join(workDirectory, 'absent.pub')) =>
  run(
    [
      join(repositoryRoot, 'scripts/ci/sign-pwa-release.sh'),
      '--sequence',
      String(SEQUENCE),
      '--commit',
      COMMIT,
      '--public-key',
      key.pub,
      '--next-public-key',
      nextPublicKey,
      dist,
    ],
    new Uint8Array(await readFile(key.pem)),
  );

beforeAll(async () => {
  workDirectory = await mkdtemp(join(tmpdir(), 'ferretry-release-signing-'));
  const pair = (name: string) => {
    const pem = join(workDirectory, `${name}.pem`);
    const pub = join(workDirectory, `${name}.pub`);
    spawnSync('openssl', ['genpkey', '-algorithm', 'ed25519', '-out', pem]);
    spawnSync('openssl', ['pkey', '-in', pem, '-pubout', '-out', pub]);
    return { pem, pub };
  };
  const current = pair('key');
  key = { ...current, next: pair('next').pub, attacker: pair('attacker').pub };
});

afterAll(async () => {
  if (workDirectory !== '') await rm(workDirectory, { recursive: true, force: true });
});

describe('sign-pwa-release.sh', () => {
  test('signs a release that says only what the run decided, and the signature verifies', async () => {
    const dist = await writeScene(scene());

    const signed = await sign(dist);
    const verified = run([join(repositoryRoot, 'scripts/ci/verify-pwa-release.sh'), dist, key.pub]);

    expect(signed.stderr).toBe('');
    expect(signed.status).toBe(0);
    expect(verified.status).toBe(0);
    expect(await readFile(join(dist, 'release-manifest.sig'), 'utf8')).toMatch(/^[\w-]{43}\.[\w-]{86}\n$/u);
  });

  test('signs an announced next key that is the checkout’s release-signing-key.next.pub', async () => {
    const dist = await writeScene(
      scene(base => ({ ...base, manifest: { ...base.manifest, nextKey: spki(key.next) } })),
    );
    expect((await sign(dist, key.next)).status).toBe(0);
  });

  const attacker = (): string => spki(key.attacker);

  test.each<[string, (base: Scene) => Scene, RegExp, boolean]>([
    [
      'an attacker’s next key',
      base => ({ ...base, manifest: { ...base.manifest, nextKey: attacker() } }),
      /next key/u,
      false,
    ],
    [
      'a next key other than the checkout’s',
      base => ({ ...base, manifest: { ...base.manifest, nextKey: attacker() } }),
      /next key that is not/u,
      true,
    ],
    ['no next key when the checkout announces one', base => base, /next key that is not/u, true],
    [
      'a sequence that is not this run’s',
      base => ({ ...base, manifest: { ...base.manifest, sequence: 9007199254740991 } }),
      /sequence/u,
      false,
    ],
    [
      'a commit that is not this run’s',
      base => ({ ...base, manifest: { ...base.manifest, commit: 'fffffff' } }),
      /commit/u,
      false,
    ],
    ['another worker', base => ({ ...base, manifest: { ...base.manifest, worker: 'sw.evil.js' } }), /worker/u, false],
    [
      'a field the format does not have',
      base => ({ ...base, manifest: { ...base.manifest, extra: 1 } }),
      /field/u,
      false,
    ],
    [
      'a version that is not x.y.z',
      base => ({ ...base, manifest: { ...base.manifest, version: 'v1' } }),
      /version/u,
      false,
    ],
    [
      'a listed _worker.js',
      base => ({ ...base, files: { ...base.files, '_worker.js': 'export default {}' } }),
      /server code/u,
      false,
    ],
    [
      'a listed _worker.js directory',
      base => ({ ...base, files: { ...base.files, '_worker.js/index.js': 'x' } }),
      /server code/u,
      false,
    ],
    [
      'a listed _routes.json',
      base => ({ ...base, files: { ...base.files, '_routes.json': '{}' } }),
      /server code/u,
      false,
    ],
    [
      'a listed functions/ file',
      base => ({ ...base, files: { ...base.files, 'functions/api.js': 'x' } }),
      /server code/u,
      false,
    ],
    [
      'a path that climbs out',
      base => ({ ...base, files: { ...base.files, 'assets/../x.js': 'x' } }),
      /not plain/u,
      false,
    ],
    [
      'a file in dist the list does not name',
      base => ({ ...base, extra: { '_worker.js': 'export default {}' } }),
      /exactly the files/u,
      false,
    ],
    [
      'a file whose bytes are not the listed ones',
      base => ({
        ...base,
        manifest: { ...base.manifest, files: { ...hashes(base.files), 'index.html': sha256('other') } },
      }),
      /not the file the release lists/u,
      false,
    ],
    [
      'a weakened _headers',
      base => ({ ...base, config: { _headers: '/*\n  X-Frame-Options: ALLOWALL\n' } }),
      /_headers is not/u,
      false,
    ],
    [
      'a changed _redirects',
      base => ({ ...base, config: { _redirects: '/* https://evil.example 302\n' } }),
      /_redirects is not/u,
      false,
    ],
  ])('refuses to sign %s, before it reads the key', async (_name, change, message, announced) => {
    const dist = await writeScene(scene(change));

    const actual = await sign(dist, announced ? key.next : join(workDirectory, 'absent.pub'));

    expect(actual.status).toBe(1);
    expect(actual.stderr).toMatch(message);
    expect(await readFile(join(dist, 'release-manifest.sig'), 'utf8')).toBe('unsigned\n');
  });

  test('refuses a dist that holds a symlink, which the list could never name', async () => {
    const dist = await writeScene(scene());
    run(['ln', '-s', 'index.html', join(dist, '_worker.js')]);

    const actual = await sign(dist);

    expect(actual.status).toBe(1);
    expect(actual.stderr).toMatch(/neither a file nor a directory/u);
  });
});

const hashes = (files: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(files).map(([path, body]) => [path, sha256(body)]));

describe('verify-pwa-release.sh', () => {
  test.each([
    ['the unsigned marker', async (_dist: string) => undefined, /unsigned marker/u],
    [
      'a list changed after it was signed',
      async (dist: string) => {
        await sign(dist);
        await writeFile(
          join(dist, 'release-manifest.json'),
          (await readFile(join(dist, 'release-manifest.json'), 'utf8')).replace('1.2.3', '1.2.4'),
        );
      },
      /does not verify/u,
    ],
  ])('refuses %s', async (_name, prepare, message) => {
    const dist = await writeScene(scene());
    await prepare(dist);

    const actual = run([join(repositoryRoot, 'scripts/ci/verify-pwa-release.sh'), dist, key.pub]);

    expect(actual.status).toBe(1);
    expect(actual.stderr).toMatch(message);
  });
});
