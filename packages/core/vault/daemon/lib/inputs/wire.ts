import { durationWords } from '@ferretry/std';
import { z } from 'zod';
import {
  AgendaIdSchema,
  boundedLine,
  INPUT_QUARANTINE_SECONDS,
  type InputActor,
  InputDeliverBodySchema,
  InputDeliveryIdSchema,
  InputEchoSchema,
  type InputFieldRaise,
  type InputHoldReasonSchema,
  InputHoldSchema,
  type InputRaise,
  InputReasonSchema,
  InputRequestIdSchema,
  InputRequestStateSchema,
  type InputSensitivity,
  InputSensitivitySchema,
  InputSubmitModeSchema,
  SurfaceKeySchema,
  CopyNameSchema,
  CopyPlanIdSchema,
  GrantMissReasonSchema,
  LoginEntryIdSchema,
  SignInIdSchema,
  SignInRuleIdSchema,
  SignInRuleRevisionSchema,
  TaskPlanLineNumberSchema,
  TwoFactorIdSchema,
} from '../../../contract/index.ts';

/** The input card's request, deliver and outcome shapes are the contract's (`contract/inputs-wire.ts`); re-exported here. */
export {
  type AgendaId,
  AgendaIdSchema,
  InputActorSchema,
  type InputActor,
  type InputDeliverBody,
  InputDeliverBodySchema,
  InputDeliverResultSchema,
  type InputDeliverResult,
  type InputFieldElement,
  InputOutcomeSchema,
  type InputRequest,
  InputRequestListSchema,
  type InputRequestList,
  InputRequestSchema,
  type InputRequestField,
  type InputRisk,
  inputValueProblem,
  padInputValue,
  unpadInputValue,
  worstRisk,
} from '../../../contract/index.ts';

/** An ISO-8601 instant with an explicit timezone (today's `common.ts`, kept as written: an input card's times). */
const InstantSchema = z.iso.datetime({ offset: true });

const InputTargetKindSchema = z.enum(['terminal', 'page', 'secret']);

/**
 * THE INPUT REQUEST WIRE (today's `protocol/src/lib/input-request.ts`, copied): what the contract does not already
 * declare. The request, the deliver body, its answer, the outcome and the pad are the contract's
 * (`contract/inputs-wire.ts`: the owner's app reads the very same declarations) and are re-exported above; what stays
 * here is what only the daemon uses (the agent's view, the journal events, the audit detail, the card's words), with a
 * browser target named `page` (§4.7).
 *
 * ## THE SCHEMAS HERE HAVE NO FIELD FOR THE VALUE — EXCEPT ONE, AND IT IS PADDED
 *
 * A request, its facts, its events, its audit detail, the agenda item that presents it and everything an
 * agent is told describe WHERE a value goes and WHAT happened, never WHAT it was. The one place a value
 * exists is {@link InputDeliverBodySchema}: the owner's deliver, carried inside the sealed carrier and
 * dropped by the handler the moment it has been typed. `tests/unit/contract/input-request.test.ts` fails if any
 * other schema here ever gains a field named or shaped like a value.
 */

/** The longest card title today's agenda keeps; an input card's title is the daemon's own words, within it. */
export const MAX_AGENDA_TITLE_LENGTH = 60;

export type InputLockReason = z.infer<typeof InputHoldReasonSchema>;
/** How long a card's hold lasts and why (the contract's `InputHoldSchema`). */
export type InputLock = z.infer<typeof InputHoldSchema>;

/** The lock's length in the owner's and the ferret's words ("two minutes"), from {@link INPUT_QUARANTINE_SECONDS}. */
export const INPUT_QUARANTINE_WORDS = durationWords(INPUT_QUARANTINE_SECONDS);
/**
 * ONE SENTENCE EACH for what the ferret can read (C41): a plain value, and a one-time code (not secret either, but
 * neutral). The daemon's flag on a field and the app's and CLI's words are these; a client that tells one only once
 * compares the risk to them, never searches the text.
 */
