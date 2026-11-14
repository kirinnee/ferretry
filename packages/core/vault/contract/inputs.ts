import { defineState } from '@ferretry/kernel/contract';
import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';
import { INPUT_MAX_FIELDS, InputFieldIdSchema, InputTargetSchema } from './targets.ts';

/**
 * Input requests (today's `protocol/src/lib/input-request.ts`): a card asking the owner to type a value into a target.
 * The card is an ask of source `input` (Vault takes `ask.sources:input`); the value goes straight to the target through
 * the `input.targets` adapter and is never stored, logged or returned. The limits are today's.
 */

export const INPUT_PROMPT_MAX_LENGTH = 280;
export const INPUT_DEFAULT_EXPIRY_SECONDS = 600;
export const INPUT_MAX_EXPIRY_SECONDS = 3_600;
export const INPUT_DEFAULT_REDACTION_SECONDS = 600;
export const INPUT_MAX_REDACTION_SECONDS = 3_600;
export const INPUT_QUARANTINE_SECONDS = 120;
export const INPUT_SHORT_LOCK_SECONDS = 10;
export const INPUT_MAX_PENDING_PER_FERRET = 3;
export const INPUT_MAX_RAISES_PER_HOUR = 20;
export const INPUT_MAX_CHECK_FAILURES = 3;
export const INPUT_MAX_REBINDS = 5;
export const INPUT_MAX_REMOTE_DELIVERIES_PER_HOUR = 30;
export const INPUT_VALUE_MAX_BYTES = 1_024;
export const INPUT_PAD_BUCKET_BYTES = 256;

export const InputRequestIdSchema = z.string().regex(/^[0-9a-f]{32}$/u, 'a 128-bit hex id');
export type InputRequestId = z.infer<typeof InputRequestIdSchema>;
export const InputDeliveryIdSchema = z.uuid();

/** How careful the card is with each value (today's four). `code` is the only one a ferret may type around (I32). */
export const INPUT_SENSITIVITIES = ['secret', 'private', 'code', 'plain'] as const;
export const InputSensitivitySchema = z.enum(INPUT_SENSITIVITIES);
export type InputSensitivity = z.infer<typeof InputSensitivitySchema>;

const SENSITIVITY_RANK: Readonly<Record<InputSensitivity, number>> = { plain: 0, code: 1, private: 2, secret: 3 };
/** The most careful sensitivity among some fields (today's `strongestSensitivity`). */
export function strongestSensitivity(fields: readonly { readonly sensitivity: InputSensitivity }[]): InputSensitivity {
  return fields.reduce<InputSensitivity>(
    (strongest, field) =>
      SENSITIVITY_RANK[field.sensitivity] > SENSITIVITY_RANK[strongest] ? field.sensitivity : strongest,
    'plain',
  );
}

export const InputRequestStateSchema = z.enum([
  'pending',
  'delivering',
  'delivered',
  'refused',
  'expired',
  'cancelled',
]);
export type InputRequestState = z.infer<typeof InputRequestStateSchema>;

export const INPUT_REASONS = [
  'target_changed',
  'target_gone',
  'insecure_origin',
  'interrupted',
  'owner_declined',
  'agent_cancelled',
  'check_failures',
  'expired',
  'copy_gone',
  'taken_over',
] as const;
export const InputReasonSchema = z.enum(INPUT_REASONS);

/** Why a hold (today's lock) lasts as long as it does (today's `INPUT_LOCK_REASONS`). */
export const INPUT_HOLD_REASONS = [
  'hidden-terminal',
  'proven-field',
  'probed-field',
  'code',
  'not-proven',
  'terminal-shows',
  'scripted',
  'steered',
  'not-password-field',
  'first-time',
  'did-not-move-on',
  'until-moved-on',
  'probe-shown',
  'probe-stopped',
] as const;
export const InputHoldReasonSchema = z.enum(INPUT_HOLD_REASONS);
export const InputHoldSchema = z.strictObject({
  seconds: z.number().int().min(1).max(INPUT_QUARANTINE_SECONDS),
  reason: InputHoldReasonSchema,
});

const FieldLabelSchema = z.string().trim().min(1).max(60);

