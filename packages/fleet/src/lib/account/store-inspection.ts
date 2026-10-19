/**
 * What looking in one credential's store found, said in words a person can act on.
 *
 * A sign-in whose harness exited cleanly but whose store then held no usable login used to end with
 * "no usable login was written for this credential" and nothing else — not WHERE it was looked for,
 * and not whether that place was empty, refused the read, or held something this build could not use.
 * Those are three different problems with three different remedies (wait and look again; unlock or
 * approve the keychain; sign in again), and on macOS the place is a keychain item whose name is
 * derived from a path, so naming it is the only way a person can check it themselves.
 *
 * So a store read records each place it looked, in order, and this module turns that trail into one
 * sentence. **No credential value appears anywhere here**: a check names a location and what kind of
 * thing was there, and the reasons it carries were written by the adapter about the failure, never
 * copied from the material.
 */
import type { CredentialReading } from '../identity.ts';

/** One place a store read looked, and what it found there. Never the material itself. */
export interface CredentialStoreCheck {
  /**
   * Where, as a person would look for it: `the keychain item "Claude Code-credentials-1a2b3c4d" (account
   * "sam")` or `the file /…/.credentials.json`. Names a location, never a value.
   */
  readonly location: string;
  /** `nothing` — not there at all; `unreadable` — there, or maybe there, but the read failed; `present` — read. */
  readonly found: 'nothing' | 'unreadable' | 'present';
  /** Why the read failed. Set for `unreadable` only, and describes the failure, never the credential. */
  readonly why?: string;
}

/** A store read with its trail: the verdict on what was found, and every place that was looked in. */
export interface CredentialStoreInspection {
  readonly reading: CredentialReading;
  readonly checked: readonly CredentialStoreCheck[];
}

/** Whether a reading is a login a harness can launch with. */
export const usableCredentialReading = (reading: CredentialReading): boolean =>
  reading.state === 'valid' || reading.state === 'refreshable';

/** Why a login that WAS read cannot be used, from its verdict alone. */
function unusableWords(reading: CredentialReading): string {
  if (reading.state === 'unreadable') return reading.reason ?? 'its contents are not in a shape this version reads';
  return reading.expiresAt === undefined
    ? 'it holds neither an access token nor a refresh token'
    : 'it has expired and holds no refresh token to renew it';
}

function checkWords(check: CredentialStoreCheck, reading: CredentialReading): string {
  if (check.found === 'nothing') return `${check.location} — nothing there`;
  if (check.found === 'unreadable') return `${check.location} — could not be read: ${check.why ?? 'no reason given'}`;
  return `${check.location} — a login is there, but it cannot be used: ${unusableWords(reading)}`;
}

/**
 * One sentence saying where a store was looked for and what each place held.
 *
 * Only the LAST `present` check is the one the verdict is about — a store reads its places in order and
 * stops at the first that answers — so an earlier `present` cannot occur, and the verdict's words are
 * attached to whichever check found the material.
 */
export function storeInspectionWords(inspection: CredentialStoreInspection): string {
  if (usableCredentialReading(inspection.reading)) return 'A usable login is stored for this credential.';
  if (inspection.checked.length === 0) return 'No place this login could be stored in was looked at.';
  return `Checked ${inspection.checked.map(check => checkWords(check, inspection.reading)).join('; then ')}.`;
}
