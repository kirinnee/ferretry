/**
 * WHAT THE INPUT CARD READS AND SENDS, as the app half knows it.
 *
 * The request view, the deliver body and the pad function are the Vault daemon's (`daemon/lib/inputs/wire.ts`), which
 * an app half may not import (halves share only the manifest and the contract). So this file keeps:
 *
 *   - a TOLERANT reader of just the fields the card draws, built from the contract's own parts (`InputTargetSchema`,
 *     `InputTargetFactsSchema`, the sensitivities, the states, the hold). A field the daemon adds is ignored; a field
 *     this card needs and the daemon stopped sending fails the read, shown as "needs a newer version of the app";
 *   - the deliver body as a plain type (the DAEMON parses it strictly; nothing here widens what it takes);
 *   - `padInputValue`, a copy of the daemon's, so the relay's size view shows a bucket and not a password's length.
 *     `tests/unit/app/input-wire-agreement.test.ts` pins this copy to the daemon's for every length it can take.
 *
 * NOTHING HERE KEEPS A VALUE. {@link padInputValue} returns a string for one body and keeps nothing.
 */
import { z } from 'zod';
import {
  INPUT_MAX_FIELDS,
  INPUT_PAD_BUCKET_BYTES,
  INPUT_VALUE_MAX_BYTES,
  InputFieldIdSchema,
  InputHoldSchema,
  InputRequestIdSchema,
  InputRequestStateSchema,
  InputSensitivitySchema,
  InputSubmitModeSchema,
  InputTargetFactsSchema,
  InputTargetSchema,
} from '../../contract/index.ts';

const RISK_LEVELS = ['green', 'neutral', 'amber', 'red'] as const;
/** A level this build does not know (a newer daemon's) reads as `amber`: a warning, never a pass. */
const RiskSchema = z.strictObject({
  level: z.preprocess(
    raw => (typeof raw === 'string' && !(RISK_LEVELS as readonly string[]).includes(raw) ? 'amber' : raw),
    z.enum(RISK_LEVELS),
  ),
  reason: z.string(),
});
export type InputRisk = z.infer<typeof RiskSchema>;

/**
 * A paste's copy as the owner's card is told it (the request's `source`): the handle's NAME and where the daemon read it.
 * Tolerant, like the rest of this reader: a member a newer daemon adds is ignored. There is no member for a value.
 */
const SealedSourceSchema = z.looseObject({
  kind: z.literal('sealed'),
  name: z.string().min(1),
  length: z.number().optional(),
  capturedAt: z.string().optional(),
  from: z.looseObject({
    kind: z.enum(['browser', 'clipboard', 'command']),
    origin: z.string().optional(),
    program: z.string().optional(),
    path: z.string().optional(),
  }),
});

const FieldSchema = z.strictObject({
  id: InputFieldIdSchema,
  label: z.string().min(1),
  sensitivity: InputSensitivitySchema,
  risk: RiskSchema.optional(),
});
export type InputRequestField = z.infer<typeof FieldSchema>;

/** The request as the owner's card reads it. `observed` is absent while the daemon is re-observing. */
export const InputRequestViewSchema = z.looseObject({
  id: InputRequestIdSchema,
  /** The ferret the request is from (the wire's `sessionId`). */
  sessionId: z.string().min(1),
  /** The ask that presents it: the owner knows it as `!A<n>`. */
  agendaItemId: z.string().min(1),
  target: InputTargetSchema,
  prompt: z.string(),
  sensitivity: InputSensitivitySchema,
  fields: z.array(FieldSchema).min(1).max(INPUT_MAX_FIELDS),
  submit: InputSubmitModeSchema,
  expiresAt: z.string().min(1),
  /** Present on a paste of a secure copy: there is nothing to type, and the owner allows it on this card. */
  source: SealedSourceSchema.optional(),
  chain: z.string().optional(),
  step: z.number().int().optional(),
  observed: InputTargetFactsSchema.optional(),
  risk: RiskSchema.optional(),
  observedDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .optional(),
  lock: InputHoldSchema.optional(),
  state: InputRequestStateSchema,
});
export type InputRequestView = z.infer<typeof InputRequestViewSchema>;

export const InputRequestListViewSchema = z.looseObject({ requests: z.array(z.unknown()) });

/** The answer to a deliver: where it stands, no value. */
export const InputDeliverAnswerSchema = z.looseObject({
  id: InputRequestIdSchema,
  state: InputRequestStateSchema,
  submitted: z.boolean(),
});
export type InputDeliverAnswer = z.infer<typeof InputDeliverAnswerSchema>;

/** `POST …/deliver` for a typed card: one padded value, or each field's, and whether to press Enter. */
export interface InputDeliverBodyView {
  readonly deliveryId: string;
  readonly observedDigest: string;
  /** The owner allows the copy the REQUEST names: no value, no handle (docs/secure-copy.md). */
  readonly sealed?: true;
  readonly padded?: string;
  readonly fields?: readonly { readonly field: string; readonly padded: string }[];
  readonly submit: boolean;
}

const encoder = new TextEncoder();
const LENGTH_WIDTH = 5;

/**
 * Round a value up to a bucket for the wire: `NNNNN:` (its UTF-8 length), the value, then spaces to the next multiple of
 * the bucket size. Throws `RangeError` for a value over the limit.
 */
export function padInputValue(value: string): string {
  const length = encoder.encode(value).length;
  if (length > INPUT_VALUE_MAX_BYTES) throw new RangeError('value too long');
  const head = `${String(length).padStart(LENGTH_WIDTH, '0')}:`;
  const used = head.length + length;
  const total = Math.max(INPUT_PAD_BUCKET_BYTES, Math.ceil(used / INPUT_PAD_BUCKET_BYTES) * INPUT_PAD_BUCKET_BYTES);
  return `${head}${value}${' '.repeat(total - used)}`;
}

/**
 * Why a value may not be typed as a `sensitivity`, or `undefined` when it may. A `secret`, `private` or `code` value
 * with a control character or a newline would press keys; `plain` may carry a Tab. Empty and over-long values are
 * refused for every sensitivity. The daemon checks again; this only saves the owner a round trip.
 */
export function inputValueProblem(
  value: string,
  sensitivity: z.infer<typeof InputSensitivitySchema>,
): string | undefined {
  if (value === '') return 'type something to send';
  if (encoder.encode(value).length > INPUT_VALUE_MAX_BYTES) return `a value is at most ${INPUT_VALUE_MAX_BYTES} bytes`;
  const checked = sensitivity === 'plain' ? value.replaceAll('\t', '') : value;
  if (/\p{Cc}/u.test(checked)) return 'this would press keys: remove the control characters or line breaks';
  return undefined;
}
