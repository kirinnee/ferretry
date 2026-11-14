/**
 * WHAT `fy input` READS AND SENDS, as the CLI half knows it.
 *
 * The request view, the deliver body and the pad function are the Vault daemon's (`daemon/lib/inputs/wire.ts`), which a
 * CLI half may not import (halves share only the manifest and the contract). So this file keeps what the daemon's own
 * wire would have given it, built from the contract's parts wherever the contract has them:
 *
 *   - a TOLERANT reader of just the fields the owner's terminal draws (the app half's card does the same). A field the
 *     daemon adds is ignored; one this command needs and the daemon stopped sending fails the read, and the command says
 *     the daemon is newer than this `fy`.
 *   - the deliver body as a plain type (the DAEMON parses it strictly; nothing here widens what it takes);
 *   - `padInputValue` and `inputValueProblem`, copies of the daemon's, pinned to it for every length it takes by
 *     `tests/unit/cli/input-wire-agreement.test.ts`.
 *
 * NOTHING HERE KEEPS A VALUE. {@link padInputValue} returns a string for one body and keeps nothing.
 */
import { z } from 'zod';
import {
  INPUT_MAX_FIELDS,
  INPUT_PAD_BUCKET_BYTES,
  INPUT_REASONS,
  INPUT_SENSITIVITIES,
  INPUT_VALUE_MAX_BYTES,
  InputFieldIdSchema,
  InputRequestIdSchema,
  InputRequestStateSchema,
  InputSensitivitySchema,
  InputSubmitModeSchema,
  InputTargetFactsSchema,
  InputTargetSchema,
  MIN_SECRET_VALUE_LENGTH,
  SecretNameSchema,
} from '../../../contract/index.ts';

const RISK_LEVELS = ['green', 'neutral', 'amber', 'red'] as const;
/** A level this build does not know (a newer daemon's) reads as `amber`: a warning, never a pass. */
const RiskSchema = z.looseObject({
  level: z.preprocess(
    raw => (typeof raw === 'string' && !(RISK_LEVELS as readonly string[]).includes(raw) ? 'amber' : raw),
    z.enum(RISK_LEVELS),
  ),
  reason: z.string(),
});

/** A kind this build does not know (a newer daemon's) reads as `secret`: closed, never `plain`. */
const ReadSensitivitySchema = z.preprocess(
  raw => (typeof raw === 'string' && !(INPUT_SENSITIVITIES as readonly string[]).includes(raw) ? 'secret' : raw),
  InputSensitivitySchema,
);

const FieldSchema = z.looseObject({
  id: InputFieldIdSchema,
  label: z.string().min(1),
  sensitivity: ReadSensitivitySchema,
  risk: RiskSchema.optional(),
});

/** The saved accounts a card may offer: only the handle, the label and which one the daemon matched are read. */
const SavedSchema = z.looseObject({
  suggest: z.looseObject({ id: z.string(), label: z.string() }).optional(),
  saves: z.string().optional(),
  offers: z.array(z.looseObject({ id: z.string(), label: z.string(), matched: z.boolean().optional() })).default([]),
});

/** A paste's source: the secure copy it will type, and where the daemon captured it from. Names, never the value. */
const SourceSchema = z.looseObject({
  name: z.string().min(1),
  from: z.looseObject({
    kind: z.string(),
    origin: z.string().optional(),
    path: z.string().optional(),
    program: z.string().optional(),
  }),
});

/** The request as the owner's terminal reads it. `observed` is absent while the daemon is re-observing. */
export const InputRequestViewSchema = z.looseObject({
  id: InputRequestIdSchema,
  /** The ferret the request is from (the wire's `sessionId`). */
  sessionId: z.string().min(1),
  /** The ask that presents it: the owner knows it as `!A<n>`. */
  agendaItemId: z.string().min(1),
  target: InputTargetSchema,
  prompt: z.string(),
  sensitivity: ReadSensitivitySchema,
  fields: z.array(FieldSchema).min(1).max(INPUT_MAX_FIELDS),
  submit: InputSubmitModeSchema,
  expiresAt: z.string().min(1),
  source: SourceSchema.optional(),
  chain: z.string().optional(),
  step: z.number().int().optional(),
  observed: InputTargetFactsSchema.optional(),
  risk: RiskSchema.optional(),
  observedDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .optional(),
  saved: SavedSchema.optional(),
  state: InputRequestStateSchema,
});
export type InputRequestView = z.infer<typeof InputRequestViewSchema>;

export const InputRequestListViewSchema = z.looseObject({ requests: z.array(InputRequestViewSchema) });
export type InputRequestListView = z.infer<typeof InputRequestListViewSchema>;

/** The answer to a deliver: where it stands, and what came of "save as". No value. */
export const InputDeliverAnswerSchema = z.looseObject({
  id: InputRequestIdSchema,
  state: InputRequestStateSchema,
  submitted: z.boolean(),
  reason: z.enum(INPUT_REASONS).optional(),
  saved: z.looseObject({ entry: z.string(), ok: z.boolean(), problem: z.string().optional() }).optional(),
});
export type InputDeliverAnswer = z.infer<typeof InputDeliverAnswerSchema>;

/** `POST …/deliver`: a typed card sends `padded` or each field's; a saved account is named; a paste sends `sealed`. */
export interface InputDeliverBodyView {
  readonly deliveryId: string;
  readonly observedDigest: string;
  readonly padded?: string;
  readonly fields?: readonly { readonly field: string; readonly padded: string }[];
  readonly entry?: string;
  readonly sealed?: true;
  readonly submit: boolean;
  readonly save?: { readonly entry: string; readonly label: string };
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

/** An account's CLI name is the Vault's secret name (Accounts' `AccountIdSchema`); only a NAME is ever sent, never a value. */
export const ACCOUNT_HANDLE = SecretNameSchema;
/** Accounts' label limit (`LOGIN_LABEL_MAX_LENGTH`) and its saved password's minimum length, which is the Vault's own. */
export const ACCOUNT_LABEL_MAX_LENGTH = 80;
export const ACCOUNT_PASSWORD_MIN_LENGTH = MIN_SECRET_VALUE_LENGTH;
