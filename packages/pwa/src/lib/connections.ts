import {
  type DaemonConnection,
  type DaemonConnectionInput,
  type DaemonId,
  daemonConnection,
  daemonId,
  daemonRelayCarrier,
  type RelayCarrier,
  sameDaemonConnection,
} from './daemon-connection.ts';

/** Repository key reserved for the browser's IndexedDB-backed connection record. */
export const CONNECTIONS_KEY = 'fy-connections-v1';
export const CONNECTIONS_VERSION = 1 as const;
export const MAX_CONNECTIONS = 20;

/** One paired daemon and the reader-local metadata used to order the picker. */
export interface DaemonConnectionRecord extends DaemonConnection {
  readonly label?: string;
  readonly pairedAt: number;
  readonly lastSelectedAt: number;
}

export interface DaemonConnectionsSnapshot {
  readonly connections: readonly DaemonConnectionRecord[];
  readonly selectedDaemonId: DaemonId | null;
}

/** Async seam intentionally compatible with IndexedDB rather than browser globals. */
export interface DaemonConnectionRepository {
  load(key: string): Promise<string | null>;
  save(key: string, value: string): Promise<void>;
}

/** Every daemon-derived cache participates in unpair/re-pair invalidation. */
export interface DaemonScopedCache {
  clearDaemon(daemonId: DaemonId): void;
}

export interface DaemonConnectionStoreOptions {
  readonly repository?: DaemonConnectionRepository;
  readonly caches?: readonly DaemonScopedCache[];
  readonly maxConnections?: number;
  readonly now?: () => number;
}

export interface AddDaemonConnectionOptions {
  readonly label?: string;
  readonly pairedAt?: number;
}

type Listener = () => void;

const emptySnapshot = (): DaemonConnectionsSnapshot => ({ connections: [], selectedDaemonId: null });

const timestamp = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

const label = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized === '' ? undefined : normalized;
};

/**
 * A STORED RELAY CARRIER, AND THE ONE THAT IS DELIBERATELY NOT RESTORED.
 *
 * A relay somebody runs themselves has no runtime source: its address is a value
 * its owner supplied, so forgetting it across a reload would silently take the
 * only carrier a NAT-bound daemon had. That one is persisted, and an absent
 * `operator` reads as `'self'` — the relay package's own documented rule, because
 * a record written before the field existed can only have described a relay its
 * owner deployed.
 *
 * FERRETRY'S HOSTED CARRIER IS NOT RESTORED FROM STORAGE, EVER. Its address is a
 * `no-store` runtime advertisement precisely so its operator can change or
 * withdraw it without an app release (§13), and `relayUrl: null` is a kill switch.
 * A browser that dialled a remembered hosted address would be a browser the kill
 * switch does not reach — the switch not working. So a stored hosted row is
 * dropped on load and the live advertisement is asked again, which is strictly
 * stronger than surviving a reload.
 */
const relayFrom = (value: unknown): RelayCarrier | undefined => {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.kind !== 'relay' || typeof raw.relayUrl !== 'string') return undefined;
  const operator = raw.operator === undefined ? 'self' : raw.operator;
  if (operator !== 'self') return undefined;
  return { kind: 'relay', relayUrl: raw.relayUrl, operator };
};

const recordFrom = (value: unknown): DaemonConnectionRecord | undefined => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const pairedAt = timestamp(raw.pairedAt);
  const lastSelectedAt = timestamp(raw.lastSelectedAt);
  if (
    typeof raw.daemonId !== 'string' ||
    typeof raw.baseUrl !== 'string' ||
    typeof raw.deviceToken !== 'string' ||
    pairedAt === undefined ||
    lastSelectedAt === undefined
  )
    return undefined;
  try {
    const connection = daemonConnection({
      daemonId: raw.daemonId,
      baseUrl: raw.baseUrl,
      deviceToken: raw.deviceToken,
      relay: relayFrom(raw.relay),
    });
    const displayLabel = label(raw.label);
    return { ...connection, ...(displayLabel ? { label: displayLabel } : {}), pairedAt, lastSelectedAt };
  } catch {
    return undefined;
  }
};

const bounded = (
  records: readonly DaemonConnectionRecord[],
  selectedDaemonId: DaemonId | null,
  maximum: number,
): readonly DaemonConnectionRecord[] =>
  [...records]
    .sort((left, right) => {
      if (left.daemonId === selectedDaemonId) return -1;
      if (right.daemonId === selectedDaemonId) return 1;
      return right.lastSelectedAt - left.lastSelectedAt || left.daemonId.localeCompare(right.daemonId);
    })
    .slice(0, maximum);

