import { z } from 'zod';
import {
  INPUT_PAD_BUCKET_BYTES,
  INPUT_PROMPT_MAX_LENGTH,
  INPUT_SENSITIVITIES,
  INPUT_VALUE_MAX_BYTES,
  InputDeliveryIdSchema,
  InputHoldSchema,
  InputReasonSchema,
  InputRequestIdSchema,
  InputRequestStateSchema,
  type InputSensitivity,
  InputSensitivitySchema,
  InputSubmitModeSchema,
} from './inputs.ts';
import { MIN_SECRET_VALUE_LENGTH, SecretNameSchema } from './secrets.ts';
import {
  INPUT_MAX_FIELDS,
  InputFieldIdSchema,
  InputTargetFactsSchema,
  InputTargetSchema,
  SurfaceKeySchema,
} from './targets.ts';

/**
 * THE INPUT CARD'S WIRE, as the owner's app and the daemon both read it: the request an input card draws, the deliver
 * body it sends, the saved-login offers it may draw, the outcome and the pad that hides a value's length from a relay.
 * The daemon (`daemon/lib/inputs/wire.ts`, `borrowed.ts`) re-exports these; it adds only what the daemon alone uses
 * (the agent's view, the journal events, the audit detail). One declaration, two readers: the app no longer keeps a
 * tolerant copy pinned by a test.
 *
 * ## THE SCHEMAS HERE HAVE NO FIELD FOR THE VALUE: EXCEPT ONE, AND IT IS PADDED
 *
 * A request, its facts, its offers and its outcome describe WHERE a value goes and WHAT happened, never WHAT it was.
 * The one place a value exists is {@link InputDeliverBodySchema}: the owner's deliver, carried inside the sealed carrier
 * and dropped by the handler the moment it has been typed. A saved login is named in it (`entry`); the DAEMON resolves
 * its value inside the use boundary, so a saved value never reaches an app.
 *
 * What the daemon keeps from the neighbours' wire (accounts, sign-ins, 2FA keys, secure copies, task-plan lines) is the
 * part an input card carries; it is declared once, here, because a core contract may import no plugin's.
 */

/** An ISO-8601 instant with an explicit timezone (today's `common.ts`, kept as written: an input card's times). */
const InstantSchema = z.iso.datetime({ offset: true });

/** One line of at most `maximum` characters with no control or format characters, untrimmed. */
export const boundedLine = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .regex(/^[^\p{Cc}\p{Cf}]*$/u, 'must be one line with no control characters');

/** A one-line text field: trimmed, at most `maximum` characters, no control or format characters. */
export const oneLine = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .regex(/^[^\p{Cc}\p{Cf}]*$/u, 'must be one line with no control characters');

/**
 * WHY A PRE-APPROVAL DID NOT FILL, or why a line can't be pre-approved at all. Each has one fixed sentence
 * ({@link grantMissWords}); the ferret is never told which ({@link TASK_PLAN_MISS_AGENT_NOTE}).
 */
export const GRANT_MISS_REASONS = [
  'expired',
  'other-session',
  'stopped',
  'used-up',
  'sign-in-gone',
  'place-changed',
  'recipe-changed',
  'not-here',
  'field-not-covered',
  'code-not-ticked',
  'ferret-named-another',
  'account-lacks-field',
  'rate',
  'not-https',
  'frame',
  'password-field',
  'field-hidden',
  'challenge',
  'scripted',
  'code-target',
  'form-changed',
  'not-proved',
  'not-system',
  'did-not-move-on',
  // A standing sign-in rule only (sign-in-rules.ts).
  'suspended',
  'out-of-scope',
  'account-changed',
  'factor-changed',
  'proof-invalid',
  'no-history',
  'code-without-sign-in',
  'scripted-origin',
  'program-changed',
  // At propose time only: the line is `unavailable`.
  'not-in-accounts',
  'via-provider',
  'tool-not-covered',
] as const;

export const GrantMissReasonSchema = z.enum(GRANT_MISS_REASONS);

export type GrantMissReason = z.infer<typeof GrantMissReasonSchema>;

/** A sign-in's id: `si_` and 16 lowercase hex digits. Random on create. */
export const SignInIdSchema = z.string().regex(/^si_[0-9a-f]{16}$/u, 'a sign-in id is si_ and 16 hex digits');

