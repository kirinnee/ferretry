import { join } from 'node:path';
import {
  type CapabilityGrants,
  CapabilityGrantsSchema,
  DAEMON_CAPABILITIES,
  type DaemonId,
  LIMITED_DEVICE_GRANTS,
  DaemonIdSchema,
  DaemonNameSchema,
  InstantSchema,
  PAIRING_DEVICE_NAME_MAX_LENGTH,
  PairedDeviceIdSchema,
  PairingDeviceNameSchema,
} from '@ferretry/protocol';
import { DeviceKeySchema } from '@ferretry/relay';
import { z } from 'zod';
import type { FileSystemPort, FoundationPaths } from '../../lib/index.ts';
import type { PairingDeviceRecord, PairingDeviceStore } from '../../lib/pairing/index.ts';
import { NodePairingCryptography } from './node-pairing-cryptography.ts';

const IdentityDocumentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  privateKeyPem: z.string().min(1),
});

/** What a stored record says about a capability it predates: off, a narrowing and so always safe. */
const CAPABILITY_OFF = Object.freeze({ use: false, configure: false });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Whether a stored `grants` names every capability this release knows. A capability added after a record
 * was written is missing from it, and the closed schema would refuse the whole document, which would
 * stop the daemon from starting. Missing is filled with off instead (see `fillMissingCapabilities`) and the document is
 * written back whole, so the next open finds nothing to fill.
 */
const namesEveryCapability = (grants: unknown): boolean =>
  isRecord(grants) && DAEMON_CAPABILITIES.every(capability => capability in grants);

/**
 * A capability that, in a record written before it existed, takes the value of an OLDER, stronger one rather
 * than off. `sharing` follows `pairing`: a device that may hand another device control of this machine could
 * already give one everything, Sharing included, so giving it Sharing widens nothing it could not arrange
 * (owner decision 2026-10-31; docs/grants.md). Every other capability a record predates reads as off.
 */
export const CAPABILITY_FOLLOWS: Readonly<
  Partial<Record<(typeof DAEMON_CAPABILITIES)[number], (typeof DAEMON_CAPABILITIES)[number]>>
> = {
  sharing: 'pairing',
};

const isGrant = (value: unknown): value is { use: boolean; configure: boolean } =>
  isRecord(value) && typeof value.use === 'boolean' && typeof value.configure === 'boolean';

/**
 * Fills each capability a stored record predates: with the grant of the capability it follows when that is
 * stored and well formed, otherwise with off. Anything else is left for the schema to judge.
 */
function fillMissingCapabilities(grants: unknown): unknown {
  if (!isRecord(grants)) return grants;
  const filled = DAEMON_CAPABILITIES.map(capability => {
    const leader = CAPABILITY_FOLLOWS[capability];
    const inherited = leader === undefined ? undefined : grants[leader];
    return [capability, isGrant(inherited) ? { use: inherited.use, configure: inherited.configure } : CAPABILITY_OFF];
  });
  return { ...Object.fromEntries(filled), ...grants };
}

const DeviceRecordSchema = z.strictObject({
  id: PairedDeviceIdSchema,
  daemonId: DaemonIdSchema,
  name: PairingDeviceNameSchema,
  platform: z.literal('browser'),
  createdAt: InstantSchema,
  lastSeenAt: InstantSchema,
  pairedOver: z.enum(['direct', 'relay']).optional(),
  publicKey: DeviceKeySchema,
  // A record written before per-device grants reads as LIMITED (fleet.use only), a narrowing and
  // therefore safe — so the document stays at schema 2. A record written before a CAPABILITY existed
  // reads that capability as off, for the same reason — or, for one that FOLLOWS a stronger capability
  // (sharing follows pairing), as that one reads. Every write carries the whole field.
  grants: z.preprocess(fillMissingCapabilities, CapabilityGrantsSchema).default(LIMITED_DEVICE_GRANTS),
  /** When `publicKey` last replaced an earlier one. Absent until a first rotation. */
  keyRotatedAt: InstantSchema.optional(),
});

