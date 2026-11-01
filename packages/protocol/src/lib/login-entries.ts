import { z } from 'zod';
import { SignInIdSchema, TwoFactorIdSchema } from './account-ids.ts';
import { InstantSchema } from './common.ts';
import {
  LOGIN_OBSERVED_MAX,
  LOGIN_RECIPE_PROPOSALS_MAX,
  ferretObserved,
  LoginObservedHintSchema,
  LoginObservedSchema,
  LoginRecipeAuthorSchema,
  LoginRecipeProposalSchema,
  LoginRecipeSchema,
  observedWords,
  RECIPE_FENCE_CLOSE,
  RECIPE_FENCE_OPEN,
  recipeReferences,
} from './login-recipes.ts';
import { MIN_SECRET_VALUE_LENGTH, SecretNameSchema, SecretStoreHealthSchema } from './secrets.ts';

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
export const LOGIN_USERNAME_MAX_LENGTH = 256;
export const LOGIN_MATCH_MAX = 16;
/** Most entries one daemon keeps: a list a person can read, not a database. */
export const MAX_LOGIN_ENTRIES = 256;
/**
 * The shortest password an entry keeps. A REDACTION constraint, exactly as {@link MIN_SECRET_VALUE_LENGTH}
 * is: a saved value is masked wherever the daemon scrubs text, and a very short value would mask ordinary
 * words. A shorter password can still be TYPED on a card; it just cannot be saved.
 */
export const LOGIN_PASSWORD_MIN_LENGTH = MIN_SECRET_VALUE_LENGTH;
export const LOGIN_PASSWORD_MAX_LENGTH = 1_024;

/** A one-line text field: trimmed, at most `maximum` characters, no control or format characters. */
export const oneLine = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .regex(/^[^\p{Cc}\p{Cf}]*$/u, 'must be one line with no control characters');

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

/** The fields an entry can hold, and which of them are secret. */
export const LOGIN_FIELD_ROLES = ['username', 'password', 'totp'] as const;
export const LoginFieldRoleSchema = z.enum(LOGIN_FIELD_ROLES);
export type LoginFieldRole = z.infer<typeof LoginFieldRoleSchema>;

/** How the code is made from the seed (RFC 6238). Not secret: an authenticator shows these. */
export const TotpParametersSchema = z.strictObject({
  algorithm: z.enum(['SHA1', 'SHA256', 'SHA512']).default('SHA1'),
  digits: z.union([z.literal(6), z.literal(7), z.literal(8)]).default(6),
  period: z.number().int().min(15).max(120).default(30),
});
export type TotpParameters = z.infer<typeof TotpParametersSchema>;

/**
 * THE SENTENCE the owner reads before a 2FA seed is kept, in the app, the CLI and the docs. It is the
 * reason TOTP is off by default and opted into per entry.
 */
export const LOGIN_TOTP_WARNING =
  "Keeping the password and the 2FA seed in the same place means one compromise of this machine's vault defeats both factors.";

/** The same warning, short, under every "Use code from Ferretry" button on a code card. */
export const LOGIN_ONE_FACTOR_WARNING = 'Password and code both come from this machine: together they are one factor.';

/** Most 2FA keys of one account that hold a seed: a re-enrolled second authenticator, a backup app. */
export const MAX_SEEDS_PER_ACCOUNT = 4;
/** The longest label the owner gives a 2FA key ("Okta Verify on Pixel", "Phone ••42"). */
export const TWO_FACTOR_LABEL_MAX_LENGTH = 60;

/** A base32 TOTP seed, as authenticator setup pages show it (spaces and `=` padding allowed). */
export const TotpSeedSchema = z
  .string()
  .transform(seed => seed.replaceAll(/[\s=-]/gu, '').toUpperCase())
  .pipe(z.string().regex(/^[A-Z2-7]{16,128}$/u, 'a base32 2FA seed of 16 to 128 characters'));

/**
 * WHERE THE SIGN-IN HAPPENS: a web host, exactly as a page's origin names it (`app.vercel.com`,
 * `accounts.google.com`, `localhost:8443`). Separate from `match`, which says what the entry is FOR (the site
 * the work is on). A page card's one-tap choice is an entry whose login domain is the page's host EXACTLY:
 * no wildcard, no parent domain, no look-alike.
 */
