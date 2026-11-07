import { afterEach, beforeEach, expect, test } from 'bun:test';
import { CAPABILITY_NAMES } from '@ferretry/core-gate/contract';
import { DevicesFileSchema, GrantAuditLineSchema, PasskeysFileSchema } from '@ferretry/plugin-access/contract';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accessStep, V5_DEVICES_FILE, V5_GRANT_AUDIT_FILE, V5_PASSKEYS_FILE } from '../../src/steps/access.ts';
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
  // Push still waits for the VAPID key decision, so the step is not finished.
  expect(report.status).toBe('pending');
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
  expect(report.status).toBe('pending');
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

  expect(report.kept).toContainEqual({ what: 'grant and security journal lines', count: 4 });
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
    { what: 'grant and security journal lines', count: 1 },
  ]);
  expect(await readdir(v5)).toEqual([]);
});
