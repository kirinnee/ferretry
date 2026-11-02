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
import {
  type AccountRef,
  AccountRefSchema,
  type Place,
  PlaceKeySchema,
  PlaceSchema,
  placeKeys,
  type TwoFactorKeySummary,
} from './accounts.ts';
import { canonicalJson } from './canonical-json.ts';
import { InstantSchema, timesWords } from './common.ts';
import { AUTOMATED_CODE_WARNING, LOGIN_MATCH_MAX, LOGIN_USERNAME_MAX_LENGTH, oneLine } from './login-entries.ts';
import { LOGIN_OBSERVED_MAX } from './login-recipes.ts';
import { sha256Hex } from './mcp-oauth.ts';
import { type DaemonId, DaemonIdSchema, PairedDeviceIdSchema } from './pairing.ts';
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
 * fill ONE sign-in, for any ferret (unless the owner narrowed its scope), until it expires — at most 90 days for a page,
 * at most 7 for sudo, su or doas in a terminal.
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
 * ## A PAGE, OR SUDO, SU OR DOAS
 *
 * A rule is for a page sign-in (`surface: 'page'`, web hosts only) or for a terminal one (`surface: 'terminal'`):
 * exactly one `sudo@host`, `su@host` or `doas@host` key, the password only, red-flagged as root, 1 day by default and
 * at most 7 (owner decision !A197). It fills only where the KERNEL proves that program is reading the terminal
 * setuid root, never on a name a process gave itself; any other terminal program is never covered (`tool-not-covered`).
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
/** One day, in seconds: every rule lifetime is a whole number of these. */
export const DAY_SECONDS = 86_400;
export const SIGN_IN_RULE_DEFAULT_SECONDS = SIGN_IN_RULE_DEFAULT_DAYS * DAY_SECONDS;
export const SIGN_IN_RULE_MAX_SECONDS = SIGN_IN_RULE_MAX_DAYS * DAY_SECONDS;
/** The same for a terminal rule (sudo, su, doas): root on demand, so a day by default and a week at most. */
export const SIGN_IN_RULE_TERMINAL_DEFAULT_DAYS = 1;
export const SIGN_IN_RULE_TERMINAL_MAX_DAYS = 7;
export const SIGN_IN_RULE_TERMINAL_DEFAULT_SECONDS = SIGN_IN_RULE_TERMINAL_DEFAULT_DAYS * DAY_SECONDS;
export const SIGN_IN_RULE_TERMINAL_MAX_SECONDS = SIGN_IN_RULE_TERMINAL_MAX_DAYS * DAY_SECONDS;
/** The shortest a rule may last. */
export const SIGN_IN_RULE_MIN_SECONDS = 3_600;
/**
 * How far ahead of the clock a rule may say it was created ({@link signInRuleClockProblems}): skew between the stage
 * and the check. Further ahead would let a rule reach past 90 days from now, the bound a rolled-back file relies on.
 */
export const SIGN_IN_RULE_CLOCK_SKEW_SECONDS = 300;
/** The optional use cap's ceiling. Absent: no count (the expiry, the hourly rate and the log still bound it). */
export const SIGN_IN_RULE_MAX_USES = 1_000;
/** How long a staged rule waits for its passkey: as long as the challenge it is answered with. */
export const SIGN_IN_RULE_STAGE_TTL_SECONDS = PASSKEY_CHALLENGE_TTL_SECONDS;
/** A ferret's suggestions: per session an hour, at most one pending per sign-in, each gone after a day. */
export const SIGN_IN_RULE_SUGGESTIONS_PER_HOUR = 3;
const SIGN_IN_RULE_SUGGESTION_TTL_DAYS = 1;
export const SIGN_IN_RULE_SUGGESTION_TTL_SECONDS = SIGN_IN_RULE_SUGGESTION_TTL_DAYS * DAY_SECONDS;
/** How many of the owner's own device taps that went through a sign-in needs before a rule can be made for it. */
export const SIGN_IN_RULE_HISTORY_TAPS = 2;
/** The most own-hand sign-ins an eligibility answer counts (it is a tally for the owner to read, not a limit). */
export const SIGN_IN_RULE_HISTORY_MAX = 1_000_000;
/** Longest paired-device name a rule view shows. */
const DEVICE_LABEL_MAX_CHARS = 200;

/**
 * The one line every rule card, sheet, Settings group and doc section carries, verbatim: what a rule does and does not
 * protect against while every ferret on this machine is honest-client (!A192).
 */
export const SIGN_IN_RULE_HONEST_LIMIT =
  "This stops a ferret putting the password anywhere else, or granting itself a rule, through Ferretry. It can't stop a ferret that reads Ferretry's own files, and any ferret may use this sign-in while the rule lasts.";

/** Where the app lists every standing rule on a machine and a waiting one is confirmed: said by `fy rules`, verbatim. */
export const SIGN_IN_RULES_SCREEN_PATH = 'Settings › Secure copy › Standing sign-in rules';

/** The red line on every terminal rule (sudo, su, doas), first in its one red block, verbatim. */
export const SIGN_IN_RULE_ROOT_WARNING = 'Any ferret on this machine gets root while this rule lasts.';

