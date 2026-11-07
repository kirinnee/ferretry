import { afterEach, beforeEach, expect, test } from 'bun:test';
import { CAPABILITY_NAMES } from '@ferretry/core-gate/contract';
import { DevicesFileSchema } from '@ferretry/plugin-access/contract';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accessStep, V5_DEVICES_FILE } from '../../src/steps/access.ts';
import { v4Paths } from '../../src/v4/layout.ts';
import { v5Writer } from '../../src/v5/write.ts';

// Fake device values in the v4 shapes; a public key is not a secret, but the report must still hold counts only.
const DEVICE_ID = 'fy_device_id_AAAAAAAAAAAAAAAAAAAAAA';
const PUBLIC_KEY = 'MCowBQYDK2VwAyEAZmFrZS1wdWJsaWMta2V5LWZha2UtcHVibGljLWtleQ';
const DAEMON_ID = `fy_daemon_${'A'.repeat(43)}`;

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

const ctx = () => ({ v4: v4Paths(v4), v5: v5Writer(v5, { dryRun: false }), dryRun: false });

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

test('a paired device keeps its id, public key and grants, so it stays paired', async () => {
  await writeFile(join(v4, 'state', 'devices.json'), v4Devices({ fleet: { use: true, configure: false } }));
  const report = await accessStep.run(ctx());

  expect(report.kept).toEqual([{ what: 'paired devices', count: 1 }]);
  const file = DevicesFileSchema.parse(JSON.parse(await readFile(join(v5, V5_DEVICES_FILE), 'utf8')));
  const [device] = file.devices;
  expect(device?.id).toBe(DEVICE_ID);
  expect(device?.publicKey).toBe(PUBLIC_KEY);
  expect(device?.pairedOver).toBe('relay');
  expect(device?.grants.fleet).toEqual({ use: true, configure: false });
  expect((await stat(join(v5, V5_DEVICES_FILE))).mode & 0o777).toBe(0o600);
  expect(JSON.stringify(report)).not.toContain(PUBLIC_KEY);
  // Passkeys, unlocks and push still wait for their Access schemas, so the step is not finished.
  expect(report.status).toBe('pending');
});

test('a capability v4 did not name is off (narrower), and one v5 dropped is reported', async () => {
  await writeFile(
    join(v4, 'state', 'devices.json'),
    v4Devices({ fleet: { use: true, configure: true }, retired: { use: true, configure: true } }),
  );
  const report = await accessStep.run(ctx());
  const file = DevicesFileSchema.parse(JSON.parse(await readFile(join(v5, V5_DEVICES_FILE), 'utf8')));
  const others = CAPABILITY_NAMES.filter(name => name !== 'fleet');
  for (const name of others) expect(file.devices[0]?.grants[name]).toEqual({ use: false, configure: false });
  expect(report.notCarried.some(item => item.what.includes('retired'))).toBe(true);
});

test('an old bearer document is not converted, and no devices file is written', async () => {
  await writeFile(join(v4, 'state', 'devices.json'), JSON.stringify({ schemaVersion: 1, devices: [] }));
  const report = await accessStep.run(ctx());
  expect(report.kept).toEqual([]);
  expect(await stat(join(v5, V5_DEVICES_FILE)).catch(() => undefined)).toBeUndefined();
});

test('a home with no devices file reports none and does not fail', async () => {
  const report = await accessStep.run(ctx());
  expect(report.status).toBe('pending');
  expect(report.kept).toEqual([]);
});
