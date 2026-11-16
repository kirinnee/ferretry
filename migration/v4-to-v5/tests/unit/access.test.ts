import { afterEach, beforeEach, expect, test } from 'bun:test';
import { CAPABILITY_NAMES } from '@ferretry/core-gate/contract';
import {
  DevicesFileSchema,
  GrantAuditLineSchema,
  PasskeysFileSchema,
  PushFileSchema,
  PushKeysFileSchema,
} from '@ferretry/plugin-access/contract';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  accessStep,
  V5_DEVICES_FILE,
  V5_GRANT_AUDIT_FILE,
  V5_PASSKEYS_FILE,
  V5_PUSH_FILE,
  V5_PUSH_KEYS_FILE,
} from '../../src/steps/access.ts';
import { v4Paths } from '../../src/v4/layout.ts';
import { v5Writer } from '../../src/v5/write.ts';

// FAKE values in the v4 shapes. A public key is not a secret, but the report must still hold counts only.
const DEVICE_ID = 'fy_device_id_AAAAAAAAAAAAAAAAAAAAAA';
const OTHER_DEVICE = 'fy_device_id_BBBBBBBBBBBBBBBBBBBBBB';
const PUBLIC_KEY = 'MCowBQYDK2VwAyEAZmFrZS1wdWJsaWMta2V5LWZha2UtcHVibGljLWtleQ';
const DAEMON_ID = `fy_daemon_${'A'.repeat(43)}`;
const CREDENTIAL = 'RkFLRS1jcmVkZW50aWFsLWlk';
const PASSKEY_SPKI = 'RkFLRS1wYXNza2V5LXB1YmxpYy1rZXktc3BraQ';
const ORIGIN = 'https://app.example.test';
// A FAKE VAPID key: the right shape for v5's schema, not a P-256 key. Members in v4's written order, not sorted.
const JWK = {
  kty: 'EC',
  crv: 'P-256',
  d: 'FAKEdFAKEdFAKEdFAKEdFAKEdFAKEdFAKEdFAKEdFAK',
  x: 'FAKExFAKExFAKExFAKExFAKExFAKExFAKExFAKExFAK',
  y: 'FAKEyFAKEyFAKEyFAKEyFAKEyFAKEyFAKEyFAKEyFAK',
} as const;
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/FAKE-endpoint-token';
const P256DH = `B${'F'.repeat(86)}`;
const AUTH = 'FAKEauthFAKEauthFAKEau';

let root: string;
let v4: string;
let v5: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fy-v4-access-'));
  v4 = join(root, 'v4');
  v5 = join(root, 'v5');
  await mkdir(join(v4, 'state'), { recursive: true });
  await mkdir(v5, { mode: 0o700 });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ctx = (dryRun = false) => ({ v4: v4Paths(v4), v5: v5Writer(v5, { dryRun }), dryRun });
const put = (name: string, text: string) => writeFile(join(v4, 'state', name), text, { mode: 0o600 });
const read = async (path: string) => JSON.parse(await readFile(join(v5, path), 'utf8')) as unknown;
const jsonl = (...lines: unknown[]) => `${lines.map(line => JSON.stringify(line)).join('\n')}\n`;
const at = (minute: number) => `2026-11-01T00:${String(minute).padStart(2, '0')}:00.000Z`;

function v4Devices(grants: Record<string, { use: boolean; configure: boolean }>): string {
  return JSON.stringify({
    schemaVersion: 2,
    daemonId: DAEMON_ID,
    devices: [
      {
        id: DEVICE_ID,
        daemonId: DAEMON_ID,
        name: 'Phone',
        platform: 'browser',
        createdAt: '2026-11-01T00:00:00.000Z',
        lastSeenAt: '2026-11-06T00:00:00.000Z',
        pairedOver: 'relay',
        publicKey: PUBLIC_KEY,
        grants,
        keyRotatedAt: '2026-11-03T00:00:00.000Z',
      },
    ],
  });
}

