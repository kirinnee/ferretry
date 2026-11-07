import type { StatePort } from '@ferretry/kernel/contract';
import {
  type CapabilityGrants,
  CapabilityGrantsSchema,
  type DaemonId,
  DaemonIdSchema,
  DaemonNameSchema,
  DeviceRecordSchema,
  DevicesFile,
  type DevicesFile as DevicesDocument,
  PAIRING_DEVICE_NAME_MAX_LENGTH,
} from '../../lib/wire.ts';
import { DeviceKeySchema } from '../../lib/proof/device-proof.ts';
import type { PairingDeviceRecord, PairingDeviceStore } from '../../lib/pairing/index.ts';

export interface PairingState {
  readonly daemonId: DaemonId;
  readonly daemonName: string;
  readonly devices: readonly PairingDeviceRecord[];
}

/** A stored record, checked: the closed record schema, and a key that is an Ed25519 SPKI (today's `DeviceKeySchema`). */
function parseRecord(record: PairingDeviceRecord): PairingDeviceRecord {
  const parsed = DeviceRecordSchema.parse(record);
  DeviceKeySchema.parse(parsed.publicKey);
  return parsed;
}

/**
 * Device public keys and grants inside Access's state (`devices.json`), bound to ONE daemon identity.
 *
 * The identity itself is the kernel's: this daemon's id and name are handed in, and a document written under another
 * identity (a state home copied between machines, a reset identity) is refused rather than adopted. A document that
 * does not parse is the kernel's damage, and nothing here reads it as "no devices".
 */
export class StatePairingRepository implements PairingDeviceStore {
  private daemonId: DaemonId | undefined;
  private records: readonly PairingDeviceRecord[] | undefined;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly state: StatePort) {}

  async open(identity: { readonly daemonId: string; readonly daemonName: string }): Promise<PairingState> {
    const daemonId = DaemonIdSchema.parse(identity.daemonId);
    const name = normalizeDaemonName(identity.daemonName);
    const read = await this.state.read(DevicesFile);
    if (!read.ok) throw new Error(`device grants are damaged: ${read.error.sentence}`);
    let records: readonly PairingDeviceRecord[];
    if (read.value === undefined) {
      records = [];
      await this.state.write(DevicesFile, deviceDocument(daemonId, records));
    } else {
      const document = read.value;
      if (document.daemonId !== daemonId) throw new Error('device grants belong to a different daemon identity');
      if (new Set(document.devices.map(device => device.id)).size !== document.devices.length) {
        throw new Error('device grants contain duplicate identities');
      }
      for (const device of document.devices) DeviceKeySchema.parse(device.publicKey);
      records = document.devices;
    }
    this.daemonId = daemonId;
    this.records = records;
    return { daemonId, daemonName: name, devices: records };
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
            existing.id === id ? parseRecord({ ...existing, publicKey, keyRotatedAt }) : existing,
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
      return [...records, parseRecord(record)];
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
      await this.state.write(DevicesFile, deviceDocument(daemonId, next));
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

function deviceDocument(daemonId: DaemonId, devices: readonly PairingDeviceRecord[]): DevicesDocument {
  return { format: 1, daemonId, devices: devices.map(device => DeviceRecordSchema.parse(device)) };
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
