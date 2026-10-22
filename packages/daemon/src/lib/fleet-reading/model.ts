/**
 * WHAT THE FLEET READING KNOWS, AND WHEN EACH CREDENTIAL IS NEXT DUE (docs/design/housekeeping-worker.md
 * §3.2, §3.4).
 *
 * A credential's usage row and status are a pure function of its configuration, its store's facts, its
 * newest passive reading, its status head and the time. Every input but time arrives as an event — a
 * configuration load, a store file written, a statusLine file renamed into place, a rollout appended —
 * so the only reason to read on a clock is the provider's own windows, which move with use on other
 * devices and with their resets. That read is the active free read, and its rule is unchanged: a
 * credential gets it once its newest measured passive reading is one usage interval old
 * (`activeUsageReadDueAt`). This module turns that rule into instants; it holds no timer and does no I/O.
 *
 * Pure and total. A state is replaced, never mutated.
 */
import { activeUsageReadDueAt, type PassiveUsageRecord } from '@ferretry/fleet';

/** What the reading knows about one stored credential. */
export interface CredentialReading {
  /** The newest passive reading a watch delivered; absent when there is none. */
  readonly passive?: PassiveUsageRecord;
  /**
   * Whether `passive` is current: a read finished since the watch began and none has failed since. A
   * reading that is not current is never trusted to hold the active read off.
   */
  readonly passiveKnown: boolean;
  /** When a pass last observed the credential. */
  readonly observedAt?: number;
}

/** Every stored credential the configuration names, by id. */
export type FleetReadingState = ReadonlyMap<string, CredentialReading>;

export const EMPTY_FLEET_READING: FleetReadingState = new Map();

const UNKNOWN: CredentialReading = { passiveKnown: false };

/** The reading for exactly `ids`: what is known of each survives, a new one starts unknown, the rest go. */
export function readingFor(state: FleetReadingState, ids: readonly string[]): FleetReadingState {
  return new Map(ids.map(id => [id, state.get(id) ?? UNKNOWN] as const));
}

/** A passive read finished: `passive` is the credential's newest reading, or there is none. */
export function withPassive(
  state: FleetReadingState,
  id: string,
  passive: PassiveUsageRecord | undefined,
): FleetReadingState {
  const current = state.get(id);
  if (current === undefined) return state;
  const { passive: _replaced, ...rest } = current;
  return new Map(state).set(id, { ...rest, ...(passive === undefined ? {} : { passive }), passiveKnown: true });
}

/** A passive read failed: what was known is no longer current. */
export function withPassiveUnknown(state: FleetReadingState, id: string): FleetReadingState {
  const current = state.get(id);
  if (current === undefined) return state;
  return new Map(state).set(id, { ...current, passiveKnown: false });
}

/** A pass observed `ids` at `at`. */
export function withObserved(state: FleetReadingState, ids: readonly string[], at: number): FleetReadingState {
  const next = new Map(state);
  for (const id of ids) {
    const current = next.get(id);
    if (current !== undefined) next.set(id, { ...current, observedAt: at });
  }
  return next;
}

/** When `reading` is next due its active read. A passive reading that is not current counts for nothing. */
export function readingDueAt(reading: CredentialReading, intervalMs: number): number {
  return activeUsageReadDueAt(reading.passiveKnown ? reading.passive : undefined, reading.observedAt, intervalMs);
}

/** The credentials due their active read at `now`, in the order the configuration names them. */
export function dueCredentials(state: FleetReadingState, now: number, intervalMs: number): readonly string[] {
  return [...state].filter(([, reading]) => readingDueAt(reading, intervalMs) <= now).map(([id]) => id);
}

/** The earliest instant any credential is due, or `undefined` when there are none to read. */
export function nextDueAt(state: FleetReadingState, intervalMs: number): number | undefined {
  let earliest: number | undefined;
  for (const reading of state.values()) {
    const due = readingDueAt(reading, intervalMs);
    if (earliest === undefined || due < earliest) earliest = due;
  }
  return earliest;
}
