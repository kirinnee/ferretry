import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';
import {
  CAPABILITY_NAMES,
  CapabilityGrantSchema,
  CapabilityGrantsSchema,
  type CapabilityName,
  CapabilityNameSchema,
  GrantRefusalSchema,
} from './policy.ts';

/**
 * The grants wire (today's `protocol/src/lib/grants.ts`, copied; #11): what `/v1/grants` and `/v1/grants/audit`
 * answer and what `PATCH /v1/grants` takes. In Gate's contract because four consumers must agree on it: the daemon
 * that enforces it, the command line that reports it, the configuration document that records it, and the app that
 * has to explain a refusal instead of greying a control out. The vocabulary (capabilities, axes, refusals) is
 * `policy.ts`.
 */

/**
 * How a CLIENT reads grants off the wire from a daemon on another version. A capability this build knows and the
 * answer omits (an older daemon) reads as OFF, a narrowing; a key this build does not know (a newer daemon) is
 * dropped. The result is the closed `CapabilityGrantsSchema`.
 */
export const ReadCapabilityGrantsSchema = z.preprocess(raw => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  const given = raw as Record<string, unknown>;
  return Object.fromEntries(
    CAPABILITY_NAMES.map(capability => [
      capability,
      capability in given ? given[capability] : { use: false, configure: false },
    ]),
  );
}, CapabilityGrantsSchema);

/** One capability as the UI is told about it. */
export const CapabilityGrantViewSchema = z.strictObject({
  capability: CapabilityNameSchema,
  /** May this caller exercise the capability right now? */
  use: z.boolean(),
  /** May this caller change the capability's host behaviour right now — step-up included? */
  configure: z.boolean(),
  /** What the operator's document says, before a step-up is considered. */
  granted: CapabilityGrantSchema,
  /**
   * What THIS device has been granted, when the caller is a governed paired device — absent for a caller on the host
   * (ungoverned) and for a credential that is not a device (a remote warden). The effective answer is `granted` AND
   * this, axis by axis.
   */
  deviceGranted: CapabilityGrantSchema.optional(),
  /** Why `use` reads the way it does. */
  useRefusal: GrantRefusalSchema,
  /** Why `configure` reads the way it does. */
  configureRefusal: GrantRefusalSchema,
  /** May THIS caller turn this capability on? `false` for every remote caller, always; it equals `hostLocal`. */
  mayGrant: z.boolean(),
  /** Whether the operator wrote this capability down, or the product answered for them (G155). */
  origin: z.enum(['default', 'config file']),
});
export type CapabilityGrantView = z.infer<typeof CapabilityGrantViewSchema>;

/** The whole picture, as one read. */
export const GrantsViewSchema = z.strictObject({
  capabilities: z.array(CapabilityGrantViewSchema).readonly(),
  /** Whether the operator's grants GOVERN this caller at all: served rather than inferred. */
  governed: z.boolean(),
  /** Whether this call ARRIVED on the machine the daemon runs on (the carrier's fact, never a header's). */
  hostLocal: z.boolean(),
  /** Whether this caller's device holds a recent passkey step-up for this app session right now. */
  steppedUp: z.boolean(),
});
export type GrantsView = z.infer<typeof GrantsViewSchema>;

/** How many recorded changes one read returns, newest first (G160). */
export const GRANT_AUDIT_MAX_ENTRIES = 50 as const;

/** One recorded grant change, as a reader is told about it. */
export const GrantAuditEntryViewSchema = z.strictObject({
  at: InstantSchema,
  /** WHO, as the resolved actor — `admin-cli`, `admin-ui`, `device:<id>`. Never a token. */
  actor: z.string().min(1).max(256),
  /** Each axis that moved, as `capability.axis=on|off`. Empty is impossible: a patch that changed nothing is not recorded. */
  changes: z.array(z.string().min(1).max(96)).readonly(),
});
export type GrantAuditEntryView = z.infer<typeof GrantAuditEntryViewSchema>;

/** The recent history of who changed what; `unreadable` lines are damage, counted and told, never dropped silently. */
export const GrantAuditViewSchema = z.strictObject({
  entries: z.array(GrantAuditEntryViewSchema).readonly(),
  /** Lines in the window that could not be read as a record. Non-zero means the history is damaged. */
  unreadable: z.number().int().nonnegative(),
  /** Whether older records exist outside the window this read covered. */
  truncated: z.boolean(),
});
export type GrantAuditView = z.infer<typeof GrantAuditViewSchema>;

/**
 * A change to the grants themselves: PARTIAL, so a UI may change one answer without restating four it did not look
 * at. WIDENING IS HOST-ONLY; A GOVERNED CALLER MAY ONLY NARROW (G46, G121).
 */
export const GrantsPatchSchema = z
  .strictObject(
    Object.fromEntries(
      CAPABILITY_NAMES.map(name => [
        name,
        z.strictObject({ use: z.boolean().optional(), configure: z.boolean().optional() }).optional(),
      ]),
    ) as {
      readonly [K in CapabilityName]: z.ZodOptional<
        z.ZodObject<{ use: z.ZodOptional<z.ZodBoolean>; configure: z.ZodOptional<z.ZodBoolean> }>
      >;
    },
  )
  .refine(patch => Object.values(patch).some(value => value !== undefined), 'a grant patch must change something');
export type GrantsPatch = z.infer<typeof GrantsPatchSchema>;
