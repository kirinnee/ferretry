import { NonNegativeIntegerSchema } from '@ferretry/std';
import { z } from 'zod';
import {
  oneLine,
  type GrantMissReason,
  SignInIdSchema,
  SignInRuleIdSchema,
  TwoFactorIdSchema,
  LOGIN_USERNAME_MAX_LENGTH,
  LoginEntryIdSchema,
  type LoginEntryId,
  LOGIN_LABEL_MAX_LENGTH,
  LOGIN_MATCH_MAX,
  LoginMatchSchema,
  type LoginFieldRole,
  type LoginEntryRef,
  InputSavedSchema,
  CopyNameSchema,
  type CopyName,
  CopyOriginSchema,
  TWO_FACTOR_LABEL_MAX_LENGTH,
  MAX_LOGIN_ENTRIES,
  type SignInChoiceReason,
  LoginFieldRoleSchema,
  LoginMethodSchema,
  type LoginMatch,
  SIGN_IN_PROJECT_MAX_LENGTH,
  SecretNameSchema,
} from '../../../contract/index.ts';

/** The declarations an input card carries live in the contract (`contract/inputs-wire.ts`); re-exported here for the daemon. */
export {
  oneLine,
  type GrantMissReason,
  LOGIN_USERNAME_MAX_LENGTH,
  type LoginEntryId,
  LOGIN_MATCH_MAX,
  LOGIN_PASSWORD_MIN_LENGTH,
  LoginMatchSchema,
  type LoginFieldRole,
  type InputCodeKey,
  type InputSavedOffer,
  type LoginEntryRef,
  type InputSignIn,
  InputSavedSchema,
  type InputSaved,
  type CopyName,
  CopyOriginSchema,
  type CopyOrigin,
} from '../../../contract/index.ts';

/**
 * THE NEIGHBOURS' WIRE THE INPUT SERVICE READS (copied, not owned). Today's input requests read the saved logins,
 * sign-ins, secure copies and task-plan lines of other subsystems straight out of `@ferretry/protocol`. In 5.0 those
 * belong to Accounts (`account-ids`, `accounts`, `login-entries`, `login-recipes`, `secure-copy`, `sign-in-rules`,
 * `two-factor`), Board (`task-plan`, `board`), Browsers (`browser-target`), Access (`push`) and Connections
 * (`mcp-oauth`), and a core contract may import no plugin's. Only the declarations the input service, its card and its
 * tests use are copied here, byte for byte from rebuild-ref (bb89d054d); each section names its source file.
 *
 * It goes away when Accounts offers the input service its saved logins through a Vault-offered hook (`input.saved`,
 * proposed): the Accounts port owns every one of these shapes.
 */

/** Whether the secret store can be read (today's `secrets.ts`; only the input service's saved-login listing reads it). */
const SecretStoreHealthSchema = z.enum(['ready', 'damaged']);

/** An ISO-8601 instant with an explicit timezone (today's `common.ts`, kept as written). */
const InstantSchema = z.iso.datetime({ offset: true });

// ─── from mcp-oauth.ts ───

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

/**
 * SHA-256 (FIPS 180-4) as lowercase hex, synchronously, with no dependency. Synchronous because the fleet
 * materialiser that names a secret is pure and synchronous, and it must agree with the daemon to the bit.
 */
function sha256Hex(text: string): string {
  const data = new TextEncoder().encode(text);
  const length = Math.ceil((data.length + 9) / 64) * 64;
  const padded = new Uint8Array(length);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(length - 8, Math.floor((data.length * 8) / 0x100000000));
  view.setUint32(length - 4, (data.length * 8) >>> 0);
  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const rotr = (value: number, bits: number): number => (value >>> bits) | (value << (32 - bits));
  for (let offset = 0; offset < length; offset += 64) {
    for (let index = 0; index < 16; index += 1) w[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const a = w[index - 15] as number;
      const b = w[index - 2] as number;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[index] = ((w[index - 16] as number) + s0 + (w[index - 7] as number) + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash as unknown as number[];
    for (let index = 0; index < 64; index += 1) {
      const t1 =
        ((h as number) +
          (rotr(e as number, 6) ^ rotr(e as number, 11) ^ rotr(e as number, 25)) +
          (((e as number) & (f as number)) ^ (~(e as number) & (g as number))) +
          (K[index] as number) +
          (w[index] as number)) >>>
        0;
      const t2 =
        ((rotr(a as number, 2) ^ rotr(a as number, 13) ^ rotr(a as number, 22)) +
          (((a as number) & (b as number)) ^ ((a as number) & (c as number)) ^ ((b as number) & (c as number)))) >>>
        0;
      h = g;
      g = f;
      f = e;
      e = ((d as number) + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, h] as number[];
    for (let index = 0; index < 8; index += 1) hash[index] = ((hash[index] as number) + (next[index] as number)) >>> 0;
  }
  return [...hash].map(word => word.toString(16).padStart(8, '0')).join('');
}

// ─── from sign-in-rules.ts ───

// ─── from login-entries.ts ───

// ─── from sign-in-rules.ts ───

/**
 * Which sessions a rule fills for: `any` ferret on this machine (the default, !A193), the sessions stamped with one
 * board `project` (never a folder-resolved or Unfiled project, so the id is a registered project's uuid), or exactly
 * one `session` (not its children). A kind this build does not know is refused, never read as `any`.
 */
const SignInRuleScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('any') }),
  z.strictObject({ kind: z.literal('project'), project: z.uuid() }),
  z.strictObject({ kind: z.literal('session'), session: oneLine(128) }),
]);

export type SignInRuleScope = z.infer<typeof SignInRuleScopeSchema>;

/**
 * WHY A RULE WAS SUSPENDED. Sticky: changing the pinned fact back does not resume it; only a new passkey does. The
 * first ten are also grant misses (a fill found them); `passkey-removed` follows the registry, and `store-write-failed`
 * keeps a rule suspended in memory when its file could not be written.
 */