/**
 * A STANDING SIGN-IN RULE (`sr_` and 24 hex digits, sign-in-rules.ts): the owner's passkey-signed permission to fill one
 * sign-in for any ferret, until it expires. Kept on disk. Its id survives a resume, renew or widen (`revision` + 1).
 */
export const SignInRuleIdSchema = z
  .string()
  .regex(/^sr_[0-9a-f]{24}$/u, 'a standing sign-in rule is sr_ and 24 hex digits');

/**
 * A 2FA key's id: `tf_` and 12 lowercase hex digits. Immutable and never shown to people (the CLI and plan lines
 * only): a card names a key by its owner-written label. Random on add.
 */
export const TwoFactorIdSchema = z.string().regex(/^tf_[0-9a-f]{12}$/u, 'a 2FA key id is tf_ and 12 hex digits');

/** The longest label the owner gives a 2FA key ("Okta Verify on Pixel", "Phone ••42"). */
export const TWO_FACTOR_LABEL_MAX_LENGTH = 60;

export const LOGIN_USERNAME_MAX_LENGTH = 256;

/** A ref as a snapshot writes it: `e12`, or `f1e3` inside a frame. */
export const BROWSER_REF_PATTERN = /^(?:f\d{1,6})?e\d{1,7}$/u;

export const BrowserRefSchema = z
  .string()
  .trim()
  .regex(BROWSER_REF_PATTERN, 'a ref is what a page snapshot names an element: e12, or f1e3 inside a frame');

/** A standing rule's revision: 1 when created, one more on each resume, renew or widen. Part of the signed bytes. */
export const SignInRuleRevisionSchema = z.number().int().min(1).max(1_000_000);

/** A plan card: at most this many planned pastes, each said in at most this many characters, waiting this long. */
const COPY_PLAN_MAX_ITEMS = 10;

/** Most lines on one plan. */
const TASK_PLAN_MAX_LINES = COPY_PLAN_MAX_ITEMS;

/** A line of a plan, numbered from 0 (the owner reads it from 1). */
export const TaskPlanLineNumberSchema = z
  .number()
  .int()
  .min(0)
  .max(TASK_PLAN_MAX_LINES - 1);

/** The fields an entry can hold, and which of them are secret. */
export const LOGIN_FIELD_ROLES = ['username', 'password', 'totp'] as const;

export const LoginFieldRoleSchema = z.enum(LOGIN_FIELD_ROLES);

/**
 * SAVED LOGINS: the password manager the input bridge places values from (docs/input-requests.md, "Saved
 * logins").
 *
 * A saved login is a LABELLED ENTRY, the way a password manager keeps one: a label the owner reads
 * ("GitHub (kirinnee)"), what it is for (`match`: `sudo@kirin-box`, `github.com`), and its fields:
 *
 * - `username`: PLAIN. Stored as text, shown on the card, and allowed to reach the ferret, because a
 *   username is typed where the ferret can see it anyway.
 * - `password`: SECRET. Sealed in the daemon's vault; no route, command or API returns it.
 * - `totp`: SECRET, OPT-IN. A 2FA seed, sealed the same way. The daemon makes the current code inside the
 *   use boundary and types it into a `code` (or `private`) field; neither the seed nor the code is ever returned (the
 *   code's text is masked from text reads, but the ferret may see it on screen).
 *
 * ## THE SAME RULE AS EVERY OTHER SECRET: USE, NEVER READ
 *
 * A value travels IN, on {@link PutLoginEntryRequestSchema}, and never travels back. Everything a client
 * may learn about an entry is {@link LoginEntrySummarySchema}: the label, what it matches, the username,
 * WHICH secret fields exist, and when it changed. No value, no length, no digest. A saved value leaves the
 * daemon only into the target of an input request the owner tapped "Use" on.
 */

/** An entry's handle: the shape of a secret name, because the CLI and the card name it (`SUDO_KIRIN_BOX`). */
export const LoginEntryIdSchema = SecretNameSchema;

export type LoginEntryId = z.infer<typeof LoginEntryIdSchema>;

export const LOGIN_LABEL_MAX_LENGTH = 80;

export const LOGIN_MATCH_MAX = 16;

/** Most entries one daemon keeps: a list a person can read, not a database. */
export const MAX_LOGIN_ENTRIES = 256;

/**
 * The shortest password an entry keeps. A REDACTION constraint, exactly as {@link MIN_SECRET_VALUE_LENGTH}
 * is: a saved value is masked wherever the daemon scrubs text, and a very short value would mask ordinary
 * words. A shorter password can still be TYPED on a card; it just cannot be saved.
 */