const passkey = (deviceId: string, credentialId = CREDENTIAL) => ({
  credentialId,
  deviceId,
  algorithm: -7,
  publicKeySpki: PASSKEY_SPKI,
  signCount: 41,
  origin: ORIGIN,
  createdAt: '2026-11-02T00:00:00.000Z',
});

const pushRow = (deviceId: string, id = 'push-00000000-0000-4000-8000-000000000001') => ({
  id,
  deviceId,
  deviceName: 'Phone',
  subscription: { endpoint: ENDPOINT, expirationTime: null, keys: { p256dh: P256DH, auth: AUTH } },
  createdAt: '2026-11-02T00:00:00.000Z',
  updatedAt: '2026-11-02T00:00:00.000Z',
});
const v4Vapid = (envelope: Record<string, unknown> = { schemaVersion: 1 }) =>
  `${JSON.stringify({ ...envelope, privateKeyJwk: JWK })}\n`;
/** No member of the key and no part of a subscription may reach the report. */
const holdsNoPushSecret = (report: unknown) => {
  const text = JSON.stringify(report);
  for (const value of [JWK.d, JWK.x, JWK.y, ENDPOINT, P256DH, AUTH]) expect(text).not.toContain(value);
  expect(text).not.toContain('FAKE');
};

test('a paired device keeps every field, its public key and its grants, so it stays paired', async () => {
  await put('devices.json', v4Devices({ fleet: { use: true, configure: false } }));
  const report = await accessStep.run(ctx());

  expect(report.kept).toEqual([{ what: 'paired devices', count: 1 }]);
  const file = DevicesFileSchema.parse(await read(V5_DEVICES_FILE));
  expect(file.daemonId).toBe(DAEMON_ID);
  expect(file.devices as unknown).toEqual([
    {
      id: DEVICE_ID,
      daemonId: DAEMON_ID,
      name: 'Phone',
      platform: 'browser',
      createdAt: '2026-11-01T00:00:00.000Z',
      lastSeenAt: '2026-11-06T00:00:00.000Z',
      pairedOver: 'relay',
      publicKey: PUBLIC_KEY,
      grants: Object.fromEntries(CAPABILITY_NAMES.map(name => [name, { use: name === 'fleet', configure: false }])),
      keyRotatedAt: '2026-11-03T00:00:00.000Z',
    },
  ]);
  expect(Object.keys((await read(V5_DEVICES_FILE)) as object)[0]).toBe('format');
  expect((await stat(join(v5, V5_DEVICES_FILE))).mode & 0o777).toBe(0o600);
  expect(JSON.stringify(report)).not.toContain(PUBLIC_KEY);
  expect(report.status).toBe('converted');
});

test('grants are never wider than v4: a missing capability is off, configure needs use, a dropped one is reported', async () => {
  await put(
    'devices.json',
    v4Devices({
      fleet: { use: true, configure: true },
      terminal: { use: false, configure: true },
      retired: { use: true, configure: true },
    }),
  );
  const report = await accessStep.run(ctx());
  const grants = DevicesFileSchema.parse(await read(V5_DEVICES_FILE)).devices[0]?.grants;
  expect(grants?.fleet).toEqual({ use: true, configure: true });
  expect(grants?.terminal).toEqual({ use: false, configure: false });
  for (const name of CAPABILITY_NAMES.filter(name => name !== 'fleet'))
    expect(grants?.[name]).toEqual({ use: false, configure: false });
  expect(report.notCarried.some(item => item.what.includes('retired'))).toBe(true);
});

test('an old bearer document is not converted, and its passkeys go with it', async () => {
  await put('devices.json', JSON.stringify({ schemaVersion: 1, devices: [] }));
  await put('passkeys.json', JSON.stringify({ schemaVersion: 1, passkeys: [passkey(DEVICE_ID)] }));
  const report = await accessStep.run(ctx());
  expect(report.kept).toEqual([{ what: 'passkeys', count: 0 }]);
  expect(await stat(join(v5, V5_DEVICES_FILE)).catch(() => undefined)).toBeUndefined();
  expect(report.notCarried.some(item => item.what === 'bearer-era devices')).toBe(true);
  expect(report.notCarried.some(item => item.what.startsWith('1 passkey(s)'))).toBe(true);
});

