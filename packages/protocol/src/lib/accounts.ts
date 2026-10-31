import { z } from 'zod';
import {
  type AccountId,
  AccountIdSchema,
  type AccountKey,
  AccountKeySchema,
  namesSignIn,
  type SignInId,
  SignInIdSchema,
} from './account-ids.ts';
import { InstantSchema } from './common.ts';
import {
  LOGIN_LABEL_MAX_LENGTH,
  LOGIN_MATCH_MAX,
  LOGIN_HINT_PASSKEYS_OFF,
  LOGIN_USERNAME_MAX_LENGTH,
  type LoginDomain,
  LoginDomainSchema,
  type LoginMatch,
  LoginMatchSchema,
  type LoginMethod,
  LoginMethodKindSchema,
  loginMethodIssues,
  LoginMethodSchema,
  loginMethodSentence,
  MAX_LOGIN_ENTRIES,
  oneLine,
  SIGN_IN_PROJECT_MAX_LENGTH,
  type SignInChoiceReason,
  type TotpParameters,
  TotpParametersSchema,
  webHostsOf,
} from './login-entries.ts';
import {
  LOGIN_OBSERVED_MAX,
  LOGIN_RECIPE_MAX_LENGTH,
  LOGIN_RECIPE_PROPOSALS_MAX,
  type LoginObserved,
  LoginObservedSchema,
  LoginRecipeAuthorSchema,
  type LoginRecipeProposal,
  LoginRecipeProposalSchema,
  LoginRecipeProposeRequestSchema,
  LoginRecipeSchema,
  observedWords,
  RECIPE_FENCE_CLOSE,
  RECIPE_FENCE_OPEN,
  recipeReferences,
} from './login-recipes.ts';
import { sha256Hex } from './mcp-oauth.ts';
import { SecretStoreHealthSchema } from './secrets.ts';

/**
 * ACCOUNTS AND SIGN-INS: the saved login split in two (docs/input-requests.md, "Accounts and sign-ins").
 *
 * - An **account** is one identity: a label, a PLAIN username and its SECRET fields (a password, an opt-in 2FA
 *   seed), sealed exactly as a saved login's are. Its handle is today's saved login handle; its key is today's.
 * - A **sign-in** is how that account signs in at ONE place: a website (its login domains) or a terminal tool
 *   (`sudo@kirin-box`, `ssh@build.example.com`). It carries the method, the provider it goes via, the recipe and
 *   what the daemon observed there. Same site, two accounts: two sign-ins. Same account, two sites: two sign-ins.
 *
 * Nothing here is secret, and the same rule as every secret holds: a value travels IN on an owner's write and never
 * travels back. Every shape a client may read is listed in this file, and none has a field for a value.
 *
 * The shared pieces (methods, login domains, match keys, recipes, observed facts, TOTP parameters) are owned by
 * `login-entries.ts` and `login-recipes.ts` and imported here, never copied.
 */

export { AccountIdSchema, AccountKeySchema, SignInIdSchema, namesSignIn };
export type { AccountId, AccountKey, SignInId };

/** Most accounts one daemon keeps (today's most saved logins). */
export const MAX_ACCOUNTS = MAX_LOGIN_ENTRIES;
/** Most sign-ins one daemon keeps. */
export const MAX_SIGN_INS = 512;
/** Most sign-ins one account has. */
export const MAX_SIGN_INS_PER_ACCOUNT = 16;

// ── Place ────────────────────────────────────────────────────────────────────────────────────────

/** A key a target is matched on: a web host exactly as an origin names it, or `program@host` for a terminal. */
export const PlaceKeySchema = LoginMatchSchema;
export type PlaceKey = LoginMatch;

/** A website. A page is matched on its login domains only; `match` says what it is FOR and never matches a page. */
export const SitePlaceSchema = z
  .strictObject({
    kind: z.literal('site'),
    /** Where the sign-in happens: a page whose host is one of these EXACTLY is matched (a saved login's `domains`). */
    domains: z.array(LoginDomainSchema).max(LOGIN_MATCH_MAX).readonly(),
    /** What it is for (the site the work is on), web hosts only (a saved login's web `match`). Never matches a page. */
    match: z.array(LoginDomainSchema).max(LOGIN_MATCH_MAX).readonly(),
  })
  .refine(place => place.domains.length + place.match.length > 0, 'a site sign-in names at least one host');
export type SitePlace = z.infer<typeof SitePlaceSchema>;

/** The programs whose password is a REMOTE machine's, so their key names the destination. */
export const REMOTE_TOOLS = ['ssh', 'scp', 'sftp'] as const;
const isRemoteTool = (tool: string): boolean => (REMOTE_TOOLS as readonly string[]).includes(tool);

