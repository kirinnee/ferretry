import { z } from 'zod';
import { APP_STORAGE } from '../storage/names.ts';
import { type KeyValueStore, readRecord, writeRecord } from '../storage/records.ts';

/**
 * THE DAEMON LIST (§5.1): every daemon this browser is paired with, grouped by machine. Copied in spirit from today's
 * PWA `lib/connections.ts` (`DaemonConnectionStore`), narrowed to what the shell owns:
 *
 * - the static bundle contains no default daemon, address or credential; every entry comes from a pairing at run time;
 * - an entry is an IDENTITY, not a credential: the device proves each session with a non-extractable key (Access
 *   owns it), and `deviceId` only says which key;
 * - the carrier set is Connections' fact: the shell keeps the daemon's published list as opaque records and never
 *   interprets it;
 * - removing a pairing calls `forget`, so the device key goes with the pairing it proved, and clears every daemon-scoped
 *   cache before the entry can be seen again.
 *
 * Stored under `fy:app:daemons` as `{ format: 1, value }`; an older record is never read (every device pairs again).
 */

export const MAX_DAEMONS = 20;

/**
 * A daemon's direct address: an origin, nothing else. Credentials, paths, queries and fragments are refused so every
 * adapter resolves the same `/v1` surface. Copied from today's `daemonBaseUrl`.
 */
export function daemonOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('daemon URL must be absolute');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('daemon URL must use http or https');
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('daemon URL may not include credentials, a query, or a fragment');
  }
  if (url.pathname !== '/') throw new Error('daemon URL must be an origin without a path');
  return url.origin;
}

const OriginSchema = z
  .string()
  .max(2048)
  .transform((value, ctx) => {
    try {
      return daemonOrigin(value);
    } catch (error) {
      ctx.addIssue({ code: 'custom', message: (error as Error).message });
      return z.NEVER;
    }
  });

export const PairedDaemonSchema = z.strictObject({
  daemon: z.string().min(1).max(128),
  /** What the daemon calls its machine (its host name, from the pairing answer). */
  machine: z.string().min(1).max(128),
  /** The owner's own name for this daemon, when they gave one. */
  label: z.string().min(1).max(80).optional(),
  deviceId: z.string().min(1).max(128),
  address: OriginSchema,
  /** The daemon's published carrier set, opaque to the shell (Connections parses it). */
  carriers: z.array(z.unknown()).max(16).default([]),
  pairedAt: z.number().int().nonnegative(),
  lastSelectedAt: z.number().int().nonnegative(),
});

export type PairedDaemon = z.infer<typeof PairedDaemonSchema>;

const ListSchema = z.strictObject({
  selected: z.string().nullable(),
  daemons: z.array(z.unknown()).max(MAX_DAEMONS * 2),
});

export interface DaemonListSnapshot {
  readonly daemons: readonly PairedDaemon[];
  readonly selected: string | null;
}

export interface MachineGroup {
  readonly machine: string;
  readonly daemons: readonly PairedDaemon[];
}

/** A cache keyed by daemon; cleared on unpair and on re-pair, before the new pairing is visible. */
export interface DaemonScopedCache {
  clearDaemon(daemon: string): void;
}

export interface DaemonListOptions {
  readonly storage: KeyValueStore | null;
  readonly now: () => number;
  readonly forget?: (daemon: string) => void;
}

/** A display name: the owner's label, else the machine name. */
export const daemonTitle = (daemon: PairedDaemon): string => daemon.label ?? daemon.machine;

/** Groups by machine (case-insensitive), machines and the daemons inside each sorted by name. */
export function groupByMachine(daemons: readonly PairedDaemon[]): readonly MachineGroup[] {
  const groups = new Map<string, PairedDaemon[]>();
  const names = new Map<string, string>();
  for (const daemon of daemons) {
    const key = daemon.machine.toLowerCase();
    names.set(key, names.get(key) ?? daemon.machine);
    groups.set(key, [...(groups.get(key) ?? []), daemon]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, list]) => ({
      machine: names.get(key) ?? key,
      daemons: [...list].sort(
        (a, b) => daemonTitle(a).localeCompare(daemonTitle(b)) || a.daemon.localeCompare(b.daemon),
      ),
    }));
}

function parseList(raw: z.infer<typeof ListSchema> | undefined): DaemonListSnapshot {
  if (raw === undefined) return { daemons: [], selected: null };
  const byId = new Map<string, PairedDaemon>();
  for (const candidate of raw.daemons) {
    const parsed = PairedDaemonSchema.safeParse(candidate);
    if (!parsed.success) continue;
    const previous = byId.get(parsed.data.daemon);
    if (previous === undefined || parsed.data.lastSelectedAt >= previous.lastSelectedAt) {
      byId.set(parsed.data.daemon, parsed.data);
    }
  }
  const daemons = [...byId.values()].sort((a, b) => b.lastSelectedAt - a.lastSelectedAt).slice(0, MAX_DAEMONS);
  const selected = raw.selected !== null && byId.has(raw.selected) ? raw.selected : (daemons[0]?.daemon ?? null);
  return { daemons, selected };
}