/**
 * The one red line on a rule that also types the 2FA code, verbatim: with it the password and the code both come from
 * this machine. The same sentence a task-plan line's code tick says ({@link AUTOMATED_CODE_WARNING}), never the
 * key-saving {@link LOGIN_TOTP_WARNING}, which is about a vault and is longer than a rule's single red block holds.
 */
export const SIGN_IN_RULE_TOTP_WARNING = AUTOMATED_CODE_WARNING;

/**
 * The amber line on a rule whose sign-in applies its recipe by itself (`autoRecipe`), verbatim, on every surface that
 * draws the flag: the form it fills is then one a ferret may have written, with no review by the owner.
 */
export const SIGN_IN_RULE_AUTO_RECIPE_WARNING =
  'This sign-in applies its recipe by itself, so the form it fills is one a ferret may have written.';

/**
 * What a terminal rule's program proof is worth, beside {@link SIGN_IN_RULE_ROOT_WARNING}, verbatim: the kernel proves a
 * program root installed is reading the terminal setuid root, never by a name a process gave itself; but whoever starts
 * it picks the name it starts under (secrev-1266a L4).
 *
 * THE RACE THAT REMAINS (secrev-1301 M1, said exactly): between the daemon's last kernel look and tmux's guarded write,
 * the reader is checked only by facts a process of this account can reproduce (the pane, its foreground command's name,
 * the cursor row). A program swapped in between the last kernel check and the typing can still read the password ONCE:
 * holding Enter back does not stop a reader that takes bytes as they arrive. The rule is then suspended
 * (`program-changed`: the kernel's check before Enter, or tmux's guard, saw the change), so it cannot be retried under
 * that approval. Nothing more is claimed. Terminal rules fill only while the daemon reports
 * `sign-in-rules-terminal.1` (daemon-features.ts).
 */
export const SIGN_IN_RULE_TERMINAL_HONEST_LIMIT =
  'Ferretry types it only where the kernel proves sudo, su or doas is reading the terminal as root, never on a name a process gave itself. A ferret starts that program, so it could start another program root installed under the name sudo.';

/**
 * The residual risk the owner accepted for terminal rules (!A226, 2026-11-01), verbatim, second in the one red block
 * after {@link SIGN_IN_RULE_ROOT_WARNING}: said wherever the red root flag is, so nobody approves a sudo rule without
 * it. Twenty-five words at most, so the block stays two short sentences (the "How it's checked" expander holds the
 * kernel proof, {@link SIGN_IN_RULE_TERMINAL_HONEST_LIMIT}).
 */
export const SIGN_IN_RULE_TERMINAL_RESIDUAL =
  'In the split second before typing, a ferret could swap in another program and read the password once. Ferretry stops the rule if it notices.';

/** Whether a rule is for a page sign-in or a terminal one (sudo, su, doas). */
export const SignInRuleSurfaceSchema = z.enum(['page', 'terminal']);
export type SignInRuleSurface = z.infer<typeof SignInRuleSurfaceSchema>;

/** How long a rule of each surface lasts when the owner names no time, and the most it may: in seconds and in days. */
export const signInRuleLifetime = (
  surface: SignInRuleSurface,
): {
  readonly defaultSeconds: number;
  readonly maxSeconds: number;
  readonly defaultDays: number;
  readonly maxDays: number;
} =>
  surface === 'terminal'
    ? {
        defaultSeconds: SIGN_IN_RULE_TERMINAL_DEFAULT_SECONDS,
        maxSeconds: SIGN_IN_RULE_TERMINAL_MAX_SECONDS,
        defaultDays: SIGN_IN_RULE_TERMINAL_DEFAULT_DAYS,
        maxDays: SIGN_IN_RULE_TERMINAL_MAX_DAYS,
      }
    : {
        defaultSeconds: SIGN_IN_RULE_DEFAULT_SECONDS,
        maxSeconds: SIGN_IN_RULE_MAX_SECONDS,
        defaultDays: SIGN_IN_RULE_DEFAULT_DAYS,
        maxDays: SIGN_IN_RULE_MAX_DAYS,
      };

/** A week: the shorter choice a page rule's sheet offers beside its default and its most. */
const WEEK_DAYS = 7;

/**
 * THE LIFETIMES A SHEET OFFERS, in days, shortest first, built from {@link signInRuleLifetime} so a sheet never offers
 * one the daemon refuses: a terminal rule its default and its most (1 and 7), a page rule a week, its default and its
 * most (7, 30 and 90).
 */
export const signInRuleDayChoices = (surface: SignInRuleSurface): readonly number[] => {
  const { defaultDays, maxDays } = signInRuleLifetime(surface);
  const choices = surface === 'terminal' ? [defaultDays, maxDays] : [WEEK_DAYS, defaultDays, maxDays];
  return [...new Set(choices.filter(days => days <= maxDays))].sort((a, b) => a - b);
};

/**
 * THE SURFACE A RULE FOR A PLACE IS FOR, decided once for every program: a site is a page rule, a terminal place a
 * terminal one. Exhaustive over the place kinds, so a new kind is a compile error here, never a rule of a guessed surface.
 */
