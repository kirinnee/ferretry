import { describe, expect, test } from 'bun:test';
import { accessConformance, fakeAccess } from '../../contract/testing/index.ts';
import { PairingCodeSchema, PairedDevicesViewSchema, RegisterPushDeviceRequestSchema } from '../../contract/index.ts';

accessConformance('fakeAccess', () => fakeAccess());

describe('access wire', () => {
  test('an invite code is normalised and checked against the unambiguous alphabet', () => {
    expect(PairingCodeSchema.parse(' abcd efgh ')).toBe('ABCD-EFGH');
    expect(PairingCodeSchema.safeParse('ABCD-EFG0').success).toBe(false);
  });
  test('a device list is strict: no key material can ride along', () => {
    const none = { use: false, configure: false };
    const mayWiden = Object.fromEntries(
      ['fleet', 'terminal', 'browser', 'filesystem', 'warden', 'pairing', 'secrets', 'sharing'].map(name => [
        name,
        none,
      ]),
    );
    const view = { devices: [], hostLocal: true, mayWiden };
    expect(PairedDevicesViewSchema.safeParse(view).success).toBe(true);
    expect(PairedDevicesViewSchema.safeParse({ ...view, publicKey: 'x' }).success).toBe(false);
  });
  test('a push enrolment names a browser push service, over HTTPS, without credentials', () => {
    const subscription = (endpoint: string) => ({
      deviceName: 'phone',
      subscription: { endpoint, expirationTime: null, keys: { p256dh: 'a'.repeat(87), auth: 'b'.repeat(22) } },
    });
    expect(RegisterPushDeviceRequestSchema.safeParse(subscription('https://fcm.googleapis.com/x')).success).toBe(true);
    expect(RegisterPushDeviceRequestSchema.safeParse(subscription('https://evil.example/x')).success).toBe(false);
  });
});
