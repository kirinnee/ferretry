/**
 * THE DEVICE LEDGER: which client steps this browser has answered, and for which daemons (`fy:onboarding:client`: the
 * plugin owns its storage name as the stepper does, since a plugin cannot reach the shell's name table).
 *
 * A client step configures THIS browser (layout, appearance, voice), so "already set" is a fact about the device, not a
 * machine: a step answered while setting up one daemon is skipped when setting up another. Written only through
 * `recordClientStep` (a page's `done()`), read only to decide a skip. It holds step keys, instants and opaque daemon
 * ids, never a credential, a name the person typed or a pairing value. Damaged or foreign storage reads as an empty
 * ledger (clean slate); nothing here throws.
 */
import { localKey } from '@ferretry/app';
import { InstantSchema, type Instant } from '@ferretry/std';
import { z } from 'zod';
import { clientStepKey } from '../../contract/step-host.ts';

/** `<plugin>.<step>`: two kebab-case slugs. */
const KEY = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/u;
/** A ledger holds a few dozen steps and a handful of daemons; anything larger is damage, not data. */
const MAX_STEPS = 256;
const MAX_DAEMONS = 64;

const LedgerSchema = z.strictObject({
  format: z.literal(1),
  steps: z.record(
    z.string().regex(KEY),
    z.strictObject({ at: InstantSchema, daemons: z.array(z.string().min(1).max(200)).max(MAX_DAEMONS) }),
  ),
});
export type ClientLedger = z.infer<typeof LedgerSchema>;

/** localStorage: the device ledger. */
export const CLIENT_LEDGER_KEY = localKey('onboarding', 'client');

export const EMPTY_LEDGER: ClientLedger = Object.freeze({ format: 1, steps: Object.freeze({}) });

/** The part of `localStorage` the ledger needs; `undefined` where storage is blocked (private modes throw). */
export interface LedgerStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  /** A browser's storage has it; a ledger that cannot forget simply keeps the entry. */
  removeItem?(key: string): void;
}

/** The ledger as stored, or the empty one when nothing, something damaged or something of another format is there. */
export function readLedger(storage: LedgerStorage | undefined): ClientLedger {
  if (storage === undefined) return EMPTY_LEDGER;
  try {
    const raw = storage.getItem(CLIENT_LEDGER_KEY);
    if (raw === null) return EMPTY_LEDGER;
    const parsed = LedgerSchema.safeParse(JSON.parse(raw));
    return parsed.success && Object.keys(parsed.data.steps).length <= MAX_STEPS ? parsed.data : EMPTY_LEDGER;
  } catch {
    return EMPTY_LEDGER;
  }
}

/** Whether this device has answered the step (for any daemon). */
export const isClientStepSet = (ledger: ClientLedger, plugin: string, step: string): boolean =>
  Object.hasOwn(ledger.steps, clientStepKey(plugin, step));

/** The ledger with one step answered for one daemon at `at`; the daemons it was answered for accumulate. Pure. */
export function withClientStep(
  ledger: ClientLedger,
  plugin: string,
  step: string,
  daemon: string,
  at: Instant,
): ClientLedger {
  const key = clientStepKey(plugin, step);
  if (!KEY.test(key)) return ledger;
  const before = Object.hasOwn(ledger.steps, key) ? (ledger.steps[key]?.daemons ?? []) : [];
  const daemons = before.includes(daemon) ? before : [...before, daemon].slice(-MAX_DAEMONS);
  return { format: 1, steps: { ...ledger.steps, [key]: { at, daemons } } };
}

/** Writes the ledger; false when storage refuses (full, blocked): the step is then asked again next time, never lost silently. */
export function recordClientStep(
  storage: LedgerStorage | undefined,
  plugin: string,
  step: string,
  daemon: string,
  at: Instant,
): boolean {
  if (storage === undefined) return false;
  try {
    const next = withClientStep(readLedger(storage), plugin, step, daemon, at);
    storage.setItem(CLIENT_LEDGER_KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}
