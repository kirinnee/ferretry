import { z } from 'zod';
import { AgendaIdSchema } from './agenda.ts';
import { SurfaceKeySchema, SurfaceKindSchema } from './surface-names.ts';
import { InstantSchema, NonNegativeIntegerSchema, PositiveIntegerSchema } from './common.ts';
import { SecretNameSchema } from './secrets.ts';

/**
 * THE INPUT REQUEST: the contract between an agent stuck at a password, sudo, one-time-code or 2FA prompt
 * and the owner who knows the value (docs/input-requests.md).
 *
 * ## THE SCHEMAS HERE HAVE NO FIELD FOR THE VALUE — EXCEPT ONE, AND IT IS PADDED
 *
 * A request, its facts, its events, its audit detail, the agenda item that presents it and everything an
 * agent is told describe WHERE a value goes and WHAT happened, never WHAT it was. The one place a value
 * exists is {@link InputDeliverBodySchema}: the owner's deliver, carried inside the sealed carrier and
 * dropped by the handler the moment it has been typed. `tests/unit/input-request.test.ts` fails if any
 * other schema here ever gains a field named or shaped like a value.
 */

/** The longest prompt an agent may write; the card shows it as "the agent says", never as fact. */
export const INPUT_PROMPT_MAX_LENGTH = 280;
/** How long a request lives when the agent names no time, and the most it may ask for. */
export const INPUT_DEFAULT_EXPIRY_SECONDS = 600;
export const INPUT_MAX_EXPIRY_SECONDS = 3_600;
/** How long a delivered value stays masked from reads: the default and the cap. */
export const INPUT_DEFAULT_REDACTION_SECONDS = 600;
export const INPUT_MAX_REDACTION_SECONDS = 3_600;
/** Per session: requests open at once, and raises an hour. Past either, the raise is refused with a sentence. */
export const INPUT_MAX_PENDING_PER_SESSION = 3;
export const INPUT_MAX_RAISES_PER_HOUR = 20;
/** Per request: deliveries that fail a check (the target changed, echo came on) before the request is refused. */
export const INPUT_MAX_CHECK_FAILURES = 3;
/** Per daemon: deliveries an hour from carriers that are not this machine. */
export const INPUT_MAX_REMOTE_DELIVERIES_PER_HOUR = 30;
/** The longest value, in UTF-8 bytes, before padding. */
export const INPUT_VALUE_MAX_BYTES = 1_024;
/** The bucket a padded value is rounded up to, so the relay cannot read the length from the size. */
export const INPUT_PAD_BUCKET_BYTES = 256;

const boundedLine = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .regex(/^[^\p{Cc}\p{Cf}]*$/u, 'must be one line with no control characters');

const HEX_DIGEST = /^[0-9a-f]{64}$/u;
const Digest = z.string().regex(HEX_DIGEST, 'a sha-256 digest in lowercase hex');

/** 128 random bits in hex: unguessable, and never reused. The owner reads the card as `!A<n>`, not this. */
export const InputRequestIdSchema = z.string().regex(/^[0-9a-f]{32}$/u, 'a 128-bit hex id');
export type InputRequestId = z.infer<typeof InputRequestIdSchema>;

/** One Send, minted by the client. A retry carries the same id and gets the first outcome; it never types twice. */
export const InputDeliveryIdSchema = z.uuid();
export type InputDeliveryId = z.infer<typeof InputDeliveryIdSchema>;

/**
 * How careful the daemon is with what is typed:
 * - `secret`: a password, passphrase or token. Echo must be off or the field a password field; masked
 *   from reads; never shown back; may be saved to the secret store.
 * - `private`: an OTP, 2FA code, username or e-mail. May be visible on screen; masked from reads for a window.
 * - `plain`: nothing sensitive (a hostname, "y"). Only the target binding is checked.
 */
export const InputSensitivitySchema = z.enum(['secret', 'private', 'plain']);
export type InputSensitivity = z.infer<typeof InputSensitivitySchema>;

/** Who presses Enter: the agent afterwards, the owner offered the choice, or the owner's default is on. */
export const InputSubmitModeSchema = z.enum(['agent', 'offer-owner', 'owner-default']);
export type InputSubmitMode = z.infer<typeof InputSubmitModeSchema>;

