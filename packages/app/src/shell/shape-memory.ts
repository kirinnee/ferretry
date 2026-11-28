import { PROTOCOL } from '@ferretry/kernel/contract';
import { z } from 'zod';
import type { Inventory } from '../client/inventory.ts';
import { localKey } from '../storage/names.ts';
import { type KeyValueStore, readRecord, removeRecord, writeRecord } from '../storage/records.ts';
import { GrantRowSchema, type GrantRow } from './grants-cache.ts';

/**
 * WHAT THIS DEVICE REMEMBERS OF A MACHINE'S SHAPE, so a reload draws at once and the answer refreshes quietly behind.
 *
 * The SHAPE is two lists the daemon already told this device: which plugins are on (id, on, contract hash) and which
 * capabilities this device holds (names, booleans, refusal reasons). It is what to DRAW, nothing more:
 *
 * - **Never data.** No read's body, token, secret, pairing code or device credential is kept (the grants answer and the
 *   plugin list carry none by Gate's own guard); a field outside the two schemas below is refused on the way in AND out.
 * - **The daemon still decides.** A remembered "allowed" only draws a screen; every read and write it makes still goes to
 *   the daemon, which may refuse it, and the refusal is shown as the normal locked / refused state. The client sends
 *   nothing for a plugin until the LIVE plugin list has answered (`DaemonClient` admits on the live read only).
 * - **Keyed by daemon AND device.** One record per daemon, holding the device id it was learned under: another device
 *   id (a re-pair) reads as nothing, and the next live answer replaces the record. It is removed on unpair, on a re-pair and whenever the daemon answers anything but
 *   a plugin list or a grants list (refused, protocol mismatch, locked, unreadable). An unauthenticated `4426` preserves both.
 * - **Storage may be refused** (a private window, a sandbox): every call is total and falls back to "nothing remembered".
 */
const RememberedSchema = z.strictObject({
  deviceId: z.string().min(1).max(128),
  inventory: z
    .strictObject({
      protocol: z.literal(PROTOCOL),
      plugins: z
        .array(z.strictObject({ id: z.string().min(1).max(64), on: z.boolean(), contract: z.string().max(128) }))
        .max(256),
    })
    .optional(),
  grants: z.array(GrantRowSchema).max(64).optional(),
});
type Remembered = z.infer<typeof RememberedSchema>;

export interface RememberedShape {
  readonly inventory?: Extract<Inventory, { kind: 'read' }>;
  readonly grants?: ReadonlyMap<string, GrantRow>;
}

export class ShapeMemory {
  readonly #store: KeyValueStore | null;

  constructor(store: KeyValueStore | null) {
    this.#store = store;
  }

  static key(daemon: string): string {
    return localKey('app', 'shape', daemon);
  }

  /** What was remembered for this daemon under THIS device id; another device id reads as nothing and is dropped. */
  read(daemon: string, deviceId: string): RememberedShape {
    const held = this.#held(daemon);
    if (held === undefined) return {};
    // Another device id (a re-pair) reads as nothing. A read never deletes: the record may be the NEW pairing's.
    if (held.deviceId !== deviceId) return {};
    return {
      ...(held.inventory === undefined
        ? {}
        : {
            inventory: {
              kind: 'read',
              entries: new Map(held.inventory.plugins.map(p => [p.id, { on: p.on, contract: p.contract }])),
            },
          }),
      ...(held.grants === undefined ? {} : { grants: new Map(held.grants.map(row => [row.capability, row])) }),
    };
  }

  /** A live list is remembered; an unauthenticated 4426 preserves it; other failed reads forget the shape. */
  saveInventory(daemon: string, deviceId: string, inventory: Inventory): void {
    // A pre-handshake 4426 is unauthenticated: it may draw an update page, but cannot erase stored grants.
    if (inventory.kind === 'unreadable' && inventory.versionUnsupported === true) return;
    if (inventory.kind !== 'read') {
      this.clear(daemon);
      return;
    }
    const held = this.#same(daemon, deviceId);
    this.#write(daemon, {
      ...held,
      deviceId,
      inventory: {
        protocol: PROTOCOL,
        plugins: [...inventory.entries].map(([id, entry]) => ({ id, on: entry.on, contract: entry.contract })),
      },
    });
  }

  /** A live grants list, or `undefined` for any other answer (locked, unreadable): that forgets the grants. */
  saveGrants(daemon: string, deviceId: string, rows: ReadonlyMap<string, GrantRow> | undefined): void {
    const held = this.#same(daemon, deviceId);
    if (held === undefined && rows === undefined) return;
    const { grants: _dropped, ...rest } = held ?? { deviceId };
    this.#write(daemon, { ...rest, deviceId, ...(rows === undefined ? {} : { grants: [...rows.values()] }) });
  }

  /** The daemon was unpaired, re-paired or refused this device: nothing about it is kept. */
  clear(daemon: string): void {
    removeRecord(this.#store, ShapeMemory.key(daemon));
  }

  #held(daemon: string): Remembered | undefined {
    return readRecord(this.#store, ShapeMemory.key(daemon), RememberedSchema);
  }

  #same(daemon: string, deviceId: string): Remembered | undefined {
    const held = this.#held(daemon);
    return held?.deviceId === deviceId ? held : undefined;
  }

  #write(daemon: string, value: Remembered): void {
    writeRecord(this.#store, ShapeMemory.key(daemon), RememberedSchema.parse(value));
  }
}
