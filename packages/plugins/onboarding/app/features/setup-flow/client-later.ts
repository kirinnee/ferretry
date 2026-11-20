/**
 * "LATER" FOR A CLIENT PAGE. A daemon step left for later is recorded on the machine (`later`); the device ledger
 * (`../../lib/client-ledger.ts`) records only what was ANSWERED, so a client page the person left for later needs a place
 * of its own, or the flow would ask it again on every start. It is a second small key beside the ledger, `fy:onboarding:later`:
 * `{ format: 1, steps: { "<plugin>.<step>": <instant> } }`. Step keys and instants only, never a value of a setting.
 *
 * Meaning: a later step is NOT "already set" (it is not skipped for good, and Settings still has it); the run simply does
 * not resume on it. Damaged or foreign storage reads as nothing left for later; nothing here throws.
 */
import { localKey } from '@ferretry/app';
import { type Instant, InstantSchema } from '@ferretry/std';
import { z } from 'zod';
import type { LedgerStorage } from '../../lib/index.ts';

const KEY = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/u;
const MAX_STEPS = 256;

const LaterSchema = z.strictObject({ format: z.literal(1), steps: z.record(z.string().regex(KEY), InstantSchema) });

/** localStorage: the client pages left for later. */
export const CLIENT_LATER_KEY = localKey('onboarding', 'later');

/** The step keys left for later; empty when nothing, something damaged or something of another format is stored. */
export function readLater(storage: LedgerStorage | undefined): ReadonlySet<string> {
  if (storage === undefined) return new Set();
  try {
    const raw = storage.getItem(CLIENT_LATER_KEY);
    if (raw === null) return new Set();
    const parsed = LaterSchema.safeParse(JSON.parse(raw));
    return parsed.success && Object.keys(parsed.data.steps).length <= MAX_STEPS
      ? new Set(Object.keys(parsed.data.steps))
      : new Set();
  } catch {
    return new Set();
  }
}

/** Leaves one client step for later. False when storage refuses: the step is then asked again next time, never lost silently. */
export function rememberLater(storage: LedgerStorage | undefined, key: string, at: Instant): boolean {
  if (storage === undefined || !KEY.test(key)) return false;
  try {
    const raw = storage.getItem(CLIENT_LATER_KEY);
    const parsed = raw === null ? undefined : LaterSchema.safeParse(JSON.parse(raw));
    const steps = parsed?.success === true ? parsed.data.steps : {};
    storage.setItem(CLIENT_LATER_KEY, JSON.stringify({ format: 1, steps: { ...steps, [key]: at } }));
    return true;
  } catch {
    return false;
  }
}
