/**
 * The config etag is an HMAC under a daemon-local key, not a sha256 of the text. It goes to every `fleet.use` reader
 * (`GET /v1/config/file`, the `kernel.config-changed` frame, `GET /v1/config/status`): with a plain digest a reader could
 * test a guess at a short hidden value offline; with a key only the daemon holds, it cannot.
 */
import { describe, expect, test } from 'bun:test';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { acceptedConfigFile, acceptedName, type ConfigStateChange } from '../../../contract/index.ts';
import { configEtagger, configEtagKey, ephemeralConfigEtagKey } from '../../../host/config/etag.ts';
import { createConfigFiles } from '../../../host/config/service.ts';
import { identityFromPem } from '../../../host/identity.ts';
import { createMemoryHostFs } from '../../../host/state/memory-fs.ts';
import { createStatePort } from '../../../host/state/state-port.ts';
import { captureLog, HOME, manualClock, updatesDef } from './support.ts';

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const PASSWORD_FILE = 'limit: 3\napiKey: hunter2hunter2\n';
const KEY_A = new Uint8Array(32).fill(1);
const KEY_B = new Uint8Array(32).fill(2);

const serviceOver = (fs = createMemoryHostFs(), etagKey?: Uint8Array) =>
  createConfigFiles({
    home: HOME,
    fs,
    clock: manualClock(),
    log: captureLog(),
    binary: 'fy',
    defs: [{ plugin: 'updates', def: updatesDef }],
    ...(etagKey === undefined ? {} : { etagKey }),
  });

const etagOf = async (files: ReturnType<typeof serviceOver>): Promise<string> =>
  (await files.read('updates', updatesDef))?.etag ?? 'no view';

async function keyOf(): Promise<{ pem: string }> {
  const { privateKey } = generateKeyPairSync('ed25519');
  return { pem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() };
}

describe('KEYED-ETAG the etag of a config text is a keyed digest', () => {
  test('KEYED-ETAG the etag is no sha256 of the text, so a guessed value cannot be checked against it', async () => {
    const fs = createMemoryHostFs();
    fs.seed(`${HOME}/config/updates.yaml`, PASSWORD_FILE);
    const files = serviceOver(fs, KEY_A);
    await files.reload();
    const etag = await etagOf(files);
    expect(etag).toMatch(/^[0-9a-f]{64}$/);
    expect(etag).not.toBe(sha256(PASSWORD_FILE));
    // the offline attack: with the rest of the file known, try each guess and compare it with what a reader was given
    const guesses = ['password1', 'hunter2hunter2', 'letmein123'].map(word => `limit: 3\napiKey: ${word}\n`);
    expect(guesses.map(sha256)).not.toContain(etag);
  });

  test('KEYED-ETAG one key gives the same etag for the same text, and another text another etag', () => {
    const etagger = configEtagger(KEY_A);
    expect(etagger('limit: 3\n')).toBe(etagger('limit: 3\n'));
    expect(etagger('limit: 3\n')).not.toBe(etagger('limit: 4\n'));
  });

  test('KEYED-ETAG another key gives another etag for the same text', () => {
    expect(configEtagger(KEY_A)('limit: 3\n')).not.toBe(configEtagger(KEY_B)('limit: 3\n'));
  });

  test('KEYED-ETAG a service with no key of its own still keys its etags, each service with its own', async () => {
    const fs = createMemoryHostFs();
    fs.seed(`${HOME}/config/updates.yaml`, PASSWORD_FILE);
    const first = serviceOver(fs);
    const second = serviceOver(fs);
    await first.reload();
    await second.reload();
    expect(await etagOf(first)).not.toBe(sha256(PASSWORD_FILE));
    expect(await etagOf(first)).not.toBe(await etagOf(second));
    expect(ephemeralConfigEtagKey()).toHaveLength(32);
    expect(ephemeralConfigEtagKey()).not.toEqual(ephemeralConfigEtagKey());
  });

  test('KEYED-ETAG the etag of a file is the same for the same daemon key across a restart, and another daemon gets another', async () => {
    const fs = createMemoryHostFs();
    fs.seed(`${HOME}/config/updates.yaml`, PASSWORD_FILE);
    const before = serviceOver(fs, KEY_A);
    await before.reload();
    const restarted = serviceOver(fs, KEY_A);
    await restarted.reload();
    const elsewhere = serviceOver(fs, KEY_B);
    await elsewhere.reload();
    expect(await etagOf(restarted)).toBe(await etagOf(before));
    expect(await etagOf(elsewhere)).not.toBe(await etagOf(before));
  });

  test('KEYED-ETAG the key comes from the daemon identity: the same identity, the same key; another identity, another', async () => {
    const one = await identityFromPem((await keyOf()).pem);
    const sameAgain = await identityFromPem((await keyOf()).pem);
    const key = await configEtagKey(one);
    expect(key).toHaveLength(32);
    expect(await configEtagKey(one)).toEqual(key);
    expect(await configEtagKey(sameAgain)).not.toEqual(key);
  });

  test('KEYED-ETAG the key is bound to its purpose: it is not the hash of the identity signature of anything else', async () => {
    const identity = await identityFromPem((await keyOf()).pem);
    const other = createHash('sha256')
      .update(await identity.sign(new TextEncoder().encode('something else')))
      .digest();
    expect(new Uint8Array(other)).not.toEqual(await configEtagKey(identity));
  });
});

