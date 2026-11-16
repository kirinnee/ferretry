import { defineState } from '@ferretry/kernel/contract';
import { z } from 'zod';

// ─── names.json (today's callsign claim ledger, `adapters/names/file-name-claim-store.ts`) ────────────────────────

/** The longest callsign (today's `lib/names/types.ts`). */
const MAX_CALLSIGN_LENGTH = 32;
const CALLSIGN_PATTERN = /^[a-z][a-z0-9-]*$/;

/** A callsign in its one stored spelling: trimmed, lowercase, a letter then letters, digits or hyphens; else `null`. */
export function normalizeCallsign(raw: string): string | null {
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > MAX_CALLSIGN_LENGTH) return null;
  return CALLSIGN_PATTERN.test(normalized) ? normalized : null;
}

// STRICT so an unknown field on a ledger row fails closed. Zod's default strip mode would accept the
// row, drop the extra field, and silently rewrite it on the next successful claim — hiding exactly
// the tampering or corruption the damaged-ledger cases exist to surface.
export const NameClaimSchema = z
  .strictObject({
    callsign: z.string().refine(callsign => normalizeCallsign(callsign) === callsign, 'callsign is not canonical'),
    ownerId: z.string().min(1),
    claimedAtMs: z.number().int().nonnegative(),
    expiresAtMs: z.number().int().nonnegative(),
  })
  .refine(claim => claim.expiresAtMs > claim.claimedAtMs, 'claim expiry must be after its creation');

/**
 * `names.json`: today's claim ledger, the reservations a start holds on a callsign before its record exists. Today the
 * file was the bare array of claims; a state document is an object with `format` first, so the claims sit under
 * `claims`.
 */
export const NamesDocumentSchema = z.strictObject({ claims: z.array(NameClaimSchema) });
export type NamesDocument = z.infer<typeof NamesDocumentSchema>;
export const NamesFile = defineState({
  name: 'names',
  path: 'names.json',
  store: 'json',
  format: 1,
  schema: NamesDocumentSchema,
});

/**
 * `system-callsigns.json` (today's `FY_HOME/state/system-callsigns.json`, `FileSystemCallsignCounters`): the last
 * sequence issued for each system prefix, so a restart carries on instead of starting again from 1. A prefix never
 * issued is absent. Reading is total at the adapter: a damaged document is "nothing issued yet".
 */
const SystemCallsignSequence = z.number().int().min(0).max(0xff_ff_ff);
export const SystemCallsignsDocumentSchema = z.object({
  warden: SystemCallsignSequence.optional(),
  learning: SystemCallsignSequence.optional(),
  pack: SystemCallsignSequence.optional(),
});
export const SystemCallsignsFile = defineState({
  name: 'system-callsigns',
  path: 'system-callsigns.json',
  store: 'json',
  format: 1,
  schema: SystemCallsignsDocumentSchema,
  // Today a damaged counter file read as nothing issued. It never flags the Ferrets subsystem: the counter only says
  // where to start looking, and the fleet's own held names keep an issued id unique.
  onDamaged: {
    narrower: 'a damaged system-callsigns.json reads as nothing issued; ids are still unique against the fleet',
  },
});