export const LOGIN_PASSWORD_MIN_LENGTH = MIN_SECRET_VALUE_LENGTH;

/**
 * What an entry is for, as the daemon names a target: `program@host` for a terminal (`sudo@kirin-box`,
 * `ssh@build.example.com`), or a web host for a page (`github.com`, `localhost:8443`). Lowercase. The DAEMON
 * works out a target's key from what it observed; an agent never says what matches.
 */
export const LoginMatchSchema = z
  .string()
  .max(320)
  .regex(
    /^(?:[a-z0-9][a-z0-9._+-]{0,63}@)?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[0-9]{1,5})?$/u,
    'a program@host or a web host, lowercase',
  );

export type LoginMatch = z.infer<typeof LoginMatchSchema>;

export type LoginFieldRole = z.infer<typeof LoginFieldRoleSchema>;

/** Most 2FA keys of one account that hold a seed: a re-enrolled second authenticator, a backup app. */
export const MAX_SEEDS_PER_ACCOUNT = 4;

/**
 * HOW A SAVED LOGIN SIGNS IN. `password` types what the entry holds. An identity-provider method means the site
 * signs in through that provider ("Continue with Google"): the ferret clicks it, and the PROVIDER's page is
 * filled from the provider's own saved login, named by `via` (this site → the "Google (kirin@…)" entry).
 *
 * THERE IS NO PASSKEY METHOD, and an `sso` name that says passkey, WebAuthn or a security key is refused: the
 * agent browser has passkeys switched off (docs/input-requests.md, "Passkeys are off"), so a login that needs
 * one is the owner's hands, never a saved login.
 */
export const LOGIN_METHODS = ['password', 'google', 'github', 'microsoft', 'apple', 'sso'] as const;

export const LoginMethodKindSchema = z.enum(LOGIN_METHODS);

export type LoginMethodKind = z.infer<typeof LoginMethodKindSchema>;

export const LOGIN_SSO_NAME_MAX_LENGTH = 40;

/**
 * What is wrong with a method, as issues: an SSO method names its provider, only SSO does, and a password sign-in
 * goes via nothing. `link` is the provider it goes via, however the caller spells it (a handle here, an account key
 * in the stored sign-in of accounts.ts), so both shapes keep one rule.
 */
export function loginMethodIssues(
  kind: LoginMethodKind,
  name: string | undefined,
  link: string | undefined,
  linkPath: string,
): readonly { readonly path: string[]; readonly message: string }[] {
  return [
    ...(kind === 'sso' && name === undefined
      ? [{ path: ['name'], message: 'name the SSO provider, as its button says it' }]
      : []),
    ...(kind !== 'sso' && name !== undefined ? [{ path: ['name'], message: 'only other SSO takes a name' }] : []),
    ...(kind === 'password' && link !== undefined
      ? [{ path: [linkPath], message: 'a password sign-in is not via another login' }]
      : []),
  ];
}

export const LoginMethodSchema = z
  .strictObject({
    kind: LoginMethodKindSchema,
    /** `sso` only: the provider's name as the site's button says it ("Okta", "Company SSO"). */
    name: oneLine(LOGIN_SSO_NAME_MAX_LENGTH).optional(),
    /** An identity-provider method only: the saved login of that provider, whose page it fills. */
    via: LoginEntryIdSchema.optional(),
  })
  .superRefine((method, context) => {
    for (const issue of loginMethodIssues(method.kind, method.name, method.via, 'via'))
      context.addIssue({ code: 'custom', ...issue });
  });

/**
 * Why a card's primary offer is first (accounts.ts `chosenSignIn`): the ferret named it, a project, folder or
 * site default chose it, or it is the only account that signs in here. Absent on every other offer.
 */
export const SIGN_IN_CHOICE_REASONS = ['ferret', 'project', 'folder', 'site', 'only'] as const;

export const SignInChoiceReasonSchema = z.enum(SIGN_IN_CHOICE_REASONS);

export type SignInChoiceReason = z.infer<typeof SignInChoiceReasonSchema>;

/** The longest project name a card's "Default for <project>" carries. */
export const SIGN_IN_PROJECT_MAX_LENGTH = 128;

