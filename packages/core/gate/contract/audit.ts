import { defineState, type PolicyRef } from '@ferretry/kernel/contract';
import { InstantSchema, NonNegativeIntegerSchema } from '@ferretry/std';
import { z } from 'zod';

/**
 * The audit log (today's `protocol/src/lib/audit.ts`, field for field): a bounded `0600` append-only record of names
 * and ids only (docs/audit.md). `event` is an audit kind ref (`AUDIT_KINDS` or a plugin's own `auditKind`).
 */

export const AUDIT_ACTOR_KINDS = ['host', 'device', 'warden', 'anonymous'] as const;
export const AuditActorKindSchema = z.enum(AUDIT_ACTOR_KINDS);
export type AuditActorKind = z.infer<typeof AuditActorKindSchema>;

export const AuditTextSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[^\p{Cc}\p{Cf}]*$/u, 'audit text must be one line with no control characters');

export const AuditActorSchema = z.strictObject({
  kind: AuditActorKindSchema,
  deviceId: AuditTextSchema.optional(),
  deviceName: AuditTextSchema.optional(),
});
export type AuditActor = z.infer<typeof AuditActorSchema>;

/** Names a device can never take, because the log uses them for the other actors. */
export const AUDIT_RESERVED_ACTOR_PHRASES = [
  'this computer',
  'a supervising agent',
  'someone who is not paired',
  'a paired device',
] as const;

export function isReservedActorPhrase(name: string): boolean {
  const folded = name.trim().replace(/\s+/gu, ' ').toLowerCase();
  return AUDIT_RESERVED_ACTOR_PHRASES.some(phrase => phrase === folded);
}

export function auditShortId(id: string): string {
  return id.length <= 6 ? id : `…${id.slice(-6)}`;
}

export const AUDIT_OUTCOMES = ['succeeded', 'refused', 'failed'] as const;
export const AuditOutcomeSchema = z.enum(AUDIT_OUTCOMES);
export type AuditOutcome = z.infer<typeof AuditOutcomeSchema>;

const AuditDetailKeySchema = z.string().regex(/^[a-z][A-Za-z0-9]{0,31}$/u, 'audit detail keys are short camelCase');
export const AuditDetailSchema = z
  .record(AuditDetailKeySchema, z.union([AuditTextSchema, z.number().finite(), z.boolean()]))
  .refine(detail => Object.keys(detail).length <= 12, 'an audit record carries at most twelve details');
export type AuditDetail = z.infer<typeof AuditDetailSchema>;

const AuditKindSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:[-.:][a-z0-9]+)*$/u)
  .max(64)
  .transform(name => name as PolicyRef<'audit'>);

export const AuditRecordSchema = z.strictObject({
  format: z.literal(1),
  at: InstantSchema,
  event: AuditKindSchema,
  actor: AuditActorSchema,
  subject: AuditTextSchema.optional(),
  outcome: AuditOutcomeSchema,
  detail: AuditDetailSchema.optional(),
});
export type AuditRecord = z.infer<typeof AuditRecordSchema>;

/** What a subsystem hands Gate to record; Gate stamps `format` and `at`. */
export type AuditDraft = Omit<AuditRecord, 'format' | 'at' | 'event'> & {
  readonly event: PolicyRef<'audit'>;
  /**
   * `daemon` when the DAEMON did this on its own — an idle expiry — rather than somebody at the machine (today's
   * `AuditEntry.cause`). The actor is still `host`, because it is the machine acting; but how OFTEN it happens is not
   * the owner's choice, so a daemon-caused kept record is rationed like a remote one and can never rotate the kept
   * store. Never written to the record.
   */
  readonly cause?: 'daemon';
};

export const AUDIT_MAX_LIMIT = 200 as const;
export const AUDIT_DEFAULT_LIMIT = 50 as const;

export const AuditQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(AUDIT_MAX_LIMIT).default(AUDIT_DEFAULT_LIMIT),
  keptOffset: z.coerce.number().int().min(0).default(0),
});
export type AuditQuery = z.infer<typeof AuditQuerySchema>;

const AuditRecordViewSchema = AuditRecordSchema.omit({ format: true });
export const AuditViewSchema = z.strictObject({
  records: z.array(AuditRecordViewSchema).max(AUDIT_MAX_LIMIT).readonly(),
  kept: z.array(AuditRecordViewSchema).max(AUDIT_MAX_LIMIT).readonly(),
  keptTotal: NonNegativeIntegerSchema,
  unreadable: NonNegativeIntegerSchema,
});
export type AuditView = z.infer<typeof AuditViewSchema>;

/** `state/gate/audit.jsonl` (`0600`, rotated). One record per line. */
export const AuditLogFile = defineState({
  name: 'audit',
  path: 'audit.jsonl',
  store: 'jsonl',
  format: 1,
  schema: AuditRecordSchema,
  mode: 0o600,
});
