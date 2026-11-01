import { z } from 'zod';
import {
  AccountIdSchema,
  AccountKeySchema,
  SignInIdSchema,
  type SignInRuleId,
  SignInRuleIdSchema,
  SignInRuleRevisionSchema,
  type SignInRuleStageId,
  SignInRuleStageIdSchema,
  type SignInRuleSuggestionId,
  SignInRuleSuggestionIdSchema,
  TwoFactorIdSchema,
} from './account-ids.ts';
import { AccountRefSchema, PlaceKeySchema, PlaceSchema, type TwoFactorKeySummary } from './accounts.ts';
import { canonicalJson } from './canonical-json.ts';
import { InstantSchema } from './common.ts';
import { LOGIN_MATCH_MAX, LOGIN_USERNAME_MAX_LENGTH, oneLine } from './login-entries.ts';
import { LOGIN_OBSERVED_MAX } from './login-recipes.ts';
import { sha256Hex } from './mcp-oauth.ts';
import { PairedDeviceIdSchema } from './pairing.ts';
import { PASSKEY_CHALLENGE_TTL_SECONDS, StoredStepUpProofSchema } from './step-up.ts';
import {
  type GrantMissReason,
  grantMissWords,
  type SignInField,
  SignInFieldSchema,
  TASK_PLAN_SUMMARY_LINE_MAX_CHARS,
  taskPlanKeysFitLine,
} from './task-plan.ts';

export {
  type SignInRuleId,
  SignInRuleIdSchema,
  SignInRuleRevisionSchema,
  type SignInRuleStageId,
  SignInRuleStageIdSchema,
  type SignInRuleSuggestionId,
  SignInRuleSuggestionIdSchema,
};

/**
 * STANDING SIGN-IN RULES (docs/input-requests.md, "Standing rule fills"): one owner-signed permission for Ferretry to
 * fill ONE page sign-in, for any ferret (unless the owner narrowed its scope), until it expires — at most 90 days.
 *
 * ## THE BODY IS SIGNED; EVERYTHING ELSE MAY ONLY NARROW
 *
 * A rule is created, widened, resumed or renewed only by the owner, each time with a fresh `approve-sign-in-rule`
 * passkey (step-up.ts), asked of every caller, the machine included. The assertion's challenge commits to the rule's
 * canonical bytes ({@link canonicalSignInRule} → {@link signInRuleSubject} → {@link signInRuleChallenge}), and the
 * daemon keeps the assertion with the record so it can check it again, offline, before every fill. Nothing outside
 * {@link SignInRuleBodySchema} can widen what fills: the record's overlay (suspension, narrowing, usage) is unsigned
 * and the schema refuses any overlay that would widen the body.
 *
 * ## PINNED FACTS SUSPEND, NEVER SILENTLY
 *
 * The body pins what the owner approved against: the account's key, handle and username, the sign-in's login
 * domains, its recipe version, the field identities the owner's own taps have history with, and a fingerprint of the
 * account's 2FA keys. Any drift suspends the rule ({@link SIGN_IN_RULE_SUSPENSIONS}), and only a new passkey resumes it.
 *
 * ## PAGES ONLY
 *
 * A standing rule is for a page sign-in only (`surface: 'page'`, web hosts only). A sudo, su or doas password stays
 * covered per task, by a task plan line (owner decision, R3c §18).
 *
 * ## THE FERRET LEARNS NOTHING ABOUT RULES
 *
 * Every shape here is the owner's. A ferret may only suggest one (`account.propose` with `preapprove`), which raises a
 * card that opens the owner's create sheet with nothing ticked.
 */

// ── Limits (one owner each) ─────────────────────────────────────────────────────────────────────────

/** Most rules on one machine: one per sign-in. */
export const SIGN_IN_RULE_MAX = 64;
/** How long a rule lasts when the owner names no time, and the most it may: in days, and the bounds in seconds. */
export const SIGN_IN_RULE_DEFAULT_DAYS = 30;
export const SIGN_IN_RULE_MAX_DAYS = 90;
const DAY_SECONDS = 86_400;
export const SIGN_IN_RULE_DEFAULT_SECONDS = SIGN_IN_RULE_DEFAULT_DAYS * DAY_SECONDS;
export const SIGN_IN_RULE_MAX_SECONDS = SIGN_IN_RULE_MAX_DAYS * DAY_SECONDS;
/** The shortest a rule may last. */
export const SIGN_IN_RULE_MIN_SECONDS = 3_600;
/**
 * How far ahead of this machine's clock a rule may say it was created: clock skew between the stage and the parse.
 * Further ahead would let a rule reach past 90 days from now, the bound a rolled-back file relies on.
 */