const DEVICE_DOCUMENT_VERSION = 2;

const DeviceDocumentSchema = z.strictObject({
  schemaVersion: z.literal(DEVICE_DOCUMENT_VERSION),
  daemonId: DaemonIdSchema,
  devices: z.array(DeviceRecordSchema),
});

/**
 * A document from before device keys: grants that each held the digest of a bearer token.
 *
 * Recognised only so it can be DROPPED in words. Nothing in it can authenticate any more — there is no
 * code path left that compares a token — so carrying the records forward would list devices that can
 * never get in. The owner's decision is that every device pairs again once; this is where that happens.
 */
const BearerDeviceDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  daemonId: DaemonIdSchema,
  devices: z.array(z.unknown()),
});

export interface PairingState {
  readonly daemonId: DaemonId;
  readonly daemonName: string;
  readonly devices: readonly PairingDeviceRecord[];
  /**
   * How many bearer-token grants a pre-device-key document held and this open dropped. Non-zero exactly
   * once — the next write replaces the document — so the boot trail can say who has to pair again.
   */
  readonly droppedBearerGrants: number;
}

/** Durable identity and device public keys inside one already-owned state home. */
export class StatePairingRepository implements PairingDeviceStore {
  private readonly identityPath: string;
  private readonly devicesPath: string;
  private daemonId: DaemonId | undefined;
  private records: readonly PairingDeviceRecord[] | undefined;
  private writes: Promise<void> = Promise.resolve();

  constructor(
    paths: FoundationPaths,
    private readonly files: Pick<FileSystemPort, 'readText' | 'writeTextAtomic'>,
    private readonly cryptography = new NodePairingCryptography(),
  ) {
    this.identityPath = paths.daemonIdentity;
    this.devicesPath = join(paths.state, 'devices.json');
  }

  async open(daemonName: string): Promise<PairingState> {
    const name = normalizeDaemonName(daemonName);
    const [identityText, devicesText] = await Promise.all([
      this.files.readText(this.identityPath),
      this.files.readText(this.devicesPath),
    ]);
    let daemonId: DaemonId;
    let records: readonly PairingDeviceRecord[];
    let droppedBearerGrants = 0;
    if (identityText === undefined) {
      if (devicesText !== undefined) throw new Error('pairing state is incomplete');
      const identity = this.cryptography.newIdentity();
      daemonId = DaemonIdSchema.parse(identity.daemonId);
      records = [];
      await this.files.writeTextAtomic(
        this.identityPath,
        `${JSON.stringify({ schemaVersion: 1, privateKeyPem: identity.privateKeyPem })}\n`,
      );
      await this.files.writeTextAtomic(this.devicesPath, deviceDocument(daemonId, records));
    } else {
      if (devicesText === undefined) throw new Error('pairing state is incomplete');
      const identity = IdentityDocumentSchema.parse(parseDocument(identityText));
      daemonId = DaemonIdSchema.parse(this.cryptography.identityFromPrivateKey(identity.privateKeyPem).daemonId);
      const raw = parseDocument(devicesText);
      const bearer = BearerDeviceDocumentSchema.safeParse(raw);
      if (bearer.success) {
        if (bearer.data.daemonId !== daemonId) throw new Error('device grants belong to a different daemon identity');
        droppedBearerGrants = bearer.data.devices.length;
        records = [];
        await this.files.writeTextAtomic(this.devicesPath, deviceDocument(daemonId, records));
      } else {
        const document = DeviceDocumentSchema.parse(raw);
        if (document.daemonId !== daemonId) throw new Error('device grants belong to a different daemon identity');
        if (new Set(document.devices.map(device => device.id)).size !== document.devices.length) {
          throw new Error('device grants contain duplicate identities');
        }
        records = document.devices;
        const stale = (raw as { devices: { grants?: unknown }[] }).devices.some(
          device => !namesEveryCapability(device.grants),
        );
        if (stale) await this.files.writeTextAtomic(this.devicesPath, deviceDocument(daemonId, records));
      }
    }

    this.daemonId = daemonId;
    this.records = records;
    return { daemonId, daemonName: name, devices: records, droppedBearerGrants };
  }