test('a home with no access files reports none and does not fail', async () => {
  const report = await accessStep.run(ctx());
  expect(report.status).toBe('converted');
  expect(report.kept).toEqual([]);
  expect(await readdir(v5)).toEqual([]);
});

test('passkeys keep credential id, public key and sign counter per device; a passkey of an unknown device is dropped', async () => {
  await put('devices.json', v4Devices({ fleet: { use: true, configure: false } }));
  await put(
    'passkeys.json',
    JSON.stringify({ schemaVersion: 1, passkeys: [passkey(DEVICE_ID), passkey(OTHER_DEVICE, 'RkFLRS1vdGhlcg')] }),
  );
  const report = await accessStep.run(ctx());

  expect(report.kept).toContainEqual({ what: 'passkeys', count: 1 });
  const file = PasskeysFileSchema.parse(await read(V5_PASSKEYS_FILE));
  expect(file.passkeys as unknown).toEqual([passkey(DEVICE_ID)]);
  expect((await stat(join(v5, V5_PASSKEYS_FILE))).mode & 0o777).toBe(0o600);
  expect(report.notCarried.some(item => item.what.startsWith('1 passkey(s) of a device'))).toBe(true);
  const text = JSON.stringify(report);
  for (const value of [CREDENTIAL, PASSKEY_SPKI, OTHER_DEVICE]) expect(text).not.toContain(value);
});

test('a passkey v5 refuses fails the step by file and key path, never by value', async () => {
  await put('devices.json', v4Devices({ fleet: { use: true, configure: false } }));
  await put(
    'passkeys.json',
    JSON.stringify({ schemaVersion: 1, passkeys: [{ ...passkey(DEVICE_ID), origin: 'FAKE-not-an-origin' }] }),
  );
  const report = await accessStep.run(ctx());
  expect(report.status).toBe('failed');
  expect(report.note).toBe('state/passkeys.json: a passkey does not fit v5 at: passkeys.0.origin');
  expect(JSON.stringify(report)).not.toContain('FAKE');
  expect(await stat(join(v5, V5_PASSKEYS_FILE)).catch(() => undefined)).toBeUndefined();
});

test('live unlocks are not carried: no unlocks.json is written', async () => {
  await put('unlocks.json', JSON.stringify({ schemaVersion: 1, daemonId: DAEMON_ID, unlocks: [] }));
  const report = await accessStep.run(ctx());
  expect(await readdir(v5)).toEqual([]);
  expect(report.notCarried.some(item => item.what.startsWith('live unlocks'))).toBe(true);
});

