import { z } from 'zod';
import { SignInIdSchema, SignInRuleIdSchema, SignInRuleRevisionSchema, TwoFactorIdSchema } from './account-ids.ts';
import { AgendaIdSchema } from './agenda.ts';
import { BrowserChallengeProviderSchema, BrowserRefSchema } from './browser-target.ts';
import { durationWords, InstantSchema, NonNegativeIntegerSchema, PositiveIntegerSchema } from './common.ts';
import { InputSavedSchema, LOGIN_LABEL_MAX_LENGTH, LoginEntryIdSchema } from './login-entries.ts';
import { SecretNameSchema } from './secrets.ts';
import { CopyNameSchema, CopyOriginSchema, CopyPlanIdSchema } from './secure-copy.ts';
import { SurfaceKeySchema } from './surface-names.ts';
import { GrantMissReasonSchema, TaskPlanLineNumberSchema } from './task-plan.ts';

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
/**
 * How long a terminal is QUARANTINED after the daemon types a secret into it: the agent's reads of it are
 * refused and the owner's viewer shows a cover instead of the screen. The owner can end it sooner.
 */
export const INPUT_QUARANTINE_SECONDS = 120;
/** The lock's length in the owner's and the ferret's words ("two minutes"), from {@link INPUT_QUARANTINE_SECONDS}. */
export const INPUT_QUARANTINE_WORDS = durationWords(INPUT_QUARANTINE_SECONDS);
/**
 * ONE SENTENCE EACH for what the ferret can read (C41): a plain value, and a one-time code (not secret either, but
 * neutral). The daemon's flag on a field and the app's and CLI's words are these; a client that tells one only once
 * compares the risk to them, never searches the text.
 */
export const INPUT_PLAIN_VALUE_NOTICE = 'Not secret: the ferret can see this value.';
export const INPUT_CODE_VISIBLE_NOTICE = 'One-time code: the ferret can see it.';
/**
 * THE SHORT LOCK (docs/input-requests.md, "How long the lock lasts"): a target PROVEN not to show what is typed is
 * kept from the ferret this long after the write instead of {@link INPUT_QUARANTINE_SECONDS}. Masking still runs
 * its whole redaction window either way.
 */
export const INPUT_SHORT_LOCK_SECONDS = 10;

/**
 * Why a card's lock is as long as it is. Only the first three are short, and each is something the DAEMON saw:
 *
 * - `hidden-terminal`: a local password prompt: echo off in line mode, sudo/su/doas/passwd running setuid root.
 * - `proven-field`: a password field on a secure page whose identity Ferretry has seen, on an earlier sign-in, hide
 *   the value after submit and move on (a saved login's observed facts).
 * - `probed-field`: one password field on a secure page into which Ferretry typed a throwaway value, did not find it in
 *   the page's text, and cleared it again, with no request or socket it could see and no navigation meanwhile.
 * - `code`: a `private` value shows as it is typed (a one-time `code` field has no lock at all).
 * - `not-proven`: nothing proved that this target hides what is typed.
 */
export const INPUT_LOCK_REASONS = ['hidden-terminal', 'proven-field', 'probed-field', 'code', 'not-proven'] as const;
export const InputLockReasonSchema = z.enum(INPUT_LOCK_REASONS);
export type InputLockReason = z.infer<typeof InputLockReasonSchema>;

export const InputLockSchema = z.strictObject({
  seconds: z.number().int().min(1).max(INPUT_QUARANTINE_SECONDS),
  reason: InputLockReasonSchema,
});
export type InputLock = z.infer<typeof InputLockSchema>;

/** What the card says about each reason: one fixed sentence, never page or terminal text. */
export const INPUT_LOCK_WORDS: Readonly<Record<InputLockReason, string>> = {
  'hidden-terminal': 'A local password prompt (sudo, su, doas or passwd) with typing hidden.',
  'proven-field': 'A password field Ferretry has seen hide the value and move on after signing in.',
  'probed-field': "A password field: a test value Ferretry typed did not show in the page's text.",
  code: 'This value shows on screen as it is typed.',
  'not-proven': 'Ferretry has not proven that this target hides what is typed.',
};

/** "Hidden from the ferret for 10 s" or "for 2 minutes". */
export function lockWords(lock: InputLock): string {
  return lock.seconds >= 60
    ? `${String(Math.round(lock.seconds / 60))} minute${lock.seconds >= 90 ? 's' : ''}`
    : `${String(lock.seconds)} s`;
}
/** Per session: requests open at once, and raises an hour. Past either, the raise is refused with a sentence. */
export const INPUT_MAX_PENDING_PER_SESSION = 3;
export const INPUT_MAX_RAISES_PER_HOUR = 20;
/** Per request: deliveries that fail a check (the target changed, echo came on) before the request is refused. */
export const INPUT_MAX_CHECK_FAILURES = 3;
/**
 * Per request: times the daemon may find the SAME target again after it changed under the card (a page that
 * re-rendered its field, a terminal that redrew its prompt) and redraw the card instead of counting a failure.
 * Past it the target is changing faster than the owner can answer, and the request ends.
 */