/** Where the value goes. A browser target names the field; the daemon, not the agent, observes what it is. */
export const InputTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('terminal'), key: SurfaceKeySchema }),
  z.strictObject({ kind: z.literal('browser'), key: SurfaceKeySchema, selector: boundedLine(512) }),
]);
export type InputTarget = z.infer<typeof InputTargetSchema>;

/** Exactly what an agent may say when it raises a request: nothing in it was observed. */
export const InputRaiseSchema = z.strictObject({
  target: InputTargetSchema,
  prompt: z.string().trim().min(1).max(INPUT_PROMPT_MAX_LENGTH),
  sensitivity: InputSensitivitySchema,
  submit: InputSubmitModeSchema.default('offer-owner'),
  /** Seconds the request lives; the default and the cap are above. */
  expiresInSeconds: z.number().int().min(30).max(INPUT_MAX_EXPIRY_SECONDS).optional(),
  /** Pings the owner (default for `secret`). */
  blocking: z.boolean().optional(),
  /** A follow-up in a multi-step login: the card it follows. */
  chain: AgendaIdSchema.optional(),
});
export type InputRaise = z.infer<typeof InputRaiseSchema>;

/** The pane the value goes to, as {@link PANE_PROOF_FORMAT} proved it (daemon-side `pane-proof.ts`). */
export const InputPaneProofSchema = z.strictObject({
  paneId: z.string().regex(/^%(?:0|[1-9][0-9]*)$/u),
  pid: PositiveIntegerSchema,
  sessionCreated: PositiveIntegerSchema.optional(),
});
export type InputPaneProof = z.infer<typeof InputPaneProofSchema>;

/** Does the TTY echo what is typed? `unknown` (the probe failed) is treated as `on` for a `secret`. */
export const InputEchoSchema = z.enum(['off', 'on', 'unknown']);
export type InputEcho = z.infer<typeof InputEchoSchema>;

/** The program reading the pane's TTY right now. `argv` is cut to 200 characters and is never audited. */
export const InputForegroundSchema = z.strictObject({
  pid: PositiveIntegerSchema,
  pgid: PositiveIntegerSchema,
  comm: boundedLine(64),
  argv: z
    .string()
    .max(200)
    .regex(/^[^\p{Cc}\p{Cf}]*$/u),
});
export type InputForeground = z.infer<typeof InputForegroundSchema>;

const TerminalFactsSchema = z.strictObject({
  kind: z.literal('terminal'),
  paneProof: InputPaneProofSchema,
  foreground: InputForegroundSchema,
  echo: InputEchoSchema,
  cursorRow: NonNegativeIntegerSchema,
  /** The prompt's own line, scrubbed of known values; the daemon captured it, the agent did not write it. */
  promptLine: z
    .string()
    .max(200)
    .regex(/^[^\p{Cc}\p{Cf}]*$/u),
  promptLineDigest: Digest,
  /** The program is one that asks for a secret (sudo, ssh, gpg, …); the shell itself or an interpreter is not. */
  recognisedConsumer: z.boolean(),
});

const BrowserFieldSchema = z.strictObject({
  tag: boundedLine(32),
  type: boundedLine(32).optional(),
  autocomplete: boundedLine(64).optional(),
  name: boundedLine(128).optional(),
  id: boundedLine(128).optional(),
  inputmode: boundedLine(32).optional(),
});

const BrowserFactsSchema = z.strictObject({
  kind: z.literal('browser'),
  pageId: boundedLine(128),
  /** scheme + host + port from the browser itself, never from the agent. */
  origin: boundedLine(256),
  secure: z.boolean(),
  frameOrigin: boundedLine(256),
  navigationId: boundedLine(128),
  backendNodeId: PositiveIntegerSchema,
  field: BrowserFieldSchema,
  box: z.strictObject({
    x: z.number().finite(),
    y: z.number().finite(),
    w: z.number().finite().nonnegative(),
    h: z.number().finite().nonnegative(),
  }),
  visible: z.boolean(),
});

/**
 * WHAT THE DAEMON SAW at the target when the request was raised, and sees again before it types. Held in
 * RAM and re-observed on restart; the card draws it large and the agent's `prompt` small, which is the
 * defence against a fake prompt.
 */