export const signInRuleSurfaceOf = (place: Pick<Place, 'kind'>): SignInRuleSurface => {
  switch (place.kind) {
    case 'site':
      return 'page';
    case 'terminal':
      return 'terminal';
  }
};

/**
 * Whether match keys are ones a rule of this surface may fill at: a page rule only at web hosts (never a `tool@host`),
 * a terminal rule at EXACTLY ONE `sudo@host`, `su@host` or `doas@host`. The one check behind the body and eligibility.
 */
export const signInRuleKeysFit = (surface: SignInRuleSurface, keys: readonly string[]): boolean =>
  surface === 'terminal'
    ? keys.length === 1 && taskPlanKeysFitLine('terminal-sign-in', keys)
    : taskPlanKeysFitLine('sign-in', keys);

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
 * - `placeKeys`: the sign-in's login domains (web hosts only), or a terminal rule's one `sudo@host`, `su@host` or
 *   `doas@host`.
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
  readonly surface: SignInRuleSurface;
  readonly fields: readonly SignInField[];
  readonly pins: Pick<SignInRulePins, 'placeKeys' | 'identities' | 'factor'>;
  readonly createdAt: string;
  readonly expiresAt: string;
}

/**
 * What a rule body may not be: the one check behind the schema, the canonical bytes and the tests. Clock-free: it reads
 * the body alone. Whether the body is from the future is {@link signInRuleClockProblems}, which takes the clock.
 */
export const signInRuleBodyProblems = (body: SignInRuleBodyFacts): readonly string[] => {
  const lifetime = (Date.parse(body.expiresAt) - Date.parse(body.createdAt)) / 1_000;
  const totp = body.fields.includes('totp');
  const terminal = body.surface === 'terminal';
  const { maxSeconds, maxDays } = signInRuleLifetime(body.surface);
  return [
    ...(unique(body.fields) ? [] : ['a rule names each field once']),
    ...(totp === (body.pins.factor !== undefined) ? [] : ['a rule types a code exactly when it pins the 2FA key']),
    ...(totp && !body.fields.includes('password') ? ['a rule types a code only after its own password'] : []),
    // A page rule's `tool@host` key would put the password into a terminal; a terminal rule is one sudo, su or doas.
    ...(signInRuleKeysFit(body.surface, body.pins.placeKeys)
      ? []
      : [terminal ? 'a terminal rule is pinned to one sudo, su or doas' : 'a page rule is pinned to web hosts only']),
    // sudo, su and doas ask for the password alone: no username to type, and no code a rule could add.
    ...(terminal && (body.fields.length !== 1 || body.fields[0] !== 'password')
      ? ['a terminal rule types the password only']
      : []),
    ...(unique(body.pins.placeKeys) ? [] : ['a rule pins each login domain once']),
    ...(unique(body.pins.identities) ? [] : ['a rule pins each field identity once']),
    ...(Number.isFinite(lifetime) && lifetime >= SIGN_IN_RULE_MIN_SECONDS
      ? []
      : [`a rule lasts at least ${String(SIGN_IN_RULE_MIN_SECONDS / 3_600)} hour`]),
    ...(Number.isFinite(lifetime) && lifetime <= maxSeconds
      ? []
      : [`a ${terminal ? 'terminal' : 'page'} rule lasts at most ${String(maxDays)} days`]),
  ];
};

/**
 * What a rule body may not be AT `now`: created further ahead of the clock than {@link SIGN_IN_RULE_CLOCK_SKEW_SECONDS},
 * which would let it reach past 90 days from now. Pure: the caller hands in its clock. The daemon refuses such a body
 * when it stages and commits a rule, and suspends one it loads (R3c-3); the schema never reads a clock, so a stored
 * document parses the same way at any time.
 */
export const signInRuleClockProblems = (body: { readonly createdAt: string }, now: number): readonly string[] => {
  const ahead = (Date.parse(body.createdAt) - now) / 1_000;
  return Number.isFinite(ahead) && ahead <= SIGN_IN_RULE_CLOCK_SKEW_SECONDS
    ? []
    : ['a rule is never created in the future'];
};

/**
 * THE SIGNED PART of a rule. `revision` is 1 when created and one more on each resume, renew or widen (the id stays).
 * `surface` is `page` (web hosts) or `terminal` (one sudo, su or doas key, the password only). `fields` are the ones
 * Ferretry may type: `totp` only with `pins.factor`, and only beside `password`. `expiresAt` is fixed when the rule is
 * staged, between one hour and 90 days after `createdAt` (7 days for a terminal rule). `uses` is the optional cap.
 * `approvedBy` is the paired device whose passkey proved it.
 */
