/**
 * SOLE OWNER of the `fy:onboarding:pair-trip` browser-storage key: how many machines were paired when the first run's
 * pairing step sent the person to Access's `/pair` page.
 *
 * It lives beside the place `fy:onboarding:progress` keeps (written at the same moment), so a reload on the pairing page
 * — which forgets everything in memory — still comes back to a step that can tell "a machine was added since I left"
 * from "that machine was already here".
 *
 * IT HOLDS ONE SMALL WHOLE NUMBER AND NOTHING ELSE. Never a pairing code, address, fingerprint or machine id: the pairing
 * page takes its own code from the address, and this file has no way to be handed one. Anything stored that is not a
 * plain whole number reads as nothing (the step then counts from the list as it is, the conservative reading).
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

/** Keeps the count of machines at the moment of leaving. A refused write is not a failure: memory still holds it. */
export const rememberPairTrip = (count: number, storage: PairTripStorage | undefined): void => {
  if (storage === undefined || !Number.isSafeInteger(count) || count < 0) return;
  try {
    storage.setItem(ONBOARDING_PAIR_TRIP_KEY, String(count));
  } catch {
    /* storage denial is an ordinary browser condition, not a setup failure */
  }
};

/** The count kept when the person left, or `undefined` when none is kept or what is kept is not a plain whole number. */
export const readPairTrip = (storage: PairTripStorage | undefined): number | undefined => {
  if (storage === undefined) return undefined;
  try {
    const raw = storage.getItem(ONBOARDING_PAIR_TRIP_KEY);
    return raw !== null && /^\d{1,6}$/u.test(raw) ? Number(raw) : undefined;
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
