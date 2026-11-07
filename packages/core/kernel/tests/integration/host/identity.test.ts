import { afterEach, describe, expect, test } from 'bun:test';
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { nodeFs } from '../../../host/adapters/node-fs.ts';
import { identityFileText, IDENTITY_FILE, loadIdentity } from '../../../host/identity.ts';

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
const fs = nodeFs(() => 'r');

async function home(): Promise<string> {
  const path = await mkdtemp(`${tmpdir()}/fy-id-`);
  homes.push(path);
  await mkdir(`${path}/state/kernel`, { recursive: true });
  return path;
}

/** Today's writer (state-pairing-repository): Node PKCS#8 PEM in {"schemaVersion":1,"privateKeyPem":…}\n, 0600. */
function todaysFile(): { readonly text: string; readonly daemonId: string } {
  const { privateKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  const daemonId = `fy_daemon_${createHash('sha256').update(spki).digest('base64url')}`;
  return { text: `${JSON.stringify({ schemaVersion: 1, privateKeyPem })}\n`, daemonId };
}

describe('the identity key (D17: today’s layout, byte for byte)', () => {
  test('a key written by today’s daemon is read unchanged and keeps its daemon id', async () => {
    const at = await home();
    const today = todaysFile();
    await writeFile(`${at}/${IDENTITY_FILE}`, today.text, { mode: 0o600 });
    const outcome = await loadIdentity(fs, at);
    expect(outcome.kind === 'ready' && outcome.identity.daemonId).toBe(today.daemonId);
    expect(await readFile(`${at}/${IDENTITY_FILE}`, 'utf8')).toBe(today.text);
  });

  test('a new key is written in exactly today’s layout, 0600', async () => {
    const at = await home();
    const outcome = await loadIdentity(fs, at);
    expect(outcome.kind).toBe('ready');
    const text = await readFile(`${at}/${IDENTITY_FILE}`, 'utf8');
    const parsed = JSON.parse(text) as { schemaVersion: number; privateKeyPem: string };
    expect(Object.keys(parsed)).toEqual(['schemaVersion', 'privateKeyPem']);
    expect(text).toBe(identityFileText(parsed.privateKeyPem));
    expect(parsed.privateKeyPem.startsWith('-----BEGIN PRIVATE KEY-----\n')).toBe(true);
    expect((await stat(`${at}/${IDENTITY_FILE}`)).mode & 0o777).toBe(0o600);
  });

  test('the identity signs, and its signature verifies under the published key', async () => {
    const outcome = await loadIdentity(fs, await home());
    if (outcome.kind !== 'ready') throw new Error('no identity');
    const message = new TextEncoder().encode('transcript');
    const signature = await outcome.identity.sign(message);
    const key = await crypto.subtle.importKey('spki', new Uint8Array(outcome.identity.publicKeySpki), { name: 'Ed25519' }, false, ['verify']);
    expect(await crypto.subtle.verify({ name: 'Ed25519' }, key, new Uint8Array(signature), message)).toBe(true);
  });

  test('a file in another format is damaged, never replaced', async () => {
    const at = await home();
    await writeFile(`${at}/${IDENTITY_FILE}`, '{"schemaVersion":2,"privateKeyPem":"x"}\n');
    expect((await loadIdentity(fs, at)).kind).toBe('damaged');
    expect(await readFile(`${at}/${IDENTITY_FILE}`, 'utf8')).toBe('{"schemaVersion":2,"privateKeyPem":"x"}\n');
  });
});