export const InputTargetFactsSchema = z.discriminatedUnion('kind', [TerminalFactsSchema, BrowserFactsSchema]);
export type InputTargetFacts = z.infer<typeof InputTargetFactsSchema>;

/** Where a request stands. Only `pending` may become `delivering`; the rest are final. */
export const InputRequestStateSchema = z.enum([
  'pending',
  'delivering',
  'delivered',
  'refused',
  'expired',
  'cancelled',
]);
export type InputRequestState = z.infer<typeof InputRequestStateSchema>;

/** Why a request was refused or cancelled: a closed list, so a reader's words fail typecheck for a new one. */
export const INPUT_REASONS = [
  'target_changed',
  'target_gone',
  'echo_on',
  'not_secret_field',
  'insecure_origin',
  'interrupted',
  'owner_declined',
  'agent_cancelled',
  'check_failures',
  'expired',
] as const;
export const InputReasonSchema = z.enum(INPUT_REASONS);
export type InputReason = z.infer<typeof InputReasonSchema>;

/** Who did it, as the daemon's actor rule names callers: a person at the machine or a paired device. */
export const InputActorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('host') }),
  z.strictObject({ kind: z.literal('device'), deviceId: boundedLine(128) }),
]);
export type InputActor = z.infer<typeof InputActorSchema>;

export const InputOutcomeSchema = z.strictObject({
  at: InstantSchema,
  by: InputActorSchema,
  submitted: z.boolean(),
  /** Typed by the owner, or a saved secret chosen by name. */
  source: z.enum(['typed', 'saved']),
  /** The NAME of the saved secret used; the owner's card shows it, the agent never sees it for a `secret`. */
  secretName: SecretNameSchema.optional(),
  reason: InputReasonSchema.optional(),
});
export type InputOutcome = z.infer<typeof InputOutcomeSchema>;

/**
 * THE REQUEST, as the owner's card reads it. `observed` is absent while the daemon is re-observing after
 * a restart: Send stays disabled until it is back.
 */
export const InputRequestSchema = z.strictObject({
  id: InputRequestIdSchema,
  /** From the agent's session credential, never from a body. */
  sessionId: boundedLine(128),
  /** The agenda card that presents it (`kind: 'input'`): the owner knows it as `!A<n>`. */
  agendaItemId: AgendaIdSchema,
  target: InputTargetSchema,
  prompt: z.string().trim().min(1).max(INPUT_PROMPT_MAX_LENGTH),
  sensitivity: InputSensitivitySchema,
  submit: InputSubmitModeSchema,
  raisedAt: InstantSchema,
  expiresAt: InstantSchema,
  chain: AgendaIdSchema.optional(),
  observed: InputTargetFactsSchema.optional(),
  /** A digest of the facts the card showed; deliver refuses `target_changed` when it no longer matches. */
  observedDigest: Digest.optional(),
  state: InputRequestStateSchema,
  outcome: InputOutcomeSchema.optional(),
});
export type InputRequest = z.infer<typeof InputRequestSchema>;

/**
 * WHAT THE AGENT IS TOLD, in the answer to its raise and in `input.wait`: where it stands and a short
 * summary of what the daemon saw — never the value, never its length, never a saved secret's name for a
 * `secret`. `screen` is the target's text through the redactor.
 */
export const InputAgentViewSchema = z.strictObject({
  id: AgendaIdSchema,
  state: InputRequestStateSchema,
  observed: z
    .strictObject({
      consumer: boundedLine(256).optional(),
      echo: InputEchoSchema.optional(),
      recognised: z.boolean().optional(),
    })
    .optional(),
  submitted: z.boolean().optional(),
  source: z.enum(['typed', 'saved']).optional(),
  reason: InputReasonSchema.optional(),
  screen: z.string().max(65_536).optional(),
  note: z.string().max(400).optional(),
});
export type InputAgentView = z.infer<typeof InputAgentViewSchema>;

/**
 * `POST /v1/sessions/:sid/input-requests/:id/deliver`. The one schema with a value, carried only inside
 * the sealed carrier. `padded` is {@link padInputValue}'s output, so the relay's size view reveals a
 * bucket, not a length. Exactly one of `padded` or `secretName`.
 */