/** A terminal tool: the program at the prompt, the machine it runs on and, for ssh, scp and sftp, where it goes. */
export const TerminalPlaceSchema = z
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
  .refine(place => LoginMatchSchema.safeParse(terminalKey(place)).success, {
    message: 'the program and host are too long to be a terminal key',
  });
export type TerminalPlace = z.infer<typeof TerminalPlaceSchema>;

export const PlaceSchema = z.discriminatedUnion('kind', [SitePlaceSchema, TerminalPlaceSchema]);
export type Place = z.infer<typeof PlaceSchema>;

function terminalKey(place: {
  readonly tool: string;
  readonly host: string;
  readonly dest?: string | undefined;
}): string {
  return `${place.tool}@${place.dest ?? place.host}`;
}

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

/** "on github.com", "for vercel.com" (a site with no login domain of its own), "on sudo@kirin-box". */
export function placeWords(place: Place): string {
  if (place.kind === 'terminal') return `on ${terminalKey(place)}`;
  return place.domains.length > 0 ? `on ${place.domains.join(', ')}` : `for ${place.match.join(', ')}`;
}

// ── Records (the non-secret index, `state/login-entries.json`, `v: 2`) ──────────────────────────────

/** Where one secret field rests in the sealed document: the account's key, the field, a fresh suffix. */
export const SealedNameSchema = z.string().regex(/^L[0-9A-F]{24}_(?:PASSWORD|TOTP)_[0-9A-F]{8}$/u);