export const SIGN_IN_RULE_CLOCK_SKEW_SECONDS = 300;
/** The optional use cap's ceiling. Absent: no count (the expiry, the hourly rate and the log still bound it). */
export const SIGN_IN_RULE_MAX_USES = 1_000;
/** How long a staged rule waits for its passkey: as long as the challenge it is answered with. */
export const SIGN_IN_RULE_STAGE_TTL_SECONDS = PASSKEY_CHALLENGE_TTL_SECONDS;
/** A ferret's suggestions: per session an hour, at most one pending per sign-in, each gone after a day. */
export const SIGN_IN_RULE_SUGGESTIONS_PER_HOUR = 3;
export const SIGN_IN_RULE_SUGGESTION_TTL_SECONDS = DAY_SECONDS;
/** How many of the owner's own device taps that went through a sign-in needs before a rule can be made for it. */
export const SIGN_IN_RULE_HISTORY_TAPS = 2;
/** Most lines of a staged rule's summary: the daemon's words the passkey dialog shows. */
export const SIGN_IN_RULE_SUMMARY_MAX_LINES = 8;
/** Longest paired-device name a rule view shows. */
const DEVICE_LABEL_MAX_CHARS = 200;

/**
 * The one line every rule card, sheet, Settings group and doc section carries, verbatim: what a rule does and does not
 * protect against while every ferret on this machine is honest-client (!A192).
 */
export const SIGN_IN_RULE_HONEST_LIMIT =
  "This stops a ferret putting the password anywhere else, or granting itself a rule, through Ferretry. It can't stop a ferret that reads Ferretry's own files, and any ferret may use this sign-in while the rule lasts.";

// ── The signed body ──────────────────────────────────────────────────────────────────────────────────

/**
 * Which sessions a rule fills for: `any` ferret on this machine (the default, !A193), the sessions stamped with one
 * board `project` (never a folder-resolved or Unfiled project, so the id is a registered project's uuid), or exactly
 * one `session` (not its children). A kind this build does not know is refused, never read as `any`.
 */
export const SignInRuleScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('any') }),
  z.strictObject({ kind: z.literal('project'), project: z.uuid() }),
  z.strictObject({ kind: z.literal('session'), session: oneLine(128) }),
]);
export type SignInRuleScope = z.infer<typeof SignInRuleScopeSchema>;

/** A field identity the daemon observed (`LoginObserved.identity`). */
const IdentitySchema = z.string().regex(/^[0-9a-f]{16}$/u, 'a field identity is 16 hex digits');

/** {@link factorFingerprint}'s output. */
const FactorFingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/u, 'a 2FA key fingerprint is 64 hex digits');

/**
 * WHAT THE RULE WAS APPROVED AGAINST, snapshotted when it is staged. Every part is in the signed bytes, and any of them
 * drifting suspends the rule:
 *
 * - `accountKey`: the immutable `L…` key; `account`, the handle at approval (a rename suspends); `username` (a change
 *   suspends).
 * - `placeKeys`: the sign-in's login domains (web hosts only).
 * - `recipeVersion`: the recipe the owner saw; absent when the sign-in has none.
 * - `identities`: the field identities the owner's own taps have history with. REQUIRED: a rule never pins a new form.
 * - `factors`: {@link factorFingerprint} of the account's 2FA keys; any change to the list suspends.
 * - `factor`: the one key whose codes a rule types, present exactly when it may type a code. Chosen by when it was
 *   added, never by whether a code of it went through.
 */
export const SignInRulePinsSchema = z.strictObject({
  accountKey: AccountKeySchema,
  account: AccountIdSchema,
  username: oneLine(LOGIN_USERNAME_MAX_LENGTH).optional(),
  placeKeys: z.array(PlaceKeySchema).min(1).max(LOGIN_MATCH_MAX),
  recipeVersion: z.number().int().min(1).optional(),
  identities: z.array(IdentitySchema).min(1).max(LOGIN_OBSERVED_MAX),
  factors: FactorFingerprintSchema,
  factor: TwoFactorIdSchema.optional(),
});
export type SignInRulePins = z.infer<typeof SignInRulePinsSchema>;

const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;

/** The facts {@link signInRuleBodyProblems} reads: a body as parsed, before its own refinement. */
interface SignInRuleBodyFacts {
  readonly fields: readonly SignInField[];
  readonly pins: Pick<SignInRulePins, 'placeKeys' | 'identities' | 'factor'>;
  readonly createdAt: string;
  readonly expiresAt: string;
}

/**
 * What a rule body may not be: the one check behind the schema, the canonical bytes and the tests. `now` is this
 * machine's clock: a body created further ahead of it than {@link SIGN_IN_RULE_CLOCK_SKEW_SECONDS} is refused, so the
 * schema reads the clock. A stored rule only grows older, so it keeps parsing; a clock set back further than the skew
 * fails closed (the document reads as no rules) until the clock is right again.
 */