/** Tolerantly parses one versioned browser record and drops malformed rows whole. */
export const parseDaemonConnections = (raw: string | null, maximum = MAX_CONNECTIONS): DaemonConnectionsSnapshot => {
  if (!raw || !Number.isInteger(maximum) || maximum < 1) return emptySnapshot();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return emptySnapshot();
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return emptySnapshot();
  const document = value as Record<string, unknown>;
  if (document.v !== CONNECTIONS_VERSION || !Array.isArray(document.connections)) return emptySnapshot();

  const byId = new Map<DaemonId, DaemonConnectionRecord>();
  for (const candidate of document.connections) {
    const record = recordFrom(candidate);
    if (record === undefined) continue;
    const previous = byId.get(record.daemonId);
    if (previous === undefined || record.lastSelectedAt >= previous.lastSelectedAt) byId.set(record.daemonId, record);
  }
  let requested: DaemonId | null = null;
  if (typeof document.selectedDaemonId === 'string') {
    try {
      requested = daemonId(document.selectedDaemonId);
    } catch {
      requested = null;
    }
  }
  const selected = requested !== null && byId.has(requested) ? requested : null;
  let connections = bounded([...byId.values()], selected, maximum);
  const selectedDaemonId = selected ?? connections[0]?.daemonId ?? null;
  connections = bounded(connections, selectedDaemonId, maximum);
  return { connections, selectedDaemonId };
};

const serialized = (snapshot: DaemonConnectionsSnapshot): string =>
  JSON.stringify({
    v: CONNECTIONS_VERSION,
    selectedDaemonId: snapshot.selectedDaemonId,
    connections: snapshot.connections,
  });

/**
 * The liveness test, borrowed rather than restated.
 *
 * This used to be a second copy of the field-by-field comparison in
 * `daemon-connection.ts`. Two copies is how a field added to one — the relay
 * carrier, here — gets forgotten by the other, and the forgotten one is the one
 * that decides whether a daemon's caches are invalidated.
 */
const sameConnection = sameDaemonConnection;

/**
 * Document-lifetime registry for every runtime-paired daemon.
 *
 * The static bundle contains no default URL, identity, or credential. A host
 * loads and saves the versioned record through the injected repository (the
 * architecture's browser implementation is IndexedDB), while all consumers
 * read an immutable external-store snapshot. Re-pair and unpair invalidate
 * every registered daemon cache before the old credential can remain visible.
 */
export class DaemonConnectionStore {
  #snapshot: DaemonConnectionsSnapshot;
  readonly #listeners = new Set<Listener>();
  readonly #caches = new Set<DaemonScopedCache>();
  readonly #repository: DaemonConnectionRepository | undefined;
  readonly #maximum: number;
  readonly #now: () => number;
  #write: Promise<void> = Promise.resolve();