/**
 * One saved login an input card may offer. `fills` is the field it would type (the password for a
 * `secret`, the code for a `code` or `private`, the username for a `plain`). `matched` is the DAEMON's decision that
 * the entry is for this target: only a matched entry is the card's one-tap primary; the rest stay
 * selectable by hand. `hinted` says the ferret named it, which never makes it matched.
 *
 * A daemon that keeps accounts and sign-ins (`accounts.signins.1`) adds four fields, all optional so an older
 * daemon's card still parses: `id` is then the ACCOUNT's handle and `signIn` the sign-in it would use here
 * (absent: an account hand-picked with no sign-in here); `primary` marks the one-tap choice, at most one and only
 * ever a matched one, with `why` it is first (and `project`, the project a "Default for ferretry" names). With
 * `primary` absent from every offer, nothing is the one-tap choice: the owner picks.
 */
/**
 * ONE "Use code from Ferretry" button: a 2FA key of the offer's account whose seed Ferretry holds, by its id (what a
 * deliver's `factor` names) and the OWNER's label. `checked` is what the last code made from it came to, as the daemon
 * saw it (`worked`, `failed`); absent: never tried. Owner view only, like the whole offer: a ferret never learns that a
 * seed exists.
 */
export const InputCodeKeySchema = z.strictObject({
  factor: TwoFactorIdSchema,
  label: oneLine(TWO_FACTOR_LABEL_MAX_LENGTH),
  checked: z.enum(['worked', 'failed']).optional(),
});

export type InputCodeKey = z.infer<typeof InputCodeKeySchema>;

export const InputSavedOfferSchema = z
  .strictObject({
    id: LoginEntryIdSchema,
    label: oneLine(LOGIN_LABEL_MAX_LENGTH),
    username: oneLine(LOGIN_USERNAME_MAX_LENGTH).optional(),
    fills: LoginFieldRoleSchema,
    matched: z.boolean(),
    hinted: z.boolean().optional(),
    /**
     * Where this account signs in, when that is somewhere else (place keys, names only: `liftoff.okta.com`,
     * `sudo@kirin-box`); EMPTY when it signs in nowhere ("not linked to a site"). Only on an offer picked by hand
     * (`matched: false`): the card puts it behind a second step and it is never the one-tap choice. Absent: an account
     * for this very site that no sign-in matched, or an older daemon, whose card keeps it in the one list.
     */
    elsewhere: z.array(LoginMatchSchema).max(LOGIN_MATCH_MAX).readonly().optional(),
    signIn: SignInIdSchema.optional(),
    primary: z.literal(true).optional(),
    why: SignInChoiceReasonSchema.optional(),
    project: oneLine(SIGN_IN_PROJECT_MAX_LENGTH).optional(),
    /**
     * An offer that makes a one-time code: one button per key whose seed Ferretry holds, in the order a deliver without
     * `factor` falls back on (one that worked first, then one never tried, then one that failed; newest first). Only
     * ever on a MATCHED offer that fills `totp`, and only where the daemon may type a code it made (docs/input-requests.md,
     * "Codes Ferretry makes"). Absent from an older daemon: the offer is one button with the account's first seed.
     */
    codes: z.array(InputCodeKeySchema).min(1).max(MAX_SEEDS_PER_ACCOUNT).readonly().optional(),
  })
  .superRefine((offer, context) => {
    if (offer.codes !== undefined && (!offer.matched || offer.signIn === undefined || offer.fills !== 'totp'))
      context.addIssue({
        code: 'custom',
        path: ['codes'],
        message: 'only a matched offer that fills a code names the keys it makes codes from',
      });
    if (offer.elsewhere !== undefined && offer.matched)
      context.addIssue({
        code: 'custom',
        path: ['elsewhere'],
        message: 'an offer that signs in here is not one from somewhere else',
      });
    if (offer.primary === true && !offer.matched)
      context.addIssue({ code: 'custom', path: ['primary'], message: 'only a matched offer is the one-tap choice' });
    if (offer.primary === true && offer.signIn === undefined)
      context.addIssue({ code: 'custom', path: ['signIn'], message: 'the one-tap choice names the sign-in it uses' });
    if ((offer.primary === true) !== (offer.why !== undefined))
      context.addIssue({ code: 'custom', path: ['why'], message: 'the one-tap choice, and only it, says why' });
    if (offer.project !== undefined && offer.why !== 'project')
      context.addIssue({ code: 'custom', path: ['project'], message: 'a project is named only by a project default' });
  });

export type InputSavedOffer = z.infer<typeof InputSavedOfferSchema>;

