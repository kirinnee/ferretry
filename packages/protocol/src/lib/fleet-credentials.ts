/**
 * The wire contract for the account model's credentials (docs/design/account-model.md §3.2, §7):
 * `GET /v1/fleet/credentials` and the explicit `POST /v1/fleet/credentials/:id/check`.
 *
 * ## Status and usage, never material
 *
 * A row says whether a login works, how much of its two rate-limit windows is spent, which runtimes use
 * it and what signing it out would do. There is no field here that could carry an access token, a
 * refresh token or a digest of either: the daemon parses its own answers through these schemas on the
 * way out, and every object is strict, so a field somebody added on the daemon side without adding it
 * here fails the response rather than reaching a browser.
 *
 * ## Four words
 *
 * `ready`, `refresh_due`, `needs_sign_in`, `checking` — the closed set the fleet package owns
 * (`CredentialStatusWordSchema`). It is restated here because this package depends on nothing, and the
 * daemon proves the two spellings agree.
 */
import { z } from 'zod';
import { InstantSchema, NonEmptyStringSchema, NonNegativeIntegerSchema } from './common.ts';
import { OperatorPasswordSchema } from './grants.ts';

const HarnessKindSchema = z.enum(['claude', 'codex']);

/** A credential id: the config's own slug. */
export const FleetCredentialIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/u, 'a credential id uses only lowercase letters, digits and dashes')
  .max(64);

export const FleetCredentialStatusWordSchema = z.enum(['ready', 'refresh_due', 'needs_sign_in', 'checking']);
export type FleetCredentialStatusWord = z.infer<typeof FleetCredentialStatusWordSchema>;

/** Why the word is what it is: the fleet's closed set, restated (see the module note). */
export const FleetCredentialStatusReasonSchema = z.enum([
  'provider_accepted',
  'usage_scope_unavailable',
  'passive_usage_seen',
  'access_current',
  'refresh_accepted',
  'not_checked_yet',
  'api_key',
  'from_environment',
  'credential_unreadable',
  'access_expired_refreshable',
  'access_expiring',
  'last_refresh_old',
  'not_signed_in',
  'access_expired_no_refresh',
  'provider_rejected',
  'refresh_expired',
  'refresh_revoked',
  'refresh_rejected',
  'store_unreachable',
  'check_in_flight',
]);
export type FleetCredentialStatusReason = z.infer<typeof FleetCredentialStatusReasonSchema>;

/** Where a credential is kept (C3). */
export const FleetCredentialStoreSchema = z.enum(['host', 'ferretry', 'environment']);
export type FleetCredentialStore = z.infer<typeof FleetCredentialStoreSchema>;

/** One credential's status: the word, the sentence that explains it, and how old the evidence is. */
export const FleetCredentialStatusSchema = z.strictObject({
  word: FleetCredentialStatusWordSchema,
  /** The word as a person reads it: "Ready", "Refresh due", "Needs sign-in", "Checking". */
  label: NonEmptyStringSchema,
  /** The closed-set reason the fleet decided on, for a client that branches on cause. */
  reason: FleetCredentialStatusReasonSchema,
  /** One plain sentence saying why. */
  explanation: NonEmptyStringSchema,
  since: InstantSchema.optional(),
  lastCheckedAt: InstantSchema.optional(),
  /** The newest check could not conclude, so the word rests on older evidence (or none). */
  lastCheckInconclusive: z.boolean(),
  /** Codex: the plan the login is on. Display only. */
  planType: NonEmptyStringSchema.optional(),
});
export type FleetCredentialStatus = z.infer<typeof FleetCredentialStatusSchema>;

/** One rate-limit window. No `usedPercent` means nobody measured it: "unknown", never 0%. */
export const FleetCredentialUsageWindowSchema = z.strictObject({
  usedPercent: z.number().finite().min(0).optional(),
  resetsAt: InstantSchema.optional(),
});
export type FleetCredentialUsageWindow = z.infer<typeof FleetCredentialUsageWindowSchema>;