/** An account as it rests in the index. Its handle is the index's key; `key` never changes. */
export const AccountRecordSchema = z.strictObject({
  key: AccountKeySchema,
  label: z.string().min(1).max(LOGIN_LABEL_MAX_LENGTH),
  username: z.string().min(1).max(LOGIN_USERNAME_MAX_LENGTH).optional(),
  /** The one commit point for each secret field, exactly as a saved login's: absent, the account has no such field. */
  seals: z.strictObject({ password: SealedNameSchema.optional(), totp: SealedNameSchema.optional() }),
  /** How the 2FA code is made; present exactly when `seals.totp` is. */
  totp: TotpParametersSchema.optional(),
  /** Accounts the owner said are NOT one account ("these look like one account" → "Keep apart"), by key. */
  apartFrom: z.array(AccountKeySchema).max(MAX_ACCOUNTS).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type AccountRecord = z.infer<typeof AccountRecordSchema>;

/** A method as a sign-in stores it: the provider it goes via is an account's KEY, so a rename touches nothing. */
export const LoginMethodRecordSchema = z
  .strictObject({
    kind: LoginMethodKindSchema,
    name: oneLine(40).optional(),
    viaKey: AccountKeySchema.optional(),
  })
  .superRefine((method, context) => {
    for (const issue of loginMethodIssues(method.kind, method.name, method.viaKey, 'viaKey'))
      context.addIssue({ code: 'custom', ...issue });
  });
export type LoginMethodRecord = z.infer<typeof LoginMethodRecordSchema>;

/** A sign-in as it rests in the index. Its id is the index's key and never changes. */
export const SignInRecordSchema = z.strictObject({
  /** The account's immutable KEY, never its handle: a rename touches nothing here. */
  account: AccountKeySchema,
  place: PlaceSchema,
  /** How it signs in. Absent: a password. */
  method: LoginMethodRecordSchema.optional(),
  recipe: z.string().min(1).max(LOGIN_RECIPE_MAX_LENGTH).optional(),
  /** Bumped on every recipe change (owner edit, approval, auto-apply). Starts at 1. */
  recipeVersion: z.number().int().min(1).optional(),
  recipeBy: z.literal('ferret').optional(),
  autoApplyRecipe: z.literal(true).optional(),
  /** What the daemon saw while typing this sign-in. Written only by the input service. */
  observed: z.array(LoginObservedSchema).max(LOGIN_OBSERVED_MAX).optional(),
  proposals: z.array(LoginRecipeProposalSchema).max(LOGIN_RECIPE_PROPOSALS_MAX).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type SignInRecord = z.infer<typeof SignInRecordSchema>;

/** One way an index breaks the store's rules, where. */
export interface AccountIndexProblem {
  readonly path: readonly (string | number)[];
  readonly message: string;
}

/**
 * THE STORE'S RULES, as problems: every sign-in's account exists; one account never has two sign-ins naming the same
 * key (so "this account's sign-in here" is one or none); `via` names another account that signs in on a site, and
 * following via links never comes back round; no two handles share a key; and the limits. A write checks them, and a
 * read does through {@link AccountIndexDocumentSchema}, so a hand-edited file is damaged, never half-trusted.
 */
export function accountIndexProblems(document: {
  readonly accounts: Readonly<Record<string, AccountRecord>>;
  readonly signIns: Readonly<Record<string, SignInRecord>>;
}): readonly AccountIndexProblem[] {
  const problems: AccountIndexProblem[] = [];
  const accounts = Object.entries(document.accounts);
  const signIns = Object.entries(document.signIns);
  if (accounts.length > MAX_ACCOUNTS)
    problems.push({ path: ['accounts'], message: `at most ${String(MAX_ACCOUNTS)} accounts` });
  if (signIns.length > MAX_SIGN_INS)
    problems.push({ path: ['signIns'], message: `at most ${String(MAX_SIGN_INS)} sign-ins` });

  const handleOfKey = new Map<string, string>();
  for (const [handle, account] of accounts) {
    const other = handleOfKey.get(account.key);
    if (other !== undefined)
      problems.push({ path: ['accounts', handle, 'key'], message: `${handle} and ${other} share one key` });
    else handleOfKey.set(account.key, handle);
  }

  const perAccount = new Map<string, number>();
  const named = new Map<string, string>();
  const sites = new Set<string>();
  for (const [id, signIn] of signIns) {
    if (!handleOfKey.has(signIn.account)) {
      problems.push({ path: ['signIns', id, 'account'], message: `${id} belongs to no account` });
      continue;
    }
    if (signIn.place.kind === 'site') sites.add(signIn.account);
    const count = (perAccount.get(signIn.account) ?? 0) + 1;
    perAccount.set(signIn.account, count);
    if (count === MAX_SIGN_INS_PER_ACCOUNT + 1)
      problems.push({
        path: ['signIns', id],
        message: `an account has at most ${String(MAX_SIGN_INS_PER_ACCOUNT)} sign-ins`,
      });
    for (const host of placeHosts(signIn.place)) {
      const pair = `${signIn.account}\0${host}`;
      const first = named.get(pair);
      if (first !== undefined)
        problems.push({
          path: ['signIns', id, 'place'],
          message: `${handleOfKey.get(signIn.account) ?? signIn.account} already signs in at ${host} (${first})`,
        });
      else named.set(pair, id);
    }
  }

  const providers = new Map<string, Set<string>>();
  for (const [id, signIn] of signIns) {
    const via = signIn.method?.viaKey;
    if (via === undefined || !handleOfKey.has(signIn.account)) continue;
    if (via === signIn.account)
      problems.push({ path: ['signIns', id, 'method', 'viaKey'], message: `${id} cannot sign in via its own account` });
    else if (!handleOfKey.has(via))
      problems.push({
        path: ['signIns', id, 'method', 'viaKey'],
        message: `${id} signs in via an account that is gone`,
      });
    else if (!sites.has(via))
      problems.push({
        path: ['signIns', id, 'method', 'viaKey'],
        message: `${id} signs in via ${handleOfKey.get(via) ?? via}, which signs in on no site`,
      });
    else providers.set(signIn.account, (providers.get(signIn.account) ?? new Set()).add(via));
  }
  const loop = viaLoop(providers);
  if (loop !== undefined)
    problems.push({
      path: ['signIns'],
      message: `via links go round in a circle: ${loop.map(key => handleOfKey.get(key) ?? key).join(' → ')}`,
    });
  return problems;
}

/** A circle in the "signs in via" graph, as the keys round it (first repeated last), or `undefined`. */
function viaLoop(providers: ReadonlyMap<string, ReadonlySet<string>>): readonly string[] | undefined {
  const done = new Set<string>();
  const visit = (key: string, path: readonly string[]): readonly string[] | undefined => {
    const at = path.indexOf(key);
    if (at !== -1) return [...path.slice(at), key];
    if (done.has(key)) return undefined;
    for (const next of [...(providers.get(key) ?? [])].sort()) {
      const loop = visit(next, [...path, key]);
      if (loop !== undefined) return loop;
    }
    done.add(key);
    return undefined;
  };
  for (const key of [...providers.keys()].sort()) {
    const loop = visit(key, []);
    if (loop !== undefined) return loop;
  }
  return undefined;
}

/**
 * The non-secret index, version 2 (`state/login-entries.json`, file name unchanged): accounts by handle, sign-ins by
 * id. An older daemon reads it with its `v: 1` strict schema and fails closed (damaged, never empty).
 */
export const AccountIndexDocumentSchema = z
  .strictObject({
    v: z.literal(2),
    accounts: z.record(AccountIdSchema, AccountRecordSchema),
    signIns: z.record(SignInIdSchema, SignInRecordSchema),
    /** Written once by the migration from a version 1 index; never changed after. */
    migrated: z
      .strictObject({ from: z.literal(1), at: z.string().min(1), entries: z.number().int().min(0) })
      .optional(),
  })
  .superRefine((document, context) => {
    for (const problem of accountIndexProblems(document))
      context.addIssue({ code: 'custom', path: [...problem.path], message: problem.message });
  });
export type AccountIndexDocument = z.infer<typeof AccountIndexDocumentSchema>;

// ── Wire (the owner's view) ──────────────────────────────────────────────────────────────────────

/** An account named by another: its handle and its label, never what it holds. */
export const AccountRefSchema = z.strictObject({ id: AccountIdSchema, label: oneLine(LOGIN_LABEL_MAX_LENGTH) });
export type AccountRef = z.infer<typeof AccountRefSchema>;

/** The provider a sign-in goes via: its account and, when it has one on a site, that sign-in. */
export const SignInViaSchema = z.strictObject({ account: AccountRefSchema, signIn: SignInIdSchema.optional() });
export type SignInVia = z.infer<typeof SignInViaSchema>;

/** An account as the OWNER reads it. `fields` says which secret fields exist, never what they hold. */
export const AccountSummarySchema = z.strictObject({
  id: AccountIdSchema,
  label: oneLine(LOGIN_LABEL_MAX_LENGTH),
  username: oneLine(LOGIN_USERNAME_MAX_LENGTH).optional(),
  /** OWNER VIEW ONLY: which secret fields exist. Never in a hint. */
  fields: z.strictObject({ password: z.boolean(), totp: z.boolean() }),
  totp: TotpParametersSchema.optional(),
  signIns: z.array(SignInIdSchema).max(MAX_SIGN_INS_PER_ACCOUNT).readonly(),
  createdAt: InstantSchema,
  updatedAt: InstantSchema,
});
export type AccountSummary = z.infer<typeof AccountSummarySchema>;

/** A sign-in as the owner reads it. `method.via` is the provider account's handle. */
export const SignInSummarySchema = z.strictObject({
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

// ── `config/account-defaults.yaml` ───────────────────────────────────────────────────────────────

const DefaultsMapSchema = z
  .record(PlaceKeySchema, AccountIdSchema)
  .refine(map => Object.keys(map).length <= MAX_ACCOUNTS, `at most ${String(MAX_ACCOUNTS)} lines`);

/**
 * WHICH ACCOUNT A SIGN-IN CARD OFFERS FIRST, as the owner wrote it. It orders buttons only: the owner's tap is still
 * the permission, and a line can only choose among the sign-ins the daemon matched ({@link chosenSignIn}). Each map
 * is key → account handle, the key a login domain, a site's `match` host or a `tool@host`.
 */
export const AccountDefaultsFileSchema = z.strictObject({
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
        .regex(/^(?:~|~\/[^\p{Cc}]*|\/[^\p{Cc}]*)$/u, 'an absolute path or ~/…'),
      DefaultsMapSchema,
    )
    .optional(),
});
export type AccountDefaultsFile = z.infer<typeof AccountDefaultsFileSchema>;

// ── Which sign-in a card offers first ────────────────────────────────────────────────────────────

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

/** The matched sign-in a defaults map names: the target key's line first, then a line for a site's `match` host. */
function pickedBy(
  map: Readonly<Record<string, string>> | undefined,
  key: string,
  matched: readonly SignInCandidate[],
): SignInCandidate | undefined {
  if (map === undefined) return undefined;
  const account = lineOf(map, key);
  const direct = account === undefined ? undefined : matched.find(candidate => candidate.account === account);
  if (direct !== undefined) return direct;
  return matched.find(
    candidate =>
      candidate.place.kind === 'site' && candidate.place.match.some(host => lineOf(map, host) === candidate.account),
  );
}

/** A folder line as a path to compare: `~` expanded, no trailing slash (but the root). `undefined`: it cannot be. */
function folderPath(line: string, home: string | undefined): string | undefined {
  const expanded =
    line === '~' || line.startsWith('~/') ? (home === undefined ? undefined : home + line.slice(1)) : line;
  if (expanded === undefined || !expanded.startsWith('/')) return undefined;
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
      : matched.find(candidate => (namesSignIn(hint) ? candidate.id === hint : candidate.account === hint));
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

function lineOfProject(
  defaults: AccountDefaultsFile | undefined,
  project: string,
): Readonly<Record<string, string>> | undefined {
  const projects = defaults?.projects;
  return projects !== undefined && Object.hasOwn(projects, project) ? projects[project] : undefined;
}

/** The few words a card says under its primary: "Ferret chose this", "Default for ferretry", "Only account here". */
export function signInChoiceWords(choice: Pick<SignInChoice, 'why' | 'project'>, key: string): string {
  switch (choice.why) {
    case 'ferret':
      return 'Ferret chose this';
    case 'project':
      return `Default for ${choice.project ?? 'this project'}`;
    case 'folder':
      return 'Default for this folder';
    case 'site':
      return `Default for ${key}`;
    case 'only':
      return 'Only account here';
  }
}

/** What a card says when two or more accounts sign in here and nothing chose one. */
export const pickOneWords = (count: number): string => `Pick one: ${String(count)} accounts sign in here`;

// ── `account.hint` ──────────────────────────────────────────────────────────────────────────────

/** Why a hint's sign-in would be first on the calling session's card. Never `ferret`: a hint is asked before one. */
export const AccountHintDefaultSchema = z.strictObject({
  by: z.enum(['project', 'folder', 'site', 'only']),
  project: oneLine(SIGN_IN_PROJECT_MAX_LENGTH).optional(),
});
export type AccountHintDefault = z.infer<typeof AccountHintDefaultSchema>;

/**
 * WHAT A FERRET MAY LEARN ABOUT SIGNING IN TO A SITE (`account_hint`), one entry per sign-in: the account's label and
 * PLAIN username, the place, the method and the provider it goes via, the recipe, what the daemon observed, and why
 * it would be first. Never a password, a seed, a code, which secret fields exist, the TOTP parameters (they say a
 * seed exists), seal names, "keep apart" pairs, whether a ferret's recipe would auto-apply, proposals or times.
 */
export const AccountHintSchema = z.strictObject({
  signIn: SignInIdSchema,
  account: AccountRefSchema,
  username: oneLine(LOGIN_USERNAME_MAX_LENGTH).optional(),
  role: z.enum(['site', 'provider']),
  place: PlaceSchema,
  method: LoginMethodSchema,
  via: SignInViaSchema.optional(),
  recipe: LoginRecipeSchema.optional(),
  recipeVersion: z.number().int().min(1).optional(),
  recipeBy: LoginRecipeAuthorSchema.optional(),
  observed: z.array(LoginObservedSchema).max(LOGIN_OBSERVED_MAX).readonly().optional(),
  default: AccountHintDefaultSchema.optional(),
});
export type AccountHint = z.infer<typeof AccountHintSchema>;

/** `GET /v1/accounts/hint?site=`. `passkeys` is always off: say so wherever a hint is read. */
export const AccountHintListSchema = z.strictObject({
  v: z.literal(1),
  site: PlaceKeySchema,
  hints: z.array(AccountHintSchema).max(MAX_SIGN_INS).readonly(),
  passkeys: z.literal('off'),
});
export type AccountHintList = z.infer<typeof AccountHintListSchema>;

/** A hint's `default` from the calling session's {@link chosenSignIn} (asked with no ferret hint). */
export function accountHintDefault(choice: SignInChoice | undefined, signIn: SignInId): AccountHintDefault | undefined {
  if (choice === undefined || choice.signIn !== signIn || choice.why === 'ferret') return undefined;
  return { by: choice.why, ...(choice.project === undefined ? {} : { project: choice.project }) };
}

/** One sign-in as a hint: the non-secret projection, nothing else. */
function hintOf(
  signIn: SignInSummary,
  role: AccountHint['role'],
  account: AccountSummary,
  choice: SignInChoice | undefined,
): AccountHint {
  const preferred = accountHintDefault(choice, signIn.id);
  return {
    signIn: signIn.id,
    account: { id: account.id, label: account.label },
    ...(account.username === undefined ? {} : { username: account.username }),
    role,
    place: signIn.place,
    method: signIn.method,
    ...(signIn.via === undefined ? {} : { via: signIn.via }),
    ...(signIn.recipe === undefined ? {} : { recipe: signIn.recipe }),
    ...(signIn.recipe === undefined || signIn.recipeVersion === undefined
      ? {}
      : { recipeVersion: signIn.recipeVersion }),
    ...(signIn.recipe === undefined || signIn.recipeBy === undefined ? {} : { recipeBy: signIn.recipeBy }),
    ...(signIn.observed === undefined || signIn.observed.length === 0 ? {} : { observed: [...signIn.observed] }),
    ...(preferred === undefined ? {} : { default: preferred }),
  };
}

/**
 * The sign-ins for a site: those that name it EXACTLY (a login domain, what a site is for, or a terminal key), then
 * the provider ones they lead to — the via account's site sign-ins and every sign-in of an account a recipe names as
 * `[[ID]]`. Each is listed once, a site one before a provider one. `choice` is the calling session's
 * {@link chosenSignIn} for this site, asked with no ferret hint.
 */
export function accountHintsFor(
  site: PlaceKey,
  list: Pick<AccountList, 'accounts' | 'signIns'>,
  choice?: SignInChoice,
): readonly AccountHint[] {
  const accounts = new Map(list.accounts.map(account => [account.id, account]));
  const forSite = list.signIns.filter(signIn => placeHosts(signIn.place).includes(site));
  const listed = new Set(forSite.map(signIn => signIn.id));
  const providers: SignInSummary[] = [];
  const add = (signIn: SignInSummary): void => {
    if (listed.has(signIn.id)) return;
    listed.add(signIn.id);
    providers.push(signIn);
  };
  for (const signIn of forSite) {
    const via = signIn.method.via;
    for (const other of list.signIns)
      if (via !== undefined && other.account === via && other.place.kind === 'site') add(other);
    for (const named of recipeReferences(signIn.recipe))
      for (const other of list.signIns) if (other.account === named) add(other);
  }
  const hints: AccountHint[] = [];
  for (const [signIn, role] of [
    ...forSite.map(signIn => [signIn, 'site'] as const),
    ...providers.map(signIn => [signIn, 'provider'] as const),
  ]) {
    const account = accounts.get(signIn.account);
    if (account !== undefined) hints.push(hintOf(signIn, role, account, choice));
  }
  return hints;
}

/** One hint as a line a ferret reads: who, which sign-in, how, where, why first, what was seen, and the recipe. */
export function accountHintLine(hint: AccountHint, site: string): string {
  const as = hint.username === undefined ? '' : ` as ${hint.username}`;
  const how =
    hint.method.kind === 'password'
      ? 'password'
      : `${loginMethodSentence(hint.method, hint.via?.account.label)}: click that button, then request input on the provider's page`;
  const first =
    hint.default === undefined
      ? ''
      : ` ${signInChoiceWords({ why: hint.default.by, ...(hint.default.project === undefined ? {} : { project: hint.default.project }) }, site)}.`;
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
  const role = hint.role === 'provider' ? ', provider' : '';
  return `'${hint.account.label}' (${hint.account.id}${role})${as} [${hint.signIn}]: ${how} ${placeWords(hint.place)}.${first}${seen}${recipe}`;
}

/** The sentence a hint that listed a sign-in ends with: how a ferret names one and suggests a better recipe. */
export const ACCOUNT_HINT_NEXT =
  'Name the account when you request input (secretHint) if your brief says which; propose recipe fixes with account_propose and the sign-in id.';

/** What `account_hint` says: each sign-in's line, or that none is saved, and the passkey rule. */
export function accountHintSummary(site: string, hints: readonly AccountHint[]): string {
  return hints.length === 0
    ? `No account for ${site}; request the values as usual and the owner can save them. ${LOGIN_HINT_PASSKEYS_OFF}`
    : `Accounts for ${site}: ${hints.map(hint => accountHintLine(hint, site)).join(' ')} ${ACCOUNT_HINT_NEXT} ${LOGIN_HINT_PASSKEYS_OFF}`;
}

// ── `account.propose` ───────────────────────────────────────────────────────────────────────────

/**
 * A ferret's recipe proposal, keyed by the SIGN-IN it is for. It changes nothing until the owner approves it, unless
 * the owner turned auto-apply on for that one sign-in. The older `{ login }` spelling resolves to an account's only
 * sign-in (the daemon's job); this is the canonical call every check runs on.
 */
export const AccountProposeCallSchema = z.strictObject({
  tool: z.literal('account.propose'),
  signIn: SignInIdSchema,
  recipe: LoginRecipeSchema,
  why: LoginRecipeProposeRequestSchema.shape.why,
});
export type AccountProposeCall = z.infer<typeof AccountProposeCallSchema>;

// ── Migration: a version 1 index (saved logins) → version 2 (accounts and sign-ins) ─────────────────

/** A saved login as a version 1 index keeps it: the daemon's `LoginRecordSchema` output. */
export interface LoginRecordV1 {
  readonly key: string;
  readonly label: string;
  readonly match: readonly string[];
  readonly method?: LoginMethod | undefined;
  readonly domains?: readonly string[] | undefined;
  readonly username?: string | undefined;
  readonly seals: { readonly password?: string | undefined; readonly totp?: string | undefined };
  readonly totp?: TotpParameters | undefined;
  readonly recipe?: string | undefined;
  readonly autoApplyRecipe?: true | undefined;
  readonly recipeBy?: 'ferret' | undefined;
  readonly observed?: readonly LoginObserved[] | undefined;
  readonly proposals?: readonly LoginRecipeProposal[] | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A version 1 index, as the daemon's `LoginIndexDocumentSchema` parses it. */
export interface LoginIndexV1 {
  readonly v: 1;
  readonly entries: Readonly<Record<string, LoginRecordV1>>;
}

/** What a migration did, in counts only: the audit record and the report never carry a name or a value. */
export interface AccountsMigrationReport {
  readonly entries: number;
  readonly accounts: number;
  readonly signIns: number;
  /** Facts kept at a place that is none of the entry's places (it was hand-picked elsewhere): dropped. */
  readonly droppedFacts: number;
  /** Match keys that are not a key a target could have, or past an account's or the store's sign-in limit. */
  readonly droppedPlaces: number;
  /** Via links to a login that is gone, is itself, signs in on no site or would go round in a circle. */
  readonly droppedVia: number;
}

export type AccountsMigration =
  | {
      readonly ok: true;
      readonly value: { readonly document: AccountIndexDocument; readonly report: AccountsMigrationReport };
    }
  | { readonly ok: false; readonly error: string };

/** The domain separator a migrated sign-in's id is derived under. */
const SIGN_IN_ID_DOMAIN = 'ferretry.signin.v1';

/**
 * A migrated sign-in's id: `si_` and the first 16 hex digits of `sha256("ferretry.signin.v1\0" + key + "\0" + place)`.
 * Derived, not random, so migrating the same index twice (a crash and a reboot, or a read of an index not yet
 * rewritten) gives the same ids.
 */
export function migratedSignInId(accountKey: string, placeKey: string): SignInId {
  return `si_${sha256Hex(`${SIGN_IN_ID_DOMAIN}\0${accountKey}\0${placeKey}`).slice(0, 16)}`;
}

/** The key a place is named by in its migrated id: a site's first host, a terminal's key. One site per entry. */
const idKeyOf = (place: Place): string => placeHosts(place)[0] ?? '';

/** This machine's short name as a terminal place keeps it (`kirin-box.local` → `kirin-box`); `localhost` if none. */
function shortHostOf(hostName: string): LoginDomain {
  const host = hostName.trim().toLowerCase().split('.')[0] ?? '';
  return LoginDomainSchema.safeParse(host).success ? host : 'localhost';
}

const unique = <T>(items: readonly T[]): readonly T[] => [...new Set(items)];

/** An entry's places, primary first: its one site (if any), then one terminal place per terminal key. */
function placesOf(
  record: LoginRecordV1,
  host: LoginDomain,
): { readonly places: readonly Place[]; readonly dropped: number } {
  const keys = unique(record.match);
  const valid = keys.filter(key => LoginMatchSchema.safeParse(key).success);
  const match = webHostsOf(valid);
  const domains = unique((record.domains ?? match).filter(domain => LoginDomainSchema.safeParse(domain).success));
  const places: Place[] = [];
  if (domains.length + match.length > 0) places.push({ kind: 'site', domains, match });
  let dropped = keys.length - valid.length;
  for (const key of valid) {
    const at = key.indexOf('@');
    if (at === -1) continue;
    const tool = key.slice(0, at);
    const target = key.slice(at + 1);
    const place = TerminalPlaceSchema.safeParse(
      isRemoteTool(tool) ? { kind: 'terminal', tool, host, dest: target } : { kind: 'terminal', tool, host: target },
    );
    if (place.success) places.push(place.data);
    else dropped += 1;
  }
  return { places, dropped };
}

/**
 * MIGRATES A VERSION 1 INDEX, purely: one saved login becomes one account (handle, key, label, username, seals and
 * TOTP parameters verbatim) and one sign-in per place — its site, and each terminal key in `match`. Method, via and
 * recipe go to every sign-in from the entry (today one recipe is shown for every match); auto-apply and proposals go
 * to the PRIMARY only (the site, else the first terminal), so a ferret never gains auto-apply where the owner never
 * saw it. Each observed fact goes to the sign-in whose keys contain its place; one at no place of the entry is
 * dropped and counted, which is safe because facts only ever shorten a lock.
 *
 * Sealed names are untouched (the sealed document is never rewritten). Ids are derived ({@link migratedSignInId}),
 * so only `migrated.at` depends on `now`. The result always satisfies {@link AccountIndexDocumentSchema}; an index
 * that cannot become one (two handles sharing a key) is refused, and the caller treats the store as damaged.
 */
export function migrateLoginIndex(
  v1: LoginIndexV1,
  options: { readonly hostName: string; readonly now: string },
): AccountsMigration {
  const host = shortHostOf(options.hostName);
  const handles = Object.keys(v1.entries).sort();
  const accounts: Record<string, AccountRecord> = {};
  const signIns: Record<string, SignInRecord> = {};
  const sitesOf = new Set<string>();
  let droppedFacts = 0;
  let droppedPlaces = 0;
  let droppedVia = 0;

  for (const handle of handles) {
    const record = v1.entries[handle] as LoginRecordV1;
    accounts[handle] = {
      key: record.key,
      label: record.label,
      ...(record.username === undefined ? {} : { username: record.username }),
      seals: {
        ...(record.seals.password === undefined ? {} : { password: record.seals.password }),
        ...(record.seals.totp === undefined ? {} : { totp: record.seals.totp }),
      },
      ...(record.totp === undefined ? {} : { totp: { ...record.totp } }),
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
    const found = placesOf(record, host);
    const room = Math.max(0, Math.min(MAX_SIGN_INS_PER_ACCOUNT, MAX_SIGN_INS - Object.keys(signIns).length));
    const places = found.places.slice(0, room);
    droppedPlaces += found.dropped + (found.places.length - places.length);
    const facts = record.observed ?? [];
    droppedFacts += facts.filter(fact => !places.some(place => placeKeys(place).includes(fact.at))).length;
    const method = record.method;
    places.forEach((place, index) => {
      const primary = index === 0;
      const kept = facts.filter(fact => placeKeys(place).includes(fact.at)).map(fact => ({ ...fact }));
      if (place.kind === 'site') sitesOf.add(record.key);
      signIns[migratedSignInId(record.key, idKeyOf(place))] = {
        account: record.key,
        place,
        ...(method === undefined
          ? {}
          : { method: { kind: method.kind, ...(method.name === undefined ? {} : { name: method.name }) } }),
        ...(record.recipe === undefined ? {} : { recipe: record.recipe, recipeVersion: 1 }),
        ...(record.recipe === undefined || record.recipeBy === undefined ? {} : { recipeBy: record.recipeBy }),
        ...(primary && record.autoApplyRecipe === true ? { autoApplyRecipe: true as const } : {}),
        ...(kept.length === 0 ? {} : { observed: kept }),
        ...(primary && record.proposals !== undefined && record.proposals.length > 0
          ? { proposals: record.proposals.map(proposal => ({ ...proposal })) }
          : {}),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      };
    });
  }

  // Via links, by key, once every account and its places are known: kept only where the v2 rules hold.
  const providers = new Map<string, Set<string>>();
  for (const handle of handles) {
    const record = v1.entries[handle] as LoginRecordV1;
    const via = record.method?.via;
    const own = Object.values(signIns).filter(signIn => signIn.account === record.key);
    // An account with no sign-in has no method to keep a link on: nothing is lost.
    if (via === undefined || own.length === 0) continue;
    const target = Object.hasOwn(v1.entries, via) ? v1.entries[via] : undefined;
    const viaKey = target?.key;
    const tried = new Map(providers);
    if (viaKey !== undefined) tried.set(record.key, new Set([...(providers.get(record.key) ?? []), viaKey]));
    const keep = viaKey !== undefined && viaKey !== record.key && sitesOf.has(viaKey) && viaLoop(tried) === undefined;
    if (!keep) {
      droppedVia += 1;
      continue;
    }
    providers.set(record.key, new Set([...(providers.get(record.key) ?? []), viaKey]));
    for (const signIn of own) if (signIn.method !== undefined) signIn.method = { ...signIn.method, viaKey };
  }

  const document = {
    v: 2 as const,
    accounts,
    signIns,
    migrated: { from: 1 as const, at: options.now, entries: handles.length },
  };
  const checked = AccountIndexDocumentSchema.safeParse(document);
  if (!checked.success)
    return { ok: false, error: checked.error.issues[0]?.message ?? 'the saved logins cannot become accounts' };
  return {
    ok: true,
    value: {
      document: checked.data,
      report: {
        entries: handles.length,
        accounts: Object.keys(accounts).length,
        signIns: Object.keys(signIns).length,
        droppedFacts,
        droppedPlaces,
        droppedVia,
      },
    },
  };
}
