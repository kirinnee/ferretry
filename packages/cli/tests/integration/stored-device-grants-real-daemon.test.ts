import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { identityFileText, identityFromPem } from '../../../core/kernel/host/identity.ts';
import { bootRealDaemon, type RealDaemon } from './support/real-daemon.ts';

/**
 * A device paired BEFORE a capability existed must still be a paired device after the capability ships.
 *
 * The P0 this pins: `voice` joined the capability list and every `devices.json` written without it failed its schema, so
 * Access refused to start, Catalogs (which needs Access) refused too, and the browser was told the machine no longer
 * accepted it. Here the real `fyd` boots on a temp FY_HOME seeded with that exact file shape (every capability but
 * `voice`) under a synthetic identity, and the real `fy` reads the devices back. Fake ids and keys only.
 */

setDefaultTimeout(180_000);

const STAMP = '2026-09-01T00:00:00.000Z';
/** An Ed25519 SPKI: the fixed DER prefix and 32 key bytes. */
const KEY = Buffer.from([
  0x30,
  0x2a,
  0x30,
  0x05,
  0x06,
  0x03,
  0x2b,
  0x65,
  0x70,
  0x03,
  0x21,
  0x00,
  ...new Array(32).fill(5),
]).toString('base64url');
const OLD_CAPABILITIES = [
  'fleet',
  'terminal',
  'browser',
  'filesystem',
  'warden',
  'pairing',
  'secrets',
  'sharing',
] as const;
const grants = (on: readonly string[]) =>
  Object.fromEntries(OLD_CAPABILITIES.map(name => [name, { use: on.includes(name), configure: false }]));

let daemon: RealDaemon;

beforeAll(async () => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const { daemonId } = await identityFromPem(pem);
  const record = (letter: string, name: string, on: readonly string[]) => ({
    id: `fy_device_id_${letter.repeat(22)}`,
    daemonId,
    name,
    platform: 'browser',
    createdAt: STAMP,
    lastSeenAt: new Date().toISOString(),
    pairedOver: 'relay',
    publicKey: KEY,
    grants: grants(on),
  });
  daemon = await bootRealDaemon([], {
    'state/kernel/identity.json': identityFileText(pem),
    'state/access/devices.json': JSON.stringify({
      format: 1,
      daemonId,
      devices: [record('a', 'Synthetic laptop', OLD_CAPABILITIES), record('b', 'Synthetic phone', ['fleet'])],
    }),
  });
});

afterAll(async () => await daemon?.dispose());

describe('a devices.json written before the newest capability', () => {
  it('should let the daemon boot, list both devices and read the capability they predate as off', async () => {
    const ran = await daemon.fy('owner', ['device', 'ls']);
    expect(ran.code, ran.err).toBe(0);
    expect(ran.out).toContain('"Synthetic laptop"');
    expect(ran.out).toContain('"Synthetic phone"');
    expect(ran.out).toMatch(/voice\s+use=off\s+configure=off/u);

    const served = await daemon.call('GET', '/v1/pair/devices');
    expect(served.status).toBe(200);
    const devices = (JSON.parse(served.text) as { devices: { name: string; grants: Record<string, unknown> }[] })
      .devices;
    expect(devices.map(device => device.name).sort()).toEqual(['Synthetic laptop', 'Synthetic phone']);
    for (const device of devices) expect(device.grants.voice).toEqual({ use: false, configure: false });
    expect(devices.find(device => device.name === 'Synthetic laptop')?.grants.terminal).toEqual({
      use: true,
      configure: false,
    });
  });

  it('should leave Catalogs, which needs Access, running', async () => {
    const ran = await daemon.fy('owner', ['catalog', 'ls']);
    expect(ran.code, ran.err).toBe(0);
  });
});