  constructor(initial: DaemonConnectionsSnapshot = emptySnapshot(), options: DaemonConnectionStoreOptions = {}) {
    const maximum = options.maxConnections ?? MAX_CONNECTIONS;
    if (!Number.isInteger(maximum) || maximum < 1) throw new Error('maxConnections must be a positive integer');
    this.#maximum = maximum;
    this.#repository = options.repository;
    this.#now = options.now ?? Date.now;
    const selected = initial.selectedDaemonId;
    let connections = bounded(initial.connections, selected, maximum);
    const selectedDaemonId =
      selected !== null && connections.some(record => record.daemonId === selected)
        ? selected
        : (connections[0]?.daemonId ?? null);
    connections = bounded(connections, selectedDaemonId, maximum);
    this.#snapshot = {
      connections,
      selectedDaemonId,
    };
    for (const cache of options.caches ?? []) this.#caches.add(cache);
  }

  static async open(options: DaemonConnectionStoreOptions = {}): Promise<DaemonConnectionStore> {
    let initial = emptySnapshot();
    if (options.repository !== undefined) {
      try {
        initial = parseDaemonConnections(
          await options.repository.load(CONNECTIONS_KEY),
          options.maxConnections ?? MAX_CONNECTIONS,
        );
      } catch {
        // Persistence is best-effort; pairing can recover an empty registry.
      }
    }
    return new DaemonConnectionStore(initial, options);
  }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  getSnapshot(): DaemonConnectionsSnapshot {
    return this.#snapshot;
  }

  list(): readonly DaemonConnectionRecord[] {
    return this.#snapshot.connections;
  }

  get(id: DaemonId): DaemonConnectionRecord | undefined {
    return this.#snapshot.connections.find(record => record.daemonId === id);
  }

  selected(): DaemonConnectionRecord | undefined {
    return this.#snapshot.selectedDaemonId === null ? undefined : this.get(this.#snapshot.selectedDaemonId);
  }

  registerCache(cache: DaemonScopedCache): () => void {
    this.#caches.add(cache);
    return () => this.#caches.delete(cache);
  }

  add(
    input: DaemonConnectionInput | DaemonConnection,
    options: AddDaemonConnectionOptions = {},
  ): DaemonConnectionRecord {
    const connection = daemonConnection(input);
    const existing = this.get(connection.daemonId);
    const displayLabel = label(options.label) ?? existing?.label;
    const pairedAt = timestamp(options.pairedAt) ?? existing?.pairedAt ?? this.#now();
    const record: DaemonConnectionRecord = {
      ...connection,
      ...(displayLabel ? { label: displayLabel } : {}),
      pairedAt,
      lastSelectedAt: this.#now(),
    };
    if (
      existing !== undefined &&
      sameConnection(existing, record) &&
      existing.label === record.label &&
      this.#snapshot.selectedDaemonId === record.daemonId
    )
      return existing;
    if (existing !== undefined && !sameConnection(existing, record)) this.#clearDaemon(record.daemonId);

    const previousIds = new Set(this.#snapshot.connections.map(candidate => candidate.daemonId));
    const candidates = [
      record,
      ...this.#snapshot.connections.filter(candidate => candidate.daemonId !== record.daemonId),
    ];
    const connections = bounded(candidates, record.daemonId, this.#maximum);
    for (const id of previousIds) {
      if (!connections.some(candidate => candidate.daemonId === id)) this.#clearDaemon(id);
    }
    this.#publish({ connections, selectedDaemonId: record.daemonId });
    return record;
  }

  select(id: DaemonId): DaemonConnectionRecord {
    const existing = this.get(id);
    if (existing === undefined) throw new Error(`daemon ${id} is not paired`);
    if (this.#snapshot.selectedDaemonId === id) return existing;
    const selected = { ...existing, lastSelectedAt: this.#now() };
    const connections = bounded(
      [selected, ...this.#snapshot.connections.filter(record => record.daemonId !== id)],
      id,
      this.#maximum,
    );
    this.#publish({ connections, selectedDaemonId: id });
    return selected;
  }

  /** Changes only the reader-local display name for one paired daemon. */
  rename(id: DaemonId, nextLabel?: string): DaemonConnectionRecord {
    const existing = this.get(id);
    if (existing === undefined) throw new Error(`daemon ${id} is not paired`);
    const displayLabel = label(nextLabel);
    if (existing.label === displayLabel) return existing;
    const { label: _previousLabel, ...connection } = existing;
    const renamed: DaemonConnectionRecord =
      displayLabel === undefined ? connection : { ...connection, label: displayLabel };
    const connections = this.#snapshot.connections.map(record => (record.daemonId === id ? renamed : record));
    this.#publish({ connections, selectedDaemonId: this.#snapshot.selectedDaemonId });
    return renamed;
  }

  /**
   * Records the rendezvous this daemon may be reached through, or that there is none.
   *
   * Called from the composition root with whatever the live advertisement says, on
   * every load — so `undefined` here is a real answer and not an omission: a relay
   * that was switched off, or a discovery that could not be completed, must leave
   * this browser with direct as its only carrier rather than a remembered address.
   *
   * DAEMON CACHES ARE NOT CLEARED. A carrier change moves where the bytes travel;
   * it does not rotate a credential and it does not change whose data this is. What
   * DOES re-derive is anything holding a live connection, because
   * `sameDaemonConnection` counts the carrier — which is the boundary that matters.
   */
  attachRelay(id: DaemonId, relay: RelayCarrier | undefined): DaemonConnectionRecord | undefined {
    const existing = this.get(id);
    if (existing === undefined) return undefined;
    if (existing.relay?.relayUrl === relay?.relayUrl && existing.relay?.operator === relay?.operator) return existing;
    const { relay: _previous, ...rest } = existing;
    const updated: DaemonConnectionRecord = relay === undefined ? rest : { ...rest, relay: daemonRelayCarrier(relay) };
    const connections = this.#snapshot.connections.map(record => (record.daemonId === id ? updated : record));
    this.#publish({ connections, selectedDaemonId: this.#snapshot.selectedDaemonId });
    return updated;
  }

  remove(id: DaemonId): boolean {
    if (this.get(id) === undefined) return false;
    const connections = this.#snapshot.connections.filter(record => record.daemonId !== id);
    const selectedDaemonId =
      this.#snapshot.selectedDaemonId === id ? (connections[0]?.daemonId ?? null) : this.#snapshot.selectedDaemonId;
    this.#clearDaemon(id);
    this.#publish({ connections, selectedDaemonId });
    return true;
  }

  /** Resolves when all best-effort repository writes scheduled so far settle. */
  flush(): Promise<void> {
    return this.#write;
  }

  #clearDaemon(id: DaemonId): void {
    for (const cache of this.#caches) {
      try {
        cache.clearDaemon(id);
      } catch {
        // One faulty cache must not retain credentials or block the others.
      }
    }
  }

  #publish(snapshot: DaemonConnectionsSnapshot): void {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
    if (this.#repository === undefined) return;
    const value = serialized(snapshot);
    this.#write = this.#write
      .catch(() => undefined)
      .then(async () => await this.#repository?.save(CONNECTIONS_KEY, value))
      .then(() => undefined)
      .catch(() => undefined);
  }
}
