import { describe, it } from 'bun:test';
import {
  CapabilityGrantsSchema,
  DAEMON_CAPABILITIES,
  PairedDevicesViewSchema,
  ReadCapabilityGrantsSchema,
} from '@ferretry/protocol';
import should from 'should';

const on = { use: true, configure: true };
const off = { use: false, configure: false };
const everyCapability = (grant: typeof on): Record<string, typeof on> =>
  Object.fromEntries(DAEMON_CAPABILITIES.map(capability => [capability, grant]));

const device = (grants: unknown): unknown => ({
  id: `fy_device_id_${'b'.repeat(22)}`,
  name: 'Phone',
  platform: 'browser',
  createdAt: '2026-08-03T12:00:00.000Z',
  lastSeenAt: '2026-08-03T12:00:00.000Z',
  idleExpiresAt: '2026-09-03T12:00:00.000Z',
  grants,
});

const view = (grants: unknown, mayWiden: unknown): unknown => ({
  devices: [device(grants)],
  hostLocal: false,
  mayWiden,
});

describe('how a client reads grants from a daemon on another version', () => {
  it('should read a capability an older daemon omits as off, so a newer app still opens the device screen', () => {
    const { sharing: _omitted, ...older } = everyCapability(on);
    const read = PairedDevicesViewSchema.parse(view(older, older));
    should(read.devices[0]?.grants.sharing).deepEqual(off);
    should(read.devices[0]?.grants.fleet).deepEqual(on);
    should(read.mayWiden.sharing).deepEqual(off);
    should(read.mayWiden.terminal).deepEqual(on);
  });

  it('should drop a capability this build has not heard of, so an older app keeps working against a newer daemon', () => {
    const newer = { ...everyCapability(on), telepathy: on };
    const read = PairedDevicesViewSchema.parse(view(newer, newer));
    should(read.devices[0]?.grants).deepEqual(everyCapability(on));
    should(read.mayWiden).deepEqual(everyCapability(on));
  });

  it('should leave a complete answer exactly as it is', () => {
    const complete = everyCapability(off);
    should(ReadCapabilityGrantsSchema.parse(complete)).deepEqual(CapabilityGrantsSchema.parse(complete));
  });

  it('should still refuse a capability whose answer is malformed, and a value that is not an object at all', () => {
    should(() => ReadCapabilityGrantsSchema.parse({ ...everyCapability(on), fleet: { use: true } })).throw();
    should(() => ReadCapabilityGrantsSchema.parse('open')).throw();
    should(() => ReadCapabilityGrantsSchema.parse(null)).throw();
    should(() => ReadCapabilityGrantsSchema.parse([])).throw();
  });
});