export const SignInRuleBodySchema = z
  .strictObject({
    v: z.literal(1),
    id: SignInRuleIdSchema,
    revision: SignInRuleRevisionSchema,
    signIn: SignInIdSchema,
    surface: SignInRuleSurfaceSchema,
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
 * first ten are also grant misses (a fill found them); `passkey-removed` follows the registry, and `store-write-failed`
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
  'program-changed',
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
  'store-write-failed': "Ferretry couldn't save the rule's state, so it suspended the rule",
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

/**
 * The daemon's flags on a rule, drawn red (`root`: a terminal rule types sudo, su or doas's password; `one-factor`: the
 * code is ticked) or amber (`auto-recipe`).
 */
export const SIGN_IN_RULE_FLAGS = ['root', 'one-factor', 'auto-recipe'] as const;
export const SignInRuleFlagSchema = z.enum(SIGN_IN_RULE_FLAGS);
export type SignInRuleFlag = z.infer<typeof SignInRuleFlagSchema>;

/** `fields` and `totp` said twice on purpose: the red warning reads the boolean, never a list or the rows' words. */
const codeTickProblems = (value: {
  readonly fields: readonly SignInField[];
  readonly totp: boolean;
}): readonly string[] => [
  ...(unique(value.fields) ? [] : ['each field is named once']),
  ...(value.totp === value.fields.includes('totp') ? [] : ['totp says exactly whether the fields hold a code']),
  ...(value.totp && !value.fields.includes('password') ? ['a code is typed only after its own password'] : []),
];

/**
 * A rule's place as it may be shown: a site, or a terminal place whose key is one sudo, su or doas (`root` said for
 * exactly those, so the red line reads the boolean, never the place's words), typing the password only.
 */
const placeProblems = (value: {
  readonly place: Place;
  readonly fields: readonly SignInField[];
  readonly root: boolean;
}): readonly string[] => {
  const terminal = value.place.kind === 'terminal';
  return [
    ...(terminal && !signInRuleKeysFit('terminal', placeKeys(value.place))
      ? ['a terminal rule is for sudo, su or doas only']
      : []),
    ...(value.root === terminal ? [] : ['a terminal rule is flagged root, and only a terminal rule']),
    ...(terminal && (value.fields.length !== 1 || value.fields[0] !== 'password')
      ? ['a terminal rule types the password only']
      : []),
  ];
};

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
    /** The label of the 2FA key this rule's code comes from, when it types the code: the daemon's, never a value. */
    codeKey: oneLine(TASK_PLAN_SUMMARY_LINE_MAX_CHARS).optional(),
    scope: SignInRuleScopeSchema,
    createdAt: InstantSchema,
    expiresAt: InstantSchema,
    uses: z.number().int().min(0).max(SIGN_IN_RULE_MAX_USES).optional(),
    remaining: z.number().int().min(0).max(SIGN_IN_RULE_MAX_USES).optional(),
    status: SignInRuleStatusSchema,
    /**
     * Its proof or its pinned facts could not be checked yet (the passkeys or the accounts could not be read): it fills
     * nothing until the daemon has checked them. Only on a rule that is not suspended.
     */
    unverified: z.literal(true).optional(),
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
      ...placeProblems({ place: view.place, fields: view.fields, root: view.flags.includes('root') }),
      ...((view.codeKey !== undefined) === view.totp
        ? []
        : ['a rule that types a code names its key, and only that one']),
      ...(unique(view.flags) ? [] : ['each flag is shown once']),
      ...(view.flags.includes('one-factor') === view.totp ? [] : ['a rule that types a code is flagged one-factor']),
      ...((view.status === 'suspended') === (view.suspended !== undefined)
        ? []
        : ['a suspended rule says why, and only a suspended one']),
      ...(view.unverified === true && view.suspended !== undefined ? ['a suspended rule is not also unverified'] : []),
      ...((view.uses === undefined) === (view.remaining === undefined) ? [] : ['uses left come with a cap only']),
      ...(view.uses !== undefined && view.remaining !== undefined && view.remaining > view.uses
        ? ['a rule never has more uses left than its cap']
        : []),
    ];
    for (const message of problems) context.addIssue({ code: 'custom', message });
  });
export type SignInRuleView = z.infer<typeof SignInRuleViewSchema>;

const STATUS_WORDS = {
  active: 'Active',
  suspended: 'Suspended',
  'used-up': 'All uses spent',
  expired: 'Expired',
} as const satisfies Record<SignInRuleStatus, string>;

/** The owner's words for a rule's status, on every surface that lists rules: a suspended one says why. */
export function signInRuleStatusWords(rule: Pick<SignInRuleView, 'status' | 'suspended' | 'unverified'>): string {
  if (rule.status === 'suspended' && rule.suspended !== undefined)
    return `Suspended: ${signInRuleSuspensionWords(rule.suspended.because)}`;
  if (rule.status === 'active' && rule.unverified === true) return 'Active once Ferretry has checked it';
  return STATUS_WORDS[rule.status];
}

/** Whether a suspended rule can be resumed with a new passkey: not when its sign-in is gone. */
export const signInRuleResumable = (rule: Pick<SignInRuleView, 'status' | 'suspended'>): boolean =>
  rule.status === 'suspended' && rule.suspended?.because !== 'sign-in-gone';

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

/** The labels a rule's rows carry: the facts the passkey binds, one row each (two notes at most). */
export const SignInRuleRowLabelSchema = z.enum([
  'Machine',
  'Site',
  'Account',
  'Types',
  'Who',
  'Until',
  'Uses',
  'Code key',
  'Note',
]);
export type SignInRuleRowLabel = z.infer<typeof SignInRuleRowLabelSchema>;

/** One fact of a rule as the owner reads it: a label and one line. */
export const SignInRuleRowSchema = z.strictObject({
  label: SignInRuleRowLabelSchema,
  value: oneLine(TASK_PLAN_SUMMARY_LINE_MAX_CHARS),
});
export type SignInRuleRow = z.infer<typeof SignInRuleRowSchema>;

