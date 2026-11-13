/**
 * This browser’s per-machine carrier preference. Absent means the DEFAULT: Relay, which — because nobody chose it —
 * falls back to the direct address the device paired over when the relay cannot be reached (§15). A saved `relay` is
 * "Relay only", a choice, and stays strict.
 */

type DaemonId = string;

/** The sole browser-storage key for the per-machine connection preference. */
export const CARRIER_PREFERENCE_KEY = 'fy-carrier-preference-v1';

/** What a person chose for one machine. */
export type CarrierPreference = 'auto' | 'webrtc' | 'tunnel' | 'relay';

/** The four carriers a walk can try. */
export type CarrierKind = 'direct' | 'webrtc' | 'tunnel' | 'relay';

export const DEFAULT_CARRIER_PREFERENCE: CarrierPreference = 'relay';

/** Every preference, in the order a selector offers them. */
export const CARRIER_PREFERENCES: readonly CarrierPreference[] = ['auto', 'webrtc', 'tunnel', 'relay'];

/** How each preference is named wherever a person reads it — the selector, and a failure that names it. */
export const CARRIER_PREFERENCE_LABEL: Readonly<Record<CarrierPreference, string>> = {
  auto: 'Auto',
  webrtc: 'WebRTC only',
  tunnel: 'Tunnel only',
  relay: 'Relay only',
};

/**
 * What a selector offers: the four preferences a person can choose, and the DEFAULT — nothing chosen. The default walks
 * Relay and, when the relay cannot be reached, uses the direct address the device paired over; "Relay only" is a
 * choice and never does.
 */
export type CarrierSetting = CarrierPreference | 'default';

/** Every setting, in the order a selector offers them. */
export const CARRIER_SETTINGS: readonly CarrierSetting[] = ['default', ...CARRIER_PREFERENCES];

/** How the default is named wherever a person reads it. */
export const DEFAULT_SETTING_LABEL = 'Relay (default)';

/** A machine's setting: what was chosen, or the default when nothing was. */
export const settingOf = (chosen: CarrierPreference | undefined): CarrierSetting => chosen ?? 'default';

/** Auto's walk (§15): direct has the fewest parties, WebRTC is the first remote carrier, the relay is last. */
const AUTO_ORDER: readonly CarrierKind[] = ['direct', 'webrtc', 'tunnel', 'relay'];

/**
 * The carrier kinds a preference walks, in order: Auto walks all four, and "X only" walks X.
 *
 * WebRTC only still USES another carrier to introduce the two ends — that is signalling, owned by the
 * WebRTC dialer, and never the session's bytes, so it is not a kind this walk tries.
 */
export const carrierOrder = (preference: CarrierPreference): readonly CarrierKind[] =>
  preference === 'auto' ? AUTO_ORDER : [preference];

/** One of the four known words, or nothing: anything else is no choice at all (so it reads as the unchosen default). */
export const parseCarrierPreference = (raw: unknown): CarrierPreference | undefined =>
  typeof raw === 'string' && (CARRIER_PREFERENCES as readonly string[]).includes(raw)
    ? (raw as CarrierPreference)
    : undefined;

/** Every machine's CHOSEN preference. A machine that is absent is on the default: Relay, unchosen. */
export type CarrierPreferences = Readonly<Record<string, CarrierPreference>>;

/**
 * The stored map, read defensively: a document that is not an object is no preferences at all, and
 * an entry that is not a known word is dropped (so it reads as the unchosen default) rather than refusing the rest.
 * A saved `relay` is kept: it is "Relay only", a choice, and is told apart from absent, the default.
 */
export const parseCarrierPreferences = (raw: string | null | undefined): CarrierPreferences => {
  if (raw === null || raw === undefined) return {};
  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return {};
  const preferences: Record<string, CarrierPreference> = {};
  for (const [daemonId, value] of Object.entries(document)) {
    const preference = parseCarrierPreference(value);
    if (preference !== undefined) preferences[daemonId] = preference;
  }
  return preferences;
};

export interface CarrierPreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const browserStorage = (): CarrierPreferenceStorage | undefined => {
  try {
    const candidate = (globalThis as { localStorage?: CarrierPreferenceStorage }).localStorage;
    return candidate && typeof candidate.getItem === 'function' && typeof candidate.setItem === 'function'
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
};

/** This browser's connection preference for every machine, shaped for `useSyncExternalStore`. */
export class CarrierPreferenceStore {
  readonly #storage: CarrierPreferenceStorage | undefined;
  readonly #listeners = new Set<(daemonId: DaemonId) => void>();
  #preferences: CarrierPreferences | null = null;

  constructor(storage: CarrierPreferenceStorage | undefined = browserStorage()) {
    this.#storage = storage;
  }

  /** Every machine's preference; the first read hydrates from storage. Identity-stable until a change. */
  snapshot = (): CarrierPreferences => {
    this.#preferences ??= this.#load();
    return this.#preferences;
  };

  /** One machine's preference: what the walk follows. An unchosen machine reads as the default, Relay. */
  preference = (daemonId: DaemonId): CarrierPreference => this.snapshot()[daemonId] ?? DEFAULT_CARRIER_PREFERENCE;

  /** Whether the person chose this machine's preference. Unchosen Relay may fall back to the paired direct address. */
  chosen = (daemonId: DaemonId): boolean => this.snapshot()[daemonId] !== undefined;

  /** Told which machine changed, so a router can forget only that machine's winner. */
  subscribe = (listener: (daemonId: DaemonId) => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Chooses one machine's preference — "Relay only" included. A failed write still changes it for the rest of this tab. */
  set(daemonId: DaemonId, preference: CarrierPreference): void {
    if (this.snapshot()[daemonId] === preference) return;
    const next: Record<string, CarrierPreference> = { ...this.snapshot(), [daemonId]: preference };
    this.#commit(daemonId, next);
  }

  /** Forgets the choice: the machine is back on the default, Relay, which may fall back to the paired direct address. */
  reset(daemonId: DaemonId): void {
    if (this.snapshot()[daemonId] === undefined) return;
    const next: Record<string, CarrierPreference> = { ...this.snapshot() };
    delete next[daemonId];
    this.#commit(daemonId, next);
  }

  #commit(daemonId: DaemonId, next: Record<string, CarrierPreference>): void {
    this.#preferences = next;
    this.#persist(next);
    for (const listener of this.#listeners) listener(daemonId);
  }

  #load(): CarrierPreferences {
    try {
      const current = this.#storage?.getItem(CARRIER_PREFERENCE_KEY);
      if (current !== null && current !== undefined) return parseCarrierPreferences(current);
      return {};
    } catch {
      return {};
    }
  }

  #persist(preferences: CarrierPreferences): void {
    try {
      this.#storage?.setItem(CARRIER_PREFERENCE_KEY, JSON.stringify(preferences));
    } catch {
      // Storage denied (private mode, quota): the in-memory choice still applies.
    }
  }
}