export const INPUT_MAX_REBINDS = 5;
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
 * How careful the daemon is with what is typed, most careful first:
 * - `secret`: a password, passphrase or token. Echo must be off or the field a password field; masked
 *   from reads; never shown back; may be saved to the secret store.
 * - `private`: a value that is not one-time but shows on screen as it is typed (rare). Masked from reads for a
 *   window, and the target is kept from the ferret for the full lock.
 * - `code`: a one-time code (2FA, an e-mail or SMS verification code, a device code). NOT secret: the ferret may see
 *   it, and may type one itself. No lock and no masking, except a code the DAEMON made from a saved 2FA seed: no tool,
 *   result or route RETURNS it, and its text is masked from text reads; the ferret may still see it on screen (a
 *   screenshot, a scripted read), as the owner allowed (docs/input-requests.md, "One-time codes").
 * - A `code` field the daemon sees going into a password field or prompt is handled as `secret` instead.
 * - `plain`: nothing sensitive (a username, a hostname, "y"). Only the target binding is checked.
 */
export const INPUT_SENSITIVITIES = ['secret', 'private', 'code', 'plain'] as const;
export const InputSensitivitySchema = z.enum(INPUT_SENSITIVITIES);
export type InputSensitivity = z.infer<typeof InputSensitivitySchema>;

/**
 * A sensitivity as a CLIENT reads it off a request: one this build does not know (a newer daemon's) reads as
 * `secret`, the most careful, so a card is never drawn or answered as `plain` because its kind is new. A build
 * from before `code` existed has the closed enum here and refuses the whole request instead: also closed, never
 * plain. The daemon never parses a request, so this leniency is a reader's only.
 */
export const ReadInputSensitivitySchema = z.preprocess(
  raw => (typeof raw === 'string' && !(INPUT_SENSITIVITIES as readonly string[]).includes(raw) ? 'secret' : raw),
  InputSensitivitySchema,
);

/** Who presses Enter: the agent afterwards, the owner offered the choice, or the owner's default is on. */
export const InputSubmitModeSchema = z.enum(['agent', 'offer-owner', 'owner-default']);
export type InputSubmitMode = z.infer<typeof InputSubmitModeSchema>;

/** Where the value goes. A browser's fields each name their own element; the daemon, not the agent, observes what it is. */
export const InputTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('terminal'), key: SurfaceKeySchema }),
  z.strictObject({ kind: z.literal('browser'), key: SurfaceKeySchema }),
  /**
   * The secret store, under a name (docs/secure-copy.md): only a paste of a secure copy goes here, and what the
   * daemon observes is whether the name already holds a value.
   */
  z.strictObject({ kind: z.literal('secret'), key: SecretNameSchema }),
]);
export type InputTarget = z.infer<typeof InputTargetSchema>;

/** The kinds of place a value can go: a terminal, a page, or the secret store. */
export const InputTargetKindSchema = z.enum(['terminal', 'browser', 'secret']);
export type InputTargetKind = z.infer<typeof InputTargetKindSchema>;

/** The most fields one card holds: a login's username, password and code, and one spare. */
export const INPUT_MAX_FIELDS = 4;
/** The longest label an agent may give a field ("Email", "Password"). */
export const INPUT_FIELD_LABEL_MAX_LENGTH = 60;
/** The id a request with one field gives it when the agent names none. */
export const INPUT_SINGLE_FIELD_ID = 'value';

/** A field's id within its card: a short lowercase word, so a deliver can say which value is which. */
export const InputFieldIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,31}$/u, 'a field id is a short lowercase word: letters, digits and underscores');
export type InputFieldId = z.infer<typeof InputFieldIdSchema>;

const FieldLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(INPUT_FIELD_LABEL_MAX_LENGTH)
  .regex(/^[^\p{Cc}\p{Cf}]*$/u, 'must be one line with no control characters');

/**
 * The element a browser field names, the way every browser act names one: a snapshot's `ref` or a selector.
 * It is the agent's POINTER, never a fact: the daemon resolves it and observes what is actually there.
 */
export const InputFieldElementSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('selector'), selector: boundedLine(512) }),
  z.strictObject({ kind: z.literal('ref'), ref: BrowserRefSchema }),
]);
export type InputFieldElement = z.infer<typeof InputFieldElementSchema>;

/**
 * One value a card asks for, as the agent raises it. Each field carries its own sensitivity, so a login is
 * "Email (plain, the ferret can see it)" + "Password (secret)" on ONE card. A terminal takes exactly one field
 * (its prompts come one at a time: a second is a chained request); a browser field names its element.
 */
export const InputFieldRaiseSchema = z.strictObject({
  id: InputFieldIdSchema,
  label: FieldLabelSchema.optional(),
  sensitivity: InputSensitivitySchema,
  element: InputFieldElementSchema.optional(),
});
export type InputFieldRaise = z.infer<typeof InputFieldRaiseSchema>;

const fieldsProblem = (fields: readonly { readonly id: string }[]): string | undefined =>
  new Set(fields.map(field => field.id)).size === fields.length ? undefined : 'each field needs its own id';

/**
 * Exactly what an agent may say when it raises a request: nothing in it was observed. A one-value request
 * names its `sensitivity`; a card of several values names its `fields` instead.
 */