const SIGN_IN_RULE_SUSPENSIONS = [
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

const SignInRuleSuspensionSchema = z.enum(SIGN_IN_RULE_SUSPENSIONS);

export type SignInRuleSuspension = z.infer<typeof SignInRuleSuspensionSchema>;

// ─── from task-plan.ts ───

// ─── from sign-in-rules.ts ───

/** The suspension a fill's miss causes, or `undefined` for a miss that leaves the rule as it was. */
export const signInRuleSuspensionOf = (reason: GrantMissReason): SignInRuleSuspension | undefined => {
  const parsed = SignInRuleSuspensionSchema.safeParse(reason);
  return parsed.success ? parsed.data : undefined;
};

// ─── from account-ids.ts ───

// ─── from sign-in-rules.ts ───

const SIGN_IN_RULE_FACTORS_DOMAIN = 'ferretry.sign-in-rule.factors.v1';

// ─── from account-ids.ts ───

// ─── from login-entries.ts ───

// ─── from accounts.ts ───

/** A key's label: the OWNER's words, one line. A card names a key by it, never by a ferret's text. */
const TwoFactorLabelSchema = oneLine(TWO_FACTOR_LABEL_MAX_LENGTH);

/** Who put a key there: the owner. Never a ferret. */
const TwoFactorAddedBySchema = z.enum(['owner']);

/** What every kind says, beside its kind. */
const factorShape = <Time extends z.ZodType<string>>(time: Time) => ({
  id: TwoFactorIdSchema,
  label: TwoFactorLabelSchema,
  addedAt: time,
  addedBy: TwoFactorAddedBySchema,
});

// ─── from login-entries.ts ───

/** How the code is made from the seed (RFC 6238). Not secret: an authenticator shows these. */
const TotpParametersSchema = z.strictObject({
  algorithm: z.enum(['SHA1', 'SHA256', 'SHA512']).default('SHA1'),
  digits: z.union([z.literal(6), z.literal(7), z.literal(8)]).default(6),
  period: z.number().int().min(15).max(120).default(30),
});

// ─── from accounts.ts ───

/** What a `totp` key says whether or not Ferretry holds its seed. Nothing here is secret. */
const totpShape = {
  kind: z.literal('totp'),
  /** How a code is made; present exactly when Ferretry holds the seed. */
  params: TotpParametersSchema.optional(),
  /** From the `otpauth://` label: kept for the mismatch warning and the screen. */
  issuer: oneLine(80).optional(),
  accountName: oneLine(LOGIN_USERNAME_MAX_LENGTH).optional(),
};

/**
 * Whether a code Ferretry made went through, as the daemon saw it (the page moved on, or the same prompt came back).
 * Absent: never tried since it was added. It orders the offers; it grants nothing.
 */
const verifiedShape = <Time extends z.ZodType<string>>(time: Time) => z.strictObject({ worked: z.boolean(), at: time });

const smsShape = {
  kind: z.literal('sms'),
  /** The last 2 to 4 digits only, for "Code sent to ••42". Never a whole number. */
  endsWith: z
    .string()
    .regex(/^[0-9]{2,4}$/u)
    .optional(),
};

const emailShape = {
  kind: z.literal('email'),
  /** Where the code arrives, as the owner wrote it: an address or a masked one. Plain, not secret. */
  to: oneLine(LOGIN_USERNAME_MAX_LENGTH).optional(),
};

/** The app a push goes to, when the owner said. */
const PUSH_APPS = ['okta-verify', 'microsoft-authenticator', 'google', 'duo', 'other'] as const;

const PushAppSchema = z.enum(PUSH_APPS);

const pushShape = { kind: z.literal('push'), app: PushAppSchema.optional() };

const securityKeyShape = { kind: z.literal('security-key') };

const SEED_EXACTLY_WITH_PARAMS = {
  path: ['params'],
  message: 'a 2FA key keeps its code parameters exactly when it keeps a seed',
};

const CHECKED_ONLY_WITH_SEED = {
  path: ['verified'],
  message: 'only a key whose codes Ferretry makes is checked by use',
};

/**
 * A 2FA key as the OWNER reads it: the record without its seal, and `automatic` (Ferretry holds the seed and makes
 * the codes). Never in a hint: a hint says a key's kind and label only ({@link TwoFactorKeyHintSchema}).
 */
const TwoFactorKeySummarySchema = z.discriminatedUnion('kind', [
  z
    .strictObject({
      ...factorShape(InstantSchema),
      ...totpShape,
      automatic: z.boolean(),
      verified: verifiedShape(InstantSchema).optional(),
    })
    .refine(key => key.automatic === (key.params !== undefined), SEED_EXACTLY_WITH_PARAMS)
    .refine(key => key.verified === undefined || key.automatic, CHECKED_ONLY_WITH_SEED),
  z.strictObject({ ...factorShape(InstantSchema), ...smsShape, automatic: z.literal(false) }),
  z.strictObject({ ...factorShape(InstantSchema), ...emailShape, automatic: z.literal(false) }),
  z.strictObject({ ...factorShape(InstantSchema), ...pushShape, automatic: z.literal(false) }),
  z.strictObject({ ...factorShape(InstantSchema), ...securityKeyShape, automatic: z.literal(false) }),
]);

export type TwoFactorKeySummary = z.infer<typeof TwoFactorKeySummarySchema>;

// ─── from sign-in-rules.ts ───

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

// ─── from browser-target.ts ───

// ─── from surface-names.ts ───

const SurfaceKindSchema = z.enum(['terminal', 'browser']);

export type SurfaceKind = z.infer<typeof SurfaceKindSchema>;

// ─── from account-ids.ts ───

/**
 * THE NAMES OF AN ACCOUNT AND OF A SIGN-IN (docs/input-requests.md, "Accounts and sign-ins").
 *
 * Their own file, apart from `accounts.ts`, only so `login-entries.ts` (the card's offers) and `input-request.ts`
 * (a raise's hint, a deliver's sign-in) can name a sign-in without importing the module that imports them. The ids of
 * a 2FA key and of a staged seed live here for the same reason (a raise and a deliver name a key; a step-up names a
 * stage).
 *
 * - An ACCOUNT's id is the handle people and recipes read (`GITHUB_KIRINNEE`, `[[GITHUB_KIRINNEE]]`): today's saved
 *   login handle, the same shape, and renameable. Behind it sits an immutable KEY (`L…`) that never changes, so a
 *   rename moves nothing that is sealed and nothing that points at the account.
 * - A SIGN-IN's id (`si_` and 16 hex digits) is immutable and never renamed, because it is what a plan line or a
 *   standing rule pins.
 */

/** An account's handle: a saved login's handle, unchanged. */
const AccountIdSchema = SecretNameSchema;

export type AccountId = z.infer<typeof AccountIdSchema>;

/** An account's immutable key: today's saved login key, which every sealed name starts with. Never on a card. */
const AccountKeySchema = z.string().regex(/^L[0-9A-F]{24}$/u, 'an account key is L and 24 hex digits');

export type AccountKey = z.infer<typeof AccountKeySchema>;

export type SignInId = z.infer<typeof SignInIdSchema>;

/** Whether a ferret's `secretHint` names a sign-in (`si_…`) rather than an account handle. */
export const namesSignIn = (hint: string): hint is SignInId => SignInIdSchema.safeParse(hint).success;

export type TwoFactorId = z.infer<typeof TwoFactorIdSchema>;

export type SignInRuleId = z.infer<typeof SignInRuleIdSchema>;

// ─── from secure-copy.ts ───

// ─── from task-plan.ts ───

/**
 * The terminal tools a terminal sign-in line may be for: setuid-root programs that read the password with getpass.
 * Any other program runs in an environment and with config files the ferret controls (`LD_PRELOAD`, a registry in
 * `~/.npmrc`, `ProxyCommand` in `~/.ssh/config`), so proving WHICH file runs says nothing about where the password
 * goes. A line for another tool is `unavailable` (`tool-not-covered`).
 */
export const TASK_PLAN_TERMINAL_TOOLS = ['sudo', 'su', 'doas'] as const;

/**
 * The misses that STOP a line (or SUSPEND a standing rule): every later fill under it asks. There is no resume; a new
 * plan, or a rule approved again, is a new passkey. The last five come only from a rule's own checks.
 */
export const GRANT_STOPPING_REASONS = [
  'place-changed',
  'recipe-changed',
  'form-changed',
  'did-not-move-on',
  'account-changed',
  'factor-changed',
  'proof-invalid',
  'scripted-origin',
  'program-changed',
] as const satisfies readonly GrantMissReason[];

/** Whether a miss leaves a standing rule suspended: a stopping reason, one already suspended, or the sign-in gone. */
export const ruleMissSuspends = (reason: GrantMissReason): boolean =>
  reason === 'suspended' ||
  reason === 'sign-in-gone' ||
  (GRANT_STOPPING_REASONS as readonly GrantMissReason[]).includes(reason);

/**
 * THE OWNER'S LINE for a card a pre-approval filled, by its source, with the place when it is known (`github.com`,
 * `sudo@kirin-box`): one sentence for a plan fill's agenda history and for the owner's input card (C9). A rule fill's
 * agenda card closes in the words a tap fill closes with, because every ferret can read every agenda (C26): this line
 * is drawn on the owner's input card only.
 */
export function grantFilledLineFor(note: { readonly by: 'plan'; readonly line: number }, place?: string): string {
  const at = place === undefined || place === '' ? '' : ` on ${place}`;
  return `Filled under your task plan (line ${String(note.line + 1)})${at}.`;
}

/** What the FERRET is told when a plan did not fill a card: the same sentence for every reason. */
export const TASK_PLAN_MISS_AGENT_NOTE = "Your task plan didn't cover this, so the owner was asked.";

// ─── from login-entries.ts ───

// ─── from task-plan.ts ───

/** A field a sign-in line fills: the account's username, its password, or a code Ferretry makes from its 2FA key. */
const SignInFieldSchema = LoginFieldRoleSchema;

export type SignInField = z.infer<typeof SignInFieldSchema>;

// ─── from login-entries.ts ───

/**
 * WHERE THE SIGN-IN HAPPENS: a web host, exactly as a page's origin names it (`app.vercel.com`,
 * `accounts.google.com`, `localhost:8443`). Separate from `match`, which says what the entry is FOR (the site
 * the work is on). A page card's one-tap choice is an entry whose login domain is the page's host EXACTLY:
 * no wildcard, no parent domain, no look-alike.
 */
const LoginDomainSchema = z
  .string()
  .max(260)
  .regex(/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[0-9]{1,5})?$/u, 'a web host, lowercase, like app.vercel.com');