export const LoginDomainSchema = z
  .string()
  .max(260)
  .regex(/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[0-9]{1,5})?$/u, 'a web host, lowercase, like app.vercel.com');
export type LoginDomain = z.infer<typeof LoginDomainSchema>;

/** The host a person typed or pasted (`https://App.Vercel.com/login` → `app.vercel.com`), or `undefined`. */
export function normalizedLoginDomain(text: string): LoginDomain | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`).host.toLowerCase();
  } catch {
    return undefined;
  }
  return LoginDomainSchema.safeParse(host).success ? host : undefined;
}

/** The web hosts among what an entry matches: the login domains an entry kept before it had its own. */
export function webHostsOf(match: readonly string[]): readonly LoginDomain[] {
  return match.filter(target => !target.includes('@') && LoginDomainSchema.safeParse(target).success);
}

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

/** What the owner reads for each method, in the app, the CLI and the agent's hint. */
export const LOGIN_METHOD_LABELS: Readonly<Record<LoginMethodKind, string>> = {
  password: 'Password',
  google: 'Sign in with Google',
  github: 'Sign in with GitHub',
  microsoft: 'Sign in with Microsoft',
  apple: 'Sign in with Apple',
  sso: 'Other SSO',
};

/** Words that name a passkey or a hardware authenticator: never a saved login's method. */
const PASSKEY_WORDS =
  /pass\s*-?\s*key|web\s*-?\s*authn|fido|u2f|security\s*-?\s*key|hardware\s*-?\s*key|yubi\s*-?\s*key/iu;

/** Whether a sign-in method's name means a passkey: a change that says one is refused. */
export const namesPasskey = (text: string): boolean => PASSKEY_WORDS.test(text);

const PASSKEYS_OFF = 'passkeys are off: a saved login signs in with a password or a provider';

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
export type LoginMethod = z.infer<typeof LoginMethodSchema>;

/**
 * A method as a CHANGE sends it: {@link LoginMethodSchema}, and an SSO name that says passkey is refused. Only a
 * write is judged by the word list, so a list that grows later never makes an entry already stored unreadable.
 */
export const LoginMethodChangeSchema = LoginMethodSchema.refine(
  method => method.name === undefined || !namesPasskey(method.name),
  { path: ['name'], message: PASSKEYS_OFF },
);

/** The method an entry reads as: one saved before methods existed signs in with its password. */
export const PASSWORD_METHOD: LoginMethod = { kind: 'password' };

/** "Sign in with Google", "Sign in with Okta (SSO)" or "Password", without the provider entry. */
export function loginMethodWords(method: LoginMethod): string {
  return method.kind === 'sso' ? `Sign in with ${method.name ?? 'SSO'} (SSO)` : LOGIN_METHOD_LABELS[method.kind];
}

/** The same, naming the provider's saved login: `Sign in with Google via 'Google (kirin@…)'`. */
export function loginMethodSentence(method: LoginMethod, viaLabel: string | undefined): string {
  const words = loginMethodWords(method);
  return viaLabel === undefined || method.kind === 'password' ? words : `${words} via '${viaLabel}'`;
}

/**
 * Everything a client may learn about a saved login. `username` is plain and may be shown; `fields` says
 * which secret fields exist, never what they hold.
 */
export const LoginEntrySummarySchema = z.strictObject({
  id: LoginEntryIdSchema,
  label: oneLine(LOGIN_LABEL_MAX_LENGTH),
  match: z.array(LoginMatchSchema).max(LOGIN_MATCH_MAX).readonly(),
  /** How it signs in; absent reads as {@link PASSWORD_METHOD} (an older daemon). */
  method: LoginMethodSchema.optional(),
  /** Where the sign-in happens; absent reads as the web hosts of `match` ({@link loginDomainsOf}). */
  domains: z.array(LoginDomainSchema).max(LOGIN_MATCH_MAX).readonly().optional(),
  username: oneLine(LOGIN_USERNAME_MAX_LENGTH).optional(),
  fields: z.strictObject({ password: z.boolean(), totp: z.boolean() }),
  /** How the code is made, present exactly when `fields.totp`. */
  totp: TotpParametersSchema.optional(),
  /** How it signs in, step by step: the owner's Markdown (login-recipes.ts). Never a value. */
  recipe: LoginRecipeSchema.optional(),
  /** `ferret`: the recipe is a ferret's auto-applied proposal no person has reviewed. Absent: the owner's. */
  recipeBy: LoginRecipeAuthorSchema.optional(),
  /** The owner lets a ferret's recipe proposal for THIS login apply without asking. Off unless true. */
  autoApplyRecipe: z.boolean().optional(),
  /** What the daemon saw while typing this login, per place. Never an agent's words. */
  observed: z.array(LoginObservedSchema).max(LOGIN_OBSERVED_MAX).readonly().optional(),
  /** Ferrets' suggested recipes waiting for the owner. */
  proposals: z.array(LoginRecipeProposalSchema).max(LOGIN_RECIPE_PROPOSALS_MAX).readonly().optional(),
  createdAt: InstantSchema,
  updatedAt: InstantSchema,
});
export type LoginEntrySummary = z.infer<typeof LoginEntrySummarySchema>;

/** How an entry signs in, reading an entry from before methods as a password one. */
export const loginMethodOf = (entry: Pick<LoginEntrySummary, 'id' | 'method'>): LoginMethod =>
  entry.method ?? PASSWORD_METHOD;

/** Where an entry signs in, reading an entry from before login domains as its web `match` hosts. */
export const loginDomainsOf = (entry: Pick<LoginEntrySummary, 'match' | 'domains'>): readonly LoginDomain[] =>
  entry.domains ?? webHostsOf(entry.match);

/** `GET /v1/secrets/logins`. A damaged store says so; it is never an empty list. */
export const LoginEntryListSchema = z.strictObject({
  v: z.literal(1),
  health: SecretStoreHealthSchema,
  diagnosis: z.string().min(1).optional(),
  entries: z.array(LoginEntrySummarySchema).max(MAX_LOGIN_ENTRIES).readonly(),
});
export type LoginEntryList = z.infer<typeof LoginEntryListSchema>;

/** A password as a write sends it: no control character or line break, which would press keys. */
export const LoginPasswordSchema = z
  .string()
  .min(LOGIN_PASSWORD_MIN_LENGTH)
  .max(LOGIN_PASSWORD_MAX_LENGTH)
  .regex(/^[^\p{Cc}]*$/u, 'a password with a control character or line break would press keys');

/**
 * `PUT /v1/secrets/logins/:id`: create the entry, or change the parts named. A field left out is kept;
 * `null` removes it. Values travel IN only. Adding a seed needs `totpAcknowledged: true`, which the
 * client sends only after showing {@link LOGIN_TOTP_WARNING}.
 */
export const PutLoginEntryRequestSchema = z
  .strictObject({
    label: oneLine(LOGIN_LABEL_MAX_LENGTH).optional(),
    match: z.array(LoginMatchSchema).max(LOGIN_MATCH_MAX).optional(),
    /** The whole method, replaced: `{ kind: 'password' }` goes back to a password sign-in. */
    method: LoginMethodChangeSchema.optional(),
    domains: z.array(LoginDomainSchema).max(LOGIN_MATCH_MAX).optional(),
    username: oneLine(LOGIN_USERNAME_MAX_LENGTH).nullable().optional(),
    password: LoginPasswordSchema.nullable().optional(),
    totp: z.strictObject({ seed: TotpSeedSchema, parameters: TotpParametersSchema.optional() }).nullable().optional(),
    totpAcknowledged: z.literal(true).optional(),
    /** The recipe, replaced whole; `null` removes it. A text holding any saved or vault value is refused. */
    recipe: LoginRecipeSchema.nullable().optional(),
    autoApplyRecipe: z.boolean().optional(),
  })
  .superRefine((body, context) => {
    if (body.totp !== undefined && body.totp !== null && body.totpAcknowledged !== true)
      context.addIssue({
        code: 'custom',
        path: ['totpAcknowledged'],
        message: `confirm the warning first: ${LOGIN_TOTP_WARNING}`,
      });
  });
export type PutLoginEntryRequest = z.input<typeof PutLoginEntryRequestSchema>;
export type PutLoginEntry = z.output<typeof PutLoginEntryRequestSchema>;

/** `POST /v1/secrets/logins/:id/rename`. The values follow; nothing is re-typed. */
export const RenameLoginEntryRequestSchema = z.strictObject({ to: LoginEntryIdSchema });
export type RenameLoginEntryRequest = z.infer<typeof RenameLoginEntryRequestSchema>;

/** `DELETE /v1/secrets/logins/:id`. A 404 is how "there was none" is reported. */
export const RemovedLoginEntrySchema = z.strictObject({ id: LoginEntryIdSchema, removed: z.literal(true) });
export type RemovedLoginEntry = z.infer<typeof RemovedLoginEntrySchema>;

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
  suggest: z.strictObject({ id: LoginEntryIdSchema, label: oneLine(LOGIN_LABEL_MAX_LENGTH) }).optional(),
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

/**
 * WHAT A FERRET MAY LEARN ABOUT SIGNING IN TO A SITE (`account_hint`, `fy account hint`): the saved logins for
 * it, by their NON-SECRET metadata only — handle, label, method, login domains, the plain username, and the
 * provider entry a method goes via. Never a password, a seed, a code, or even which secret fields exist.
 *
 * `role` says why an entry is listed: `site` — it is for this site (`match` or a login domain is the site,
 * exactly); `provider` — a listed entry signs in via it, or its recipe names it as `[[ID]]`, so its domains and
 * its recipe are where the ferret will be sent next.
 *
 * A hint also carries the entry's RECIPE (the owner's steps) and what the daemon OBSERVED there: neither is a
 * value, and neither came from page text.
 */
export const LoginHintSchema = z.strictObject({
  id: LoginEntryIdSchema,
  label: oneLine(LOGIN_LABEL_MAX_LENGTH),
  role: z.enum(['site', 'provider']),
  method: LoginMethodSchema,
  via: LoginEntryRefSchema.optional(),
  domains: z.array(LoginDomainSchema).max(LOGIN_MATCH_MAX).readonly(),
  username: oneLine(LOGIN_USERNAME_MAX_LENGTH).optional(),
  /** The steps for signing in (Markdown). */
  recipe: LoginRecipeSchema.optional(),
  /** `ferret`: an auto-applied ferret's steps nobody reviewed, never to be read as the owner's. */
  recipeBy: LoginRecipeAuthorSchema.optional(),
  /**
   * What the daemon saw while typing this login (field kinds, echo, the page moving on, the 2FA kind). Never the
   * owner-tap count (`ferretObserved`).
   */
  observed: z.array(LoginObservedHintSchema).max(LOGIN_OBSERVED_MAX).readonly().optional(),
});
export type LoginHint = z.infer<typeof LoginHintSchema>;

/** `GET /v1/secrets/logins/hint?site=`. `passkeys` is always off: say so wherever a hint is read. */
export const LoginHintListSchema = z.strictObject({
  v: z.literal(1),
  site: LoginMatchSchema,
  hints: z.array(LoginHintSchema).max(MAX_LOGIN_ENTRIES).readonly(),
  passkeys: z.literal('off'),
});
export type LoginHintList = z.infer<typeof LoginHintListSchema>;

/** The site a hint is asked for: a host, a URL or a `program@host`, as a key a saved login could match. */
export function loginHintSite(text: string): LoginMatch | undefined {
  const trimmed = text.trim().toLowerCase();
  if (LoginMatchSchema.safeParse(trimmed).success) return trimmed;
  return normalizedLoginDomain(trimmed);
}

/** The entry another names, when it still exists. */
function refTo(entries: readonly LoginEntrySummary[], id: LoginEntryId | undefined): LoginEntrySummary | undefined {
  return id === undefined ? undefined : entries.find(entry => entry.id === id);
}

/** One entry as a hint: the non-secret projection, nothing else. */
function hintOf(entry: LoginEntrySummary, role: LoginHint['role'], entries: readonly LoginEntrySummary[]): LoginHint {
  const method = loginMethodOf(entry);
  const via = refTo(entries, method.via);
  return {
    id: entry.id,
    label: entry.label,
    role,
    method,
    ...(via === undefined ? {} : { via: { id: via.id, label: via.label } }),
    domains: [...loginDomainsOf(entry)],
    ...(entry.username === undefined ? {} : { username: entry.username }),
    ...(entry.recipe === undefined ? {} : { recipe: entry.recipe }),
    ...(entry.recipe === undefined || entry.recipeBy === undefined ? {} : { recipeBy: entry.recipeBy }),
    ...(entry.observed === undefined || entry.observed.length === 0
      ? {}
      : { observed: ferretObserved(entry.observed) }),
  };
}

/**
 * The saved logins for a site: entries that match it or sign in on it, EXACTLY (no wildcard, no parent domain),
 * then the provider entries those go via. Each is listed once, a site entry before a provider one.
 */
export function loginHintsFor(site: LoginMatch, entries: readonly LoginEntrySummary[]): readonly LoginHint[] {
  const forSite = entries.filter(entry => entry.match.includes(site) || loginDomainsOf(entry).includes(site));
  const listed = new Set(forSite.map(entry => entry.id));
  const providers: LoginEntrySummary[] = [];
  for (const entry of forSite)
    for (const id of [loginMethodOf(entry).via, ...recipeReferences(entry.recipe)]) {
      const named = refTo(entries, id);
      if (named !== undefined && !listed.has(named.id)) {
        listed.add(named.id);
        providers.push(named);
      }
    }
  return [
    ...forSite.map(entry => hintOf(entry, 'site', entries)),
    ...providers.map(entry => hintOf(entry, 'provider', entries)),
  ];
}

/** One hint as a line a ferret reads: what to click, where the sign-in happens, and the username. */
export function loginHintLine(hint: LoginHint): string {
  const where = hint.domains.length === 0 ? '' : ` on ${hint.domains.join(', ')}`;
  const who = hint.username === undefined ? '' : `, username ${hint.username}`;
  const how =
    hint.method.kind === 'password'
      ? 'password'
      : `${loginMethodSentence(hint.method, hint.via?.label)}: click that button, then request input on the provider's page`;
  const seen =
    hint.observed === undefined || hint.observed.length === 0
      ? ''
      : ` Seen: ${hint.observed.map(observedWords).join('; ')}.`;
  const author =
    hint.recipeBy === 'ferret' ? "a ferret's unreviewed steps, NOT the owner's; follow with care" : "the owner's steps";
  const recipe =
    hint.recipe === undefined
      ? ''
      : ` Recipe (${author}), between the markers:\n${RECIPE_FENCE_OPEN}\n${hint.recipe}\n${RECIPE_FENCE_CLOSE}\n`;
  return `'${hint.label}' (${hint.id}${hint.role === 'provider' ? ', provider' : ''}): ${how}${where}${who}.${seen}${recipe}`;
}