  /**
   * The grants this daemon has persisted, in grant order.
   *
   * It reads the CACHE rather than the file, and that is not a shortcut: the cache is what every write
   * keeps in step with the document it just wrote, so re-reading the disk here would let a list
   * disagree with the write that produced it while a queued write is still settling.
   */
  async list(): Promise<readonly PairingDeviceRecord[]> {
    const records = this.records;
    if (records === undefined) throw new Error('pairing state is not open');
    return records;
  }

  async remove(id: string): Promise<boolean> {
    return await this.write(records => {
      const next = records.filter(existing => existing.id !== id);
      return next.length === records.length ? undefined : next;
    });
  }

  async touch(id: string, lastSeenAt: string): Promise<void> {
    await this.write(records =>
      records.some(existing => existing.id === id)
        ? records.map(existing => (existing.id === id ? { ...existing, lastSeenAt } : existing))
        : undefined,
    );
  }

  async rotateKey(id: string, publicKey: string, keyRotatedAt: string): Promise<boolean> {
    return await this.write(records =>
      records.some(existing => existing.id === id)
        ? records.map(existing =>
            existing.id === id ? DeviceRecordSchema.parse({ ...existing, publicKey, keyRotatedAt }) : existing,
          )
        : undefined,
    );
  }

  async setGrants(id: string, grants: CapabilityGrants): Promise<boolean> {
    const parsed = CapabilityGrantsSchema.parse(grants);
    return await this.write(records =>
      records.some(existing => existing.id === id)
        ? records.map(existing => (existing.id === id ? { ...existing, grants: parsed } : existing))
        : undefined,
    );
  }

  async add(record: PairingDeviceRecord): Promise<void> {
    await this.write(records => {
      if (record.daemonId !== this.daemonId) throw new Error('a device grant belongs to a different daemon');
      if (records.some(existing => existing.id === record.id)) throw new Error('a device identity already exists');
      return [...records, DeviceRecordSchema.parse(record)];
    });
  }

  /**
   * One serialised read-modify-write of the device document.
   *
   * Every write joins the same `writes` chain for the reason that chain exists: two callers rewriting
   * `devices.json` from two snapshots taken at the same moment would each write a document missing the
   * other's change, and the loser would be silently re-granted access.
   *
   * `change` answers the next list, or `undefined` for "nothing to write" — which is what makes a
   * removal of an id that is already gone report `false` rather than rewriting the file for nothing.
   */
  private async write(
    change: (records: readonly PairingDeviceRecord[]) => readonly PairingDeviceRecord[] | undefined,
  ): Promise<boolean> {
    const operation = this.writes.then(async () => {
      const daemonId = this.daemonId;
      const records = this.records;
      if (daemonId === undefined || records === undefined) throw new Error('pairing state is not open');
      const next = change(records);
      if (next === undefined) return false;
      await this.files.writeTextAtomic(this.devicesPath, deviceDocument(daemonId, next));
      this.records = next;
      return true;
    });
    this.writes = operation.then(
      () => undefined,
      () => undefined,
    );
    return await operation;
  }
}

function deviceDocument(daemonId: DaemonId, devices: readonly PairingDeviceRecord[]): string {
  return `${JSON.stringify({ schemaVersion: DEVICE_DOCUMENT_VERSION, daemonId, devices })}\n`;
}

/** Hostnames are platform text, not a display-name contract; make them safe and bounded on entry. */
function normalizeDaemonName(value: string): string {
  const cleaned = value.replaceAll(/[\p{Cc}\p{Cf}]/gu, '').trim();
  let bounded = '';
  for (const symbol of cleaned) {
    if (bounded.length + symbol.length > PAIRING_DEVICE_NAME_MAX_LENGTH) break;
    bounded += symbol;
  }
  return DaemonNameSchema.parse(bounded === '' ? 'Ferretry daemon' : bounded);
}

function parseDocument(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('pairing state is not valid JSON');
  }
}