export interface PairingInput {
  readonly daemon: string;
  readonly machine: string;
  readonly deviceId: string;
  readonly address: string;
  readonly carriers?: readonly unknown[];
  readonly label?: string;
}

/** The list, shaped for `useSyncExternalStore`: `snapshot()` is identity-stable between changes. */
export class DaemonList {
  readonly #storage: KeyValueStore | null;
  readonly #now: () => number;
  readonly #forget: (daemon: string) => void;
  readonly #listeners = new Set<() => void>();
  readonly #caches = new Set<DaemonScopedCache>();
  #snapshot: DaemonListSnapshot;

  constructor(options: DaemonListOptions) {
    this.#storage = options.storage;
    this.#now = options.now;
    this.#forget = options.forget ?? (() => {});
    this.#snapshot = parseList(readRecord(this.#storage, APP_STORAGE.daemons, ListSchema));
  }

  snapshot = (): DaemonListSnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  registerCache(cache: DaemonScopedCache): () => void {
    this.#caches.add(cache);
    return () => this.#caches.delete(cache);
  }

  get(daemon: string): PairedDaemon | undefined {
    return this.#snapshot.daemons.find(entry => entry.daemon === daemon);
  }

  groups(): readonly MachineGroup[] {
    return groupByMachine(this.#snapshot.daemons);
  }

  /** Adds a pairing, or replaces it on a re-pair (keeping its label and first pairing time). */
  add(input: PairingInput): PairedDaemon {
    const now = this.#now();
    const existing = this.get(input.daemon);
    const record = PairedDaemonSchema.parse({
      daemon: input.daemon,
      machine: input.machine,
      deviceId: input.deviceId,
      address: input.address,
      carriers: input.carriers ?? [],
      pairedAt: existing?.pairedAt ?? now,
      lastSelectedAt: now,
      ...((input.label ?? existing?.label) === undefined ? {} : { label: input.label ?? existing?.label }),
    });
    for (const cache of this.#caches) cache.clearDaemon(record.daemon);
    const others = this.#snapshot.daemons.filter(entry => entry.daemon !== record.daemon);
    const kept = [record, ...others].slice(0, MAX_DAEMONS);
    for (const evicted of [record, ...others].slice(MAX_DAEMONS)) this.#gone(evicted.daemon);
    this.#commit({ daemons: kept, selected: record.daemon });
    return record;
  }

  remove(daemon: string): void {
    if (this.get(daemon) === undefined) return;
    const daemons = this.#snapshot.daemons.filter(entry => entry.daemon !== daemon);
    this.#gone(daemon);
    const selected = this.#snapshot.selected === daemon ? (daemons[0]?.daemon ?? null) : this.#snapshot.selected;
    this.#commit({ daemons, selected });
  }

  rename(daemon: string, label: string | undefined): void {
    const trimmed = label?.trim();
    this.#replace(daemon, entry => {
      const { label: _old, ...rest } = entry;
      return trimmed === undefined || trimmed.length === 0 ? rest : { ...rest, label: trimmed.slice(0, 80) };
    });
  }

  select(daemon: string): void {
    if (this.get(daemon) === undefined) return;
    const now = this.#now();
    this.#replace(daemon, entry => ({ ...entry, lastSelectedAt: now }), daemon);
  }

  /** The daemon published a new carrier set (Connections read `GET /v1/carriers`). */
  setCarriers(daemon: string, carriers: readonly unknown[]): void {
    this.#replace(daemon, entry => ({ ...entry, carriers: [...carriers].slice(0, 16) }));
  }

  /** The daemon said what its machine is called. */
  learnMachine(daemon: string, machine: string): void {
    const name = machine.trim().slice(0, 128);
    if (name.length === 0) return;
    this.#replace(daemon, entry => (entry.machine === name ? entry : { ...entry, machine: name }));
  }

  #replace(daemon: string, edit: (entry: PairedDaemon) => PairedDaemon, selected = this.#snapshot.selected): void {
    let changed = false;
    const daemons = this.#snapshot.daemons.map(entry => {
      if (entry.daemon !== daemon) return entry;
      const next = edit(entry);
      changed ||= next !== entry;
      return next;
    });
    if (!changed && selected === this.#snapshot.selected) return;
    this.#commit({ daemons, selected });
  }

  #gone(daemon: string): void {
    for (const cache of this.#caches) cache.clearDaemon(daemon);
    this.#forget(daemon);
  }

  #commit(next: DaemonListSnapshot): void {
    this.#snapshot = next;
    writeRecord(this.#storage, APP_STORAGE.daemons, { selected: next.selected, daemons: next.daemons });
    for (const listener of this.#listeners) listener();
  }
}