export const signInRuleBodyProblems = (body: SignInRuleBodyFacts, now: number = Date.now()): readonly string[] => {
  const lifetime = (Date.parse(body.expiresAt) - Date.parse(body.createdAt)) / 1_000;
  const ahead = (Date.parse(body.createdAt) - now) / 1_000;
  const totp = body.fields.includes('totp');
  return [
    ...(unique(body.fields) ? [] : ['a rule names each field once']),
    ...(totp === (body.pins.factor !== undefined) ? [] : ['a rule types a code exactly when it pins the 2FA key']),
    ...(totp && !body.fields.includes('password') ? ['a rule types a code only after its own password'] : []),
    // Page-only (R3c §18): a `tool@host` key would put the password into a terminal.
    ...(taskPlanKeysFitLine('sign-in', body.pins.placeKeys) ? [] : ['a rule is pinned to web hosts only']),
    ...(unique(body.pins.placeKeys) ? [] : ['a rule pins each login domain once']),
    ...(unique(body.pins.identities) ? [] : ['a rule pins each field identity once']),
    ...(Number.isFinite(lifetime) && lifetime >= SIGN_IN_RULE_MIN_SECONDS
      ? []
      : [`a rule lasts at least ${String(SIGN_IN_RULE_MIN_SECONDS / 3_600)} hour`]),
    ...(Number.isFinite(lifetime) && lifetime <= SIGN_IN_RULE_MAX_SECONDS
      ? []
      : [`a rule lasts at most ${String(SIGN_IN_RULE_MAX_DAYS)} days`]),
    ...(Number.isFinite(ahead) && ahead <= SIGN_IN_RULE_CLOCK_SKEW_SECONDS
      ? []
      : ['a rule is never created in the future']),
  ];
};

/**
 * THE SIGNED PART of a rule. `revision` is 1 when created and one more on each resume, renew or widen (the id stays).
 * `surface` is `page`, always. `fields` are the ones Ferretry may type: `totp` only with `pins.factor`, and only beside
 * `password`. `expiresAt` is fixed when the rule is staged, between one hour and 90 days after `createdAt`. `uses` is
 * the optional cap. `approvedBy` is the paired device whose passkey proved it.
 */
export const SignInRuleBodySchema = z
  .strictObject({
    v: z.literal(1),
    id: SignInRuleIdSchema,
    revision: SignInRuleRevisionSchema,
    signIn: SignInIdSchema,
    surface: z.literal('page'),
    fields: z.array(SignInFieldSchema).min(1).max(3),
    pins: SignInRulePinsSchema,
    scope: SignInRuleScopeSchema,
    createdAt: InstantSchema,
    expiresAt: InstantSchema,
    uses: z.number().int().min(1).max(SIGN_IN_RULE_MAX_USES).optional(),
    approvedBy: z.strictObject({ deviceId: PairedDeviceIdSchema }),
  })
  .superRefine((body, context) => {
    for (const message of signInRuleBodyProblems(body)) context.addIssue({ code: 'custom', message });
  });
export type SignInRuleBody = z.infer<typeof SignInRuleBodySchema>;

/**
 * 32 bytes as canonical unpadded base64url: 43 characters, the last carrying only its top 4 bits (so one byte string
 * has exactly one spelling).
 */
const NONCE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;

/**
 * THE OWNER'S PASSKEY ASSERTION a rule carries: the stored proof (step-up.ts), the stage it was bound to, and the
 * 32-byte nonce the daemon drew for that stage. Re-deriving {@link signInRuleChallenge} from these and the body's
 * canonical bytes must give the challenge inside `clientDataJSON`, or the rule never fills (`proof-invalid`).
 */
export const SignInRuleProofSchema = z.strictObject({
  ...StoredStepUpProofSchema.shape,
  stage: SignInRuleStageIdSchema,
  nonce: z.string().regex(NONCE, 'a nonce is 32 bytes of unpadded base64url'),
});
export type SignInRuleProof = z.infer<typeof SignInRuleProofSchema>;

// ── Suspension ───────────────────────────────────────────────────────────────────────────────────────

/**
 * WHY A RULE WAS SUSPENDED. Sticky: changing the pinned fact back does not resume it; only a new passkey does. The
 * first nine are also grant misses (a fill found them); `passkey-removed` follows the registry, and `store-write-failed`
 * keeps a rule suspended in memory when its file could not be written.
 */