// ─── from login-recipes.ts ───

/**
 * LOGIN RECIPES: how a saved login signs in, step by step, and what the daemon has SEEN about it
 * (docs/input-requests.md, "Login recipes"). Both ride with the saved login and neither is secret.
 *
 * - A **recipe** is the owner's Markdown: "Open app.vercel.com → Continue with Google → [[GOOGLE_KIRIN]] → wait
 *   for the phone approval → done when the dashboard shows". `[[ID]]` names another saved login, whose recipe the
 *   ferret is handed too. A recipe never holds a value: a change whose text contains a saved or vault value is
 *   refused, and the schema keeps out control and hidden characters, so nothing can ride in it unseen.
 * - **Observed facts** are written ONLY by the daemon, from what it saw while typing a saved login into a real
 *   target: the field was a password field (or the terminal had echo off), nothing echoed the value after submit,
 *   the page moved on, which second factor followed. Never from an agent's words, and never from page text.
 * - A **proposal** is a ferret's suggested recipe after a sign-in. It is the ferret's words, shown as such, and it
 *   changes nothing until the owner approves it, unless the owner turned auto-apply on for that one login.
 *
 * This file depends on nothing in `login-entries.ts`, which builds the entry and the hint from it.
 */

const LOGIN_RECIPE_MAX_LENGTH = 4_000;

/**
 * Characters that draw nothing, or nothing a person can tell apart, while a model still reads them: control and
 * format characters (zero-width, bidi), every default-ignorable code point (variation selectors, which can smuggle
 * bytes inside one glyph, Hangul fillers), private-use and unassigned code points, line and paragraph separators,
 * and the blank braille pattern. A recipe or a reason holding one is refused, so what the owner reads is all there is.
 */
const UNSEEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u2800]/u;

/** Whether a text holds a character that hides from the reader (see {@link UNSEEN}); lines and tabs are allowed. */
const hidesCharacters = (text: string): boolean => UNSEEN.test(text.replaceAll(/[\n\t]/gu, ''));

/** The markers a hint fences a recipe with: a recipe may not contain them, so it cannot close its own fence. */
const RECIPE_FENCE_OPEN = '<<<recipe';

const RECIPE_FENCE_CLOSE = 'recipe>>>';

/**
 * A recipe's text: lines and tabs, CRLF read as LF, no character that hides from the owner ({@link UNSEEN}), and
 * not the hint's fence markers.
 */