export const FleetCredentialUsageSchema = z.strictObject({
  fiveHour: FleetCredentialUsageWindowSchema,
  weekly: FleetCredentialUsageWindowSchema,
  /** Which reading the windows came from. Absent when nothing has measured this credential. */
  source: z.enum(['claude-statusline', 'codex-rollout', 'anthropic-usage', 'codex-usage']).optional(),
  at: InstantSchema.optional(),
});
export type FleetCredentialUsage = z.infer<typeof FleetCredentialUsageSchema>;

/** Whether an act is offered for this credential, and the sentence that says why not when it is not. */
export const FleetCredentialActSchema = z.discriminatedUnion('available', [
  z.strictObject({ available: z.literal(true) }),
  z.strictObject({ available: z.literal(false), reason: NonEmptyStringSchema }),
]);
export type FleetCredentialAct = z.infer<typeof FleetCredentialActSchema>;

/** What signing out would do (C7, E25), said before anybody confirms it. */
export const FleetCredentialSignOutSchema = z.strictObject({
  available: z.boolean(),
  /** The confirm card's question, consequences included: "Sign out of … ? This also signs out …". */
  sentence: NonEmptyStringSchema,
  /** How many runtimes will need sign-in afterwards. */
  runtimesAffected: NonNegativeIntegerSchema,
  /** `store: host` only: signing out also signs out the person's own CLI on this machine. */
  signsOutTerminal: z.boolean(),
});
export type FleetCredentialSignOut = z.infer<typeof FleetCredentialSignOutSchema>;

/** One credential, as the Credentials tab shows it. */
export const FleetCredentialViewSchema = z.strictObject({
  id: FleetCredentialIdSchema,
  harness: HarnessKindSchema,
  store: FleetCredentialStoreSchema,
  /** The login's email, when the harness recorded one. Display only. */
  email: NonEmptyStringSchema.optional(),
  /** The person's own label (C9). Display only. */
  label: NonEmptyStringSchema.optional(),
  /**
   * Another login of this harness has the same email and the two are not told apart by distinct
   * labels (E26). A surface asks for a label rather than showing two identical rows.
   */
  needsLabel: z.boolean(),
  /** Set by Clone on an empty slot: the machine it was copied from. */
  clonedFrom: NonEmptyStringSchema.optional(),
  /** `store: host`: "Shared with claude in your terminal" (C4). */
  sharedWithTerminal: z.boolean(),
  status: FleetCredentialStatusSchema,
  usage: FleetCredentialUsageSchema,
  /** The runtimes that use this credential, by name. */
  usedBy: z.array(NonEmptyStringSchema).readonly(),
  /** Whether `POST /v1/fleet/login` can sign this credential in. */
  signIn: FleetCredentialActSchema,
  /** Whether `POST /v1/fleet/credentials/:id/check` can run. */
  checkNow: FleetCredentialActSchema,
  signOut: FleetCredentialSignOutSchema,
});
export type FleetCredentialView = z.infer<typeof FleetCredentialViewSchema>;

/**
 * Every credential on this machine.
 *
 * `format` is the config document's version, which is always the account model: a machine whose
 * config.yaml is still the old account format is refused as unreadable rather than listed.
 */
export const FleetCredentialListSchema = z.strictObject({
  format: z.literal(2),
  /** This machine's name, as the sign-out sentence names it. */
  machine: NonEmptyStringSchema,
  credentials: z.array(FleetCredentialViewSchema).readonly(),
});
export type FleetCredentialList = z.infer<typeof FleetCredentialListSchema>;

/** A person's **Check now**, with the per-change confirmation a governed caller owes. */
export const FleetCredentialCheckRequestSchema = z.strictObject({
  operatorPassword: OperatorPasswordSchema.optional(),
});
export type FleetCredentialCheckRequest = z.infer<typeof FleetCredentialCheckRequestSchema>;