export const SIGN_IN_RULE_SUSPENSIONS = [
  'place-changed',
  'recipe-changed',
  'form-changed',
  'did-not-move-on',
  'account-changed',
  'factor-changed',
  'sign-in-gone',
  'proof-invalid',
  'scripted-origin',
  'passkey-removed',
  'store-write-failed',
] as const;
export const SignInRuleSuspensionSchema = z.enum(SIGN_IN_RULE_SUSPENSIONS);
export type SignInRuleSuspension = z.infer<typeof SignInRuleSuspensionSchema>;

/** The suspension a fill's miss causes, or `undefined` for a miss that leaves the rule as it was. */
export const signInRuleSuspensionOf = (reason: GrantMissReason): SignInRuleSuspension | undefined => {
  const parsed = SignInRuleSuspensionSchema.safeParse(reason);
  return parsed.success ? parsed.data : undefined;
};

const SUSPENSION_ONLY_WORDS = {
  'passkey-removed': 'the passkey or device that approved it was removed',
  'store-write-failed': "Ferretry couldn't save the rule's state, so it stopped using it",
} as const satisfies Partial<Record<SignInRuleSuspension, string>>;

/** The owner's sentence for a suspension: Settings, Accounts and the suspension's audit read it. */
export const signInRuleSuspensionWords = (because: SignInRuleSuspension): string =>
  because === 'passkey-removed' || because === 'store-write-failed'
    ? SUSPENSION_ONLY_WORDS[because]
    : (grantMissWords(because) ?? because);

// ── The record on disk ───────────────────────────────────────────────────────────────────────────────

/** How often a rule filled, and the last time and session. */
export const SignInRuleUsageSchema = z.strictObject({
  count: z.number().int().min(0),
  lastUsedAt: InstantSchema.optional(),
  lastSession: oneLine(128).optional(),
});
export type SignInRuleUsage = z.infer<typeof SignInRuleUsageSchema>;

/** The owner's narrowing of a rule, kept beside the signed body: drop the code, an earlier end, a lower cap. */
export const SignInRuleNarrowedSchema = z.strictObject({
  dropTotp: z.literal(true).optional(),
  expiresAt: InstantSchema.optional(),
  uses: z.number().int().min(0).max(SIGN_IN_RULE_MAX_USES).optional(),
});
export type SignInRuleNarrowed = z.infer<typeof SignInRuleNarrowedSchema>;

/**
 * ONE RULE AS IT RESTS ON DISK: the signed `body`, its `proof`, and an UNSIGNED overlay that may only narrow or record
 * (`suspended`, `narrowed`, `usage`). A same-user edit can clear the overlay (the honest limit), never widen the body:
 * an overlay that would is refused here, and the whole document with it.
 */
export const SignInRuleRecordSchema = z
  .strictObject({
    body: SignInRuleBodySchema,
    proof: SignInRuleProofSchema,
    suspended: z.strictObject({ at: InstantSchema, because: SignInRuleSuspensionSchema }).optional(),
    narrowed: SignInRuleNarrowedSchema.optional(),
    usage: SignInRuleUsageSchema,
  })
  .superRefine((record, context) => {
    const problem = (message: string, path: string[]): void => {
      context.addIssue({ code: 'custom', message, path });
    };
    if (record.proof.deviceId !== record.body.approvedBy.deviceId)
      problem('the proof comes from the device the rule names', ['proof', 'deviceId']);
    const narrowed = record.narrowed;
    if (narrowed === undefined) return;
    if (narrowed.dropTotp === true && !record.body.fields.includes('totp'))
      problem('only a rule that types a code can drop it', ['narrowed', 'dropTotp']);
    if (
      narrowed.expiresAt !== undefined &&
      !(
        Date.parse(narrowed.expiresAt) <= Date.parse(record.body.expiresAt) &&
        Date.parse(narrowed.expiresAt) >= Date.parse(record.body.createdAt)
      )
    )
      problem('a narrowed rule ends no later than it was approved to', ['narrowed', 'expiresAt']);
    if (narrowed.uses !== undefined && record.body.uses !== undefined && narrowed.uses > record.body.uses)
      problem('a narrowed rule has no more uses than it was approved for', ['narrowed', 'uses']);
  });
export type SignInRuleRecord = z.infer<typeof SignInRuleRecordSchema>;

/**
 * `<state>/accounts/sign-in-rules.json`. Strict: any part that does not parse means ZERO rules (every sign-in asks),
 * never a default. One rule per id and per sign-in.
 */
export const SignInRulesDocumentSchema = z
  .strictObject({ v: z.literal(1), rules: z.array(SignInRuleRecordSchema).max(SIGN_IN_RULE_MAX) })
  .superRefine((document, context) => {
    if (!unique(document.rules.map(rule => rule.body.id)))
      context.addIssue({ code: 'custom', message: 'each rule id is used once', path: ['rules'] });
    if (!unique(document.rules.map(rule => rule.body.signIn)))
      context.addIssue({ code: 'custom', message: 'one rule per sign-in', path: ['rules'] });
  });