/** A saved login named by another: its handle and its label, never what it holds. */
export const LoginEntryRefSchema = z.strictObject({ id: LoginEntryIdSchema, label: oneLine(LOGIN_LABEL_MAX_LENGTH) });

export type LoginEntryRef = z.infer<typeof LoginEntryRefSchema>;

/**
 * How the saved login this target is for signs in, when it is not a plain password: the card says "Sign in with
 * Google via 'Google (kirin@…)'", so the owner sees the ferret should be on the provider's page, not typing here.
 */
export const InputSignInSchema = z.strictObject({
  id: LoginEntryIdSchema,
  label: oneLine(LOGIN_LABEL_MAX_LENGTH),
  method: LoginMethodSchema,
  via: LoginEntryRefSchema.optional(),
});

export type InputSignIn = z.infer<typeof InputSignInSchema>;

/**
 * What an input card knows about saved logins, as the owner reads it (never the agent): the target's key
 * the daemon worked out, the entry "Save as" would suggest, and the entries that can fill the field,
 * matched first.
 */
export const InputSavedSchema = z.strictObject({
  match: LoginMatchSchema.optional(),
  /**
   * What an older app pre-fills under "Save as": `update` when that is the account the card is about, else
   * `newAccount`. A newer app reads those two and asks the owner which one.
   */
  suggest: LoginEntryRefSchema.optional(),
  /**
   * The account "Update" would write the typed value into: the one this card is about among those that sign in here.
   * Absent when none does, or when two or more do and nothing chose one. Saving into it takes the owner's explicit
   * "Update" (`save.mode: 'update'`); its username is shown so the owner can tell it is the same person.
   */
  update: LoginEntryRefSchema.safeExtend({ username: oneLine(LOGIN_USERNAME_MAX_LENGTH).optional() }).optional(),
  /**
   * What "New account" would be called: a label and a CLI name from the site's provider and the username when it is
   * known ("Google · a@gmail.com", `GOOGLE_A`), never a CLI name an account already has.
   */
  newAccount: LoginEntryRefSchema.optional(),
  /**
   * The username the FERRET typed into this page's identifier field (an email or username box) before the card was
   * raised, as the daemon saw its own type act: plain, and only the ferret's word. It pre-fills the editable "Username"
   * under "Save as" and can REMOVE a one-tap (`differentFrom`); it never chooses, promotes or fills an account.
   */
  typedUsername: oneLine(LOGIN_USERNAME_MAX_LENGTH).optional(),
  /**
   * The account that would have been the one-tap, demoted because the page is signing in someone else: the typed
   * username is not that account's, or it has none saved. The card says "This looks like a different account" and the
   * owner picks or types.
   */
  differentFrom: LoginEntryRefSchema.safeExtend({ username: oneLine(LOGIN_USERNAME_MAX_LENGTH).optional() }).optional(),
  /** Which field a typed value would be saved as; absent when this kind of value is never saved (a code). */
  saves: LoginFieldRoleSchema.optional(),
  offers: z
    .array(InputSavedOfferSchema)
    .max(MAX_LOGIN_ENTRIES)
    .readonly()
    .refine(offers => offers.filter(offer => offer.primary === true).length <= 1, 'at most one offer is the primary'),
  /** The matched entry signs in through a provider: what the card says about it. */
  signIn: InputSignInSchema.optional(),
  /**
   * The board project the DAEMON resolved for the asking session (never the ferret's word): what a quiet "Always use for
   * <project>" after a hand-tap writes as a project default. Absent: the session has no project (Unfiled), or the daemon
   * could not tell.
   */
  project: z.strictObject({ id: z.string().min(1).max(200), name: oneLine(SIGN_IN_PROJECT_MAX_LENGTH) }).optional(),
});

export type InputSaved = z.infer<typeof InputSavedSchema>;

/** A copy's name, chosen by the agent: a lowercase letter, then lowercase letters, digits, `_` or `-`. */
export const COPY_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/u;

export const CopyNameSchema = z
  .string()
  .regex(COPY_NAME_PATTERN, 'a copy name is a lowercase letter, then up to 39 lowercase letters, digits, _ or -');

export type CopyName = z.infer<typeof CopyNameSchema>;

/**
 * WHERE A COPY CAME FROM, as the daemon saw it: the page's origin (from the browser, never the agent) or the
 * program's base name. Never the arguments, never a URL path.
 */
