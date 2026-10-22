import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { BunDaemonProcess } from '../../../src/adapters/daemon/process';
import type { ReleaseFetch } from '../../../src/adapters/update/latest-release';
import { StandaloneRelease } from '../../../src/adapters/update/standalone-release';
import type { StagedRelease } from '../../../src/lib/update/ports';
import { signedReleaseMessage } from '../../../src/lib/update/release-files';

const BASE = 'https://github.com/kirinnee/ferretry/releases/download/v1.3.0';
const ARCHIVE = 'fy_linux_amd64.tar.gz';
const processes = new BunDaemonProcess();
const b64url = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes as ArrayBuffer).toString('base64url');

let scratch: string;
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** A real signed release: a tar.gz of fake binaries, its checksums, and an Ed25519 signature. */
async function release(options: { binaries?: string[] } = {}) {
  scratch = await mkdtemp(join(tmpdir(), 'fy-standalone-'));
  const build = join(scratch, 'build');
  await mkdir(build);
  const binaries = options.binaries ?? ['fy', 'fyd', 'fyd-browser-worker'];
  for (const name of binaries) await writeFile(join(build, name), `new ${name}\n`);
  await processes.run(['tar', '-czf', join(scratch, ARCHIVE), '-C', build, ...binaries]);
  const archive = new Uint8Array(await readFile(join(scratch, ARCHIVE)));
  const sha = new Bun.CryptoHasher('sha256').update(archive).digest('hex');
  const checksums = new TextEncoder().encode(`${'0'.repeat(64)}  other.tar.gz\n${sha}  ${ARCHIVE}\n`);
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as unknown as CryptoKeyPair;
  const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
  const fingerprint = b64url(await crypto.subtle.digest('SHA-256', spki));
  const signature = b64url(
    await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, signedReleaseMessage(checksums)),
  );
  const install = join(scratch, 'bin');
  await mkdir(install);
  for (const name of ['fy', 'fyd', 'fyd-browser-worker']) await writeFile(join(install, name), `old ${name}\n`);
  const files: Record<string, Uint8Array | string> = {
    [`${BASE}/checksums.txt`]: checksums,
    [`${BASE}/checksums.txt.sig`]: `${fingerprint}.${signature}\n`,
    [`${BASE}/${ARCHIVE}`]: archive,
  };
  const fetcher: ReleaseFetch = input => {
    const body = files[input];
    return Promise.resolve(body === undefined ? new Response('', { status: 404 }) : new Response(body));
  };
  const subject = (overrides: Partial<ConstructorParameters<typeof StandaloneRelease>[0]> = {}) =>
    new StandaloneRelease({
      product: 'ferretry',
      clientName: 'fy',
      platform: 'linux',
      arch: 'x64',
      binaries: ['fy', 'fyd', 'fyd-browser-worker'],
      keys: [b64url(spki)],
      fetcher,
      run: argv => processes.run(argv),
      ...overrides,
    });
  return { install, files, subject, fingerprint, signature, spki };
}

const text = (path: string) => readFile(path, 'utf8');