export type SignInRulesDocument = z.infer<typeof SignInRulesDocumentSchema>;

// ── What is in force: the body, narrowed ────────────────────────────────────────────────────────────

export const SignInRuleStatusSchema = z.enum(['active', 'suspended', 'used-up', 'expired']);
export type SignInRuleStatus = z.infer<typeof SignInRuleStatusSchema>;

/** A rule as it stands now: the signed body intersected with the owner's narrowing, and its status. */
export interface SignInRuleEffective {
  readonly fields: readonly SignInField[];
  readonly expiresAt: string;
  /** The cap in force, if any: the lower of the body's and the narrowing's. */
  readonly uses?: number | undefined;
  /** Uses left under the cap; absent with no cap. */
  readonly remaining?: number | undefined;
  readonly status: SignInRuleStatus;
}

const earlier = (left: string, right: string | undefined): string =>
  right !== undefined && Date.parse(right) < Date.parse(left) ? right : left;

/**
 * THE ONE READING of a record's overlay: the overlay only ever takes away. A suspended rule reads `suspended` whatever
 * else is true, so its reason stays on screen; then `expired` at or after its end, and also BEFORE its start (a clock
 * that ran back: never in force outside its signed window, which is never longer than 90 days); then `used-up`.
 */
export function signInRuleEffective(record: SignInRuleRecord, now: number): SignInRuleEffective {
  const narrowed = record.narrowed;
  const fields = record.body.fields.filter(field => field !== 'totp' || narrowed?.dropTotp !== true);
  const expiresAt = earlier(record.body.expiresAt, narrowed?.expiresAt);
  const caps = [record.body.uses, narrowed?.uses].filter((cap): cap is number => cap !== undefined);
  const uses = caps.length === 0 ? undefined : Math.min(...caps);
  const remaining = uses === undefined ? undefined : Math.max(0, uses - record.usage.count);
  const status: SignInRuleStatus =
    record.suspended !== undefined
      ? 'suspended'
      : now >= Date.parse(expiresAt) || now < Date.parse(record.body.createdAt)
        ? 'expired'
        : remaining === 0
          ? 'used-up'
          : 'active';
  return { fields, expiresAt, ...(uses === undefined ? {} : { uses, remaining }), status };
}

// ── The owner's view ─────────────────────────────────────────────────────────────────────────────────

/** The daemon's flags on a rule, drawn red (`one-factor`: the code is ticked) or amber (`auto-recipe`). */
export const SIGN_IN_RULE_FLAGS = ['one-factor', 'auto-recipe'] as const;
export const SignInRuleFlagSchema = z.enum(SIGN_IN_RULE_FLAGS);
export type SignInRuleFlag = z.infer<typeof SignInRuleFlagSchema>;

/** `fields` and `totp` said twice on purpose: the red warning reads the boolean, never a list or a summary's words. */
const codeTickProblems = (value: {
  readonly fields: readonly SignInField[];
  readonly totp: boolean;
}): readonly string[] => [
  ...(unique(value.fields) ? [] : ['each field is named once']),
  ...(value.totp === value.fields.includes('totp') ? [] : ['totp says exactly whether the fields hold a code']),
  ...(value.totp && !value.fields.includes('password') ? ['a code is typed only after its own password'] : []),
];

/**
 * ONE RULE AS THE OWNER READS IT (`GET /v1/sign-in-rules`, gated like `GET /v1/accounts` because it names accounts).
 * What is in force after narrowing ({@link signInRuleEffective}), the sign-in's account and place now, and the device
 * whose passkey approved it. Never a value, never the proof.
 */