/** The sentence a hint ends with when it listed an entry: how a ferret suggests a better recipe. */
export const LOGIN_HINT_PROPOSE =
  'After signing in, if the steps were missing or wrong, propose the recipe with account_propose; the owner approves it.';

/** The sentence every hint ends with. */
export const LOGIN_HINT_PASSKEYS_OFF = 'Use the password or provider flow; passkeys are off, never create one.';

/** What `account_hint` and `fy account hint` say: each entry's line, or that none is saved, and the passkey rule. */
export function loginHintSummary(site: string, hints: readonly LoginHint[]): string {
  const found =
    hints.length === 0
      ? `No account for ${site}; request the values as usual and the owner can save them.`
      : `Accounts for ${site}: ${hints.map(loginHintLine).join(' ')}`;
  return hints.length === 0
    ? `${found} ${LOGIN_HINT_PASSKEYS_OFF}`
    : `${found} ${LOGIN_HINT_PROPOSE} ${LOGIN_HINT_PASSKEYS_OFF}`;
}

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
export function suggestedLoginId(match: string): LoginEntryId {
  const words = match
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]+/gu, '_')
    .replaceAll(/^_+|_+$/gu, '');
  const head = /^[A-Z]/u.test(words) ? words : `LOGIN_${words}`;
  return head.slice(0, 64).replace(/_+$/u, '');
}

/** The label "Save as" suggests: `sudo on kirin-box`, or the web host itself. */
export function suggestedLoginLabel(match: string): string {
  const at = match.indexOf('@');
  return (at === -1 ? match : `${match.slice(0, at)} on ${match.slice(at + 1)}`).slice(0, LOGIN_LABEL_MAX_LENGTH);
}