const ROW_ONCE: readonly SignInRuleRowLabel[] = ['Types', 'Who', 'Until', 'Uses'];
const ROW_NOTES_MAX = 2;

/** What a staged rule's rows may not be: each fact once, the machine or the site its place says, notes at most two. */
const rowProblems = (staged: {
  readonly rows: readonly SignInRuleRow[];
  readonly place: Place;
  readonly fields: readonly SignInField[];
}): readonly string[] => {
  const count = (label: SignInRuleRowLabel): number => staged.rows.filter(row => row.label === label).length;
  const placeLabel = staged.place.kind === 'terminal' ? 'Machine' : 'Site';
  const otherLabel = staged.place.kind === 'terminal' ? 'Site' : 'Machine';
  return [
    ...ROW_ONCE.filter(label => count(label) !== 1).map(label => `the rows name ${label} exactly once`),
    ...(count(placeLabel) === 1 && count(otherLabel) === 0
      ? []
      : [`the rows name ${placeLabel} once, and not ${otherLabel}`]),
    ...(count('Account') === (staged.place.kind === 'site' ? 1 : 0)
      ? []
      : ['the rows name the account exactly once for a page rule, and never for a terminal one']),
    ...(count('Code key') === (staged.fields.includes('totp') ? 1 : 0)
      ? []
      : ['the code key is named exactly once for a rule that types the code, and never otherwise']),
    ...(count('Note') <= ROW_NOTES_MAX ? [] : [`at most ${String(ROW_NOTES_MAX)} notes`]),
  ];
};

/** What a staged rule may not be: its code flags agree, `root` says exactly whether it is a terminal rule, rows add up. */
const stagedProblems = (staged: {
  readonly fields: readonly SignInField[];
  readonly totp: boolean;
  readonly root: boolean;
  readonly place: Place;
  readonly rows: readonly SignInRuleRow[];
}): readonly string[] => [...codeTickProblems(staged), ...placeProblems(staged), ...rowProblems(staged)];

/** "username, password and 2FA code": the fields a rule types, in words. */
export const signInRuleFieldWords = (fields: readonly SignInField[]): string => {
  const named = fields.map(field => (field === 'totp' ? '2FA code' : field));
  return named.length <= 1 ? (named[0] ?? '') : `${named.slice(0, -1).join(', ')} and ${named.at(-1) ?? ''}`;
};