export const SignInRuleViewSchema = z
  .strictObject({
    id: SignInRuleIdSchema,
    revision: SignInRuleRevisionSchema,
    signIn: SignInIdSchema,
    account: AccountRefSchema,
    username: oneLine(LOGIN_USERNAME_MAX_LENGTH).optional(),
    place: PlaceSchema,
    fields: z.array(SignInFieldSchema).min(1).max(3),
    totp: z.boolean(),
    scope: SignInRuleScopeSchema,
    createdAt: InstantSchema,
    expiresAt: InstantSchema,
    uses: z.number().int().min(0).max(SIGN_IN_RULE_MAX_USES).optional(),
    remaining: z.number().int().min(0).max(SIGN_IN_RULE_MAX_USES).optional(),
    status: SignInRuleStatusSchema,
    suspended: z.strictObject({ at: InstantSchema, because: SignInRuleSuspensionSchema }).optional(),
    usage: SignInRuleUsageSchema,
    flags: z.array(SignInRuleFlagSchema).max(SIGN_IN_RULE_FLAGS.length),
    approvedWith: z.strictObject({
      deviceId: PairedDeviceIdSchema,
      /** The paired device's name now; absent once it was revoked. */
      device: oneLine(DEVICE_LABEL_MAX_CHARS).optional(),
    }),
  })
  .superRefine((view, context) => {
    const problems = [
      ...codeTickProblems(view),
      ...(view.place.kind === 'site' ? [] : ['a standing rule is for a page sign-in']),
      ...(unique(view.flags) ? [] : ['each flag is shown once']),
      ...(view.flags.includes('one-factor') === view.totp ? [] : ['a rule that types a code is flagged one-factor']),
      ...((view.status === 'suspended') === (view.suspended !== undefined)
        ? []
        : ['a suspended rule says why, and only a suspended one']),
      ...((view.uses === undefined) === (view.remaining === undefined) ? [] : ['uses left come with a cap only']),
      ...(view.uses !== undefined && view.remaining !== undefined && view.remaining > view.uses
        ? ['a rule never has more uses left than its cap']
        : []),
    ];
    for (const message of problems) context.addIssue({ code: 'custom', message });
  });
export type SignInRuleView = z.infer<typeof SignInRuleViewSchema>;

// ── Staging: the owner's draft, the stage the passkey is bound to, narrowing ─────────────────────────

/**
 * `POST /v1/sign-in-rules/stages`: what the owner ticked on the create sheet. `fields` are the username and password;
 * the code is its own tick (`totp`), which needs `totpAcknowledged` (the red one-factor warning) and the password.
 * `replaces` names the rule a resume, renew or widen approves again (same id, revision + 1). The daemon snapshots
 * every pin itself: nothing here names a domain, a key or an identity.
 */
export const SignInRuleDraftSchema = z
  .strictObject({
    signIn: SignInIdSchema,
    fields: z
      .array(z.enum(['username', 'password']))
      .min(1)
      .max(2),
    totp: z.boolean().optional(),
    totpAcknowledged: z.literal(true).optional(),
    scope: SignInRuleScopeSchema.optional(),
    lifetimeSeconds: z.number().int().min(SIGN_IN_RULE_MIN_SECONDS).max(SIGN_IN_RULE_MAX_SECONDS).optional(),
    uses: z.number().int().min(1).max(SIGN_IN_RULE_MAX_USES).optional(),
    replaces: SignInRuleIdSchema.optional(),
  })
  .superRefine((draft, context) => {
    const totp = draft.totp === true;
    const problems = [
      ...(unique(draft.fields) ? [] : ['tick each field once']),
      ...(totp && draft.totpAcknowledged !== true
        ? ['ticking the code makes the sign-in one factor: acknowledge it first']
        : []),
      ...(!totp && draft.totpAcknowledged !== undefined ? ['acknowledge the code warning only with the code'] : []),
      ...(totp && !draft.fields.includes('password') ? ['a code is typed only after its own password'] : []),
    ];
    for (const message of problems) context.addIssue({ code: 'custom', message });
  });
export type SignInRuleDraft = z.infer<typeof SignInRuleDraftSchema>;

/** What a staged rule may not be: its code flags agree, and it is for a page sign-in. */
const stagedProblems = (staged: {
  readonly fields: readonly SignInField[];
  readonly totp: boolean;
  readonly place: { readonly kind: string };
}): readonly string[] => [
  ...codeTickProblems(staged),
  ...(staged.place.kind === 'site' ? [] : ['a standing rule is for a page sign-in']),
];

/**
 * A RULE WAITING FOR ITS PASSKEY: the stage the `approve-sign-in-rule` proof is bound to, the rule it makes, and the
 * daemon's own words for it, which the passkey dialog shows. Every red and amber warning comes from the STRUCTURED
 * fields (`totp`: one factor; `autoRecipe`), never from the summary's words, which may be clipped (secrev-1268 N1);
 * so does WHICH sign-in it is for (`account`, `place`: secrev-1271 L3), since a clip cuts the host first.
 * `machine` is set when it was staged at the machine (`fy rules add`) and waits in the app. Never a value.
 */
