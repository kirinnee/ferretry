/**
 * SOLE OWNER of the `fy-carrier-preference-v2` browser-storage key (and the only reader of its retired v1 predecessor): which carriers THIS browser walks to
 * reach each paired machine, and in what order (`docs/relay-protocol.md` §15 "The choice").
 *
 * PER DEVICE AND PER MACHINE, AND NEVER SENT ANYWHERE. The daemon publishes the carriers it holds and
 * never reads a preference; this only decides which of them this browser tries. It is keyed by the
 * daemon's fingerprint (`daemonId`), so a re-pair of the same machine keeps it and a second machine
 * has its own.
 *
 * RELAY IS THE DEFAULT, AND THE ANSWER TO ANYTHING THIS BUILD DOES NOT RECOGNISE. A machine nobody chose
 * for goes through the relay; a stored value that is not one of the four words — hand-edited, from a
 * newer build, half-written — reads as `relay` rather than as an error: the person loses a choice they
 * may not remember making, never the connection. Auto is still offered, but only as an explicit choice,
 * so it IS stored (absent means Relay).
 *
 * v1 stored Auto as "absent", so a v1 entry cannot tell "chose Auto" from "never chose". The v2 key starts
 * from the v1 entries that WERE a deliberate narrowing and leaves Auto behind: those machines move to
 * the default, and a person who really wants Auto picks it once.
 *
 * The shape is `table-view-preference.ts`'s: an injected storage, a defensive parse, a denied storage
 * treated as an ordinary browser condition, and one identity-stable snapshot for `useSyncExternalStore`.
 */

import type { DaemonId } from './daemon-connection.ts';

/** The sole browser-storage key for the per-machine connection preference. */
export const CARRIER_PREFERENCE_KEY = 'fy-carrier-preference-v2';

/** The retired key, read once to carry deliberate choices forward and never written. */
export const LEGACY_CARRIER_PREFERENCE_KEY = 'fy-carrier-preference-v1';

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

/** Anything but the four known words is the default (Relay). */
export const parseCarrierPreference = (raw: unknown): CarrierPreference =>
  typeof raw === 'string' && (CARRIER_PREFERENCES as readonly string[]).includes(raw)
    ? (raw as CarrierPreference)
    : DEFAULT_CARRIER_PREFERENCE;

/** Every machine's preference. A machine that is absent is on the default, Relay. */
export type CarrierPreferences = Readonly<Record<string, CarrierPreference>>;

/**
 * The stored map, read defensively: a document that is not an object is no preferences at all, and
 * an entry that is not a known word is dropped (so it reads as Relay) rather than refusing the rest.
 * Relay is never stored, because absent already means it; Auto is, because it no longer does.
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

/**
 * The retired v1 document, read for what was a DELIBERATE choice: WebRTC only and Tunnel only. Auto was
 * v1's "absent" (and was never stored), so it is not a choice to carry; Relay is the default now and
 * needs no entry. Anything unreadable carries nothing.
 */
export const migrateLegacyCarrierPreferences = (raw: string | null | undefined): CarrierPreferences => {
  const legacy = parseLegacyDocument(raw);
  const preferences: Record<string, CarrierPreference> = {};
  for (const [daemonId, value] of Object.entries(legacy)) {
    if (value === 'webrtc' || value === 'tunnel') preferences[daemonId] = value;
  }
  return preferences;
};

const parseLegacyDocument = (raw: string | null | undefined): Record<string, unknown> => {
  if (raw === null || raw === undefined) return {};
  try {
    const document: unknown = JSON.parse(raw);
    return typeof document === 'object' && document !== null && !Array.isArray(document)
      ? (document as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
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
    this.#persist(next);
    for (const listener of this.#listeners) listener(daemonId);
  }

  #load(): CarrierPreferences {
    try {
      const current = this.#storage?.getItem(CARRIER_PREFERENCE_KEY);
      if (current !== null && current !== undefined) return parseCarrierPreferences(current);
      const migrated = migrateLegacyCarrierPreferences(this.#storage?.getItem(LEGACY_CARRIER_PREFERENCE_KEY));
      this.#persist(migrated);
      return migrated;
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
