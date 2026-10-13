import { z } from 'zod';
import { InstantSchema, NonNegativeIntegerSchema } from './common.ts';

/**
 * THE SECURITY AUDIT LOG, as the wire describes it.
 *
 * One record per thing that changed WHO may reach this machine or WHAT they did with the access they
 * were given: a device paired or revoked, a code minted, a pairing refused, a grant moved, the fleet
 * reconfigured, a terminal opened, a secret used. It exists so "which phone was paired last Tuesday,
 * and what has it done since" has an answer that does not depend on somebody having been watching.
 *
 * ## NAMES AND IDS ONLY — AND THE SCHEMA IS WHERE THAT IS ENFORCED
 *
 * An append-only file outlives every credential mentioned in it, so a record that carried a code, a
 * token, a key, a proof, a secret value or a command line would turn the audit trail into the most
 * valuable file on the machine. Every free-text field below is BOUNDED and the `detail` map holds
 * short scalar facts only, so there is no field a caller could hand a command line or a blob to and
 * have it fit. What a field may NAME is the emitter's job, and the daemon's tests grep every written
 * record for each fixture secret to prove the emitters keep it.
 *
 * ## THE EVENT LIST IS CLOSED, AND INCLUDES KINDS NOTHING EMITS YET
 *
 * `device.expired`, `session.opened`, `step-up.succeeded`, `step-up.failed` and
 * `passkey.registered` belong to the zero-trust work that lands after this log. They are declared now
 * so the units that add them emit into a schema that already accepts them, rather than each widening
 * the contract on its own branch and colliding at the merge.
 */
export const AUDIT_EVENTS = [
  'device.paired',
  'device.revoked',
  'device.expired',
  'pairing.code-minted',
  'pairing.refused',
  'session.opened',
  'step-up.succeeded',
  'step-up.failed',
  'passkey.registered',
  'terminal.opened',
  'fleet.configured',
  'grants.changed',
  'secrets.used',
] as const;
export const AuditEventSchema = z.enum(AUDIT_EVENTS);
export type AuditEvent = z.infer<typeof AuditEventSchema>;

/**
 * Who did it.
 *
 * `host` is somebody at the machine — the admin token, the command line, a browser that arrived on
 * the host's own carrier with no device grant behind it. `device` is a paired device acting under its
 * own grant, named by id and, where the emitter knows it, by the name its owner gave it. `warden` is a
 * supervising session acting under the authority it was handed. `anonymous` is a caller who has not
 * proved who they are — the only one is somebody presenting a pairing code, and it appears only on a
 * refused `pairing.refused` record, because a successful redemption is recorded as the new device.
 */
export const AUDIT_ACTOR_KINDS = ['host', 'device', 'warden', 'anonymous'] as const;
export const AuditActorKindSchema = z.enum(AUDIT_ACTOR_KINDS);
export type AuditActorKind = z.infer<typeof AuditActorKindSchema>;

/** A name or an id: short, single-line, never markup. Long enough for every id this daemon mints. */
const AuditTextSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[^\p{Cc}\p{Cf}]*$/u, 'audit text must be one line with no control characters');

export const AuditActorSchema = z.strictObject({
  kind: AuditActorKindSchema,
  /** The paired device's id, for `device`; a warden's session id is not a device and goes nowhere. */
  deviceId: AuditTextSchema.optional(),
  /** Untrusted, owner-chosen text: render as text content only. */
  deviceName: AuditTextSchema.optional(),
});
export type AuditActor = z.infer<typeof AuditActorSchema>;

/** What happened, in the two words a reader needs: it worked, or it was refused or failed. */
export const AUDIT_OUTCOMES = ['succeeded', 'refused', 'failed'] as const;
export const AuditOutcomeSchema = z.enum(AUDIT_OUTCOMES);
export type AuditOutcome = z.infer<typeof AuditOutcomeSchema>;

/**
 * Short scalar facts about a record — `carrier: "relay"`, `changes: "fleet.use=off"`.
 *
 * A BOUNDED MAP OF BOUNDED SCALARS rather than an open object, so there is nowhere to put a nested
 * document, a request body or an argv. Twelve keys of at most 160 characters each is room for every
 * fact an emitter has today and is too small to smuggle a command line through by accident.
 */
const AuditDetailKeySchema = z.string().regex(/^[a-z][A-Za-z0-9]{0,31}$/u, 'audit detail keys are short camelCase');
export const AuditDetailSchema = z
  .record(AuditDetailKeySchema, z.union([AuditTextSchema, z.number().finite(), z.boolean()]))
  .refine(detail => Object.keys(detail).length <= 12, 'an audit record carries at most twelve details');
export type AuditDetail = z.infer<typeof AuditDetailSchema>;

/** One record, exactly as it is written to `audit.jsonl` and exactly as a reader is told about it. */
export const AuditRecordSchema = z.strictObject({
  at: InstantSchema,
  event: AuditEventSchema,
  actor: AuditActorSchema,
  /** What it was done TO — a device id, a session id, a credential id, a secret's name. */
  subject: AuditTextSchema.optional(),
  outcome: AuditOutcomeSchema,
  detail: AuditDetailSchema.optional(),
});
export type AuditRecord = z.infer<typeof AuditRecordSchema>;

/**
 * How many records one read may return, and how many it returns when the caller does not say.
 *
 * BOUNDED because the log is two files of up to a mebibyte each, and the question people actually
 * have is "what happened recently", not "replay the year".
 */
export const AUDIT_MAX_LIMIT = 200 as const;
export const AUDIT_DEFAULT_LIMIT = 50 as const;

export const AuditQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(AUDIT_MAX_LIMIT).default(AUDIT_DEFAULT_LIMIT),
});
export type AuditQuery = z.infer<typeof AuditQuerySchema>;

/**
 * The recent audit history, newest first.
 *
 * `unreadable` IS NOT DECORATION. A line this daemon cannot parse is damage — a truncated write, a
 * hand edit, tampering — and dropping it silently would let a damaged history read as a clean one.
 * The count travels with the records so a reader is TOLD their history has a hole in it.
 */
export const AuditViewSchema = z.strictObject({
  records: z.array(AuditRecordSchema).max(AUDIT_MAX_LIMIT).readonly(),
  unreadable: NonNegativeIntegerSchema,
});
export type AuditView = z.infer<typeof AuditViewSchema>;