test('both v4 journals become one grant-audit.jsonl, oldest first, every line a v5 line', async () => {
  await put(
    'grant-audit.jsonl',
    `${jsonl(
      { kind: 'grant.changed', at: at(3), actor: `device:${DEVICE_ID}`, changes: ['fleet.use=on', 'terminal.use=off'] },
      { kind: 'grant.changed', at: at(1), actor: 'peer:mw5pf53b-4c9a262b', changes: ['fleet.configure=on'] },
      { kind: 'grant.changed', at: 'FAKE-not-an-instant', actor: 'admin-ui', changes: [] },
    )}{"kind":"FAKE-TORN`,
  );
  await put(
    'security-audit.jsonl',
    jsonl(
      { kind: 'security.changed', at: at(2), actor: 'admin-cli', changes: ['unlockValidityHours=8'] },
      { kind: 'device.key-rotated', at: at(4), actor: `device:${DEVICE_ID}`, changes: [] },
    ),
  );
  const report = await accessStep.run(ctx());

  expect(report.kept).toContainEqual({
    what: 'grant and security journal lines (the grant audit history is left behind by owner ruling, see not carried)',
    count: 4,
  });
  expect(report.note).toContain('1 unreadable journal line(s) skipped');
  expect(report.note).toContain('1 journal line(s) v5 refuses skipped');
  expect(JSON.stringify(report)).not.toContain('FAKE');
  const lines = (await readFile(join(v5, V5_GRANT_AUDIT_FILE), 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as Record<string, unknown>);
  for (const line of lines) {
    expect(Object.keys(line)[0]).toBe('format');
    GrantAuditLineSchema.parse(line);
  }
  expect(lines.map(line => [line.at, line.kind, line.actor])).toEqual([
    [at(1), 'grant.changed', 'peer:mw5pf53b-4c9a262b'],
    [at(2), 'security.changed', 'admin-cli'],
    [at(3), 'grant.changed', `device:${DEVICE_ID}`],
    [at(4), 'device.key-rotated', `device:${DEVICE_ID}`],
  ]);
  expect(lines[2]?.changes).toEqual(['fleet.use=on', 'terminal.use=off']);
  expect((await stat(join(v5, V5_GRANT_AUDIT_FILE))).mode & 0o777).toBe(0o600);
});

test('a dry run reads and counts, and writes nothing', async () => {
  await put('devices.json', v4Devices({ fleet: { use: true, configure: false } }));
  await put('passkeys.json', JSON.stringify({ schemaVersion: 1, passkeys: [passkey(DEVICE_ID)] }));
  await put('grant-audit.jsonl', jsonl({ kind: 'grant.changed', at: at(1), actor: 'admin-ui', changes: [] }));
  const report = await accessStep.run(ctx(true));
  expect(report.note).toStartWith('dry run: nothing written');
  expect(report.kept).toEqual([
    { what: 'paired devices', count: 1 },
    { what: 'passkeys', count: 1 },
    {
      what: 'grant and security journal lines (the grant audit history is left behind by owner ruling, see not carried)',
      count: 1,
    },
  ]);
  expect(await readdir(v5)).toEqual([]);
});

test('the VAPID key changes envelope only: the same JWK, v5-readable, 0600, and never in the report', async () => {
  await put('devices.json', v4Devices({ fleet: { use: true, configure: false } }));
  await put('push-vapid.json', v4Vapid());
  await put(
    'push.json',
    JSON.stringify({
      schemaVersion: 1,
      subscriptions: [
        { ...pushRow(DEVICE_ID), prefs: { agenda: true } },
        pushRow(OTHER_DEVICE, 'push-00000000-0000-4000-8000-000000000002'),
      ],
    }),
  );
  const report = await accessStep.run(ctx());
  expect(report.status).toBe('converted');

  const bytes = await readFile(join(v5, V5_PUSH_KEYS_FILE), 'utf8');
  // Exactly what v5's own writer stores: format first, the JWK object as v4 had it, member order kept.
  expect(bytes).toBe(JSON.stringify({ format: 1, privateKeyJwk: JWK }));
  // Read back the way v5's reader does (bytes → JSON → PushKeysFileSchema).
  expect(PushKeysFileSchema.parse(JSON.parse(bytes)).privateKeyJwk).toEqual(JWK);
  expect((await stat(join(v5, V5_PUSH_KEYS_FILE))).mode & 0o777).toBe(0o600);

  // push.json moved in the same run, legacy prefs dropped, the other device's row gone with its device.
  const push = PushFileSchema.parse(await read(V5_PUSH_FILE));
  expect(push.subscriptions as unknown).toEqual([pushRow(DEVICE_ID)]);
  expect((await stat(join(v5, V5_PUSH_FILE))).mode & 0o777).toBe(0o600);
  expect(report.kept).toContainEqual({ what: 'push signing key (envelope only, never shown)', count: 1 });
  expect(report.kept).toContainEqual({ what: 'push subscriptions', count: 1 });
  expect(report.notCarried.some(item => item.what.startsWith('1 push subscription(s) of a device'))).toBe(true);
  expect(report.sealed).toEqual([]);
  holdsNoPushSecret(report);
});

for (const [name, envelope] of [
  ['a v5-style envelope', { format: 1 }],
  ['another schema version', { schemaVersion: 2 }],
  ['an extra field', { schemaVersion: 1, publicKey: 'FAKE-extra' }],
] as const)
  test(`a VAPID document with ${name} fails naming the file only, and writes neither push file`, async () => {
    await put('devices.json', v4Devices({ fleet: { use: true, configure: false } }));
    await put('push-vapid.json', v4Vapid(envelope));
    await put('push.json', JSON.stringify({ schemaVersion: 1, subscriptions: [pushRow(DEVICE_ID)] }));
    const report = await accessStep.run(ctx());
    expect(report.status).toBe('failed');
    expect(report.note).toBe("state/push-vapid.json: is not v4's {schemaVersion: 1, privateKeyJwk} document");
    holdsNoPushSecret(report);
    for (const file of [V5_PUSH_KEYS_FILE, V5_PUSH_FILE])
      expect(await stat(join(v5, file)).catch(() => undefined)).toBeUndefined();
  });

test('a key v5 cannot read, or a push.json v5 refuses, writes neither push file', async () => {
  await put('devices.json', v4Devices({ fleet: { use: true, configure: false } }));
  await put('push-vapid.json', JSON.stringify({ schemaVersion: 1, privateKeyJwk: { ...JWK, crv: 'P-384' } }));
  const badKey = await accessStep.run(ctx());
  expect(badKey.note).toBe('state/push-vapid.json: the key is not one v5 can read');
  holdsNoPushSecret(badKey);

  await put('push-vapid.json', v4Vapid());
  const row = pushRow(DEVICE_ID);
  await put(
    'push.json',
    JSON.stringify({
      schemaVersion: 1,
      subscriptions: [{ ...row, subscription: { ...row.subscription, endpoint: 'https://FAKE.example.test/x' } }],
    }),
  );
  const badPush = await accessStep.run(ctx());
  expect(badPush.status).toBe('failed');
  expect(badPush.note).toBe(
    'state/push.json: a subscription does not fit v5 at: subscriptions.0.subscription.endpoint',
  );
  holdsNoPushSecret(badPush);
  for (const file of [V5_PUSH_KEYS_FILE, V5_PUSH_FILE])
    expect(await stat(join(v5, file)).catch(() => undefined)).toBeUndefined();
});

test('push.json with no VAPID key is not carried; a key with no push.json moves alone', async () => {
  await put('devices.json', v4Devices({ fleet: { use: true, configure: false } }));
  await put('push.json', JSON.stringify({ schemaVersion: 1, subscriptions: [pushRow(DEVICE_ID)] }));
  const noKey = await accessStep.run(ctx());
  expect(noKey.status).toBe('converted');
  expect(noKey.notCarried.some(item => item.what === '1 push subscription(s) with no VAPID key')).toBe(true);
  expect(await stat(join(v5, V5_PUSH_FILE)).catch(() => undefined)).toBeUndefined();

  await rm(join(v4, 'state', 'push.json'));
  await rm(v5, { recursive: true });
  await mkdir(v5, { mode: 0o700 });
  await put('push-vapid.json', v4Vapid());
  const keyOnly = await accessStep.run(ctx());
  expect(keyOnly.kept).toContainEqual({ what: 'push signing key (envelope only, never shown)', count: 1 });
  expect(await stat(join(v5, V5_PUSH_KEYS_FILE))).toBeDefined();
  expect(await stat(join(v5, V5_PUSH_FILE)).catch(() => undefined)).toBeUndefined();
});

test('a dry run checks the push key and writes nothing', async () => {
  await put('push-vapid.json', v4Vapid());
  const report = await accessStep.run(ctx(true));
  expect(report.kept).toContainEqual({ what: 'push signing key (envelope only, never shown)', count: 1 });
  expect(await readdir(v5)).toEqual([]);
  holdsNoPushSecret(report);
});
