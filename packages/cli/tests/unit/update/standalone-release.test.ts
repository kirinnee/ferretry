import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StandaloneRelease } from '../../../src/adapters/update/standalone-release.ts';
import { signedReleaseMessage } from '../../../src/lib/update/release-files.ts';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const b64 = (bytes: ArrayBuffer) => Buffer.from(bytes).toString('base64url');
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'fy-update-unit-'));
  dirs.push(dir);
  await writeFile(join(dir, 'fyd'), 'old daemon');
  await writeFile(join(dir, 'fy'), 'old shell');
  const archive = new TextEncoder().encode('fake archive decoded only by the fake tar');
  const sha = new Bun.CryptoHasher('sha256').update(archive).digest('hex');
  const checksums = new TextEncoder().encode(`${sha}  fy_linux_amd64.tar.gz\n`);
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const publicKey = await crypto.subtle.exportKey('spki', pair.publicKey);
  const signature = `${b64(await crypto.subtle.digest('SHA-256', publicKey))}.${b64(await crypto.subtle.sign('Ed25519', pair.privateKey, signedReleaseMessage(checksums)))}\n`;
  const files = new Map<string, Uint8Array | string>([
    ['checksums.txt', checksums],
    ['checksums.txt.sig', signature],
    ['fy_linux_amd64.tar.gz', archive],
  ]);
  const ran: string[][] = [];
  const subject = (keys = [b64(publicKey)]) =>
    new StandaloneRelease({
      product: 'ferretry',
      clientName: 'fy',
      platform: 'linux',
      arch: 'x64',
      binaries: ['fy', 'fyd'],
      keys,
      fetcher: async url => new Response(files.get(url.split('/').at(-1) ?? '') as BodyInit),
      run: async argv => {
        ran.push([...argv]);
        expect(argv.slice(0, 2)).toEqual(['tar', '-xzf']);
        const scratch = argv.at(-1) as string;
        await writeFile(join(scratch, 'fy'), 'new shell');
        await writeFile(join(scratch, 'fyd'), 'new daemon');
        return { code: 0, stdout: '', stderr: '' };
      },
    });
  return { dir, files, ran, subject };
}

test('the copied real adapter verifies, stages, swaps and rolls back in a temporary install', async () => {
  const f = await fixture();
  const adapter = f.subject();
  const staged = await adapter.stage('5.0.1', f.dir);
  expect('refused' in staged).toBe(false);
  if ('refused' in staged) throw new Error(staged.refused);
  expect(await readFile(join(f.dir, 'fyd'), 'utf8')).toBe('old daemon');
  await adapter.swap(staged);
  expect(await readFile(join(f.dir, 'fyd'), 'utf8')).toBe('new daemon');
  await adapter.rollback(f.dir);
  expect(await readFile(join(f.dir, 'fyd'), 'utf8')).toBe('old daemon');
  expect((await readdir(f.dir)).some(name => name.startsWith('.update-'))).toBe(false);
});

test('signature verification precedes checksum verification and unpacking', async () => {
  const f = await fixture();
  f.files.set('checksums.txt', 'changed checksums');
  f.files.set('fy_linux_amd64.tar.gz', 'also changed archive');
  const result = await f.subject().stage('5.0.1', f.dir);
  expect(result).toMatchObject({ refused: expect.stringContaining('signature that does not match') });
  expect(f.ran).toEqual([]);
  expect(await readFile(join(f.dir, 'fyd'), 'utf8')).toBe('old daemon');
});

test('a trusted signature still requires the archive to match the signed checksum', async () => {
  const f = await fixture();
  f.files.set('fy_linux_amd64.tar.gz', 'changed archive');
  expect(await f.subject().stage('5.0.1', f.dir)).toMatchObject({
    refused: expect.stringContaining('signed checksum'),
  });
  expect(f.ran).toEqual([]);
});

test('no trusted signing keys refuses before downloading or changing the install', async () => {
  const f = await fixture();
  expect(await f.subject([]).stage('5.0.1', f.dir)).toMatchObject({
    refused: expect.stringContaining('no release-signing key'),
  });
  expect(f.ran).toEqual([]);
  expect(await readdir(f.dir)).toEqual(['fy', 'fyd']);
});