export const InputRaiseSchema = z
  .strictObject({
    target: InputTargetSchema,
    prompt: z.string().trim().min(1).max(INPUT_PROMPT_MAX_LENGTH),
    sensitivity: InputSensitivitySchema.optional(),
    fields: z.array(InputFieldRaiseSchema).min(1).max(INPUT_MAX_FIELDS).optional(),
    submit: InputSubmitModeSchema.default('offer-owner'),
    /** Seconds the request lives; the default and the cap are above. */
    expiresInSeconds: z.number().int().min(30).max(INPUT_MAX_EXPIRY_SECONDS).optional(),
    /** Pings the owner (default when a field is `secret`). */
    blocking: z.boolean().optional(),
    /** A follow-up in a multi-step login: the card it follows. */
    chain: AgendaIdSchema.optional(),
    /**
     * The account the ferret expects to be used. A HINT only: the daemon decides what matches the target,
     * a hint never makes an entry the one-tap choice, and the answer is the same whether such an entry exists.
     * An account handle, or a sign-in (`si_…`). A daemon from before sign-ins refuses a `si_` hint, and one that
     * does not yet keep them (no `accounts.signins.1`) names no sign-in, so the hint orders nothing. No client gates
     * it: the MCP tools pass the ferret's hint through as given, and the DAEMON refuses one it cannot read. Either way
     * a hint can only choose among the sign-ins the daemon itself matched (accounts.ts `chosenSignIn`).
     */
    secretHint: z.union([LoginEntryIdSchema, SignInIdSchema]).optional(),
    /**
     * The 2FA key the code is from, as `account_hint` listed it: names the card ("Code sent to ••42 (SMS)"). A HINT
     * like `secretHint`: used only if it is a key of the account of a sign-in the daemon matched, otherwise ignored,
     * never an error that would say whether such a key exists. A daemon from before 2FA keys ignores it.
     */
    factor: TwoFactorIdSchema.optional(),
    /**
     * The value comes from a secure copy the agent holds (`sealed:<name>`, docs/secure-copy.md), not from the
     * owner's keyboard: the owner only allows it. The daemon treats every field as `secret` whatever it says.
     */
    source: z.strictObject({ kind: z.literal('sealed'), name: CopyNameSchema }).optional(),
  })
  .superRefine((raise, context) => {
    if ((raise.sensitivity === undefined) === (raise.fields === undefined))
      context.addIssue({ code: 'custom', message: 'name the sensitivity of one value, or the fields of several' });
    const problem = raise.fields === undefined ? undefined : fieldsProblem(raise.fields);
    if (problem !== undefined) context.addIssue({ code: 'custom', path: ['fields'], message: problem });
  });
export type InputRaise = z.infer<typeof InputRaiseSchema>;

/** Where a pasted value came from, as the DAEMON recorded it when the copy was captured: names, never the value. */
export const InputSourceSchema = z.strictObject({
  kind: z.literal('sealed'),
  name: CopyNameSchema,
  from: CopyOriginSchema,
});
export type InputSource = z.infer<typeof InputSourceSchema>;

/**
 * Which fields of a card "Save as" keeps, and as what, so a login's username and password are kept together in
 * ONE saved login: a `plain` field as the username, a `secret` as the password. A one-time code is never
 * saved (its seed is, from Settings). `undefined` when the card cannot be kept as one login: nothing to keep,
 * or two usernames or two passwords.
 */
export function savedRolesOf(
  fields: readonly { readonly id: string; readonly sensitivity: InputSensitivity }[],
): ReadonlyMap<string, 'username' | 'password'> | undefined {
  const roles = new Map<string, 'username' | 'password'>();
  for (const field of fields) {
    if (field.sensitivity === 'private' || field.sensitivity === 'code') continue;
    const role = field.sensitivity === 'secret' ? 'password' : 'username';
    if ([...roles.values()].includes(role)) return undefined;
    roles.set(field.id, role);
  }
  return roles.size === 0 ? undefined : roles;
}

/** A raise's fields: its own, or the one value a `sensitivity` names. */
export function inputRaiseFields(raise: Pick<InputRaise, 'sensitivity' | 'fields'>): readonly InputFieldRaise[] {
  if (raise.fields !== undefined) return raise.fields;
  return [{ id: INPUT_SINGLE_FIELD_ID, sensitivity: raise.sensitivity ?? 'secret' }];
}

const SENSITIVITY_RANK: Readonly<Record<InputSensitivity, number>> = { plain: 0, code: 1, private: 2, secret: 3 };

/** The most careful sensitivity among some fields: what the card, the journal and the audit record as the request's. */
export function strongestSensitivity(fields: readonly { readonly sensitivity: InputSensitivity }[]): InputSensitivity {
  return fields.reduce<InputSensitivity>(
    (strongest, field) =>
      SENSITIVITY_RANK[field.sensitivity] > SENSITIVITY_RANK[strongest] ? field.sensitivity : strongest,
    'plain',
  );
}

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
  /**
   * The program reading the terminal, PROVED by the kernel to be the one program every process of the foreground group
   * runs, with no process of another session holding the TTY open. Absent: UNVERIFIED — `foreground.comm` is only the
   * name a process gave itself, and a ferret's shell can call itself `sudo`.
   */
  program: boundedLine(64).optional(),
  /**
   * Every process of the foreground group is PROVED to be a program that asks for a secret (sudo, ssh, gpg, …); the
   * shell itself or an interpreter is not. Never true without `program`.
   */
  recognisedConsumer: z.boolean(),
  /**
   * The TTY is in canonical (line) mode, as a password prompt reads it. A program in raw or readline mode turns echo
   * off and draws every character itself (ssh to a remote shell, psql), so echo off alone proves nothing.
   */
  canonical: z.boolean().optional(),
  /**
   * EVERY process of the foreground group runs setuid root (effective uid 0, real uid not): not a script or binary a
   * ferret placed. Never true without `program`.
   */
  trustedProgram: z.literal(true).optional(),
});