export const CopyOriginSchema = z.strictObject({
  kind: z.enum(['browser', 'clipboard', 'command']),
  /** `scheme://host[:port]` of the page, for a page or clipboard copy. */
  origin: boundedLine(256).optional(),
  /** The program's base name, for a command copy. */
  program: boundedLine(64).optional(),
  /**
   * The file that ran, for a command copy: found by the daemon on the command's PATH, so the owner sees WHICH
   * `vercel` printed the value (`/usr/local/bin/vercel`, or one in a folder the ferret could have written to).
   */
  path: boundedLine(1024).optional(),
  /**
   * The account the daemon (and every ferret) runs as could change that file or put another in its place: its
   * file or its folder is writable. A pre-approval rule never matches such a program; the owner is asked.
   */
  replaceable: z.literal(true).optional(),
  /**
   * A page copy of a form field's VALUE: whatever was typed into it, by the agent too, so it says nothing about
   * the page that holds it. A pre-approval rule never matches it; the owner is asked.
   */
  editable: z.literal(true).optional(),
  /** The surface it was read from, for a page or clipboard copy. */
  surface: SurfaceKeySchema.optional(),
});

export type CopyOrigin = z.infer<typeof CopyOriginSchema>;

export const CopyPlanIdSchema = z.string().regex(/^[0-9a-f]{32}$/u, 'a 128-bit hex id');

export const AgendaIdSchema = z.string().regex(/^A[1-9][0-9]*$/u);
export type AgendaId = z.infer<typeof AgendaIdSchema>;

export const HEX_DIGEST = /^[0-9a-f]{64}$/u;
export const Digest = z.string().regex(HEX_DIGEST, 'a sha-256 digest in lowercase hex');

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

/** The kinds of place a value can go: a terminal, a page, or the secret store. */
export const InputTargetKindSchema = z.enum(['terminal', 'page', 'secret']);

/** The longest label an agent may give a field ("Email", "Password"). */
export const INPUT_FIELD_LABEL_MAX_LENGTH = 60;

export const FieldLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(INPUT_FIELD_LABEL_MAX_LENGTH)
  .regex(/^[^\p{Cc}\p{Cf}]*$/u, 'must be one line with no control characters');

export const fieldsProblem = (fields: readonly { readonly id: string }[]): string | undefined =>
  new Set(fields.map(field => field.id)).size === fields.length ? undefined : 'each field needs its own id';

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
  /** How many characters it holds: a count the card may show, never a sample of the value. */
  length: z.number().int().nonnegative().optional(),
  /** When THIS capture was read: the card is for this one, and the write opens no other under the name. */
  capturedAt: InstantSchema.optional(),
});

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

export const RISK_RANK: Readonly<Record<InputRiskLevel, number>> = { green: 0, neutral: 1, amber: 2, red: 3 };

/** The worst of some fields' risks: what the card's header flag says. `undefined` when none is known yet. */
export function worstRisk(risks: readonly (InputRisk | undefined)[]): InputRisk | undefined {
  return risks.reduce<InputRisk | undefined>(
    (worst, risk) =>
      risk === undefined ? worst : worst === undefined || RISK_RANK[risk.level] > RISK_RANK[worst.level] ? risk : worst,
    undefined,
  );
}

export const PreapprovalOutcomeShape = {
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
      context.addIssue({ code: 'custom', message: 'padded is the one value of a one-field input: send it alone' });
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

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();
export const LENGTH_WIDTH = 5;

export const hasControlCharacter = (text: string): boolean => /\p{Cc}/u.test(text);

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

/**
 * `GET /v1/ferrets/:ferretId/input-requests/:requestId/shot`: the picture of a page request's fields the daemon took
 * before anything was typed (`InputShot`, targets.ts), for the OWNER's card only while the request waits. `pngBase64` is
 * the browser's own screenshot; `clip` is the part of the page it shows, in the same coordinates as a field's `box`.
 * Never a value: the picture is of the page before a byte was typed.
 */
const INPUT_SHOT_MAX_BASE64 = 16_000_000;
export const InputShotSchema = z.strictObject({
  // Only base64 reaches an <img src="data:…"> the card draws: anything else is refused, never drawn.
  pngBase64: z
    .string()
    .min(1)
    .max(INPUT_SHOT_MAX_BASE64)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/u),
  clip: z.strictObject({
    x: z.number().finite(),
    y: z.number().finite(),
    w: z.number().finite().nonnegative(),
    h: z.number().finite().nonnegative(),
  }),
});