describe('KEYED-ETAG every path that compares an etag still agrees', () => {
  test('KEYED-ETAG a write pinned to the etag a reader was given is applied, and a stale one is a conflict', async () => {
    const fs = createMemoryHostFs();
    fs.seed(`${HOME}/config/updates.yaml`, 'limit: 3\n');
    const files = serviceOver(fs, KEY_A);
    await files.reload();
    const stale = await etagOf(files);
    expect(await files.write('updates', updatesDef, undefined, 'limit: 2\n', { ifMatch: stale })).toMatchObject({
      kind: 'applied',
    });
    expect(await files.write('updates', updatesDef, undefined, 'limit: 1\n', { ifMatch: stale })).toMatchObject({
      kind: 'refused',
      reason: 'conflict',
    });
    // the etag a plain sha256 of the text would have given is no key to a write either
    expect(
      await files.write('updates', updatesDef, undefined, 'limit: 1\n', { ifMatch: sha256('limit: 2\n') }),
    ).toMatchObject({ kind: 'refused', reason: 'conflict' });
    expect(
      await files.write('updates', updatesDef, undefined, 'limit: 1\n', { ifMatch: await etagOf(files) }),
    ).toMatchObject({ kind: 'applied' });
  });

  test('KEYED-ETAG the etag a write returns is the etag a read gives afterwards', async () => {
    const files = serviceOver(createMemoryHostFs(), KEY_A);
    await files.reload();
    const written = await files.write('updates', updatesDef, undefined, 'limit: 4\n', { ifMatch: 'absent' });
    expect(written).toMatchObject({ kind: 'applied' });
    const etag = written.kind === 'applied' ? written.etag : 'not applied';
    expect(etag).toBe(await etagOf(files));
    expect(etag).toBe(configEtagger(KEY_A)('limit: 4\n'));
  });

  test('KEYED-ETAG the ConfigPort etag is the very etag a read gives, and a file that is not there stays `absent`', async () => {
    const fs = createMemoryHostFs();
    const files = serviceOver(fs, KEY_A);
    await files.reload();
    expect(await files.port('updates').etag(updatesDef)).toBe('absent');
    fs.seed(`${HOME}/config/updates.yaml`, 'limit: 3\n');
    expect(await files.port('updates').etag(updatesDef)).toBe(configEtagger(KEY_A)('limit: 3\n'));
    await files.reload();
    expect(await files.port('updates').etag(updatesDef)).toBe(await etagOf(files));
  });

  test('KEYED-ETAG the etag a change frame carries is the keyed one, never the sha256', async () => {
    const fs = createMemoryHostFs();
    const files = serviceOver(fs, KEY_A);
    await files.reload();
    const heard: ConfigStateChange[] = [];
    files.port('updates').watchState(updatesDef, change => void heard.push(change));
    fs.seed(`${HOME}/config/updates.yaml`, PASSWORD_FILE);
    await files.reload();
    expect(heard).toEqual([{ state: 'valid', etag: configEtagger(KEY_A)(PASSWORD_FILE) }]);
    expect(heard[0]?.etag).not.toBe(sha256(PASSWORD_FILE));
  });

  test('KEYED-ETAG a text the service itself writes is acknowledged by the load that finds it, not held', async () => {
    const files = serviceOver(createMemoryHostFs(), KEY_A);
    await files.reload();
    // raising the limit loosens, so a confirmed write puts it into effect only if the acknowledgement matches the load
    const written = await files.write('updates', updatesDef, undefined, 'limit: 50\n', { confirmedLoosening: true });
    expect(written).toMatchObject({ kind: 'applied' });
    expect((files.port('updates').file(updatesDef) as { limit: number }).limit).toBe(50);
    await files.reload();
    expect(files.held()).toEqual([]);
    expect((files.port('updates').file(updatesDef) as { limit: number }).limit).toBe(50);
  });

  test('KEYED-ETAG an edit made on disk is told from the version in effect by the keyed etag: a loosening is held', async () => {
    const fs = createMemoryHostFs();
    fs.seed(`${HOME}/config/updates.yaml`, 'limit: 3\n');
    const files = serviceOver(fs, KEY_A);
    await files.reload();
    fs.seed(`${HOME}/config/updates.yaml`, 'limit: 50\n');
    await files.reload();
    expect(files.held()).toHaveLength(1);
    expect((files.port('updates').file(updatesDef) as { limit: number }).limit).toBe(3);
  });

  test('KEYED-ETAG a record accepted by an older daemon (a sha256 etag) is not read as a changed file after the key arrives', async () => {
    const fs = createMemoryHostFs();
    const text = 'limit: 50\n';
    fs.seed(`${HOME}/config/updates.yaml`, text);
    const state = createStatePort({ home: HOME, pluginId: 'kernel', files: [acceptedConfigFile], fs });
    await state.write(
      acceptedConfigFile,
      { etag: sha256(text), text, plugin: 'updates' },
      acceptedName('updates.yaml'),
    );
    const files = serviceOver(fs, KEY_A);
    await files.reload();
    // 50 loosens the default 10: it is in effect only because the accepted record is the very text on disk
    expect(files.held()).toEqual([]);
    expect((files.port('updates').file(updatesDef) as { limit: number }).limit).toBe(50);
    expect(await etagOf(files)).toBe(configEtagger(KEY_A)(text));
    const stored = await state.read(acceptedConfigFile, acceptedName('updates.yaml'));
    expect(stored.ok && stored.value?.etag).toBe(configEtagger(KEY_A)(text));
  });

  test('KEYED-ETAG a file kept after it broke keeps the keyed etag of its last good text, whatever the record stored', async () => {
    const fs = createMemoryHostFs();
    const good = 'limit: 50\n';
    fs.seed(`${HOME}/config/updates.yaml`, 'limit: [broken\n');
    const state = createStatePort({ home: HOME, pluginId: 'kernel', files: [acceptedConfigFile], fs });
    await state.write(
      acceptedConfigFile,
      { etag: sha256(good), text: good, plugin: 'updates' },
      acceptedName('updates.yaml'),
    );
    const files = serviceOver(fs, KEY_A);
    await files.reload();
    expect((files.port('updates').file(updatesDef) as { limit: number }).limit).toBe(50);
    const stored = await state.read(acceptedConfigFile, acceptedName('updates.yaml'));
    expect(stored.ok && stored.value?.etag).toBe(configEtagger(KEY_A)(good));
  });
});
