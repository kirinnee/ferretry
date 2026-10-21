/**
 * SOLE OWNER of the `fy-carrier-preference-v1` browser-storage key: which carriers THIS browser walks to
 * reach each paired machine, and in what order (`docs/relay-protocol.md` §15 "The choice").
 *
 * PER DEVICE AND PER MACHINE, AND NEVER SENT ANYWHERE. The daemon publishes the carriers it holds and
 * never reads a preference; this only decides which of them this browser tries. It is keyed by the
 * daemon's fingerprint (`daemonId`), so a re-pair of the same machine keeps it and a second machine
 * has its own.
 *
 * AUTO IS THE DEFAULT, AND THE ANSWER TO ANYTHING THIS BUILD DOES NOT RECOGNISE. A stored value that is
 * not one of the four words — hand-edited, from a newer build, half-written — reads as `auto` rather
 * than as an error: the person loses a narrowing they may not remember making, never the connection.
 *
 * The shape is `table-view-preference.ts`'s: an injected storage, a defensive parse, a denied storage
 * treated as an ordinary browser condition, and one identity-stable snapshot for `useSyncExternalStore`.
 */

import type { DaemonId } from './daemon-connection.ts';

/** The sole browser-storage key for the per-machine connection preference. */
export const CARRIER_PREFERENCE_KEY = 'fy-carrier-preference-v1';

/** What a person chose for one machine. */
export type CarrierPreference = 'auto' | 'webrtc' | 'tunnel' | 'relay';

/** The four carriers a walk can try. */
export type CarrierKind = 'direct' | 'webrtc' | 'tunnel' | 'relay';

export const DEFAULT_CARRIER_PREFERENCE: CarrierPreference = 'auto';

/** Every preference, in the order a selector offers them. */
export const CARRIER_PREFERENCES: readonly CarrierPreference[] = ['auto', 'webrtc', 'tunnel', 'relay'];

/** How each preference is named wherever a person reads it — the selector, and a failure that names it. */
export const CARRIER_PREFERENCE_LABEL: Readonly<Record<CarrierPreference, string>> = {
  auto: 'Auto',
  webrtc: 'WebRTC only',
  tunnel: 'Tunnel only',
  relay: 'Relay only',
};

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

/** Anything but the four known words is Auto. */
export const parseCarrierPreference = (raw: unknown): CarrierPreference =>
  typeof raw === 'string' && (CARRIER_PREFERENCES as readonly string[]).includes(raw)
    ? (raw as CarrierPreference)
    : DEFAULT_CARRIER_PREFERENCE;

/** Every machine's preference. A machine that is absent is on Auto. */
export type CarrierPreferences = Readonly<Record<string, CarrierPreference>>;

/**
 * The stored map, read defensively: a document that is not an object is no preferences at all, and
 * an entry that is not a known word is dropped (so it reads as Auto) rather than refusing the rest.
 * Auto is never stored, because absent already means it.
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
    if (preference !== DEFAULT_CARRIER_PREFERENCE) preferences[daemonId] = preference;
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

  /** One machine's preference. */
  preference = (daemonId: DaemonId): CarrierPreference => this.snapshot()[daemonId] ?? DEFAULT_CARRIER_PREFERENCE;

  /** Told which machine changed, so a router can forget only that machine's winner. */
  subscribe = (listener: (daemonId: DaemonId) => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** A failed write still changes the preference for the rest of this tab. */
  set(daemonId: DaemonId, preference: CarrierPreference): void {
    if (this.preference(daemonId) === preference) return;
    const next: Record<string, CarrierPreference> = { ...this.snapshot() };
    if (preference === DEFAULT_CARRIER_PREFERENCE) delete next[daemonId];
    else next[daemonId] = preference;
    this.#preferences = next;
    try {
      this.#storage?.setItem(CARRIER_PREFERENCE_KEY, JSON.stringify(next));
    } catch {
      // Storage denied (private mode, quota): the in-memory choice still applies.
    }
    for (const listener of this.#listeners) listener(daemonId);
  }

  #load(): CarrierPreferences {
    try {
      return parseCarrierPreferences(this.#storage?.getItem(CARRIER_PREFERENCE_KEY));
    } catch {
      return {};
    }
  }
}