const LoginRecipeSchema = z
  .string()
  .transform(text => text.replaceAll('\r\n', '\n').trim())
  .pipe(
    z
      .string()
      .min(1)
      .max(LOGIN_RECIPE_MAX_LENGTH)
      .refine(text => !hidesCharacters(text), 'a recipe is plain lines and tabs, with no control or hidden characters')
      .refine(
        text => !text.includes(RECIPE_FENCE_OPEN) && !text.includes(RECIPE_FENCE_CLOSE),
        `a recipe cannot contain ${RECIPE_FENCE_OPEN} or ${RECIPE_FENCE_CLOSE}`,
      ),
  );

// ─── from login-entries.ts ───

/**
 * The role a request's one field takes from an entry, by the request's sensitivity: a one-time `code` (and a `private`
 * value, which older ferrets raised for a 2FA code) takes the code the daemon makes from the entry's 2FA seed.
 */
export function fillRoleFor(sensitivity: 'secret' | 'private' | 'code' | 'plain'): LoginFieldRole {
  return sensitivity === 'secret'
    ? 'password'
    : sensitivity === 'private' || sensitivity === 'code'
      ? 'totp'
      : 'username';
}

/**
 * The handle "Save as" suggests for a target key: `sudo@kirin-box` → `SUDO_KIRIN_BOX`, `github.com` →
 * `GITHUB_COM`. Always a valid {@link LoginEntryIdSchema}; the owner can edit it.
 */
function suggestedLoginId(match: string): LoginEntryId {
  const words = match
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]+/gu, '_')
    .replaceAll(/^_+|_+$/gu, '');
  const head = /^[A-Z]/u.test(words) ? words : `LOGIN_${words}`;
  return head.slice(0, 64).replace(/_+$/u, '');
}

/** The label "Save as" suggests: `sudo on kirin-box`, or the web host itself. */
function suggestedLoginLabel(match: string): string {
  const at = match.indexOf('@');
  return (at === -1 ? match : `${match.slice(0, at)} on ${match.slice(at + 1)}`).slice(0, LOGIN_LABEL_MAX_LENGTH);
}

const PROVIDER_HOSTS: ReadonlyMap<string, string> = new Map([
  ['accounts.google.com', 'Google'],
  ['login.microsoftonline.com', 'Microsoft'],
  ['login.live.com', 'Microsoft'],
]);

const OKTA_DOMAINS = ['okta.com', 'oktapreview.com', 'okta-emea.com'] as const;

/**
 * The identity provider a sign-in host belongs to, by the name people call it ("Google"), from a FIXED list: Google's
 * and Microsoft's sign-in hosts exactly, and an organisation's own subdomain of Okta's (never the bare apex). Names a
 * new account only; it decides nothing.
 */
function providerNameOf(match: string): string | undefined {
  const host = match.toLowerCase();
  const exact = PROVIDER_HOSTS.get(host);
  if (exact !== undefined) return exact;
  return OKTA_DOMAINS.some(domain => host.endsWith(`.${domain}`)) ? 'Okta' : undefined;
}

/** A username's part a CLI name is made from: an email's local part, else the whole name. */
const handleWordOf = (username: string): string => {
  const at = username.indexOf('@');
  return at > 0 ? username.slice(0, at) : username;
};

/**
 * What "New account" is called on a card ({@link InputSavedSchema} `newAccount`): the provider's name, or the place as
 * {@link suggestedLoginLabel} says it, then ` · <username>` when the username is known ("Google · a@gmail.com"); the
 * CLI name from the same words (`GOOGLE_A`, `GITHUB_COM_KIRINNEE`). A CLI name in `taken` gets `_2`, `_3`, … so two
 * accounts on one site never share one. Always a valid {@link LoginEntryIdSchema}; the owner can edit both.
 */
export function suggestedNewAccount(
  match: string,
  username: string | undefined,
  taken: ReadonlySet<string>,
): LoginEntryRef {
  const provider = providerNameOf(match);
  const place = provider ?? suggestedLoginLabel(match);
  const who = username?.trim();
  const label = (who === undefined || who === '' ? place : `${place} · ${who}`).slice(0, LOGIN_LABEL_MAX_LENGTH).trim();
  const base = suggestedLoginId(
    who === undefined || who === '' ? (provider ?? match) : `${provider ?? match}_${handleWordOf(who)}`,
  );
  let id = base;
  for (let count = 2; taken.has(id); count += 1) {
    const suffix = `_${String(count)}`;
    id = `${base.slice(0, 64 - suffix.length).replace(/_+$/u, '')}${suffix}`;
  }
  return { id, label };
}

// ─── from login-recipes.ts ───

/** Most proposals one login holds at once: a fourth replaces the oldest. */
const LOGIN_RECIPE_PROPOSALS_MAX = 3;

/** Most places one login keeps facts for (its login domains and terminal keys). */
const LOGIN_OBSERVED_MAX = 16;

const LOGIN_PROPOSAL_WHY_MAX_LENGTH = 280;

/** One yes-or-no fact, as often as the daemon has seen it the same way in a row, and when it last did. */
const LoginObservedFlagSchema = z.strictObject({
  value: z.boolean(),
  observedAt: InstantSchema,
  count: z.number().int().min(1).max(1_000_000),
});

/**
 * The second factor the daemon saw follow the password: `code` (a one-time code card on the same login, soon
 * after), `push` (the page waited on the sign-in host, then moved on with no code typed: an approval somewhere
 * else), `none` (the page moved on at once).
 */
const LOGIN_SECOND_FACTORS = ['push', 'code', 'none'] as const;

const LoginSecondFactorSchema = z.enum(LOGIN_SECOND_FACTORS);

type LoginSecondFactor = z.infer<typeof LoginSecondFactorSchema>;

const LoginObservedSecondFactorSchema = z.strictObject({
  value: LoginSecondFactorSchema,
  observedAt: InstantSchema,
  count: z.number().int().min(1).max(1_000_000),
});

/**
 * WHAT THE DAEMON SAW, for one login at one place: a web host (`accounts.google.com`) or a terminal's key
 * (`sudo@kirin-box`). `identity` is a digest of the field as the daemon found it (origin, frame, tag, type, name,
 * id, autocomplete; or the program for a terminal): when a later delivery finds a different identity there, the
 * old facts are dropped and counting starts again, because they were about another field.
 *
 * `masked`: every secret field was a password input, or the terminal had echo off and a recognised program read
 * it. `noEchoAfterSubmit`: after the submit the daemon looked at the page text or the screen itself and the value
 * was not in it. `navigatedAway`: the page showed a new document within a few seconds of the submit.
 */