const BrowserFieldSchema = z.strictObject({
  tag: boundedLine(32),
  type: boundedLine(32).optional(),
  autocomplete: boundedLine(64).optional(),
  name: boundedLine(128).optional(),
  id: boundedLine(128).optional(),
  inputmode: boundedLine(32).optional(),
});

/** One field of a page as the daemon found it: the element the agent pointed at, resolved by the browser. */
export const InputBrowserFieldFactsSchema = z.strictObject({
  /** The card's field this element is for. */
  fieldId: InputFieldIdSchema,
  /** The origin of the frame the element is in; the card flags one that is not the page's own. */
  frameOrigin: boundedLine(256),
  /** The frame the element is in, as the browser names it: the write goes there and nowhere else. */
  frameId: boundedLine(128),
  backendNodeId: PositiveIntegerSchema,
  field: BrowserFieldSchema,
  box: z.strictObject({
    x: z.number().finite(),
    y: z.number().finite(),
    w: z.number().finite().nonnegative(),
    h: z.number().finite().nonnegative(),
  }),
  visible: z.boolean(),
  /** Something else is on top at the field's centre, or it is off screen: the card flags it, nothing refuses it. */
  covered: z.literal(true).optional(),
});
export type InputBrowserFieldFacts = z.infer<typeof InputBrowserFieldFactsSchema>;

const BrowserFactsSchema = z.strictObject({
  kind: z.literal('browser'),
  pageId: boundedLine(128),
  /** scheme + host + port from the browser itself, never from the agent. */
  origin: boundedLine(256),
  /** https, or a page on this machine (`http://localhost`): what is typed does not cross a network in the clear. */
  secure: z.boolean(),
  /** The document the fields belong to: a navigation since the card was drawn changes it. */
  navigationId: boundedLine(128),
  fields: z.array(InputBrowserFieldFactsSchema).min(1).max(INPUT_MAX_FIELDS),
  /** The page appears to be asking for a human check: the owner completes it (`browser_ask_owner`), never Ferretry. */
  challenge: z.strictObject({ provider: BrowserChallengeProviderSchema }).optional(),
});

/**
 * WHAT THE DAEMON SAW at the target when the request was raised, and sees again before it types. Held in
 * RAM and re-observed on restart; the card draws it large and the agent's `prompt` small, which is the
 * defence against a fake prompt.
 */
/** The secret store under one name: whether it already holds a value, as the vault said when the daemon looked. */
const SecretStoreFactsSchema = z.strictObject({
  kind: z.literal('secret'),
  name: SecretNameSchema,
  /** The name already holds a value: the paste REPLACES it. */
  exists: z.boolean(),
});

export const InputTargetFactsSchema = z.discriminatedUnion('kind', [
  TerminalFactsSchema,
  BrowserFactsSchema,
  SecretStoreFactsSchema,
]);
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
  'insecure_origin',
  'interrupted',
  'owner_declined',
  'agent_cancelled',
  'check_failures',
  'expired',
  /** The secure copy a paste was to come from was discarded, expired, or forgotten by a restart. */
  'copy_gone',
] as const;
export const InputReasonSchema = z.enum(INPUT_REASONS);
export type InputReason = z.infer<typeof InputReasonSchema>;

/** Who did it, as the daemon's actor rule names callers: a person at the machine or a paired device. */
export const InputActorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('host') }),
  z.strictObject({ kind: z.literal('device'), deviceId: boundedLine(128) }),
  /** A paste the owner approved IN ADVANCE: the daemon delivered it under this pre-approval rule (docs/secure-copy.md). */
  z.strictObject({ kind: z.literal('rule'), ruleId: z.string().regex(/^[0-9a-f]{32}$/u) }),
  /** A sign-in the owner approved IN ADVANCE on a task plan: the daemon filled it under this plan line (task-plan.ts). */
  z.strictObject({ kind: z.literal('plan'), planId: CopyPlanIdSchema, line: TaskPlanLineNumberSchema }),
  /**
   * A sign-in the owner approved IN ADVANCE with a standing rule: the daemon filled it under this rule, at this revision
   * (sign-in-rules.ts). Not `rule`: that is a paste rule, with its own 32-hex id.
   */
  z.strictObject({ kind: z.literal('sign-in-rule'), rule: SignInRuleIdSchema, revision: SignInRuleRevisionSchema }),
]);
export type InputActor = z.infer<typeof InputActorSchema>;

/**
 * WHO FILLED A SIGN-IN, as the login observer records it: the owner's tap from a paired `device`, the machine's admin
 * token (`host`: the owner at the machine, or a ferret that read the token), a task `plan` line, or a `rule` (a paste
 * rule or a standing sign-in rule). Only a `device` tap counts toward a standing rule's history ({@link ownerTapped}).
 */
export const LOGIN_OBSERVER_BYS = ['device', 'host', 'plan', 'rule'] as const;
export type LoginObserverBy = (typeof LOGIN_OBSERVER_BYS)[number];