/**
 * Where the agent's own sentence starts in an input card's agenda context: the daemon's lines come first, and the
 * agent's prompt last, after this. The card shows the prompt under the daemon's facts, so a client drawing the card
 * leaves it out of the context ({@link inputContextLines}); a restarted daemon reads the prompt back from it.
 */
export const INPUT_PROMPT_MARKER = 'The agent says: ';

/** An input card's agenda context without the agent's prompt: the daemon's own lines only, or `null` when none. */
export const inputContextLines = (context: string | null | undefined): string | null => {
  if (context == null) return null;
  const at = context.indexOf(INPUT_PROMPT_MARKER);
  const lines = (at < 0 ? context : context.slice(0, at)).trim();
  return lines === '' ? null : lines;
};

export const INPUT_PLAIN_VALUE_NOTICE = 'Not secret: the ferret can see this value.';
export const INPUT_CODE_VISIBLE_NOTICE = 'One-time code: the ferret can see it.';

/** What the card says about each reason: one fixed, plain sentence, never page or terminal text. */
export const INPUT_LOCK_WORDS: Readonly<Record<InputLockReason, string>> = {
  'hidden-terminal': 'A local password prompt (sudo, su, doas or passwd) with typing hidden.',
  'proven-field': 'A password field Ferretry has seen hide the value and move on after signing in.',
  'probed-field': "A password field: a test value Ferretry typed did not show in the page's text.",
  code: 'This value shows on screen as it is typed.',
  'not-proven': 'Ferretry has not proven that this target hides what is typed.',
  'terminal-shows': "Ferretry couldn't prove this is a local sudo, su, doas or passwd prompt with typing hidden.",
  scripted: 'A ferret ran a script on this page or this site.',
  steered: 'The ferret used this page, or another tab on this site, after asking you.',
  'not-password-field': 'This is not a plain password box on a secure page.',
  'first-time': "First time on this page: Ferretry hasn't seen it hide a password yet.",
  'did-not-move-on': "Last time here, the page didn't move on or it showed the value.",
  'until-moved-on': "It ends sooner once the page moves on, because the value hasn't been submitted yet.",
  'probe-shown': "A test value Ferretry typed showed in the page's text.",
  'probe-stopped': "Ferretry's quick test of this page didn't finish cleanly.",
};

/** "Hidden from the ferret for 10 s" or "for 2 minutes". */
export function lockWords(lock: InputLock): string {
  return lock.seconds >= 60
    ? `${String(Math.round(lock.seconds / 60))} minute${lock.seconds >= 90 ? 's' : ''}`
    : `${String(lock.seconds)} s`;
}

/** The id a request with one field gives it when the agent names none. */
export const INPUT_SINGLE_FIELD_ID = 'value';

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

export type InputReason = z.infer<typeof InputReasonSchema>;

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

/** `POST …/cancel`: the owner declines. */
export const InputCancelBodySchema = z.strictObject({});

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
const InputJournalEventTypeSchema = z.enum([
  INPUT_JOURNAL_EVENT_TYPES.requested,
  INPUT_JOURNAL_EVENT_TYPES.delivering,
  INPUT_JOURNAL_EVENT_TYPES.delivered,
  INPUT_JOURNAL_EVENT_TYPES.refused,
  INPUT_JOURNAL_EVENT_TYPES.expired,
  INPUT_JOURNAL_EVENT_TYPES.cancelled,
]);

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
const InputQuarantineEventSchema = z.strictObject({
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
const InputQuarantineSchema = z.strictObject({ key: SurfaceKeySchema, until: InstantSchema });
export type InputQuarantine = z.infer<typeof InputQuarantineSchema>;
const InputQuarantineListSchema = z.strictObject({ quarantines: z.array(InputQuarantineSchema) });
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
const InputAuditEventSchema = z.enum(INPUT_AUDIT_EVENTS);
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