const LoginObservedSchema = z.strictObject({
  at: z
    .string()
    .max(320)
    .regex(/^(?:[a-z0-9][a-z0-9._+-]{0,63}@)?[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[0-9]{1,5})?$/u),
  surface: z.enum(['page', 'terminal']),
  identity: z.string().regex(/^[0-9a-f]{16}$/u),
  /** When this identity was first seen here. */
  since: InstantSchema,
  masked: LoginObservedFlagSchema.optional(),
  noEchoAfterSubmit: LoginObservedFlagSchema.optional(),
  navigatedAway: LoginObservedFlagSchema.optional(),
  secondFactor: LoginObservedSecondFactorSchema.optional(),
  /**
   * Whether the fill was the OWNER's own tap from a paired device that went through: on a page, a device tap that
   * moved on unsteered (`false`: one that did not, which starts the count again); on a terminal, a device tap typed
   * hidden into a proved sudo, su or doas. Plan fills, rule fills and the admin token's deliveries never write it, so
   * only this fact counts toward a standing rule's history (sign-in-rules.ts).
   */
  tapped: LoginObservedFlagSchema.optional(),
});

export type LoginObserved = z.infer<typeof LoginObservedSchema>;

/** One delivery's worth of facts, as the input service reports them; folded into {@link LoginObserved}. */
export interface LoginObservation {
  readonly at: string;
  readonly surface: 'page' | 'terminal';
  readonly identity: string;
  readonly masked?: boolean;
  readonly noEchoAfterSubmit?: boolean;
  readonly navigatedAway?: boolean;
  readonly secondFactor?: LoginSecondFactor;
  /** The owner's own device tap went through (written for `by: 'device'` only). */
  readonly tapped?: boolean;
}

/** A proposal's handle. */
const LoginRecipeProposalIdSchema = z.string().regex(/^rp_[0-9a-f]{16}$/u);

const loginRecipesOneLine = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine(
      text => !/[\n\t]/u.test(text) && !hidesCharacters(text),
      'must be one line with no control or hidden characters',
    );

/**
 * A FERRET'S SUGGESTED RECIPE, waiting for the owner. `recipe` is the whole new text; `base` is the recipe it was
 * proposed against (absent: there was none), so the owner sees exactly what would change. `why` is the ferret's own
 * words and is shown as such.
 */
/** Who wrote the recipe as it stands: absent is the owner (typed or approved); `ferret` is an auto-applied proposal. */
const LoginRecipeAuthorSchema = z.literal('ferret');

const LoginRecipeProposalSchema = z.strictObject({
  id: LoginRecipeProposalIdSchema,
  recipe: LoginRecipeSchema,
  base: LoginRecipeSchema.optional(),
  why: loginRecipesOneLine(LOGIN_PROPOSAL_WHY_MAX_LENGTH),
  sessionId: z.string().min(1).max(128),
  agendaItemId: z.string().min(1).max(32).optional(),
  proposedAt: InstantSchema,
});

// ─── from secure-copy.ts ───

export const COPY_MAX_LIFETIME_SECONDS = 14_400;

/** How long a copy stays masked after it is discarded or lapses: it may still be on a screen it was pasted to. */
export const COPY_AFTER_MASK_SECONDS = 600;

/** The prefix a handle is written with. */
const COPY_HANDLE_PREFIX = 'sealed:';

/** The handle an agent is told to write for a copy. */
export const copyHandle = (name: CopyName): string => `${COPY_HANDLE_PREFIX}${name}`;

/**
 * Whether the agent may ALREADY have seen the value before it was sealed, said honestly:
 * - `transcript`: the daemon looked for the value in the session's own transcript when it captured it.
 *   `found` means it is in the agent's context and is NOT protected; `clean` means it was not in the part of
 *   the transcript the daemon read; `unknown` means the transcript could not be read.
 * - `pageReadBeforeCapture`: the agent read, screenshotted or evaluated this page since it last navigated.
 */
const CopyExposureSchema = z.strictObject({
  transcript: z.enum(['clean', 'found', 'unknown']),
  pageReadBeforeCapture: z.boolean().optional(),
});

/** Where a copy stands. Only `live` can be pasted. A daemon restart lets go of every copy: it is then not listed at all. */
const CopyStateSchema = z.enum(['live', 'discarded', 'expired']);

/**
 * EVERYTHING AN AGENT IS EVER TOLD ABOUT A COPY. `length` is in characters; `lines` counts line breaks plus
 * one. A command copy also says how the command ended and what it printed on stderr, masked.
 */
export const CopyMetaSchema = z.strictObject({
  handle: z.string().regex(/^sealed:[a-z][a-z0-9_-]{0,39}$/u),
  name: CopyNameSchema,
  from: CopyOriginSchema,
  length: NonNegativeIntegerSchema,
  lines: NonNegativeIntegerSchema,
  capturedAt: InstantSchema,
  expiresAt: InstantSchema,
  state: CopyStateSchema,
  exposure: CopyExposureSchema,
  /** How many times it has been pasted. */
  uses: NonNegativeIntegerSchema,
});

export type CopyMeta = z.infer<typeof CopyMetaSchema>;

// ─── from accounts.ts ───

/** Most accounts one daemon keeps (today's most saved logins). */
const MAX_ACCOUNTS = MAX_LOGIN_ENTRIES;

/** Most sign-ins one daemon keeps. */
const MAX_SIGN_INS = 512;

/** Most sign-ins one account has. */
const MAX_SIGN_INS_PER_ACCOUNT = 16;

/** A key a target is matched on: a web host exactly as an origin names it, or `program@host` for a terminal. */
const PlaceKeySchema = LoginMatchSchema;

export type PlaceKey = LoginMatch;

/** A website. A page is matched on its login domains only; `match` says what it is FOR and never matches a page. */
const SitePlaceSchema = z
  .strictObject({
    kind: z.literal('site'),
    /** Where the sign-in happens: a page whose host is one of these EXACTLY is matched (a saved login's `domains`). */
    domains: z.array(LoginDomainSchema).max(LOGIN_MATCH_MAX).readonly(),
    /** What it is for (the site the work is on), web hosts only (a saved login's web `match`). Never matches a page. */
    match: z.array(LoginDomainSchema).max(LOGIN_MATCH_MAX).readonly(),
  })
  .refine(place => place.domains.length + place.match.length > 0, 'a site sign-in names at least one host');

