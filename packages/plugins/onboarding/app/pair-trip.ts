/**
 * SOLE OWNER of the `fy:onboarding:pair-trip` browser-storage key: which pairings this browser held when the first run's
 * pairing step sent the person to Access's `/pair` page.
 *
 * It lives beside the place `fy:onboarding:progress` keeps (written at the same moment), so a reload on the pairing page
 * — which forgets everything in memory — still comes back to a step that can tell "a pairing was made since I left"
 * from "that machine was already here".
 *
 * IT HOLDS A SHORT LIST OF MARKS (machine id and device id) AND NOTHING ELSE. Never a pairing code, address or
 * fingerprint: the pairing page takes its own code from the address, and this file has no way to be handed one. Anything
 * stored that is not a short list of short strings reads as nothing (the step then counts from the list as it is, the
 * conservative reading).
 */

export const ONBOARDING_PAIR_TRIP_KEY = 'fy:onboarding:pair-trip';

export interface PairTripStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** `localStorage`, or nothing — Safari private mode throws on the property itself. */
export const browserPairTripStorage = (): PairTripStorage | undefined => {
  try {
    const candidate = (globalThis as { localStorage?: PairTripStorage }).localStorage;
    return candidate &&
      typeof candidate.getItem === 'function' &&
      typeof candidate.setItem === 'function' &&
      typeof candidate.removeItem === 'function'
      ? candidate
      : undefined;
  } catch {
    return undefined;
  }
};

/** The most pairings one list can hold (the shell's `MAX_DAEMONS`, with room): what a kept trip may name. */
const MAX_MARKS = 40;
const MAX_MARK_LENGTH = 300;

/** What the paired list says about one pairing: which machine, and which device grant this browser holds for it. */
export interface PairingIdentity {
  readonly daemon: string;
  readonly deviceId?: string;
}

/**
 * ONE MARK PER PAIRING, NOT A COUNT. A re-pair of the same machine replaces its entry and a pairing at capacity evicts
 * another, so the number of machines can stay put while a pairing happened; the daemon issues a fresh device grant for
 * every pairing, so (machine, device) is what tells a new pairing from one that was already here.
 */
export const pairingMark = (entry: PairingIdentity): string => `${entry.daemon}\n${entry.deviceId ?? ''}`;

/** The marks of a list as it stands. */
export const pairingMarks = (entries: readonly PairingIdentity[]): readonly string[] => entries.map(pairingMark);

/** Whether the list holds a pairing the person had not made when they left. */
export const hasNewPairing = (entries: readonly PairingIdentity[], known: ReadonlySet<string>): boolean =>
  entries.some(entry => !known.has(pairingMark(entry)));

/** Keeps the marks at the moment of leaving. A refused write is not a failure: memory still holds them. */
export const rememberPairTrip = (marks: readonly string[], storage: PairTripStorage | undefined): void => {
  if (storage === undefined || marks.length > MAX_MARKS || marks.some(mark => mark.length > MAX_MARK_LENGTH)) return;
  try {
    storage.setItem(ONBOARDING_PAIR_TRIP_KEY, JSON.stringify(marks));
  } catch {
    /* storage denial is an ordinary browser condition, not a setup failure */
  }
};

/** The marks kept when the person left, or `undefined` when none are kept or what is kept is not a short list of strings. */
export const readPairTrip = (storage: PairTripStorage | undefined): readonly string[] | undefined => {
  if (storage === undefined) return undefined;
  try {
    const raw = storage.getItem(ONBOARDING_PAIR_TRIP_KEY);
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length > MAX_MARKS) return undefined;
    return parsed.every((mark): mark is string => typeof mark === 'string' && mark.length <= MAX_MARK_LENGTH)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
};

/** The trip is over (the step is on the glass again): a later visit starts from the list as it is. */
export const clearPairTrip = (storage: PairTripStorage | undefined): void => {
  if (storage === undefined) return;
  try {
    storage.removeItem(ONBOARDING_PAIR_TRIP_KEY);
  } catch {
    /* storage denial is an ordinary browser condition, not a setup failure */
  }
};
