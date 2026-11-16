/**
 * Catalogs' stored documents over the kernel's REAL state port on a real disk (`<home>/state/catalogs/`): the typed
 * document stores and what each says when its file is damaged, the content-addressed blob store, the link-key vault's
 * sentence when a key will not open, the passkeys paired devices registered and each device's last unlock. A copy of
 * a file is read back by another adapter on the same folder, and a damaged file is reported, never read as empty.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { StateFileDef, StatePort } from '@ferretry/kernel/contract';
import { defineState } from '@ferretry/kernel/contract';
import { state } from '@ferretry/kernel/host';
import { z } from 'zod';
import manifest from '../../../manifest.ts';
import { StatePasskeyStore } from '../../../daemon/adapters/member-passkey-store.ts';
import { StateUnlockLedger } from '../../../daemon/adapters/member-unlocks.ts';
import {
  blobStore,
  catalogsDamage,
  documentStore,
  installsDamage,
  linkKeyVault,
  linksDamage,
  membersDamage,
  type DocumentDamage,
} from '../../../daemon/adapters/state.ts';

let parent = '';
let port: StatePort;
const file = (name: string): StateFileDef => {
  const declared = manifest.data.state.find(candidate => candidate.name === name);
  if (declared === undefined) throw new Error(`Catalogs did not declare ${name}`);
  return declared;
};

beforeEach(async () => {
  parent = await realpath(await mkdtemp(`${tmpdir()}/fy-catalogs-state-`));
  await mkdir(`${parent}/state/catalogs`, { recursive: true, mode: 0o700 });
  port = state.createStatePort({
    home: parent,
    pluginId: 'catalogs',
    files: manifest.data.state,
    fs: state.createNodeHostFs(),
  });
});
afterEach(async () => {
  await rm(parent, { recursive: true, force: true });
});

const onDisk = (relative: string): string => `${parent}/state/catalogs/${relative}`;

const Notes = z.strictObject({ notes: z.array(z.string()) });
type Notes = z.infer<typeof Notes>;
const EMPTY: Notes = { notes: [] };

describe('documentStore', () => {
  it('reads the empty document before anything is written, and what was written afterwards, across stores', async () => {
    const store = documentStore(port, file('links'), Notes, EMPTY, linksDamage);

    expect(await store.read()).toEqual(EMPTY);
    await store.write({ notes: ['one'] });

    expect(await store.read()).toEqual({ notes: ['one'] });
    expect(await documentStore(port, file('links'), Notes, EMPTY, linksDamage).read()).toEqual({ notes: ['one'] });
  });

  const DAMAGES: readonly (readonly [string, DocumentDamage, RegExp, RegExp, RegExp])[] = [
    [
      'links',
      linksDamage,
      /links\.json cannot be read: it is not JSON/u,
      /links\.json cannot be read: /u,
      /links\.json was not written: /u,
    ],
    [
      'members',
      membersDamage,
      /links\.json cannot be read: it is not JSON.*nobody shared with/u,
      /links\.json cannot be read: .*nobody shared with/u,
      /links\.json was not written: /u,
    ],
    [
      'catalogs',
      catalogsDamage,
      /links\.json cannot be read: it is not JSON.*no catalogs/u,
      /links\.json cannot be read: .*no catalogs/u,
      /links\.json was not written: /u,
    ],
    [
      'installs',
      installsDamage('install', 'installs'),
      /links\.json is not JSON, so no install was changed/u,
      /links\.json is not a record of installs this daemon writes/u,
      /links\.json is not a record of installs this daemon writes/u,
    ],
    [
      'preferences',
      installsDamage('preference', 'preferences'),
      /links\.json is not JSON, so no preference was changed/u,
      /links\.json is not a record of preferences this daemon writes/u,
      /links\.json is not a record of preferences this daemon writes/u,
    ],
  ];

  it.each(DAMAGES)(
    'speaks %s’s own sentence for a file that is not JSON, not its document, or not writable',
    async (_name, damage, unreadable, invalid, unwritable) => {
      const store = documentStore(port, file('links'), Notes, EMPTY, damage);

      await writeFile(onDisk('links.json'), '{ not json');
      await expect(store.read()).rejects.toThrow(unreadable);

      await writeFile(onDisk('links.json'), JSON.stringify({ format: 1, wrong: true }));
      await expect(store.read()).rejects.toThrow(invalid);

      await rm(onDisk('links.json'));
      await expect(store.write({ notes: 'not an array' } as never)).rejects.toThrow(unwritable);
      await expect(readFile(onDisk('links.json'), 'utf8')).rejects.toThrow();
    },
  );
});

describe('blobStore', () => {
  const digest = (character: string): string => `sha256:${character.repeat(64)}`;

  it('keeps a frozen item by its digest and reads it back, and reads an unknown digest as nothing', async () => {
    const blobs = blobStore(port, file('blobs'));

    expect(await blobs.get(digest('a'))).toBeUndefined();
    await blobs.put(digest('a'), 'name: a skill\n');

    expect(await blobs.get(digest('a'))).toBe('name: a skill\n');
    expect(await readFile(onDisk(`blobs/${'a'.repeat(64)}`), 'utf8')).toBe('name: a skill\n');
  });

  it('refuses a digest that is not a sha256, on every read and write', async () => {
    const blobs = blobStore(port, file('blobs'));

    await expect(blobs.get('sha256:short')).rejects.toThrow('not a sha256');
    await expect(blobs.put('md5:abc', 'x')).rejects.toThrow('not a sha256');
  });

  it('refuses a frozen item whose bytes are not text', async () => {
    const blobs = blobStore(port, file('blobs'));
    await mkdir(onDisk('blobs'), { recursive: true });
    await writeFile(onDisk(`blobs/${'b'.repeat(64)}`), new Uint8Array([0xff, 0xfe, 0xfd]));

    await expect(blobs.get(digest('b'))).rejects.toThrow();
  });

  // As declared, a blob that cannot be read is a narrower reading: "that version is refused; the catalog lists it as
  // missing". Over a file that declares no such policy, the same adapter refuses with its own sentence.
  it.skipIf(process.getuid?.() === 0)(
    'reads an unreadable blob as missing as declared, and refuses it where nothing is declared',
    async () => {
      const strict = defineState({ name: 'strict-blobs', path: 'strict-blobs/*', store: 'opaque', format: 1 });
      const strictPort = state.createStatePort({
        home: parent,
        pluginId: 'catalogs',
        files: [...manifest.data.state, strict],
        fs: state.createNodeHostFs(),
      });
      for (const folder of ['blobs', 'strict-blobs']) {
        await mkdir(onDisk(folder), { recursive: true });
        await writeFile(onDisk(`${folder}/${'c'.repeat(64)}`), 'secret');
        await chmod(onDisk(`${folder}/${'c'.repeat(64)}`), 0o000);
      }

      expect(await blobStore(port, file('blobs')).get(digest('c'))).toBeUndefined();
      await expect(blobStore(strictPort, strict).get(digest('c'))).rejects.toThrow(
        'a frozen catalog item cannot be read. Nothing was changed.',
      );
    },
  );
});

describe('linkKeyVault', () => {
  const sealedHandle = (fails: boolean) => {
    const held = new Map<string, string>();
    const fail = async (): Promise<never> => {
      throw new Error('the vault key did not open it');
    };
    return {
      put: fails ? fail : async (name: string, value: string) => void held.set(name, value),
      get: fails ? fail : async (name: string) => held.get(name),
      delete: fails ? fail : async (name: string) => void held.delete(name),
    };
  };

  it('puts, opens and forgets a link’s key through the sealed document', async () => {
    const vault = linkKeyVault(sealedHandle(false) as never);

    await vault.put('link-1', 'key-material');
    expect(await vault.open('link-1')).toBe('key-material');
    await vault.forget('link-1');
    expect(await vault.open('link-1')).toBeUndefined();
  });

  it('says the stored key did not authenticate, naming the link and never the key, when the vault refuses', async () => {
    const vault = linkKeyVault(sealedHandle(true) as never);

    for (const act of [
      () => vault.put('link-1', 'key-material'),
      () => vault.open('link-1'),
      () => vault.forget('link-1'),
    ]) {
      const caught = await act().then(
        () => undefined,
        (error: unknown) => error as Error,
      );
      expect(caught?.message).toBe('The stored key of link link-1 did not authenticate under this vault key.');
      expect(caught?.message).not.toContain('key-material');
    }
  });
});

const PASSKEY = {
  credentialId: 'Y3JlZGVudGlhbC1vbmU',
  deviceId: 'mk_AAAAAAAAAAAAAAAAAAAAAA',
  algorithm: -7 as const,
  publicKeySpki: 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE',
  signCount: 0,
  origin: 'https://app.example.test',
  createdAt: '2026-11-09T10:00:00.000Z',
};

describe('StatePasskeyStore', () => {
  const store = () => new StatePasskeyStore(port, file('member-passkeys'));

  it('holds no passkey and no snapshot before anything is registered', async () => {
    const passkeys = store();

    expect(passkeys.snapshot(PASSKEY.deviceId)).toBeUndefined();
    expect(await passkeys.any()).toBe(false);
    expect(await passkeys.list(PASSKEY.deviceId)).toEqual([]);
    expect(passkeys.snapshot(PASSKEY.deviceId)).toEqual([]);
    expect(await passkeys.holder(PASSKEY.credentialId)).toBeUndefined();
  });

  it('registers a passkey, names its holder, and lists each device’s own, read back by another store', async () => {
    const passkeys = store();
    const other = { ...PASSKEY, credentialId: 'b3RoZXI', deviceId: 'mk_BBBBBBBBBBBBBBBBBBBBBB' };

    await passkeys.add(PASSKEY);
    await passkeys.add(other);

    expect(await passkeys.any()).toBe(true);
    expect(await passkeys.holder(PASSKEY.credentialId)).toBe(PASSKEY.deviceId);
    expect((await store().list(other.deviceId)).map(entry => entry.credentialId)).toEqual(['b3RoZXI']);
    expect(passkeys.snapshot(PASSKEY.deviceId)?.map(entry => entry.credentialId)).toEqual([PASSKEY.credentialId]);
  });

  it('refuses a credential another device holds, and one it already holds: a passkey is never re-pointed or replaced', async () => {
    const passkeys = store();
    await passkeys.add(PASSKEY);

    await expect(passkeys.add({ ...PASSKEY, deviceId: 'mk_BBBBBBBBBBBBBBBBBBBBBB' })).rejects.toThrow(
      'that credential already belongs to another device',
    );
    await expect(passkeys.add({ ...PASSKEY, publicKeySpki: 'ZGlmZmVyZW50' })).rejects.toThrow(
      'that credential is already stored, and is never replaced',
    );
    expect(await passkeys.list(PASSKEY.deviceId)).toHaveLength(1);
  });

  it('moves a counter forward only, and lets a first use at zero stand', async () => {
    const passkeys = store();
    await passkeys.add(PASSKEY);

    expect(await passkeys.updateSignCount(PASSKEY.deviceId, PASSKEY.credentialId, 5)).toBe(true);
    expect(await passkeys.updateSignCount(PASSKEY.deviceId, PASSKEY.credentialId, 5)).toBe(false);
    expect(await passkeys.updateSignCount(PASSKEY.deviceId, PASSKEY.credentialId, 3)).toBe(false);
    expect(await passkeys.updateSignCount(PASSKEY.deviceId, 'bm90LWhlcmU', 9)).toBe(false);
    expect((await passkeys.list(PASSKEY.deviceId))[0]?.signCount).toBe(5);
  });

  it('accepts a counter that stays at zero for an authenticator that never counts', async () => {
    const passkeys = store();
    await passkeys.add(PASSKEY);

    expect(await passkeys.updateSignCount(PASSKEY.deviceId, PASSKEY.credentialId, 0)).toBe(true);
  });

  it('forgets a device’s passkeys and leaves the others’', async () => {
    const passkeys = store();
    await passkeys.add(PASSKEY);
    await passkeys.add({ ...PASSKEY, credentialId: 'b3RoZXI', deviceId: 'mk_BBBBBBBBBBBBBBBBBBBBBB' });

    await passkeys.forgetDevice(PASSKEY.deviceId);

    expect(await passkeys.holder(PASSKEY.credentialId)).toBeUndefined();
    expect(await passkeys.any()).toBe(true);
  });

  it('serializes writes so two registrations racing each keep their row', async () => {
    const passkeys = store();

    await Promise.all(['YQ', 'Yg', 'Yw', 'ZA'].map(id => passkeys.add({ ...PASSKEY, credentialId: id })));

    expect(await passkeys.list(PASSKEY.deviceId)).toHaveLength(4);
  });

  it('reports a damaged document as damage, never as no passkeys', async () => {
    await writeFile(onDisk('member-passkeys.json'), '{ not json');
    await expect(store().any()).rejects.toThrow('the passkey document cannot be read');

    await rm(onDisk('member-passkeys.json'));
    await port.write(file('member-passkeys'), { schemaVersion: 1, passkeys: [{ credentialId: 1 }] });
    await expect(store().any()).rejects.toThrow('the passkey document does not describe passkeys');

    await port.write(file('member-passkeys'), { schemaVersion: 1, passkeys: [PASSKEY, PASSKEY] });
    await expect(store().any()).rejects.toThrow('the passkey document holds one credential twice');
  });
});

describe('StateUnlockLedger', () => {
  const DAEMON = 'daemon-one';
  const ledger = (daemon = DAEMON) => new StateUnlockLedger(port, file('member-unlocks'), () => daemon);
  const AT = Date.parse('2026-11-09T10:00:00.000Z');

  it('reads no unlocks before one is written, and each device’s last unlock after', async () => {
    expect(await ledger().read()).toEqual(new Map());

    await ledger().write(new Map([['mk_AAAAAAAAAAAAAAAAAAAAAA', AT]]));

    expect(await ledger().read()).toEqual(new Map([['mk_AAAAAAAAAAAAAAAAAAAAAA', AT]]));
    expect(JSON.parse(await readFile(onDisk('member-unlocks.json'), 'utf8'))).toMatchObject({
      daemonId: DAEMON,
      unlocks: [{ deviceId: 'mk_AAAAAAAAAAAAAAAAAAAAAA', unlockedAt: '2026-11-09T10:00:00.000Z' }],
    });
  });

  it('reads as holding nothing a ledger another daemon wrote, such as a state home copied to another machine', async () => {
    await ledger('daemon-one').write(new Map([['mk_AAAAAAAAAAAAAAAAAAAAAA', AT]]));

    expect(await ledger('daemon-two').read()).toEqual(new Map());
  });

  it('reports a damaged ledger, and refuses to write a device id that is not one', async () => {
    await writeFile(onDisk('member-unlocks.json'), '{ not json');
    await expect(ledger().read()).rejects.toThrow('the unlock ledger cannot be read');

    await rm(onDisk('member-unlocks.json'));
    await port.write(file('member-unlocks'), { schemaVersion: 1, wrong: true });
    await expect(ledger().read()).rejects.toThrow('the unlock ledger does not describe unlocks');

    await expect(ledger().write(new Map([['not-a-device', AT]]))).rejects.toThrow();
  });
});