/** The programs whose password is a REMOTE machine's, so their key names the destination. */
const REMOTE_TOOLS = ['ssh', 'scp', 'sftp'] as const;

const isRemoteTool = (tool: string): boolean => (REMOTE_TOOLS as readonly string[]).includes(tool);

function terminalKey(place: {
  readonly tool: string;
  readonly host: string;
  readonly dest?: string | undefined;
}): string {
  return `${place.tool}@${place.dest ?? place.host}`;
}

/** A terminal tool: the program at the prompt, the machine it runs on and, for ssh, scp and sftp, where it goes. */
const TerminalPlaceSchema = z
  .strictObject({
    kind: z.literal('terminal'),
    tool: z.string().regex(/^[a-z0-9][a-z0-9._+-]{0,63}$/u, 'a program name, lowercase'),
    /** The machine's short host name (`kirin-box`): where the prompt runs. */
    host: LoginDomainSchema,
    /** ssh, scp and sftp only: the destination, because the password is the remote one. */
    dest: LoginDomainSchema.optional(),
  })
  .refine(place => place.dest === undefined || isRemoteTool(place.tool), {
    path: ['dest'],
    message: 'only ssh, scp and sftp have a destination',
  })
  // Without one, `host` would be read as the destination: this machine's password one tap away on an ssh to another
  // machine that happens to share its name.
  .refine(place => place.dest !== undefined || !isRemoteTool(place.tool), {
    path: ['dest'],
    message: 'ssh, scp and sftp name their destination',
  })
  .refine(place => LoginMatchSchema.safeParse(terminalKey(place)).success, {
    message: 'the program and host are too long to be a terminal key',
  });

const PlaceSchema = z.discriminatedUnion('kind', [SitePlaceSchema, TerminalPlaceSchema]);

export type Place = z.infer<typeof PlaceSchema>;

/**
 * The keys a target is MATCHED on, byte-identical to the daemon's target key (`targetMatchKey`): a page's host is
 * matched against a site's login domains, a terminal's `program@host` (`ssh@<destination>`) against the tool's key.
 */
export function placeKeys(place: Place): readonly PlaceKey[] {
  return place.kind === 'site' ? place.domains : [terminalKey(place)];
}

/** Every key a place NAMES: its match keys and, for a site, what it is for. What a hint lists and uniqueness is over. */
export function placeHosts(place: Place): readonly PlaceKey[] {
  return place.kind === 'site' ? [...new Set([...place.domains, ...place.match])] : placeKeys(place);
}

/** Whether a sign-in at `place` is the daemon's match for the target key `key`: EXACT, no parent, no look-alike. */
export function signInMatches(place: Place, key: string | undefined): boolean {
  return key !== undefined && placeKeys(place).includes(key);
}

/**
 * THE KINDS OF SECOND FACTOR an account can have. An account is a username, a password and a list of these. Only a
 * `totp` key can hold a value (a sealed seed), and only when the owner saved one with a passkey: every other kind is
 * a name and a few plain facts, so a card can say where the code went ("Code sent to ••42").
 */
const TWO_FACTOR_KINDS = ['totp', 'sms', 'email', 'push', 'security-key'] as const;

const TwoFactorKindSchema = z.enum(TWO_FACTOR_KINDS);

type TwoFactorKind = z.infer<typeof TwoFactorKindSchema>;

/** The kinds that end in a code someone types (or, for a `totp` key with a seed, the daemon makes). */
const CODE_FACTOR_KINDS = ['totp', 'sms', 'email'] as const satisfies readonly TwoFactorKind[];

const isCodeFactor = (kind: TwoFactorKind): boolean => (CODE_FACTOR_KINDS as readonly string[]).includes(kind);

/** Most 2FA keys one account has. */
const MAX_FACTORS_PER_ACCOUNT = 8;

const VERIFIED_RANK = (key: TwoFactorKeySummary): number =>
  key.kind !== 'totp' || key.verified === undefined ? 1 : key.verified.worked ? 0 : 2;

/**
 * The keys whose codes Ferretry makes, in the order a code card offers them: one that worked first, then one never
 * tried, then one that did not; newest first within each. The first is the key a deliver without `factor` uses.
 */
export function automaticKeysInOfferOrder(keys: readonly TwoFactorKeySummary[]): readonly TwoFactorKeySummary[] {
  return keys
    .filter(key => key.automatic)
    .toSorted(
      (a, b) =>
        VERIFIED_RANK(a) - VERIFIED_RANK(b) ||
        Date.parse(b.addedAt) - Date.parse(a.addedAt) ||
        a.id.localeCompare(b.id),
    );
}

/** An account named by another: its handle and its label, never what it holds. */
const AccountRefSchema = z.strictObject({ id: AccountIdSchema, label: oneLine(LOGIN_LABEL_MAX_LENGTH) });

/** The provider a sign-in goes via: its account and, when it has one on a site, that sign-in. */
const SignInViaSchema = z.strictObject({ account: AccountRefSchema, signIn: SignInIdSchema.optional() });

/** An account as the OWNER reads it. `fields` says which secret fields exist, never what they hold. */
const AccountSummarySchema = z.strictObject({
  id: AccountIdSchema,
  label: oneLine(LOGIN_LABEL_MAX_LENGTH),
  username: oneLine(LOGIN_USERNAME_MAX_LENGTH).optional(),
  /** OWNER VIEW ONLY: which secret fields exist. Never in a hint. */
  fields: z.strictObject({ password: z.boolean() }),
  /** The account's 2FA keys, in the owner's order: kind, label and plain facts, and whether Ferretry makes the codes. */
  factors: z.array(TwoFactorKeySummarySchema).max(MAX_FACTORS_PER_ACCOUNT).readonly(),
  signIns: z.array(SignInIdSchema).max(MAX_SIGN_INS_PER_ACCOUNT).readonly(),
  createdAt: InstantSchema,
  updatedAt: InstantSchema,
});

export type AccountSummary = z.infer<typeof AccountSummarySchema>;