/** One value a card asks for, as the ferret raises it (today's `InputFieldRaiseSchema`). */
export const InputFieldRaiseSchema = z.strictObject({
  id: InputFieldIdSchema,
  label: FieldLabelSchema.optional(),
  sensitivity: InputSensitivitySchema,
  element: z
    .discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('selector'), selector: z.string().min(1).max(512) }),
      z.strictObject({ kind: z.literal('ref'), ref: z.string().regex(/^(?:f\d{1,6})?e\d{1,7}$/u) }),
    ])
    .optional(),
});
export type InputFieldRaise = z.infer<typeof InputFieldRaiseSchema>;

export const InputSubmitModeSchema = z.enum(['agent', 'offer-owner', 'owner-default']);

/**
 * Exactly what a ferret may say when it raises a request: nothing in it was observed (today's `InputRaiseSchema`,
 * field for field). `secretHint`, `factor` and `source` are Accounts' ids, carried opaque here (a core contract never
 * imports a plugin's); Accounts parses them and they are only ever HINTS.
 */
export const InputRaiseSchema = z
  .strictObject({
    target: InputTargetSchema,
    prompt: z.string().trim().min(1).max(INPUT_PROMPT_MAX_LENGTH),
    sensitivity: InputSensitivitySchema.optional(),
    fields: z.array(InputFieldRaiseSchema).min(1).max(INPUT_MAX_FIELDS).optional(),
    submit: InputSubmitModeSchema.default('offer-owner'),
    expiresInSeconds: z.number().int().min(30).max(INPUT_MAX_EXPIRY_SECONDS).optional(),
    blocking: z.boolean().optional(),
    /** A follow-up in a multi-step login: the ask it follows (`A12`). */
    chain: z
      .string()
      .regex(/^A[1-9][0-9]*$/u)
      .optional(),
    secretHint: z.string().min(1).max(128).optional(),
    factor: z.string().min(1).max(128).optional(),
    source: z.strictObject({ kind: z.literal('sealed'), name: z.string().min(1).max(64) }).optional(),
  })
  .superRefine((raise, context) => {
    if ((raise.sensitivity === undefined) === (raise.fields === undefined))
      context.addIssue({ code: 'custom', message: 'name the sensitivity of one value, or the fields of several' });
    const ids = (raise.fields ?? []).map(field => field.id);
    if (new Set(ids).size !== ids.length)
      context.addIssue({ code: 'custom', path: ['fields'], message: 'each field needs its own id' });
  });
export type InputRaise = z.infer<typeof InputRaiseSchema>;

/** The `ask.sources:input` ref: which request an ask is the card of. Validated by Asks with this schema. */
export const InputAskRefSchema = z.strictObject({ request: InputRequestIdSchema });
export type InputAskRef = z.infer<typeof InputAskRefSchema>;

/** One line of `state/vault/holds.jsonl`: evidence of a hold, never a value (today's quarantine events). */
export const HoldEvidenceSchema = z.strictObject({
  format: z.literal(1),
  /** Durable ownership: holds survive a missing or damaged mutable request record. */
  ferret: z.string().min(1).max(128),
  hold: z.string().min(1).max(128),
  names: z.array(z.string().min(1).max(128)).min(1).max(32),
  unresolved: z.boolean().optional(),
  at: InstantSchema,
  target: z.strictObject({ kind: z.string().min(1).max(32), key: z.string().min(1).max(128) }),
  event: z.enum(['began', 'ended', 'revealed']),
  request: InputRequestIdSchema.optional(),
  until: InstantSchema.optional(),
  reason: InputHoldReasonSchema.optional(),
});
export type HoldEvidence = z.infer<typeof HoldEvidenceSchema>;

export const HoldsFile = defineState({
  name: 'holds',
  path: 'holds.jsonl',
  store: 'jsonl',
  format: 1,
  schema: HoldEvidenceSchema,
  mode: 0o600,
});

/** `state/vault/input-requests/<id>.json`: the request without any value (values are RAM only). */
export const InputRequestRecordSchema = z.strictObject({
  format: z.literal(1),
  id: InputRequestIdSchema,
  ferret: z.string().min(1).max(128),
  raise: InputRaiseSchema,
  state: InputRequestStateSchema,
  reason: InputReasonSchema.optional(),
  raisedAt: InstantSchema,
  expiresAt: InstantSchema,
});
export type InputRequestRecord = z.infer<typeof InputRequestRecordSchema>;

export const InputRequestFiles = defineState({
  name: 'input-requests',
  path: 'input-requests/*.json',
  store: 'json',
  format: 1,
  schema: InputRequestRecordSchema,
  mode: 0o600,
});
