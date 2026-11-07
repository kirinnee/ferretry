import { durationWords } from '@ferretry/std';
import { z } from 'zod';
import {
  INPUT_MAX_FIELDS,
  INPUT_PAD_BUCKET_BYTES,
  INPUT_PROMPT_MAX_LENGTH,
  INPUT_QUARANTINE_SECONDS,
  INPUT_SENSITIVITIES,
  INPUT_VALUE_MAX_BYTES,
  InputDeliveryIdSchema,
  InputEchoSchema,
  type InputFieldRaise,
  InputFieldIdSchema,
  type InputForegroundSchema,
  type InputHoldReasonSchema,
  InputHoldSchema,
  type InputPaneProofSchema,
  type InputRaise,
  InputReasonSchema,
  InputRequestIdSchema,
  InputRequestStateSchema,
  type InputSensitivity,
  InputSensitivitySchema,
  InputSubmitModeSchema,
  InputTargetFactsSchema,
  InputTargetSchema,
  type PageFieldFactsSchema,
  SurfaceKeySchema,
} from '../../../contract/index.ts';
import {
  CopyNameSchema,
  CopyOriginSchema,
  CopyPlanIdSchema,
  GrantMissReasonSchema,
  InputSavedSchema,
  LOGIN_LABEL_MAX_LENGTH,
  LOGIN_USERNAME_MAX_LENGTH,
  LoginEntryIdSchema,
  oneLine,
  SignInIdSchema,
  SignInRuleIdSchema,
  SignInRuleRevisionSchema,
  TaskPlanLineNumberSchema,
  TwoFactorIdSchema,
  BrowserRefSchema,
} from './borrowed.ts';

/**
 * THE INPUT REQUEST WIRE (today's `protocol/src/lib/input-request.ts`, copied): what the contract
 * (`contract/inputs.ts`, `contract/targets.ts`) does not already declare. The declarations the contract carries are
 * imported from it, never repeated; everything else here is today's, byte for byte, with a browser target named
 * `page` (§4.7).
 *
 * ## THE SCHEMAS HERE HAVE NO FIELD FOR THE VALUE — EXCEPT ONE, AND IT IS PADDED
 *
 * A request, its facts, its events, its audit detail, the agenda item that presents it and everything an
 * agent is told describe WHERE a value goes and WHAT happened, never WHAT it was. The one place a value
 * exists is {@link InputDeliverBodySchema}: the owner's deliver, carried inside the sealed carrier and
 * dropped by the handler the moment it has been typed. `tests/unit/contract/input-request.test.ts` fails if any
 * other schema here ever gains a field named or shaped like a value.
 */

/** Why a card's hold lasts as long as it does (the contract's `InputHoldReasonSchema`). */
/** An ISO-8601 instant with an explicit timezone (today's `common.ts`, kept as written: an input card's times). */
const InstantSchema = z.iso.datetime({ offset: true });

/**
 * The card an input request is drawn on, as today's agenda names it (`A12`). Asks' `AskId` is the same text; the
 * adapter to Asks parses it at the boundary (`daemon/adapters/inputs/asks.ts`).
 */
export const AgendaIdSchema = z.string().regex(/^A[1-9][0-9]*$/u);
export type AgendaId = z.infer<typeof AgendaIdSchema>;
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

const boundedLine = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .regex(/^[^\p{Cc}\p{Cf}]*$/u, 'must be one line with no control characters');

const HEX_DIGEST = /^[0-9a-f]{64}$/u;
const Digest = z.string().regex(HEX_DIGEST, 'a sha-256 digest in lowercase hex');

export type InputDeliveryId = z.infer<typeof InputDeliveryIdSchema>;

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

export type InputSubmitMode = z.infer<typeof InputSubmitModeSchema>;

/** The kinds of place a value can go: a terminal, a page, or the secret store. */
export const InputTargetKindSchema = z.enum(['terminal', 'page', 'secret']);
export type InputTargetKind = z.infer<typeof InputTargetKindSchema>;

/** The longest label an agent may give a field ("Email", "Password"). */
export const INPUT_FIELD_LABEL_MAX_LENGTH = 60;
/** The id a request with one field gives it when the agent names none. */
export const INPUT_SINGLE_FIELD_ID = 'value';

const FieldLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(INPUT_FIELD_LABEL_MAX_LENGTH)
  .regex(/^[^\p{Cc}\p{Cf}]*$/u, 'must be one line with no control characters');

const fieldsProblem = (fields: readonly { readonly id: string }[]): string | undefined =>
  new Set(fields.map(field => field.id)).size === fields.length ? undefined : 'each field needs its own id';

export type InputFieldId = z.infer<typeof InputFieldIdSchema>;

/**
 * The element a browser field names, the way every browser act names one: a snapshot's `ref` or a selector.
 * It is the agent's POINTER, never a fact: the daemon resolves it and observes what is actually there.
 */
export const InputFieldElementSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('selector'), selector: boundedLine(512) }),
  z.strictObject({ kind: z.literal('ref'), ref: BrowserRefSchema }),
]);
export type InputFieldElement = z.infer<typeof InputFieldElementSchema>;

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


export type InputPaneProof = z.infer<typeof InputPaneProofSchema>;

export type InputEcho = z.infer<typeof InputEchoSchema>;

export type InputForeground = z.infer<typeof InputForegroundSchema>;

export type InputBrowserFieldFacts = z.infer<typeof PageFieldFactsSchema>;

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
  lock: InputHoldSchema.optional(),
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
     *
     * `mode` is the owner's choice on the card: `new` keeps it ONLY in a new account (a CLI name that is already an
     * account's is refused, nothing typed), `update` ONLY in the account the card offers to update (`saved.update`),
     * never another person's. Absent (an older app): a new account only; an existing one is refused, nothing typed.
     * `username` is the owner-confirmed username kept with it (the "Username" box), only with a `mode`, and never on a
     * card that types a username itself.
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
        mode: z.enum(['new', 'update']).optional(),
        username: oneLine(LOGIN_USERNAME_MAX_LENGTH).optional(),
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
    if (body.save?.username !== undefined && body.save.mode === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'a username is kept only with the owner’s choice: send mode new or update',
        path: ['save', 'username'],
      });
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