/** A sign-in as the owner reads it. `method.via` is the provider account's handle. */
const SignInSummarySchema = z.strictObject({
  id: SignInIdSchema,
  account: AccountIdSchema,
  place: PlaceSchema,
  method: LoginMethodSchema,
  via: SignInViaSchema.optional(),
  recipe: LoginRecipeSchema.optional(),
  recipeVersion: z.number().int().min(1).optional(),
  recipeBy: LoginRecipeAuthorSchema.optional(),
  autoApplyRecipe: z.boolean().optional(),
  observed: z.array(LoginObservedSchema).max(LOGIN_OBSERVED_MAX).readonly().optional(),
  proposals: z.array(LoginRecipeProposalSchema).max(LOGIN_RECIPE_PROPOSALS_MAX).readonly().optional(),
  createdAt: InstantSchema,
  updatedAt: InstantSchema,
});

export type SignInSummary = z.infer<typeof SignInSummarySchema>;

/** `GET /v1/accounts`. A damaged store says so; it is never an empty list. */
export const AccountListSchema = z.strictObject({
  v: z.literal(1),
  health: SecretStoreHealthSchema,
  diagnosis: z.string().min(1).optional(),
  accounts: z.array(AccountSummarySchema).max(MAX_ACCOUNTS).readonly(),
  signIns: z.array(SignInSummarySchema).max(MAX_SIGN_INS).readonly(),
});

export type AccountList = z.infer<typeof AccountListSchema>;

const DefaultsMapSchema = z
  .record(PlaceKeySchema, AccountIdSchema)
  .refine(map => Object.keys(map).length <= MAX_ACCOUNTS, `at most ${String(MAX_ACCOUNTS)} lines`);

/** Whether a path has a `.` or `..` segment: it would name a folder other than the one it spells. */
const hasDotSegment = (path: string): boolean => path.split('/').some(segment => segment === '.' || segment === '..');

/**
 * WHICH ACCOUNT A SIGN-IN CARD OFFERS FIRST, as the owner wrote it. It orders buttons only: the owner's tap is still
 * the permission, and a line can only choose among the sign-ins the daemon matched ({@link chosenSignIn}). Each map
 * is key → account handle, the key a login domain, a site's `match` host or a `tool@host`.
 */
const AccountDefaultsFileSchema = z.strictObject({
  /** Machine-wide: the starred account per key. */
  sites: DefaultsMapSchema.optional(),
  /** Per board project, by its id or its exact name. */
  projects: z
    .record(
      z
        .string()
        .min(1)
        .max(SIGN_IN_PROJECT_MAX_LENGTH)
        .regex(/^\S(?:.*\S)?$/u),
      DefaultsMapSchema,
    )
    .optional(),
  /** For a session on the Unfiled board: by its working directory, absolute or `~/…`, the longest prefix wins. */
  folders: z
    .record(
      z
        .string()
        .min(1)
        .max(1_024)
        .regex(/^(?:~|~\/[^\p{Cc}]*|\/[^\p{Cc}]*)$/u, 'an absolute path or ~/…')
        .refine(line => !hasDotSegment(line), 'a folder path has no . or .. segment'),
      DefaultsMapSchema,
    )
    .optional(),
});

type AccountDefaultsFile = z.infer<typeof AccountDefaultsFileSchema>;

/**
 * WHAT ACCOUNTS ANSWERS to "who is asking" through `input.saved` (a {@link SignInChoiceContext} without the ferret's own
 * hint), parsed here so a provider that sent more than the order needs is refused whole, never read.
 */
export const SignInChoiceContextSchema = z.strictObject({
  project: z
    .strictObject({
      id: z.string().min(1).max(SIGN_IN_PROJECT_MAX_LENGTH),
      name: z.string().min(1).max(SIGN_IN_PROJECT_MAX_LENGTH),
      nameIsUnique: z.boolean(),
    })
    .optional(),
  folder: z.string().min(1).max(4_096).optional(),
  home: z.string().min(1).max(4_096).optional(),
  defaults: AccountDefaultsFileSchema.optional(),
});

/** What {@link chosenSignIn} needs of a sign-in. */
export interface SignInCandidate {
  readonly id: SignInId;
  /** The account's HANDLE (what a defaults line and a hint name). */
  readonly account: AccountId;
  readonly place: Place;
}

/** Who is asking, and what the owner set: the inputs {@link chosenSignIn} orders by. */
export interface SignInChoiceContext {
  /** The ferret's `secretHint`: an account handle or a `si_…`. */
  readonly hint?: string | undefined;
  /** The calling session's board project. `nameIsUnique`: no other registered project has this name. */
  readonly project?: { readonly id: string; readonly name: string; readonly nameIsUnique: boolean } | undefined;
  /** The working directory of a session on the Unfiled board (absolute, real). Ignored when `project` is given. */
  readonly folder?: string | undefined;
  /** The home directory a `~/…` folder line expands against. */
  readonly home?: string | undefined;
  readonly defaults?: AccountDefaultsFile | undefined;
}

/** The sign-in a card offers first and why. `project` is the project a "Default for ferretry" names. */
export interface SignInChoice {
  readonly signIn: SignInId;
  readonly why: SignInChoiceReason;
  readonly project?: string;
}

/** The sign-ins the daemon matched to the target key: EXACT, as {@link signInMatches}. */
export function matchedSignIns<T extends SignInCandidate>(
  key: string | undefined,
  candidates: readonly T[],
): readonly T[] {
  return candidates.filter(candidate => signInMatches(candidate.place, key));
}

const lineOf = (map: Readonly<Record<string, string>> | undefined, key: string): string | undefined =>
  map !== undefined && Object.hasOwn(map, key) ? map[key] : undefined;

/** The one candidate of several, or `undefined` when there is none or more than one: never "the first". */
const onlyOne = <T>(found: readonly T[]): T | undefined => (found.length === 1 ? found[0] : undefined);

/**
 * The matched sign-in a defaults map names: the target key's line first, then a line for a site's `match` host. Each
 * chooses only when EXACTLY ONE matched sign-in qualifies (two lines naming two matched accounts choose neither), so
 * the answer never depends on the order the caller listed the sign-ins in.
 */