export const SignInRuleStagedSchema = z
  .strictObject({
    stage: SignInRuleStageIdSchema,
    rule: SignInRuleIdSchema,
    revision: SignInRuleRevisionSchema,
    signIn: SignInIdSchema,
    /** The account and the place the rule is for, as fields: the dialog draws them from here, never from `summary`. */
    account: AccountRefSchema,
    place: PlaceSchema,
    summary: z.array(oneLine(TASK_PLAN_SUMMARY_LINE_MAX_CHARS)).min(1).max(SIGN_IN_RULE_SUMMARY_MAX_LINES),
    fields: z.array(SignInFieldSchema).min(1).max(3),
    totp: z.boolean(),
    autoRecipe: z.boolean(),
    scope: SignInRuleScopeSchema,
    /** When the RULE would end. */
    expiresAt: InstantSchema,
    uses: z.number().int().min(1).max(SIGN_IN_RULE_MAX_USES).optional(),
    /** When the STAGE lapses unanswered. */
    stageExpiresAt: InstantSchema,
    machine: z.strictObject({ askedAt: InstantSchema }).optional(),
  })
  .superRefine((staged, context) => {
    for (const message of stagedProblems(staged)) context.addIssue({ code: 'custom', message });
  });
export type SignInRuleStaged = z.infer<typeof SignInRuleStagedSchema>;

export const SignInRuleStageStateSchema = z.enum(['waiting', 'approved', 'denied', 'expired']);
export type SignInRuleStageState = z.infer<typeof SignInRuleStageStateSchema>;

/** `GET /v1/sign-in-rules/stages/:stage`: where a staged rule stands, for `fy rules add` waiting on the app. */
export const SignInRuleStageViewSchema = z
  .strictObject({ ...SignInRuleStagedSchema.shape, state: SignInRuleStageStateSchema })
  .superRefine((staged, context) => {
    for (const message of stagedProblems(staged)) context.addIssue({ code: 'custom', message });
  });
export type SignInRuleStageView = z.infer<typeof SignInRuleStageViewSchema>;

/** `GET /v1/sign-in-rules`: every rule, the machine-staged rules waiting in the app, and whether the file was readable. */
export const SignInRuleListSchema = z.strictObject({
  /** `damaged`: the file did not parse, so no rule fills until the owner writes a new one. */
  health: z.enum(['ok', 'damaged']),
  rules: z.array(SignInRuleViewSchema).max(SIGN_IN_RULE_MAX),
  stages: z.array(SignInRuleStagedSchema).max(SIGN_IN_RULE_MAX),
});
export type SignInRuleList = z.infer<typeof SignInRuleListSchema>;

/**
 * `POST /v1/sign-in-rules/:id/narrow`: drop the code, end earlier, or lower the cap. Needs no passkey, because it only
 * takes away ({@link signInRuleNarrowed} refuses anything that does not).
 */
export const SignInRuleNarrowSchema = z
  .strictObject({
    dropTotp: z.literal(true).optional(),
    expiresAt: InstantSchema.optional(),
    uses: z.number().int().min(0).max(SIGN_IN_RULE_MAX_USES).optional(),
  })
  .refine(narrow => Object.values(narrow).some(value => value !== undefined), {
    message: 'narrow the code, the end or the cap',
  });
export type SignInRuleNarrow = z.infer<typeof SignInRuleNarrowSchema>;

export type SignInRuleNarrowing =
  | { readonly ok: true; readonly narrowed: SignInRuleNarrowed }
  | { readonly ok: false; readonly reason: string };

/**
 * The overlay after a narrowing, or why it isn't one: every part must be STRICTLY narrower than what is in force now
 * (the code dropped from a rule that types one, an earlier end, a lower cap). Pure, so the daemon and the tests read
 * one answer.
 */
export function signInRuleNarrowed(
  record: SignInRuleRecord,
  narrow: SignInRuleNarrow,
  now: number,
): SignInRuleNarrowing {
  const effective = signInRuleEffective(record, now);
  if (narrow.dropTotp === true && !effective.fields.includes('totp'))
    return { ok: false, reason: 'this rule types no code' };
  if (narrow.expiresAt !== undefined) {
    const at = Date.parse(narrow.expiresAt);
    if (!(at < Date.parse(effective.expiresAt))) return { ok: false, reason: 'a narrowed rule ends earlier' };
    if (at < Date.parse(record.body.createdAt)) return { ok: false, reason: 'a rule cannot end before it began' };
  }
  if (narrow.uses !== undefined && effective.uses !== undefined && !(narrow.uses < effective.uses))
    return { ok: false, reason: 'a narrowed rule has fewer uses' };
  const kept = record.narrowed ?? {};
  return {
    ok: true,
    narrowed: {
      ...kept,
      ...(narrow.dropTotp === true ? { dropTotp: true } : {}),
      ...(narrow.expiresAt === undefined ? {} : { expiresAt: narrow.expiresAt }),
      ...(narrow.uses === undefined ? {} : { uses: narrow.uses }),
    },
  };
}

// ── The bytes the passkey is bound to ────────────────────────────────────────────────────────────────

export type SignInRuleCanonical =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: string };