describe('StandaloneRelease', () => {
  it('verifies, stages, swaps and rolls back a real signed release', async () => {
    const r = await release();
    const staged = (await r.subject().stage('1.3.0', r.install)) as StagedRelease;
    should(staged).deepEqual({ directory: r.install, names: ['fy', 'fyd', 'fyd-browser-worker'] });
    should(await text(join(r.install, 'fyd'))).equal('old fyd\n');
    should(await text(join(r.install, 'fyd.new'))).equal('new fyd\n');
    should((await readdir(r.install)).some(name => name.startsWith('.update-'))).be.false();

    await r.subject().swap(staged);
    should(await text(join(r.install, 'fyd'))).equal('new fyd\n');
    should(await text(join(r.install, 'fyd.previous'))).equal('old fyd\n');

    await r.subject().rollback(r.install);
    should(await text(join(r.install, 'fyd'))).equal('old fyd\n');
    should(await text(join(r.install, 'fy'))).equal('old fy\n');
  });

  it('places a binary the install did not have, and rolls back only what it replaced', async () => {
    const r = await release();
    await rm(join(r.install, 'fyd-browser-worker'));
    const staged = (await r.subject().stage('1.3.0', r.install)) as StagedRelease;
    await r.subject().swap(staged);
    should(await text(join(r.install, 'fyd-browser-worker'))).equal('new fyd-browser-worker\n');
    await r.subject().rollback(r.install);
    should(await text(join(r.install, 'fyd-browser-worker'))).equal('new fyd-browser-worker\n');
  });

  it('refuses without a trusted key, before downloading anything', async () => {
    const r = await release();
    const refusal = await r
      .subject({ keys: [], fetcher: () => Promise.reject(new Error('must not fetch')) })
      .stage('1.3.0', r.install);
    should(refusal)
      .have.property('refused')
      .match(/carries no release-signing key.*install\.sh \| bash$/u);
  });

  it('refuses a platform no archive is published for', async () => {
    const r = await release();
    should(await r.subject({ platform: 'win32' }).stage('1.3.0', r.install)).deepEqual({
      refused: 'no release archive is published for win32/x64',
    });
  });

  it('refuses a missing or unreachable file', async () => {
    const r = await release();
    should(await r.subject().stage('9.9.9', r.install))
      .have.property('refused')
      .match(/answered 404; nothing changed$/u);
    const unreachable = await r
      .subject({ fetcher: () => Promise.reject(new Error('offline')) })
      .stage('1.3.0', r.install);
    should(unreachable)
      .have.property('refused')
      .match(/^could not download .*checksums\.txt; nothing changed$/u);
  });

  it('refuses an unsigned, foreign-signed or tampered release', async () => {
    const r = await release();
    r.files[`${BASE}/checksums.txt.sig`] = 'unsigned';
    should(await r.subject().stage('1.3.0', r.install))
      .have.property('refused')
      .match(/carries no readable signature/u);
    r.files[`${BASE}/checksums.txt.sig`] = `AAAA.${r.signature}`;
    should(await r.subject().stage('1.3.0', r.install))
      .have.property('refused')
      .match(/signed by a key this fy does not trust/u);
    r.files[`${BASE}/checksums.txt.sig`] = `${r.fingerprint}.${r.signature}`;
    r.files[`${BASE}/checksums.txt`] = 'tampered';
    should(await r.subject().stage('1.3.0', r.install))
      .have.property('refused')
      .match(/signature that does not match/u);
  });

  it('refuses an archive that does not match its signed checksum', async () => {
    const r = await release();
    r.files[`${BASE}/${ARCHIVE}`] = 'not the archive';
    should(await r.subject().stage('1.3.0', r.install)).deepEqual({
      refused: `${ARCHIVE} does not match its signed checksum; nothing changed`,
    });
  });

  it('refuses an archive that will not unpack, or carries none of the binaries', async () => {
    const r = await release();
    const broken = await r
      .subject({ run: () => Promise.resolve({ code: 2, stdout: '', stderr: 'tar: bad\n' }) })
      .stage('1.3.0', r.install);
    should(broken).deepEqual({ refused: 'could not unpack the release: tar: bad' });
    should(await r.subject({ binaries: ['other'] }).stage('1.3.0', r.install)).deepEqual({
      refused: 'the release archive carries none of the expected binaries',
    });
  });

  it('defaults to the real fetch and download bound, never dialled without a key', async () => {
    const r = await release();
    const subject = new StandaloneRelease({
      product: 'ferretry',
      clientName: 'fy',
      platform: 'linux',
      arch: 'x64',
      binaries: [],
      keys: [],
      run: () => Promise.resolve({ code: 0, stdout: '', stderr: '' }),
    });
    should(await subject.stage('1.3.0', r.install)).have.property('refused');
  });
});

describe('StandaloneRelease — watched', () => {
  it('reports the download in bytes, then verifying and unpacking, in that order', async () => {
    const r = await release();
    const sized: ReleaseFetch = async input => {
      const body = r.files[input];
      if (body === undefined) return new Response('', { status: 404 });
      return new Response(body, {
        headers: { 'content-length': String(typeof body === 'string' ? body.length : body.byteLength) },
      });
    };
    const seen: string[] = [];
    const staged = await r.subject({ fetcher: sized }).stage('1.3.0', r.install, activity => {
      seen.push(
        activity.bytes === undefined
          ? activity.phase
          : `${activity.phase}:${String(activity.bytes.done)}/${String(activity.bytes.expected)}`,
      );
    });
    should('refused' in staged).be.false();
    should(seen[0]).equal('downloading');
    const downloading = seen.filter(line => line.startsWith('downloading:'));
    should(downloading.length).be.aboveOrEqual(3);
    const last = downloading.at(-1)?.split(':')[1]?.split('/') ?? [];
    should(last[0]).equal(last[1]);
    should(seen.slice(-2)).deepEqual(['verifying', 'unpacking']);
  });

  it('still downloads when the server does not say how big the files are', async () => {
    const r = await release();
    const seen: string[] = [];
    const staged = await r.subject().stage('1.3.0', r.install, activity => seen.push(activity.phase));
    should('refused' in staged).be.false();
    should(seen).deepEqual(['downloading', 'verifying', 'unpacking']);
  });

  it('stops at the download when a file is refused', async () => {
    const r = await release();
    const seen: string[] = [];
    const staged = await r.subject().stage('9.9.9', r.install, activity => seen.push(activity.phase));
    should(staged).have.property('refused');
    should(seen).deepEqual(['downloading']);
  });
});