/**
 * Every actor's observer word. Keyed by EVERY actor kind, so a new kind fails typecheck here until it is mapped,
 * instead of falling through to an owner's tap (which would let fills qualify themselves for a standing rule).
 */
export const INPUT_ACTOR_OBSERVER_BY = {
  host: 'host',
  device: 'device',
  rule: 'rule',
  plan: 'plan',
  'sign-in-rule': 'rule',
} as const satisfies { readonly [Kind in InputActor['kind']]: LoginObserverBy };

/** The observer word for whoever filled a card: total, with no default. */
export const observerByOf = (actor: InputActor): LoginObserverBy => INPUT_ACTOR_OBSERVER_BY[actor.kind];

/** Whether a fill was the owner's own tap from a paired device: the only fill a standing rule's history counts. */
export const ownerTapped = (by: LoginObserverBy): boolean => by === 'device';

export const InputOutcomeSchema = z.strictObject({
  at: InstantSchema,
  by: InputActorSchema,
  submitted: z.boolean(),
  /** Typed by the owner, or a saved login chosen by the owner. */
  source: z.enum(['typed', 'saved', 'sealed']),
  /** The saved login used; the owner's card shows it, the agent never sees it. */
  entry: LoginEntryIdSchema.optional(),
  reason: InputReasonSchema.optional(),
});
export type InputOutcome = z.infer<typeof InputOutcomeSchema>;

/**
 * HOW RISKY THE VALUE IS TO TYPE where it is going, as a flag on the card and never a refusal: the owner
 * decides. green = typing hidden and a program known to ask for secrets; neutral = a one-time code, which is not
 * secret and goes where it was asked for; amber = it may show on screen, or the program is not known to ask; red =
 * not a secret, the ferret can see it. `reason` is one sentence.
 */
export const INPUT_RISK_LEVELS = ['green', 'neutral', 'amber', 'red'] as const;
export type InputRiskLevel = (typeof INPUT_RISK_LEVELS)[number];
export const InputRiskSchema = z.strictObject({
  /** A level this build does not know (a newer daemon's) reads as `amber`: a warning, never a pass. */
  level: z.preprocess(
    raw => (typeof raw === 'string' && !(INPUT_RISK_LEVELS as readonly string[]).includes(raw) ? 'amber' : raw),
    z.enum(INPUT_RISK_LEVELS),
  ),
  reason: boundedLine(240),
});
export type InputRisk = z.infer<typeof InputRiskSchema>;

/**
 * One value on the card, as the owner reads it: what the agent called it, how careful the daemon is with it,
 * the element it goes into (a browser field) and its own risk flag. A `plain` field is always red: the ferret
 * can see that value, and the card says so beside it.
 */
export const InputRequestFieldSchema = z.strictObject({
  id: InputFieldIdSchema,
  label: FieldLabelSchema,
  /** Read as a client reads it: a kind this build does not know is `secret`. */
  sensitivity: ReadInputSensitivitySchema,
  element: InputFieldElementSchema.optional(),
  /** Absent while the daemon is re-observing. */
  risk: InputRiskSchema.optional(),
});
export type InputRequestField = z.infer<typeof InputRequestFieldSchema>;

const RISK_RANK: Readonly<Record<InputRiskLevel, number>> = { green: 0, neutral: 1, amber: 2, red: 3 };

/** The worst of some fields' risks: what the card's header flag says. `undefined` when none is known yet. */
export function worstRisk(risks: readonly (InputRisk | undefined)[]): InputRisk | undefined {
  return risks.reduce<InputRisk | undefined>(
    (worst, risk) =>
      risk === undefined ? worst : worst === undefined || RISK_RANK[risk.level] > RISK_RANK[worst.level] ? risk : worst,
    undefined,
  );
}

const PreapprovalOutcomeShape = {
  outcome: z.enum(['filled', 'did-not-apply']),
  reason: GrantMissReasonSchema.optional(),
};

/**
 * A PRE-APPROVAL tried on a card, by its source: a task plan's line (`by: 'plan'`) or a standing sign-in rule at one
 * revision (`by: 'rule'`). Only one that did not apply says why. A source this build does not know is refused, never
 * read as another.
 */
export const InputPreapprovalSchema = z
  .discriminatedUnion('by', [
    z.strictObject({
      by: z.literal('plan'),
      plan: CopyPlanIdSchema,
      line: TaskPlanLineNumberSchema,
      ...PreapprovalOutcomeShape,
    }),
    z.strictObject({
      by: z.literal('rule'),
      rule: SignInRuleIdSchema,
      revision: SignInRuleRevisionSchema,
      ...PreapprovalOutcomeShape,
    }),
  ])
  .refine(note => note.outcome === 'did-not-apply' || note.reason === undefined, {
    path: ['reason'],
    message: 'only a pre-approval that did not apply says why',
  });
