import { describe, it } from 'bun:test';
import { CAPABILITY_NAMES, CapabilityGrantsSchema } from '@ferretry/core-gate/contract';
import { PairedDevicesViewSchema } from '../../../contract/index.ts';
import should from 'should';

const on = { use: true, configure: true };
const off = { use: false, configure: false };
const everyCapability = (grant: typeof on): Record<string, typeof on> =>
  Object.fromEntries(CAPABILITY_NAMES.map(capability => [capability, grant]));

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

describe('the closed device grant reading', () => {
  it('G134 refuses a grant set that omits a capability, without filling missing fields', () => {
    const { sharing: _omitted, ...partial } = everyCapability(on);
    should(PairedDevicesViewSchema.safeParse(view(partial, everyCapability(on))).success).be.false();
    should(PairedDevicesViewSchema.safeParse(view(everyCapability(on), partial)).success).be.false();
  });

  it('G134 refuses unknown capabilities rather than silently dropping their grants', () => {
    const unknown = { ...everyCapability(on), telepathy: on };
    should(PairedDevicesViewSchema.safeParse(view(unknown, everyCapability(on))).success).be.false();
    should(PairedDevicesViewSchema.safeParse(view(everyCapability(on), unknown)).success).be.false();
  });

  it('should leave a complete answer exactly as it is', () => {
    const complete = everyCapability(off);
    const read = PairedDevicesViewSchema.parse(view(complete, complete));
    should(read.devices[0]?.grants).deepEqual(CapabilityGrantsSchema.parse(complete));
    should(read.mayWiden).deepEqual(complete);
  });

  it('should still refuse a capability whose answer is malformed, and a value that is not an object at all', () => {
    should(() => CapabilityGrantsSchema.parse({ ...everyCapability(on), fleet: { use: true } })).throw();
    should(() => CapabilityGrantsSchema.parse('open')).throw();
    should(() => CapabilityGrantsSchema.parse(null)).throw();
    should(() => CapabilityGrantsSchema.parse([])).throw();
  });
});
