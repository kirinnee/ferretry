import { join } from 'node:path';
import {
  type DaemonId,
  DaemonIdSchema,
  DaemonNameSchema,
  InstantSchema,
  PAIRING_DEVICE_NAME_MAX_LENGTH,
  PairingDeviceNameSchema,
} from '@ferretry/protocol';
import { z } from 'zod';
import type { FileSystemPort, FoundationPaths } from '../../lib/index.ts';
import type { PairingDeviceRecord, PairingDeviceStore } from '../../lib/pairing/index.ts';
import { NodePairingCryptography } from './node-pairing-cryptography.ts';

const IdentityDocumentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  privateKeyPem: z.string().min(1),
});

const DeviceRecordSchema = z.strictObject({
  id: z.string().regex(/^fy_device_id_[A-Za-z0-9_-]{22}$/u),
  daemonId: DaemonIdSchema,
  name: PairingDeviceNameSchema,
  platform: z.literal('browser'),
  createdAt: InstantSchema,
  lastSeenAt: InstantSchema,
  tokenHash: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
});

const DeviceDocumentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  daemonId: DaemonIdSchema,
  devices: z.array(DeviceRecordSchema),
});

export interface PairingState {
  readonly daemonId: DaemonId;
  readonly daemonName: string;
  readonly devices: readonly PairingDeviceRecord[];
}

/** Durable identity and hashed device grants inside one already-owned state home. */
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
    if (identityText === undefined) {
      if (devicesText !== undefined) throw new Error('pairing state is incomplete');
      const identity = this.cryptography.newIdentity();
      daemonId = DaemonIdSchema.parse(identity.daemonId);
      records = [];
      await this.files.writeTextAtomic(
        this.identityPath,
        `${JSON.stringify({ schemaVersion: 1, privateKeyPem: identity.privateKeyPem })}\n`,
      );
      await this.files.writeTextAtomic(
        this.devicesPath,
        `${JSON.stringify({ schemaVersion: 1, daemonId, devices: records })}\n`,
      );
    } else {
      if (devicesText === undefined) throw new Error('pairing state is incomplete');
      const identity = IdentityDocumentSchema.parse(parseDocument(identityText));
      daemonId = DaemonIdSchema.parse(this.cryptography.identityFromPrivateKey(identity.privateKeyPem).daemonId);
      const document = DeviceDocumentSchema.parse(parseDocument(devicesText));
      if (document.daemonId !== daemonId) throw new Error('device grants belong to a different daemon identity');
      if (new Set(document.devices.map(device => device.id)).size !== document.devices.length) {
        throw new Error('device grants contain duplicate identities');
      }
      records = document.devices;
    }

    this.daemonId = daemonId;
    this.records = records;
    return { daemonId, daemonName: name, devices: records };
  }

  /**
   * The grants this daemon has persisted, in grant order.
   *
   * It reads the CACHE rather than the file, and that is not a shortcut: the cache is what `add` and
   * `remove` keep in step with the document they just wrote, so re-reading the disk here would let a
   * list disagree with the write that produced it while a queued write is still settling.
   */
  async list(): Promise<readonly PairingDeviceRecord[]> {
    const records = this.records;
    if (records === undefined) throw new Error('pairing state is not open');
    return records;
  }

  /**
   * Forgets one grant, serialised behind every other write to the same document.
   *
   * It joins the same `writes` chain as `add` for the reason that chain exists: two callers rewriting
   * `devices.json` from two snapshots taken at the same moment would each write a document missing the
   * other's change, and the loser would be silently re-granted access.
   */
  async remove(id: string): Promise<boolean> {
    const operation = this.writes.then(async () => {
      const daemonId = this.daemonId;
      const records = this.records;
      if (daemonId === undefined || records === undefined) throw new Error('pairing state is not open');
      const next = records.filter(existing => existing.id !== id);
      // Nothing to write when nothing matched. A no-op rewrite would be harmless but it would also
      // report "revoked" for a device that was never here, and those are different answers.
      if (next.length === records.length) return false;
      await this.files.writeTextAtomic(
        this.devicesPath,
        `${JSON.stringify({ schemaVersion: 1, daemonId, devices: next })}\n`,
      );
      this.records = next;
      return true;
    });
    this.writes = operation.then(
      () => undefined,
      () => undefined,
    );
    return await operation;
  }

  async add(record: PairingDeviceRecord): Promise<void> {
    const operation = this.writes.then(async () => {
      const daemonId = this.daemonId;
      const records = this.records;
      if (daemonId === undefined || records === undefined) throw new Error('pairing state is not open');
      if (record.daemonId !== daemonId) throw new Error('a device grant belongs to a different daemon');
      if (records.some(existing => existing.id === record.id)) throw new Error('a device identity already exists');
      const parsed = DeviceRecordSchema.parse(record);
      const next = [...records, parsed];
      await this.files.writeTextAtomic(
        this.devicesPath,
        `${JSON.stringify({ schemaVersion: 1, daemonId, devices: next })}\n`,
      );
      this.records = next;
    });
    this.writes = operation.catch(() => undefined);
    return await operation;
  }
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