export type InputPreapproval = z.infer<typeof InputPreapprovalSchema>;

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
  /** A paste of a secure copy: where the value comes from. The owner allows it; there is nothing to type. */
  source: InputSourceSchema.optional(),
  target: InputTargetSchema,
  prompt: z.string().trim().min(1).max(INPUT_PROMPT_MAX_LENGTH),
  /** The most careful of the fields' sensitivities: what the journal and the audit record. */
  sensitivity: ReadInputSensitivitySchema,
  /** The values the card asks for, in the order the daemon types them. A terminal's request has exactly one. */
  fields: z.array(InputRequestFieldSchema).min(1).max(INPUT_MAX_FIELDS),
  submit: InputSubmitModeSchema,
  raisedAt: InstantSchema,
  expiresAt: InstantSchema,
  chain: AgendaIdSchema.optional(),
  /** Which step of a chained login this is: 2 for the card that follows the first. Absent for a lone card. */
  step: z.number().int().min(2).max(16).optional(),
  observed: InputTargetFactsSchema.optional(),
  /** The worst of the fields' risk flags; absent while the daemon is re-observing. */
  risk: InputRiskSchema.optional(),
  /** A digest of the facts the card showed; deliver refuses `target_changed` when it no longer matches. */
  observedDigest: Digest.optional(),
  /** The daemon holds a picture of a page's fields, taken before anything was typed: `GET …/shot` serves it. */
  pictured: z.literal(true).optional(),
  /** Saved logins: what the card may offer and what "Save as" suggests. The owner's view only. */
  saved: InputSavedSchema.optional(),
  /** How long the target is kept from the ferret after the write, and why: the card shows it. */
  lock: InputLockSchema.optional(),
  state: InputRequestStateSchema,
  outcome: InputOutcomeSchema.optional(),
  /**
   * The task plan line or standing rule that filled this card, or that was tried and did not apply (task-plan.ts,
   * sign-in-rules.ts). The owner's view only: the card draws one line from `grantMissLineFor(preapproval)`, and none
   * for `not-here`. The ferret is told one sentence for every plan reason and nothing at all about a rule, so a reason
   * never says which secret fields an account holds, or which sign-ins have rules.
   */
  preapproval: InputPreapprovalSchema.optional(),
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
  source: z.enum(['typed', 'saved', 'sealed']).optional(),
  /** How many seconds the surface is unreadable after the write. */
  lockSeconds: z.number().int().min(1).max(INPUT_QUARANTINE_SECONDS).optional(),
  reason: InputReasonSchema.optional(),
  screen: z.string().max(65_536).optional(),
  note: z.string().max(400).optional(),
});
export type InputAgentView = z.infer<typeof InputAgentViewSchema>;

/**
 * `POST /v1/sessions/:sid/input-requests/:id/deliver`. The one schema with a value, carried only inside
 * the sealed carrier. `padded` is {@link padInputValue}'s output, so the relay's size view reveals a
 * bucket, not a length. A saved login is named (`entry`), and the DAEMON resolves its value inside the use
 * boundary, so a saved value never passes through the app.
 *
 * A card of one field sends `padded` or `entry`. A card of several sends `fields` (each typed value, padded
 * on its own) and may add `entry` to fill the fields it did not type from a saved login; between them every
 * field is covered exactly once, which the daemon checks before it types anything.
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
    /** Each typed value of a card with several fields, by the field it goes into. */
    fields: z
      .array(
        z.strictObject({
          field: InputFieldIdSchema,
          padded: z
            .string()
            .min(1)
            .max(INPUT_VALUE_MAX_BYTES + 2 * INPUT_PAD_BUCKET_BYTES),
        }),
      )
      .min(1)
      .max(INPUT_MAX_FIELDS)
      .optional(),
    /** A saved login, by its handle: the daemon types the fields the request needs from it. */
    entry: LoginEntryIdSchema.optional(),
    /**
     * The sign-in the owner tapped (the offer's `signIn`), with `entry`. It MUST be one of `entry`'s account: the daemon
     * refuses the deliver with nothing typed otherwise. The value still comes from the account; the facts the daemon
     * sees go to this sign-in. Absent (an older app): the account's sign-in the daemon matched here, if any.
     */
    signIn: SignInIdSchema.optional(),
    /**
     * The saved account's 2FA key whose code the daemon makes ("Use code from Ferretry · Authy backup"), with `entry`:
     * one of that offer's `codes`. The daemon refuses the deliver with nothing typed unless the key is the MATCHED
     * account's, holds a seed and the card has a code field it may type a code it made into. Absent: the account's
     * first key in offer order. The code is made inside the daemon and typed; no answer, event or record holds it.
     */
    factor: TwoFactorIdSchema.optional(),
    /** Allow a paste: the daemon types the secure copy the request names (`request.source`), never one the body names. */
    sealed: z.literal(true).optional(),
    /** Press Enter / submit after typing. */
    submit: z.boolean(),
    /**
     * Keep the typed value in a saved login: a new entry with this label, or the existing one with this
     * handle (its label then stays). Saved only once it has been typed; a one-time code is never saved.
     */
    save: z
      .strictObject({
        entry: LoginEntryIdSchema,
        label: z
          .string()
          .trim()
          .min(1)
          .max(LOGIN_LABEL_MAX_LENGTH)
          .regex(/^[^\p{Cc}\p{Cf}]*$/u),
      })
      .optional(),
  })
  .superRefine((body, context) => {
    if (body.padded !== undefined && (body.entry !== undefined || body.fields !== undefined)) {
      context.addIssue({ code: 'custom', message: 'padded is the one value of a one-field card: send it alone' });
    }
    if (body.signIn !== undefined && body.entry === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'a sign-in is one of a saved account: send it with entry',
        path: ['signIn'],
      });
    }
    if (body.factor !== undefined && body.entry === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'a 2FA key is one of a saved account: send it with entry',
        path: ['factor'],
      });
    }
    if (body.sealed === true && (body.padded !== undefined || body.entry !== undefined || body.fields !== undefined)) {
      context.addIssue({ code: 'custom', message: 'sealed allows a paste: send it alone, with no value' });
    }
    if (body.padded === undefined && body.entry === undefined && body.fields === undefined && body.sealed !== true) {
      context.addIssue({
        code: 'custom',
        message: 'send a value: padded, fields, a saved entry, or sealed for a paste',
      });
    }
    if (body.fields !== undefined) {
      const problem = fieldsProblem(body.fields.map(typed => ({ id: typed.field })));
      if (problem !== undefined) context.addIssue({ code: 'custom', path: ['fields'], message: problem });
    }
    if (
      body.save !== undefined &&
      ((body.padded === undefined && body.fields === undefined) || body.entry !== undefined)
    ) {
      context.addIssue({ code: 'custom', message: 'save keeps values you typed, not a saved login', path: ['save'] });
    }
  });
