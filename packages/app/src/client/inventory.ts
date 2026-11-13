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
  /**
   * The answer was not an inventory, or never arrived. Damaged is not empty: everything stays blocked. `cause` is the
   * session's own sentence when the read failed on the way (which carrier could not carry it), capped, never a body.
   */
  | { readonly kind: 'unreadable'; readonly cause?: string };

/** The longest cause kept: a sentence to read to someone, not a log line. */
const CAUSE_MAX = 240;

/** An unreadable list because the read itself failed: the failure's sentence is kept, capped, so the screen can name it. */
export function unreadableBecause(error: unknown): Inventory {
  const message = error instanceof Error ? error.message.trim().replace(/\s+/gu, ' ') : '';
  return message === '' ? { kind: 'unreadable' } : { kind: 'unreadable', cause: message.slice(0, CAUSE_MAX) };
}

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

/**
 * Why a whole daemon is blocked, in words an owner can read to a person helping: which core piece, and how it failed
 * (`kernel: its contract differs`), or that the protocol differs, or why the answer could not be read — the carrier's own
 * sentence, alone: the line above it already says the list could not be read, so a second "could not be read:" only
 * stacks colons ("Why: Relay only — there is no relay for this machine right now."). Names
 * ids and reasons only, never a hash or a body. `undefined` when nothing is blocked (or the answer has not come).
 *
 * The one full-screen sentence is the same for every core cause, so without this a mismatch, a missing piece and a
 * damaged answer all read "Reload to get the new app." and cannot be told apart.
 */
export function wholeDaemonWhy(
  inventory: Inventory | undefined,
  compiled: readonly SurfaceEntry[],
): string | undefined {
  if (inventory === undefined) return undefined;
  if (inventory.kind === 'unreadable')
    return inventory.cause === undefined
      ? 'the plugin list this daemon sent could not be read'
      : inventory.cause.replace(/[.\s]+$/u, '');
  if (inventory.kind === 'protocol-mismatch')
    return `this app speaks protocol ${PROTOCOL}, this daemon speaks protocol ${inventory.daemonProtocol}`;
  const coreIds: readonly string[] = CORE_IDS;
  const words: Record<'missing' | 'off' | 'different', string> = {
    missing: 'is not in the list',
    off: 'is off',
    different: 'has a different contract',
  };
  const causes = compiled
    .filter(entry => coreIds.includes(entry.id))
    .flatMap(entry => {
      const own = ownStanding(entry, inventory.entries);
      return own.state === 'blocked' && own.reason !== 'core' && own.reason in words
        ? [`${entry.id} ${words[own.reason as keyof typeof words]}`]
        : [];
    });
  return causes.length === 0 ? undefined : causes.join('; ');
}