export const InputDeliverBodySchema = z
  .strictObject({
    deliveryId: InputDeliveryIdSchema,
    observedDigest: Digest,
    padded: z
      .string()
      .min(1)
      .max(INPUT_VALUE_MAX_BYTES + 2 * INPUT_PAD_BUCKET_BYTES)
      .optional(),
    secretName: SecretNameSchema.optional(),
    /** Press Enter / submit after typing. */
    submit: z.boolean(),
    /** Save a typed value to the secret store under this name (only for a typed `secret`). */
    saveAs: SecretNameSchema.optional(),
    /** The owner ticked "I trust this program" on an amber card. */
    trustProgram: z.literal(true).optional(),
  })
  .superRefine((body, context) => {
    if ((body.padded === undefined) === (body.secretName === undefined)) {
      context.addIssue({ code: 'custom', message: 'send exactly one of padded or secretName' });
    }
    if (body.saveAs !== undefined && body.padded === undefined) {
      context.addIssue({ code: 'custom', message: 'saveAs saves a typed value', path: ['saveAs'] });
    }
  });
export type InputDeliverBody = z.infer<typeof InputDeliverBodySchema>;

/** The answer to a deliver: the outcome, no value. A repeat of a `deliveryId` returns the first one. */
export const InputDeliverResultSchema = z.strictObject({
  id: InputRequestIdSchema,
  deliveryId: InputDeliveryIdSchema,
  state: InputRequestStateSchema,
  submitted: z.boolean(),
  reason: InputReasonSchema.optional(),
});
export type InputDeliverResult = z.infer<typeof InputDeliverResultSchema>;

/** `GET /v1/input-requests` and `GET /v1/sessions/:sessionId/input-requests`: the requests still open, newest last. */
export const InputRequestListSchema = z.strictObject({ requests: z.array(InputRequestSchema) });
export type InputRequestList = z.infer<typeof InputRequestListSchema>;

/** `POST …/cancel`: the owner declines. */
export const InputCancelBodySchema = z.strictObject({});
export type InputCancelBody = z.infer<typeof InputCancelBodySchema>;

/** The error codes the input routes answer with, beside the HTTP status each rides on. */
export const INPUT_ERROR_CODES = {
  /** 400: the agenda's generic answer was used on a `kind: 'input'` item. */
  useInputForm: 'use_input_form',
  /** 409: the target is no longer the one the card showed. */
  targetChanged: 'target_changed',
  /** 409: the request is delivering or delivered under another `deliveryId`. */
  alreadyDelivered: 'already_delivered',
  /** 410: the request expired or was cancelled. */
  gone: 'gone',
  /** 409: `secret` and the TTY echoes (or cannot be probed). */
  echoOn: 'echo_on',
  /** 409: an input request is pending on the surface an agent tried to type into. */
  inputPending: 'input_pending',
  /** 429: too many pending or recent requests. */
  rateLimited: 'rate_limited',
} as const;

/** The session-journal events a request is published as; the payload is {@link InputEventSchema}. */
export const INPUT_JOURNAL_EVENT_TYPES = {
  requested: 'surface.input_requested',
  delivered: 'surface.input_delivered',
  refused: 'surface.input_refused',
  expired: 'surface.input_expired',
  cancelled: 'surface.input_cancelled',
} as const;
export const InputJournalEventTypeSchema = z.enum([
  INPUT_JOURNAL_EVENT_TYPES.requested,
  INPUT_JOURNAL_EVENT_TYPES.delivered,
  INPUT_JOURNAL_EVENT_TYPES.refused,
  INPUT_JOURNAL_EVENT_TYPES.expired,
  INPUT_JOURNAL_EVENT_TYPES.cancelled,
]);
export type InputJournalEventType = z.infer<typeof InputJournalEventTypeSchema>;

/**
 * One journal event about a request: ids, the target's name, the state it moved to and why. No prompt,
 * no facts, no value. The daemon replays them on start; a pending request whose surface still exists
 * comes back and is re-observed before Send is allowed.
 */