/**
 * THE BYTES A RULE'S PASSKEY IS BOUND TO: RFC 8785 JSON ({@link canonicalJson}) of the whole parsed body, with its
 * set-like arrays (fields, login domains, identities) sorted. Every key of the body is in it, so a field added to the
 * body later is signed without anyone remembering to add it here. A body that does not parse is refused, never bound.
 */
export function canonicalSignInRule(body: SignInRuleBody): SignInRuleCanonical {
  const parsed = SignInRuleBodySchema.safeParse(body);
  if (!parsed.success) return { ok: false, reason: parsed.error.issues[0]?.message ?? 'not a rule body' };
  const rule = parsed.data;
  const sorted = (values: readonly string[]): string[] => [...values].sort();
  return canonicalJson({
    ...rule,
    fields: sorted(rule.fields),
    pins: { ...rule.pins, placeKeys: sorted(rule.pins.placeKeys), identities: sorted(rule.pins.identities) },
  });
}

const SIGN_IN_RULE_DOMAIN = 'ferretry.sign-in-rule.v1';
const SIGN_IN_RULE_CHALLENGE_DOMAIN = 'ferretry.sign-in-rule.challenge.v1';
const SIGN_IN_RULE_FACTORS_DOMAIN = 'ferretry.sign-in-rule.factors.v1';

/**
 * What an `approve-sign-in-rule` proof is bound to: `sha256("ferretry.sign-in-rule.v1\0" + stage + "\0" +
 * sha256(canonical))`. The domain keeps it apart from every other bound act's subject (a task plan's, a 2FA seed's),
 * and the stage keeps one proof from committing another staging of the same body. Throws `RangeError` for a stage that
 * is not an `srs_` id or empty canonical text: nothing is ever bound to a malformed stage or to no bytes.
 */
export const signInRuleSubject = (stage: SignInRuleStageId, canonical: string): string => {
  if (!SignInRuleStageIdSchema.safeParse(stage).success) throw new RangeError('a rule subject needs an srs_ stage');
  if (canonical.length === 0) throw new RangeError("a rule subject needs the rule's canonical bytes");
  return sha256Hex(`${SIGN_IN_RULE_DOMAIN}\0${stage}\0${sha256Hex(canonical)}`);
};

const bytesOfHex = (hex: string): Uint8Array =>
  Uint8Array.from({ length: hex.length / 2 }, (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16));

/**
 * THE WEBAUTHN CHALLENGE for a staged rule (32 bytes): `sha256("ferretry.sign-in-rule.challenge.v1\0" + nonce + "\0" +
 * subject)`. DERIVED, never random, so the daemon can re-derive it from the stored record and check the kept assertion
 * offline. The stage's random nonce keeps two stagings of one body from sharing a challenge. Throws `RangeError` for a
 * nonce that is not 32 bytes of canonical unpadded base64url, or a subject that is not a sha-256 hex digest, so no
 * challenge is ever derived from a nonce not yet drawn. (Whether the nonce is RANDOM no check can see: the daemon draws
 * it from the system CSPRNG.)
 */
export const signInRuleChallenge = (nonce: string, subject: string): Uint8Array => {
  if (!NONCE.test(nonce)) throw new RangeError('a rule challenge needs a 32-byte base64url nonce');
  if (!/^[0-9a-f]{64}$/u.test(subject)) throw new RangeError('a rule challenge needs a rule subject');
  return bytesOfHex(sha256Hex(`${SIGN_IN_RULE_CHALLENGE_DOMAIN}\0${nonce}\0${subject}`));
};

/**
 * A FINGERPRINT OF AN ACCOUNT'S 2FA KEYS, pinned by a rule: each key's id, kind and whether Ferretry makes its codes,
 * in a fixed order. Never `verified` (a ferret can steer whether a code "worked"), the label or when it was added, so a
 * check by use or a rename never suspends a rule, and any key added, removed, changed in kind, or given or stripped of
 * its seed does.
 */
export const factorFingerprint = (keys: readonly TwoFactorKeySummary[]): string =>
  sha256Hex(
    [SIGN_IN_RULE_FACTORS_DOMAIN, ...keys.map(key => `${key.id}:${key.kind}:${key.automatic ? '1' : '0'}`).sort()].join(
      '\n',
    ),
  );

/** The refusals the standing-rule routes answer with, each a different next step for the person. */
export const SIGN_IN_RULE_ERROR_CODES = {
  /** No such staged rule, or it was committed, dropped or timed out: stage it again. */
  stageNotFound: 'stage_not_found',
  /** No device has a passkey yet, so no rule can be approved: "Add a passkey in Settings › Security first". */
  passkeyRequired: 'passkey_required',
} as const;