function pickedBy(
  map: Readonly<Record<string, string>> | undefined,
  key: string,
  matched: readonly SignInCandidate[],
): SignInCandidate | undefined {
  if (map === undefined) return undefined;
  const account = lineOf(map, key);
  const direct =
    account === undefined ? undefined : onlyOne(matched.filter(candidate => candidate.account === account));
  if (direct !== undefined) return direct;
  return onlyOne(
    matched.filter(
      candidate =>
        candidate.place.kind === 'site' && candidate.place.match.some(host => lineOf(map, host) === candidate.account),
    ),
  );
}

/** A folder line as a path to compare: `~` expanded, no trailing slash (but the root). `undefined`: it cannot be. */
function folderPath(line: string, home: string | undefined): string | undefined {
  const expanded =
    line === '~' || line.startsWith('~/') ? (home === undefined ? undefined : home + line.slice(1)) : line;
  if (expanded === undefined || !expanded.startsWith('/') || hasDotSegment(expanded)) return undefined;
  return expanded.replaceAll(/\/{2,}/gu, '/').replace(/(?<=.)\/$/u, '');
}

/** The folders map of the longest folder line `folder` is inside, on a path-segment boundary. */
function folderMap(context: SignInChoiceContext): Readonly<Record<string, string>> | undefined {
  const folder = context.folder === undefined ? undefined : folderPath(context.folder, undefined);
  if (folder === undefined || context.defaults?.folders === undefined) return undefined;
  let best: { readonly length: number; readonly map: Readonly<Record<string, string>> } | undefined;
  for (const [line, map] of Object.entries(context.defaults.folders)) {
    const path = folderPath(line, context.home);
    if (path === undefined) continue;
    const inside = path === '/' || folder === path || folder.startsWith(`${path}/`);
    if (inside && (best === undefined || path.length > best.length)) best = { length: path.length, map };
  }
  return best?.map;
}

function lineOfProject(
  defaults: AccountDefaultsFile | undefined,
  project: string,
): Readonly<Record<string, string>> | undefined {
  const projects = defaults?.projects;
  return projects !== undefined && Object.hasOwn(projects, project) ? projects[project] : undefined;
}

/**
 * WHICH SIGN-IN A CARD OFFERS FIRST, decided ONLY among the sign-ins the daemon matched to the target key: the
 * ferret's hint, then the session's project default, then (an Unfiled session) its folder default, then the site
 * default, then the only matched sign-in. Two or more matched and nothing chosen: no primary, and the owner picks.
 *
 * Every rule can only pick from {@link matchedSignIns}: a hint, a project or a site line that names an account with
 * no sign-in matched here is ignored, never promoted, and nothing here types anything. A hint answer's `default`
 * and a card's `why` both come from this function, so they cannot disagree.
 */
export function chosenSignIn(
  key: string | undefined,
  candidates: readonly SignInCandidate[],
  context: SignInChoiceContext = {},
): SignInChoice | undefined {
  if (key === undefined) return undefined;
  const matched = matchedSignIns(key, candidates);
  if (matched.length === 0) return undefined;
  const hint = context.hint;
  const named =
    hint === undefined
      ? undefined
      : onlyOne(matched.filter(candidate => (namesSignIn(hint) ? candidate.id === hint : candidate.account === hint)));
  if (named !== undefined) return { signIn: named.id, why: 'ferret' };
  const defaults = context.defaults;
  const project = context.project;
  if (project !== undefined) {
    const byProject =
      pickedBy(lineOfProject(defaults, project.id), key, matched) ??
      (project.nameIsUnique ? pickedBy(lineOfProject(defaults, project.name), key, matched) : undefined);
    if (byProject !== undefined) return { signIn: byProject.id, why: 'project', project: project.name };
  } else {
    const byFolder = pickedBy(folderMap(context), key, matched);
    if (byFolder !== undefined) return { signIn: byFolder.id, why: 'folder' };
  }
  const bySite = pickedBy(defaults?.sites, key, matched);
  if (bySite !== undefined) return { signIn: bySite.id, why: 'site' };
  const [only] = matched;
  return matched.length === 1 && only !== undefined ? { signIn: only.id, why: 'only' } : undefined;
}

// ─── from push.ts ───

/**
 * What a push is about, as far as how fast it must reach a phone. A one-time code is waited on for minutes, not
 * hours (the owner's ask: "for 2FA notification, please make it high priority"), and so is a push the owner approves
 * on their phone (`approve-on-phone`, docs/input-requests.md "Approve on your phone"): the sign-in gives up on it in a
 * minute or two.
 */
export type PushSubject = 'one-time-code' | 'approve-on-phone' | 'other';

// ─── from two-factor.ts ───

/** A code key by its kind alone, for agenda text: no label, address or digits the owner wrote. */
const KEY_KIND_WORDS = { totp: 'authenticator app', sms: 'SMS', email: 'email' } as const;

/**
 * THE TITLE OF A CODE CARD, from the account's keys: the PLACE alone ("One-time code for github.com"), and the keys said
 * by KIND only ("One-time code for github.com, by email"). The words reach the agenda, which every ferret can read, so
 * they never name an account label, a username, a key's label or the address an email key goes to: an address is often
 * the username (secrev-1329a L6). Every word is Ferretry's, never a ferret's.
 */
export function factorAskWords(keys: readonly TwoFactorKeySummary[], named: { readonly place: string }): string {
  const kinds = [
    ...new Set(
      keys.filter(key => isCodeFactor(key.kind)).map(key => KEY_KIND_WORDS[key.kind as keyof typeof KEY_KIND_WORDS]),
    ),
  ];
  return `One-time code for ${named.place}${kinds.length === 0 ? '' : `, by ${kinds.join(' or ')}`}`;
}

// ─── from daemon/src/lib/secrets/accounts.ts ───

/** Why a change to an account or sign-in was refused: each is a different thing for the person to do. */
export type LoginRefusal =
  | 'unknown_login'
  | 'login_exists'
  | 'label_required'
  | 'no_such_field'
  | 'bad_via'
  | 'unknown_proposal'
  | 'stale_proposal'
  | 'unknown_sign_in'
  | 'place_taken'
  | 'invalid_change'
  | 'account_has_sign_ins'
  | 'account_has_2fa_keys'
  | 'no_sign_in'
  | 'merge_refused'
  | 'unknown_2fa_key'
  | 'add_2fa_key_needs_passkey';

export class LoginEntryError extends Error {
  constructor(
    readonly refusal: LoginRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'LoginEntryError';
  }
}

export interface LoginFieldValues {
  readonly username?: string;
  readonly password?: string;
}