export const InputEventSchema = z.strictObject({
  type: InputJournalEventTypeSchema,
  requestId: InputRequestIdSchema,
  agendaItemId: AgendaIdSchema,
  sessionId: boundedLine(128),
  target: z.strictObject({ kind: SurfaceKindSchema, key: SurfaceKeySchema }),
  sensitivity: InputSensitivitySchema,
  /** Who presses Enter, so a restart can rebuild a pending request. */
  submit: InputSubmitModeSchema.optional(),
  state: InputRequestStateSchema,
  submitted: z.boolean().optional(),
  source: z.enum(['typed', 'saved']).optional(),
  reason: InputReasonSchema.optional(),
  expiresAt: InstantSchema.optional(),
  at: InstantSchema,
});
export type InputEvent = z.infer<typeof InputEventSchema>;

/** The audit events this feature writes (general store, activity). Wired into `AUDIT_EVENTS` by the daemon PR. */
export const INPUT_AUDIT_EVENTS = [
  'input.requested',
  'input.delivered',
  'input.refused',
  'input.expired',
  'input.cancelled',
] as const;
export const InputAuditEventSchema = z.enum(INPUT_AUDIT_EVENTS);
export type InputAuditEvent = z.infer<typeof InputAuditEventSchema>;

/**
 * The details an input audit record carries: names and flags, never the value, its length (for a
 * `secret`), the prompt text or a URL path. `consumer` is a program name or an origin's host.
 */
export const InputAuditDetailSchema = z.strictObject({
  targetKind: SurfaceKindSchema,
  consumer: boundedLine(160).optional(),
  sensitivity: InputSensitivitySchema,
  recognised: z.boolean().optional(),
  source: z.enum(['typed', 'saved']).optional(),
  secretName: SecretNameSchema.optional(),
  submitted: z.boolean().optional(),
  carrier: z.enum(['loopback', 'direct', 'relay']).optional(),
  reason: InputReasonSchema.optional(),
});
export type InputAuditDetail = z.infer<typeof InputAuditDetailSchema>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const LENGTH_WIDTH = 5;

const hasControlCharacter = (text: string): boolean => /\p{Cc}/u.test(text);

/**
 * Why a value may not be typed as a `sensitivity`, or `undefined` when it may. A `secret` or `private`
 * value with a control character or a newline would press keys ("this would press keys"); `plain` may
 * carry a Tab. Empty and over-long values are refused for every sensitivity.
 */
export function inputValueProblem(value: string, sensitivity: InputSensitivity): string | undefined {
  if (value === '') return 'type something to send';
  if (encoder.encode(value).length > INPUT_VALUE_MAX_BYTES) {
    return `a value is at most ${INPUT_VALUE_MAX_BYTES} bytes`;
  }
  const checked = sensitivity === 'plain' ? value.replaceAll('\t', '') : value;
  if (hasControlCharacter(checked)) return 'this would press keys: remove the control characters or line breaks';
  return undefined;
}

/**
 * Round a value up to a bucket for the wire: `NNNNN:` (its UTF-8 length), the value, then spaces to the
 * next multiple of {@link INPUT_PAD_BUCKET_BYTES}. The relay sees a bucket, not a password length. Throws
 * `RangeError` for a value over {@link INPUT_VALUE_MAX_BYTES}.
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
 * Take the value back out of {@link padInputValue}'s output, or `undefined` when the string is not exactly
 * that: a wrong prefix, a length that does not fit, padding that is not spaces, or a size off the bucket.
 */
export function unpadInputValue(padded: string): string | undefined {
  const bytes = encoder.encode(padded);
  if (bytes.length === 0 || bytes.length % INPUT_PAD_BUCKET_BYTES !== 0) return undefined;
  const head = String.fromCharCode(...bytes.subarray(0, LENGTH_WIDTH + 1));
  if (!/^[0-9]{5}:$/u.test(head)) return undefined;
  const length = Number(head.slice(0, LENGTH_WIDTH));
  const end = LENGTH_WIDTH + 1 + length;
  if (length > INPUT_VALUE_MAX_BYTES || end > bytes.length) return undefined;
  if (!bytes.subarray(end).every(byte => byte === 0x20)) return undefined;
  if (
    bytes.length !== Math.max(INPUT_PAD_BUCKET_BYTES, Math.ceil(end / INPUT_PAD_BUCKET_BYTES) * INPUT_PAD_BUCKET_BYTES)
  ) {
    return undefined;
  }
  return decoder.decode(bytes.subarray(LENGTH_WIDTH + 1, end));
}
