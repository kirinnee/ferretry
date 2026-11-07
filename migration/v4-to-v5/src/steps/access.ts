/**
 * Access: paired devices, passkeys, unlocks, push. Nothing here is secret except the push keys (moved unopened once
 * Access declares their format); device records hold PUBLIC keys and grants only. Still, no record is ever logged:
 * the report gives counts.
 *
 * Devices: v4 `state/devices.json` `{schemaVersion: 2, daemonId, devices: [...]}` → v5 `state/access/devices.json`
 * (`DevicesFileSchema`). The device's id, name, public key, instants, `pairedOver` and grants carry; `daemonId` is not
 * a v5 field because the identity itself is carried (spine D17); `platform` and `keyRotatedAt` have no v5 field and
 * are declared not carried. A v4 `schemaVersion: 1` (bearer) document is not converted: v4 itself made those devices
 * pair again.
 *
 * Grants: v5 names a fixed capability set. A capability v4 granted that v5 also has keeps its two axes; one v5 has
 * and v4 did not name is OFF on both axes (a narrowing, never a widening); one v4 had and v5 dropped is not carried.
 */
import { CAPABILITY_NAMES } from '@ferretry/core-gate/contract';
import { DevicesFileSchema } from '@ferretry/plugin-access/contract';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { NotCarried, StepReport } from '../report.ts';
import type { Step, StepContext } from './index.ts';

export const V5_DEVICES_FILE = 'state/access/devices.json';

/** The tool's own reader of v4's `devices.json` (packages/daemon/src/adapters/pairing/state-pairing-repository.ts:72). */
const V4GrantSchema = z.strictObject({ use: z.boolean(), configure: z.boolean() });
const V4DeviceSchema = z.strictObject({
  id: z.string(),
  daemonId: z.string(),
  name: z.string(),
  platform: z.literal('browser'),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  pairedOver: z.enum(['direct', 'relay']).optional(),
  publicKey: z.string(),
  grants: z.record(z.string(), V4GrantSchema),
  keyRotatedAt: z.string().optional(),
});
const V4DevicesSchema = z.strictObject({
  schemaVersion: z.literal(2),
  daemonId: z.string(),
  devices: z.array(V4DeviceSchema),
});

const OFF = { use: false, configure: false } as const;

const ACCESS_NOT_CARRIED: readonly NotCarried[] = [
  { what: 'pairing codes', why: 'single-use and two minutes long; none survives a stop' },
  { what: 'live unlocks', why: 'each device unlocks again with its passkey' },
  { what: 'device platform and keyRotatedAt', why: 'v5 devices.json has no field for them' },
];

/** What still waits for an Access schema; listed in the report until each lands. */
const WAITING = ['passkeys.json', 'unlocks.json', 'push.json', 'push-keys.json (sealed: v4 push-vapid.json)'];

export const accessStep: Step = {
  id: 'access',
  title: 'Paired devices and passkeys (public keys, grants, unlock settings)',
  owner: ['plugin-access'],
  reads: ['state/devices.json', 'state/passkeys.json', 'state/unlocks.json', 'state/push.json'],
  sealed: ['state/push-vapid.json'],
  notCarried: ACCESS_NOT_CARRIED,
  async run(ctx: StepContext): Promise<StepReport> {
    const base = { id: 'access', title: accessStep.title, sealed: [] };
    const pending = `waits for the Access schemas of ${WAITING.join(', ')}`;
    let text: string;
    try {
      text = await readFile(join(ctx.v4.state, 'devices.json'), 'utf8');
    } catch {
      return {
        ...base,
        status: 'pending',
        note: `no paired devices; ${pending}`,
        kept: [],
        notCarried: ACCESS_NOT_CARRIED,
      };
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch {
      return {
        ...base,
        status: 'failed',
        note: 'state/devices.json is not JSON',
        kept: [],
        notCarried: ACCESS_NOT_CARRIED,
      };
    }
    const version = (decoded as { schemaVersion?: unknown } | null)?.schemaVersion;
    if (version === 1)
      return {
        ...base,
        status: 'pending',
        note: `devices.json is v4's old bearer document; ${pending}`,
        kept: [],
        notCarried: [...ACCESS_NOT_CARRIED, { what: 'bearer-era devices', why: 'v4 already made them pair again' }],
      };
    const parsed = V4DevicesSchema.safeParse(decoded);
    if (!parsed.success)
      return {
        ...base,
        status: 'failed',
        note: `state/devices.json does not match v4's shape at: ${parsed.error.issues.map(i => i.path.join('.')).join(', ')}`,
        kept: [],
        notCarried: ACCESS_NOT_CARRIED,
      };

    const dropped = new Set<string>();
    const devices = parsed.data.devices.map(device => {
      for (const name of Object.keys(device.grants))
        if (!(CAPABILITY_NAMES as readonly string[]).includes(name)) dropped.add(name);
      const grants = Object.fromEntries(CAPABILITY_NAMES.map(name => [name, device.grants[name] ?? OFF]));
      return {
        id: device.id,
        name: device.name,
        publicKey: device.publicKey,
        createdAt: device.createdAt,
        lastSeenAt: device.lastSeenAt,
        ...(device.pairedOver === undefined ? {} : { pairedOver: device.pairedOver }),
        grants,
      };
    });
    const checked = DevicesFileSchema.safeParse({ format: 1, devices });
    if (!checked.success)
      return {
        ...base,
        status: 'failed',
        note: `a v4 device does not fit v5 at: ${checked.error.issues.map(i => i.path.join('.')).join(', ')}`,
        kept: [],
        notCarried: ACCESS_NOT_CARRIED,
      };
    const value = checked.data;
    await ctx.v5.json({ path: V5_DEVICES_FILE, format: 1, schema: DevicesFileSchema }, value);
    const notCarried =
      dropped.size === 0
        ? ACCESS_NOT_CARRIED
        : [
            ...ACCESS_NOT_CARRIED,
            { what: `grants for ${[...dropped].sort().join(', ')}`, why: 'v5 has no such capability' },
          ];
    return {
      ...base,
      status: 'pending',
      note: pending,
      kept: [{ what: 'paired devices', count: devices.length }],
      notCarried,
    };
  },
};