export type InputDeliverBody = z.infer<typeof InputDeliverBodySchema>;

/**
 * `GET /v1/sessions/:sessionId/input-requests/:requestId/shot`: the picture of a page request's fields, taken at
 * raise BEFORE anything was typed, and where it sits on the page in viewport CSS pixels, so the card can draw each
 * field's `box` on it. The owner's only; it ends with the request.
 */
export const InputShotSchema = z.strictObject({
  pngBase64: z
    .string()
    .min(1)
    .max(4_000_000)
    .regex(/^[A-Za-z0-9+/]+=*$/u),
  clip: z.strictObject({
    x: z.number().finite(),
    y: z.number().finite(),
    w: z.number().finite().nonnegative(),
    h: z.number().finite().nonnegative(),
  }),
});
export type InputShot = z.infer<typeof InputShotSchema>;

/** The answer to a deliver: the outcome, no value. A repeat of a `deliveryId` returns the first one. */
export const InputDeliverResultSchema = z.strictObject({
  id: InputRequestIdSchema,
  deliveryId: InputDeliveryIdSchema,
  state: InputRequestStateSchema,
  submitted: z.boolean(),
  reason: InputReasonSchema.optional(),
  /**
   * What came of "Save as", when it was asked for. The value was typed either way: a save that failed
   * says why (`problem`, a fixed sentence) and the owner can save it from Settings instead.
   */
  saved: z
    .strictObject({ entry: LoginEntryIdSchema, ok: z.boolean(), problem: z.string().max(240).optional() })
    .optional(),
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
  /**
   * 409: the target changed under the card but is still the same field or prompt: the daemon looked again and
   * redrew the card (a new picture, digest and risk). Nothing was typed and nothing was counted; read the request
   * again and send.
   */
  targetRebound: 'target_rebound',
  /**
   * 410: the target kept changing (the last failed check, or one redraw too many), so the request ended with
   * nothing typed. The owner asks the ferret to request again.
   */
  targetUnsettled: 'target_unsettled',
  /** 409: the request is delivering or delivered under another `deliveryId`. */
  alreadyDelivered: 'already_delivered',
  /** 410: the request expired or was cancelled. */
  gone: 'gone',
  /** 409: an input request is pending on the surface an agent tried to type into. */
  inputPending: 'input_pending',
  /** 429: too many pending or recent requests. */
  rateLimited: 'rate_limited',
  /** 409: an agent read a terminal the daemon just typed a secret into; the read is refused until the window ends. */
  quarantined: 'quarantined',
} as const;

/** The session-journal events a request is published as; the payload is {@link InputEventSchema}. */
export const INPUT_JOURNAL_EVENT_TYPES = {
  requested: 'surface.input_requested',
  /** Written BEFORE the one write, so a restart knows a value may have been typed and never types it again. */
  delivering: 'surface.input_delivering',
  delivered: 'surface.input_delivered',
  refused: 'surface.input_refused',
  expired: 'surface.input_expired',
  cancelled: 'surface.input_cancelled',
} as const;
export const InputJournalEventTypeSchema = z.enum([
  INPUT_JOURNAL_EVENT_TYPES.requested,
  INPUT_JOURNAL_EVENT_TYPES.delivering,
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
  target: z.strictObject({ kind: InputTargetKindSchema, key: SurfaceKeySchema }),
  sensitivity: InputSensitivitySchema,
  /** Who presses Enter, so a restart can rebuild a pending request. */
  submit: InputSubmitModeSchema.optional(),
  /** A paste: the secure copy it was to come from, by name, so a restart (which forgets copies) can close it. */
  sealed: CopyNameSchema.optional(),
  state: InputRequestStateSchema,
  /** The attempt a `delivering` event starts: an id, never the value. */
  deliveryId: InputDeliveryIdSchema.optional(),
  submitted: z.boolean().optional(),
  source: z.enum(['typed', 'saved', 'sealed']).optional(),
  reason: InputReasonSchema.optional(),
  expiresAt: InstantSchema.optional(),
  at: InstantSchema,
});
export type InputEvent = z.infer<typeof InputEventSchema>;

/**
 * The journal event that keeps a quarantine across a restart: the terminal's names (its key and its id, because
 * a reader may hold either), when the window ends, and nothing else. `ended` closes the window early.
 *
 * `hold` is an opaque id for one hold. A later `started` with the same `hold` replaces its end time (or, with
 * `unresolved`, says a write may be in flight and the hold has none), and an `ended` with it lets go of that
 * hold alone, so an attempt that failed, or an owner ending one delivered value, never lifts another hold.
 */
export const INPUT_QUARANTINE_EVENT_TYPES = {
  started: 'surface.input_quarantined',
  ended: 'surface.input_quarantine_ended',
} as const;
export const InputQuarantineEventSchema = z.strictObject({
  type: z.enum([INPUT_QUARANTINE_EVENT_TYPES.started, INPUT_QUARANTINE_EVENT_TYPES.ended]),
  sessionId: boundedLine(128),
  names: z.array(SurfaceKeySchema).min(1).max(4),
  hold: boundedLine(128),
  /** The write under this hold may be in flight or may have landed: it holds until a later event for the same hold settles it. */
  unresolved: z.literal(true).optional(),
  until: InstantSchema,
  at: InstantSchema,
});
export type InputQuarantineEvent = z.infer<typeof InputQuarantineEventSchema>;

/** One terminal that is quarantined now and when its window ends, as the owner's client reads it. */
export const InputQuarantineSchema = z.strictObject({ key: SurfaceKeySchema, until: InstantSchema });
export type InputQuarantine = z.infer<typeof InputQuarantineSchema>;
export const InputQuarantineListSchema = z.strictObject({ quarantines: z.array(InputQuarantineSchema) });
export type InputQuarantineList = z.infer<typeof InputQuarantineListSchema>;

/** The audit events this feature writes (general store, activity). Wired into `AUDIT_EVENTS` by the daemon PR. */
export const INPUT_AUDIT_EVENTS = [
  'input.requested',
  'input.delivered',
  'input.refused',
  /** The target changed under the card and the daemon found the same field or prompt again: the card was redrawn. */
  'input.rebound',
  'input.expired',
  'input.cancelled',
  'input.quarantine_ended',
  'input.quarantine_revealed',
] as const;
export const InputAuditEventSchema = z.enum(INPUT_AUDIT_EVENTS);
export type InputAuditEvent = z.infer<typeof InputAuditEventSchema>;

/**
 * The details an input audit record carries: names and flags, never the value, its length (for a
 * `secret`), the prompt text or a URL path. `consumer` is a program name or an origin's host.
 */
export const InputAuditDetailSchema = z
  .strictObject({
    targetKind: InputTargetKindSchema,
    /** A paste: the secure copy pasted, by name. */
    copy: CopyNameSchema.optional(),
    /** A paste the owner approved in advance: the rule it was delivered under. */
    rule: z
      .string()
      .regex(/^[0-9a-f]{32}$/u)
      .optional(),
    /** A sign-in the owner approved in advance on a task plan: the plan, its line and the sign-in it filled. */
    plan: CopyPlanIdSchema.optional(),
    line: TaskPlanLineNumberSchema.optional(),
    signIn: SignInIdSchema.optional(),
    /**
     * A sign-in filled under the owner's STANDING rule: `by: 'rule'`, the rule and its revision, beside `signIn`. Not
     * `rule`, which names a paste rule.
     */
    by: z.literal('rule').optional(),
    signInRule: SignInRuleIdSchema.optional(),
    revision: SignInRuleRevisionSchema.optional(),
    /** A task plan line or standing rule was tried on this card and did not apply, and why: the card was raised as usual. */
    preapproval: z.literal('did-not-apply').optional(),
    because: GrantMissReasonSchema.optional(),
    consumer: boundedLine(160).optional(),
    /**
     * The store file of a program proved only through the owner's own profile, when that is what read the terminal:
     * a paste a rule made into it is logged with the very file, since any process running as the owner could swap it.
     */
    profileProgram: z
      .string()
      .max(512)
      .regex(/^\/nix\/store\/[^\p{Cc}\p{Cf}]+$/u)
      .optional(),
    sensitivity: InputSensitivitySchema,
    /** The terminal a quarantine was about: its name, never what was typed there. */
    surface: SurfaceKeySchema.optional(),
    recognised: z.boolean().optional(),
    source: z.enum(['typed', 'saved', 'sealed']).optional(),
    /** The saved login typed from, or saved to: a handle, never what it holds. */
    entry: LoginEntryIdSchema.optional(),
    /** The 2FA key a code Ferretry made came from: its id, never the code or the seed. */
    factor: TwoFactorIdSchema.optional(),
    /** The typed value was kept in `entry`. */
    saved: z.boolean().optional(),
    submitted: z.boolean().optional(),
    carrier: z.enum(['loopback', 'direct', 'relay']).optional(),
    reason: InputReasonSchema.optional(),
  })
  .refine(
    detail =>
      (detail.by === undefined) === (detail.signInRule === undefined) &&
      (detail.signInRule === undefined) === (detail.revision === undefined),
    { path: ['signInRule'], message: 'a standing rule is recorded as by rule, with its id and revision together' },
  );
export type InputAuditDetail = z.infer<typeof InputAuditDetailSchema>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const LENGTH_WIDTH = 5;

const hasControlCharacter = (text: string): boolean => /\p{Cc}/u.test(text);

/**
 * Why a value may not be typed as a `sensitivity`, or `undefined` when it may. A `secret`, `private` or `code`
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