const rowLine = (text: string): string => {
  const flat = text
    .replaceAll(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replaceAll(/\s+/gu, ' ')
    .trim();
  return flat.length <= TASK_PLAN_SUMMARY_LINE_MAX_CHARS
    ? flat
    : `${flat.slice(0, TASK_PLAN_SUMMARY_LINE_MAX_CHARS - 1)}…`;
};

/**
 * THE "WHO" OF A RULE, one wording on every surface (the rows' Who line, the app's cards and the CLI): any ferret on the
 * machine, the ferrets of one board project, or one session. The ids are the ones the rule pins.
 */
export const signInRuleScopeWords = (scope: SignInRuleScope): string =>
  scope.kind === 'any'
    ? 'Any ferret on this machine'
    : scope.kind === 'project'
      ? `Ferrets in board project ${scope.project}`
      : `Session ${scope.session}`;

/** The facts {@link signInRuleWords} turns into words: all resolved by the daemon, none a value. */
export interface SignInRuleWordsFacts {
  readonly fields: readonly SignInField[];
  readonly account: AccountRef;
  readonly username?: string | undefined;
  readonly place: Place;
  readonly scope: SignInRuleScope;
  readonly expiresAt: string;
  readonly uses?: number | undefined;
  /**
   * The label of the pinned 2FA key, when the rule types the code. A code rule ALWAYS has a Code key row: without a
   * label it says {@link SIGN_IN_RULE_CODE_KEY_UNNAMED}, never nothing (a field list is not a type the checker can
   * discriminate on, so the row is the one owner of this rule).
   */
  readonly codeKey?: string | undefined;
  readonly revision: number;
  /** Why the rule this approves again is suspended, when it is: a resume says what it resumes. */
  readonly suspended?: SignInRuleSuspension | undefined;
}

/** The Code key row of a rule that types the code when no key label was given: said, never dropped. */
export const SIGN_IN_RULE_CODE_KEY_UNNAMED = 'A 2FA key not named here';

/**
 * THE WORDS OF A STANDING RULE, ONE SHAPE EVERYWHERE (the create sheet, the machine view, Settings, the passkey dialog
 * and `fy rules add`): ONE plain line of what it does and the facts the passkey binds as label/value rows, in this
 * order: Machine or Site, Account (a page rule: its label and username), Types, Who, Until, Uses, Code key (only when the rule types the code), then up to two notes.
 * Warnings are NOT in these words: they come from the staged rule's structured flags. Every string is one line, clipped,
 * with no control character, and none is a value. The one builder, so the daemon states what the passkey binds and
 * every app shows exactly that.
 */
export function signInRuleWords(facts: SignInRuleWordsFacts): {
  readonly does: string;
  readonly rows: SignInRuleRow[];
} {
  const { place, scope } = facts;
  const who = signInRuleScopeWords(scope);
  const forWhom =
    scope.kind === 'any'
      ? 'any ferret'
      : scope.kind === 'project'
        ? `ferrets in board project ${scope.project}`
        : "one session's ferrets";
  const hosts = place.kind === 'site' ? (place.domains.length > 0 ? place.domains : place.match) : [];
  const [firstHost = ''] = hosts;
  const does =
    place.kind === 'terminal'
      ? `Ferretry types ${facts.username === undefined ? 'your' : `${facts.username}'s`} ${place.tool} password for ${forWhom} on ${place.host}, without asking.`
      : `Ferretry signs in to ${firstHost} as ${facts.account.label} for ${forWhom}, without asking.`;
  const rows: SignInRuleRow[] = [
    place.kind === 'terminal'
      ? { label: 'Machine', value: rowLine(place.host) }
      : { label: 'Site', value: rowLine(hosts.join(', ')) },
    ...(place.kind === 'site'
      ? [
          {
            label: 'Account' as const,
            value: rowLine(`${facts.account.label}${facts.username === undefined ? '' : ` · ${facts.username}`}`),
          },
        ]
      : []),
    {
      label: 'Types',
      value: rowLine(place.kind === 'terminal' ? `the ${place.tool} password` : signInRuleFieldWords(facts.fields)),
    },
    { label: 'Who', value: rowLine(who) },
    { label: 'Until', value: `${facts.expiresAt.slice(0, 16).replace('T', ' ')} UTC` },
    { label: 'Uses', value: facts.uses === undefined ? 'No limit' : `At most ${String(facts.uses)} times` },
    ...(facts.fields.includes('totp')
      ? [{ label: 'Code key' as const, value: rowLine(facts.codeKey ?? SIGN_IN_RULE_CODE_KEY_UNNAMED) }]
      : []),
    ...(facts.revision > 1
      ? [{ label: 'Note' as const, value: `Replaces this sign-in’s rule (revision ${String(facts.revision)})` }]
      : []),
    ...(facts.suspended === undefined
      ? []
      : [{ label: 'Note' as const, value: rowLine(`Suspended: ${signInRuleSuspensionWords(facts.suspended)}`) }]),
  ];
  return { does: rowLine(does), rows };
}

/**
 * A RULE WAITING FOR ITS PASSKEY: the stage the `approve-sign-in-rule` proof is bound to, the rule it makes, and the
 * daemon's own words for it (`does` and `rows`, {@link signInRuleWords}), which the passkey dialog shows. Every red
 * and amber warning comes from the STRUCTURED fields (`root`: sudo, su or doas; `totp`: one factor; `autoRecipe`),
 * never from those words, which may be clipped (secrev-1268 N1); so does WHICH sign-in it is for (`account`, `place`:
 * secrev-1271 L3), since a clip cuts the host first.
 * `machine` is set when it was staged at the machine (`fy rules add`) and waits in the app. Never a value.
 */
export const SignInRuleStagedSchema = z
  .strictObject({
    stage: SignInRuleStageIdSchema,
    rule: SignInRuleIdSchema,
    revision: SignInRuleRevisionSchema,
    signIn: SignInIdSchema,
    /** The account and the place the rule is for, as fields: the dialog draws them from here, never from `rows`. */
    account: AccountRefSchema,
    place: PlaceSchema,
    /** What the passkey does, in one plain line: the daemon's {@link signInRuleWords}, shown as it is. */
    does: oneLine(TASK_PLAN_SUMMARY_LINE_MAX_CHARS),
    /** The facts it binds, label by label: the same words, shown as they are (the dialog's approved rows). */
    rows: z.array(SignInRuleRowSchema).min(5).max(9),
    fields: z.array(SignInFieldSchema).min(1).max(3),
    totp: z.boolean(),
    /** A terminal rule: Ferretry would type sudo, su or doas's password for any ferret it covers, which is root. Red. */
    root: z.boolean(),
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

// ── The small answers (one schema each, for the daemon, the app and the CLI) ────────────────────────

/** `DELETE /v1/sign-in-rules/stages/:stage`: the waiting stage was dropped. */
export const SignInRuleStageDroppedSchema = z.strictObject({
  stage: SignInRuleStageIdSchema,
  dropped: z.literal(true),
});
export type SignInRuleStageDropped = z.infer<typeof SignInRuleStageDroppedSchema>;
/** `DELETE /v1/sign-in-rules/:id`: the rule was revoked. */
export const SignInRuleRevokedSchema = z.strictObject({ id: SignInRuleIdSchema, revoked: z.literal(true) });
export type SignInRuleRevoked = z.infer<typeof SignInRuleRevokedSchema>;
/** `POST /v1/accounts/:id/sign-in-rules/revoke`: how many of the account's rules were revoked (zero or more). */
export const SignInRuleAccountRevokedSchema = z.strictObject({
  account: AccountIdSchema,
  revoked: z.number().int().min(0).max(SIGN_IN_RULE_MAX),
});
export type SignInRuleAccountRevoked = z.infer<typeof SignInRuleAccountRevokedSchema>;
/** `DELETE /v1/sign-in-rules/suggestions/:sid`: whether a waiting suggestion was there to dismiss. */
export const SignInRuleSuggestionDismissedSchema = z.strictObject({
  id: SignInRuleSuggestionIdSchema,
  dismissed: z.boolean(),
});
export type SignInRuleSuggestionDismissed = z.infer<typeof SignInRuleSuggestionDismissedSchema>;

// ── The link that opens a waiting rule (`fy rules add`) ──────────────────────────────────────────────

const RULE_LINK_MACHINE_PARAMETER = 'machine';

/**
 * THE FRAGMENT THAT OPENS ONE WAITING RULE in the app: `#rules/<stage>`, and `?machine=<daemon id>` when the printer
 * knows which machine holds it. It carries no secret and never reaches the daemon: it only picks which row to show.
 */
export const ruleDeepLinkFragment = (stage: SignInRuleStageId, machine?: DaemonId): string =>
  `#rules/${encodeURIComponent(stage)}${machine === undefined ? '' : `?${RULE_LINK_MACHINE_PARAMETER}=${encodeURIComponent(machine)}`}`;

/** The whole link on an app address (trailing slashes dropped): what `fy rules add` prints and opens. */
export const ruleDeepLink = (origin: string, stage: SignInRuleStageId, machine?: DaemonId): string =>
  `${origin.replace(/\/+$/u, '')}/${ruleDeepLinkFragment(stage, machine)}`;

/**
 * The stage (and machine) a `#rules/<stage>` fragment names, the one reader of {@link ruleDeepLinkFragment}: `null` for
 * any other fragment, a stage id that is not one, or a machine that is not a daemon id.
 */
export const ruleDeepLinkFromFragment = (
  fragment: string,
): { readonly stage: SignInRuleStageId; readonly machine?: DaemonId } | null => {
  const match = /^#?rules\/([^/?]+)(?:\?(.*))?$/u.exec(fragment);
  if (match === null) return null;
  let raw: string;
  try {
    raw = decodeURIComponent(match[1] ?? '');
  } catch {
    return null;
  }
  const stage = SignInRuleStageIdSchema.safeParse(raw);
  if (!stage.success) return null;
  const named = new URLSearchParams(match[2] ?? '').get(RULE_LINK_MACHINE_PARAMETER);
  if (named === null) return { stage: stage.data };
  const machine = DaemonIdSchema.safeParse(named);
  return machine.success ? { stage: stage.data, machine: machine.data } : null;
};

/** The longest reason of a ferret's suggestion the owner's sheet shows (redacted, one line). */
export const SIGN_IN_RULE_SUGGESTION_WHY_MAX_CHARS = 300;

/**
 * ONE FERRET'S SUGGESTION of a standing rule, as the owner's sheet reads it: the HOST the daemon drew from the
 * sign-in's own place (never a label or a username), the card it rides, and the ferret's reason, redacted and quoted.
 * It holds no stage, no proof and no field that could become a rule by itself.
 */
export const SignInRuleSuggestionViewSchema = z.strictObject({
  id: SignInRuleSuggestionIdSchema,
  signIn: SignInIdSchema,
  surface: z.enum(['page', 'terminal']),
  host: z.string().min(1).max(200),
  /** The ferret's own words, redacted by the vault redactor: faint, quoted, never the card's text. */
  why: z.string().max(SIGN_IN_RULE_SUGGESTION_WHY_MAX_CHARS),
  agenda: z.string().regex(/^A[1-9][0-9]*$/u),
  raisedAt: InstantSchema,
  expiresAt: InstantSchema,
});
export type SignInRuleSuggestionView = z.infer<typeof SignInRuleSuggestionViewSchema>;

/** `GET /v1/sign-in-rules/suggestions`: the suggestions still waiting on the owner. */
export const SignInRuleSuggestionListSchema = z.strictObject({
  suggestions: z.array(SignInRuleSuggestionViewSchema).max(100),
});
export type SignInRuleSuggestionList = z.infer<typeof SignInRuleSuggestionListSchema>;

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
    if (at < now + SIGN_IN_RULE_MIN_SECONDS * 1_000)
      return { ok: false, reason: `a rule lasts at least ${String(SIGN_IN_RULE_MIN_SECONDS / 3_600)} hour` };
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
  /** The owner has not signed in to it from the app twice yet: "Sign in yourself twice from the app first". */
  noHistory: 'no_history',
  /** A provider sign-in ("ClickUp via Google"): there is no password of its own to fill. */
  viaProvider: 'via_provider',
  /** Not a password sign-in. */
  notPassword: 'not_password',
  /** A terminal sign-in for another program than sudo, su or doas (ssh, npm…): no standing rule ever covers it. */
  toolNotCovered: 'tool_not_covered',
  /** sudo, su or doas, on a machine that does not offer terminal rules ({@link terminalRulesOffered}). */
  terminalOff: 'terminal_off',
  /** The code was ticked, but the account has no 2FA key Ferretry makes codes for. */
  noCodeKey: 'no_code_key',
  /**
   * The sign-in already has a standing rule (active, suspended, expired or scoped elsewhere), and the approval did not
   * name it: approve it again as that rule's renewal, resume or change (`replaces`), never as a second rule.
   */
  ruleExists: 'rule_exists',
  /**
   * The approval named a rule (`replaces`) that is not, or is no longer, the sign-in's standing rule as it was when the
   * approval was staged: look at the rule again.
   */
  notThisRule: 'not_this_rule',
  /** This machine's clock moved back between the stage and the commit: nothing was approved; stage it again. */
  clockMovedBack: 'clock_moved_back',
  /** The sign-in, its account or a pinned fact changed between the stage and the commit: nothing was approved. */
  conflict: 'conflict',
  /** The passkey assertion did not verify against the staged bytes: nothing was approved. */
  proofInvalid: 'proof_invalid',
} as const;

/**
 * THE SENTENCE FOR EACH REFUSAL THAT IS NOT AN INELIGIBILITY, one owner for the daemon's message and the app's and the
 * CLI's words: each says what happened and the next step, so no two refusals read alike ({@link
 * SIGN_IN_RULE_INELIGIBLE_WORDS} owns the rest).
 */
export const SIGN_IN_RULE_REFUSAL_WORDS = {
  stage_not_found: 'That approval timed out or was already answered. Start it again.',
  no_code_key: 'This account has no 2FA key Ferretry makes codes for, so the code can’t be ticked.',
  rule_exists:
    'This sign-in already has a standing rule, so nothing was approved. Renew, resume or change that rule instead.',
  not_this_rule:
    'This sign-in’s standing rule changed while you were approving it, so nothing was approved. Look at it again.',
  clock_moved_back: 'This machine’s clock moved back, so nothing was approved. Start again.',
  conflict: 'The sign-in changed while you were approving it, so nothing was approved. Start again.',
  proof_invalid: 'The passkey did not match this rule, so nothing was approved.',
} as const satisfies Partial<Record<(typeof SIGN_IN_RULE_ERROR_CODES)[keyof typeof SIGN_IN_RULE_ERROR_CODES], string>>;

// ── Eligibility ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Why a sign-in cannot have a standing rule yet: the owner has no tapped history with it, it is a provider sign-in or
 * not a password one, it is a terminal sign-in for a program other than sudo, su or doas, it is sudo, su or doas on a
 * machine that does not offer terminal rules, or no paired device holds a passkey.
 */
export const SIGN_IN_RULE_INELIGIBLE = [
  'no-history',
  'via-provider',
  'not-password',
  'tool-not-covered',
  'terminal-off',
  'no-passkey',
] as const;
export const SignInRuleIneligibleSchema = z.enum(SIGN_IN_RULE_INELIGIBLE);
export type SignInRuleIneligible = z.infer<typeof SignInRuleIneligibleSchema>;

/** Each refusal's code, as the stage answers it (`409`). */
export const SIGN_IN_RULE_INELIGIBLE_CODES = {
  'no-history': SIGN_IN_RULE_ERROR_CODES.noHistory,
  'via-provider': SIGN_IN_RULE_ERROR_CODES.viaProvider,
  'not-password': SIGN_IN_RULE_ERROR_CODES.notPassword,
  'tool-not-covered': SIGN_IN_RULE_ERROR_CODES.toolNotCovered,
  'terminal-off': SIGN_IN_RULE_ERROR_CODES.terminalOff,
  'no-passkey': SIGN_IN_RULE_ERROR_CODES.passkeyRequired,
} as const satisfies Record<SignInRuleIneligible, string>;

/** The owner's sentence for each. */
export const SIGN_IN_RULE_INELIGIBLE_WORDS = {
  'no-history': `Sign in yourself ${timesWords(SIGN_IN_RULE_HISTORY_TAPS)} from the app first`,
  'via-provider': "This sign-in goes through another account, so it can't be pre-approved",
  'not-password': 'Only a password sign-in can be pre-approved',
  'tool-not-covered': 'A standing rule covers a page sign-in, or sudo, su or doas in a terminal; not this program',
  'terminal-off': 'This machine does not offer standing rules for sudo, su or doas',
  'no-passkey': 'Add a passkey in Settings › Security first',
} as const satisfies Record<SignInRuleIneligible, string>;

/**
 * `GET /v1/sign-in-rules/eligibility?signIn=`: whether the owner could make a standing rule for a sign-in now, and why
 * not. `rule` is the sign-in's rule, when it has one (a new approval replaces it). The owner's alone (it names nothing,
 * but it says whether the owner's taps qualify a sign-in, which no ferret may learn).
 */
export const SignInRuleEligibilitySchema = z.discriminatedUnion('eligible', [
  z.strictObject({
    signIn: SignInIdSchema,
    eligible: z.literal(true),
    rule: SignInRuleIdSchema.optional(),
    /** How many of the owner's own hand sign-ins qualify this one (the most for any of its places): the owner's to read. */
    history: z.number().int().min(0).max(SIGN_IN_RULE_HISTORY_MAX).optional(),
  }),
  z.strictObject({
    signIn: SignInIdSchema,
    eligible: z.literal(false),
    because: SignInRuleIneligibleSchema,
    rule: SignInRuleIdSchema.optional(),
  }),
]);
export type SignInRuleEligibility = z.infer<typeof SignInRuleEligibilitySchema>;
