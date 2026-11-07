import { CORE_IDS, PROTOCOL } from '@ferretry/kernel/contract';
import { z } from 'zod';
import type { SurfaceEntry } from '../surfaces/registry.ts';

/**
 * THE INVENTORY AND THE PER-PACKAGE CHECK (§9.6), pure.
 *
 * `GET /v1/plugins` answers `{ protocol, plugins: [{ id, on, contract }] }`, projected by Gate per standing. Before
 * every route call, tool call, event subscription and socket open, the generated client asks {@link standingOf} for
 * the owning package: present, `on`, and effective hash equal to its own compiled one. Anything else is BLOCKED
 * without sending.
 */

/** Parsed loosely first, so a protocol mismatch is told apart from a damaged answer. */
const InventoryEnvelopeSchema = z.object({ protocol: z.number().int() });

/** The strict body once the protocol matched (wire schemas are strict objects; relay-protocol.md says why). */
const InventoryBodySchema = z.strictObject({
  protocol: z.literal(PROTOCOL),
  plugins: z.array(z.strictObject({ id: z.string().min(1).max(64), on: z.boolean(), contract: z.string().max(128) })),
});

export interface InventoryEntry {
  readonly on: boolean;
  readonly contract: string;
}

export type Inventory =
  | { readonly kind: 'read'; readonly entries: ReadonlyMap<string, InventoryEntry> }
  /** The daemon speaks another session protocol: the one full-screen sentence, nothing else is sent. */
  | { readonly kind: 'protocol-mismatch'; readonly daemonProtocol: number }
  /** The answer was not an inventory. Damaged is not empty: everything stays blocked. */
  | { readonly kind: 'unreadable' };

export function parseInventory(body: unknown): Inventory {
  const envelope = InventoryEnvelopeSchema.safeParse(body);
  if (!envelope.success) return { kind: 'unreadable' };
  if (envelope.data.protocol !== PROTOCOL) return { kind: 'protocol-mismatch', daemonProtocol: envelope.data.protocol };
  const parsed = InventoryBodySchema.safeParse(body);
  if (!parsed.success) return { kind: 'unreadable' };
  const entries = new Map<string, InventoryEntry>();
  for (const plugin of parsed.data.plugins) {
    // A duplicate id is a damaged inventory: refusing it is safer than picking one.
    if (entries.has(plugin.id)) return { kind: 'unreadable' };
    entries.set(plugin.id, { on: plugin.on, contract: plugin.contract });
  }
  return { kind: 'read', entries };
}

/** Why a package is blocked on one daemon. */
export type BlockReason =
  /** The inventory has not answered yet (bootstrap or a re-read after reconnect): calls wait, nothing is sent. */
  | 'unread'
  /** Not in this caller's projection: not installed there, or this device's grants admit none of it. */
  | 'missing'
  | 'off'
  /** Effective hashes differ: one side is a different build. */
  | 'different'
  /** A core piece is blocked, or the protocol differs: everything is blocked (the full-screen sentence). */
  | 'core'
  /** The inventory answer could not be read. */
  | 'unreadable';

export type Standing =
  | { readonly state: 'allowed' }
  | {
      readonly state: 'blocked';
      readonly reason: BlockReason;
      /** For `different`: the consumed package whose own hash also differs (`needs Board, which needs an update`). */
      readonly via?: string;
    };

const ALLOWED: Standing = Object.freeze({ state: 'allowed' });

function ownStanding(compiled: SurfaceEntry, entries: ReadonlyMap<string, InventoryEntry>): Standing {
  const entry = entries.get(compiled.id);
  if (entry === undefined) return { state: 'blocked', reason: 'missing' };
  if (!entry.on) return { state: 'blocked', reason: 'off' };
  if (entry.contract !== compiled.contract) return { state: 'blocked', reason: 'different' };
  return ALLOWED;
}

/**
 * Every compiled package's standing on one daemon. A core piece that is not allowed blocks everything (§9.6: "a core
 * hash mismatch blocks everything"). A package whose hash differs names the consumed package that also differs, so
 * its line says what it is waiting for.
 */
export function standings(
  inventory: Inventory | undefined,
  compiled: readonly SurfaceEntry[],
): ReadonlyMap<string, Standing> {
  const result = new Map<string, Standing>();
  const all = (standing: Standing): ReadonlyMap<string, Standing> => {
    for (const entry of compiled) result.set(entry.id, standing);
    return result;
  };
  if (inventory === undefined) return all({ state: 'blocked', reason: 'unread' });
  if (inventory.kind === 'unreadable') return all({ state: 'blocked', reason: 'unreadable' });
  if (inventory.kind === 'protocol-mismatch') return all({ state: 'blocked', reason: 'core' });

  const own = new Map(compiled.map(entry => [entry.id, ownStanding(entry, inventory.entries)] as const));
  const coreIds: readonly string[] = CORE_IDS;
  const coreBlocked = compiled.some(entry => coreIds.includes(entry.id) && own.get(entry.id)?.state !== 'allowed');
  if (coreBlocked) return all({ state: 'blocked', reason: 'core' });

  for (const entry of compiled) {
    const standing = own.get(entry.id) ?? ALLOWED;
    if (standing.state === 'blocked' && standing.reason === 'different') {
      const via = entry.consumes.find(id => {
        const consumed = own.get(id);
        return consumed?.state === 'blocked' && consumed.reason === 'different';
      });
      result.set(entry.id, via === undefined ? standing : { ...standing, via });
    } else {
      result.set(entry.id, standing);
    }
  }
  return result;
}

/** True when nothing may run on this daemon at all: the one full-screen sentence. */
export function wholeDaemonBlocked(inventory: Inventory | undefined, compiled: readonly SurfaceEntry[]): boolean {
  if (inventory === undefined) return false;
  if (inventory.kind !== 'read') return true;
  return [...standings(inventory, compiled).values()].some(s => s.state === 'blocked' && s.reason === 'core');
}

/** Which package owns an event, from its name (`board.changed` → `board`, `kernel.plugins-changed` → `kernel`). */
export function eventOwner(eventName: string): string {
  const dot = eventName.indexOf('.');
  return dot === -1 ? eventName : eventName.slice(0, dot);
}
