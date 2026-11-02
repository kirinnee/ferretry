import {
  type AccountId,
  type AccountList,
  type AccountSummary,
  automaticKeysInOfferOrder,
  chosenSignIn,
  fillRoleFor,
  type InputCodeKey,
  type InputSaved,
  type InputSavedOffer,
  InputSavedSchema,
  type InputSensitivity,
  type InputSignIn,
  type InputTargetFacts,
  type LoginFieldRole,
  LoginMatchSchema,
  matchedSignIns,
  namesSignIn,
  type SignInChoiceContext,
  type SignInSummary,
  savedRolesOf,
  signInMatches,
  strongestSensitivity,
  suggestedNewAccount,
  type TwoFactorId,
  type TwoFactorKeySummary,
} from '@ferretry/protocol';

/**
 * WHICH SIGN-IN IS FOR THIS TARGET — decided by the daemon from what IT observed, never by the agent.
 *
 * A terminal's key is `program@host`: the PROVED foreground program's name (no key when it is unproved) and this
 * machine's short host name (`sudo@kirin-box`). For `ssh`, `scp` and `sftp` the host is the destination on the command line when one
 * can be read (`ssh@build.example.com`), because the password is the remote one. A page's key is its
 * origin's host (`github.com`). Matching is EXACT: a look-alike host or another program is not a match, so
 * it is never the one-tap choice — though the owner can still pick an account by hand where that is safe.
 *
 * A key is matched against a SIGN-IN's place (accounts.ts `signInMatches`): a terminal by its `tool@host`, a page by
 * where the sign-in SIGNS IN (its login domains: `accounts.google.com` for a Google account), so the provider's page is
 * where the provider's password is matched, and the site that sends the ferret there is not.
 */

const REMOTE_PROGRAMS = new Set(['ssh', 'scp', 'sftp']);
/** ssh's options that take a value, so the destination is not mistaken for one. */
const SSH_VALUE_OPTIONS = new Set('BbcDEeFIiJLlmOoPpQRSWw'.split(''));

/** The destination host an ssh-family command line names, lowercased, or `undefined` when it cannot be read. */
export function remoteHostOf(argv: string): string | undefined {
  const words = argv.trim().split(/\s+/u).slice(1);
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] as string;
    if (word === '--') {
      return hostPart(words[index + 1]);
    }
    if (word.startsWith('-')) {
      const option = word.slice(1);
      if (option.length === 1 && SSH_VALUE_OPTIONS.has(option)) index += 1;
      continue;
    }
    return hostPart(word);
  }
  return undefined;
}

function hostPart(word: string | undefined): string | undefined {
  if (word === undefined) return undefined;
  const withoutScheme = word.replace(/^(?:ssh|sftp):\/\//u, '');
  const afterUser = withoutScheme.slice(withoutScheme.lastIndexOf('@') + 1);
  const host = afterUser.replace(/:.*$/u, '').toLowerCase();
  return host === '' ? undefined : host;
}

/** The target's key, or `undefined` when what was seen cannot be named as one a saved login could match. */
export function targetMatchKey(facts: InputTargetFacts, hostName: string): string | undefined {
  let key: string | undefined;
  if (facts.kind === 'secret') return undefined;
  if (facts.kind === 'terminal') {
    // The PROVED program only: a shell that calls itself `sudo` must not make the sudo password the one-tap choice. And
    // only in line mode: a relay (`ssh -t`, `docker exec -it`) would hand the password to a reader it was never asked of.
    const program = facts.program?.trim().toLowerCase();
    if (program === undefined || program === '' || facts.canonical !== true) return undefined;
    const host = REMOTE_PROGRAMS.has(program) ? remoteHostOf(facts.foreground.argv) : shortHost(hostName);
    key = host === undefined ? undefined : `${program}@${host}`;
  } else {
    try {
      key = new URL(facts.origin).host.toLowerCase();
    } catch {
      key = undefined;
    }
  }
  return key !== undefined && LoginMatchSchema.safeParse(key).success ? key : undefined;
}

/** This machine's name as a key uses it: the first label, lowercase. */
export function shortHost(hostName: string): string | undefined {
  const host = hostName.trim().toLowerCase().split('.')[0] ?? '';
  return host === '' ? undefined : host;
}

/** Which field a typed value is saved as. A one-time code is never saved: its seed is, from Settings. */
export function savedFieldFor(sensitivity: InputSensitivity): Exclude<LoginFieldRole, 'totp'> | undefined {
  if (sensitivity === 'private' || sensitivity === 'code') return undefined;
  return sensitivity === 'secret' ? 'password' : 'username';
}

/** The accounts and sign-ins a card is drawn from: the store's listing, by handle. */
export type SavedListing = Pick<AccountList, 'accounts' | 'signIns'>;

/**
 * The sign-ins the daemon matched to this target's key: EXACT, a page by where a sign-in signs in (its login domains),
 * a terminal by its `tool@host` key. One account has at most one here: (account, place) is unique in the store.
 */
export function signInsAt(matchKey: string | undefined, listing: SavedListing): readonly SignInSummary[] {
  return matchedSignIns(matchKey, listing.signIns);
}

/** The account's sign-in the daemon matched to this key, if it has one. */
export function signInOfAt(
  account: AccountId,
  matchKey: string | undefined,
  listing: SavedListing,
): SignInSummary | undefined {
  return signInsAt(matchKey, listing).find(signIn => signIn.account === account);
}

/**
 * How a sign-in this target is for signs in, when it is NOT a password: the owner's card says "Sign in with Google via
 * …". A sign-in is for it by its login domains or by what its site is for, so a site that only sends the ferret to a
 * provider still says so.
 */
export function signInFor(matchKey: string | undefined, listing: SavedListing): InputSignIn | undefined {
  if (matchKey === undefined) return undefined;
  const signIn = listing.signIns.find(
    candidate =>
      candidate.method.kind !== 'password' &&
      (signInMatches(candidate.place, matchKey) ||
        (candidate.place.kind === 'site' && candidate.place.match.includes(matchKey))),
  );
  const account = signIn === undefined ? undefined : listing.accounts.find(each => each.id === signIn.account);
  if (signIn === undefined || account === undefined) return undefined;
  return {
    id: account.id,
    label: account.label,
    method: signIn.method,
    ...(signIn.via === undefined ? {} : { via: { id: signIn.via.account.id, label: signIn.via.account.label } }),
  };
}

function holds(account: AccountSummary, role: LoginFieldRole): boolean {
  return role === 'username' ? account.username !== undefined : account.fields[role];
}

/** The account a ferret's `secretHint` names: an account handle, or the account of the `si_…` it names. */
function hintedAccount(hint: string | undefined, listing: SavedListing): AccountId | undefined {
  if (hint === undefined) return undefined;
  return namesSignIn(hint) ? listing.signIns.find(signIn => signIn.id === hint)?.account : hint;
}

/**
 * Whether an account may be offered BY HAND ("Use another account…") on this card: a value the daemon did not match to
 * this target, typed only because the owner picked it. Never:
 * - a one-time code: a code belongs to the sign-in it was made for;
 * - on a target a sign-in reaches THROUGH A PROVIDER ("Sign in with Google"): no saved password belongs on that site's
 *   own page, so nothing but what the daemon matched there is offered — whether or not the link to the provider's
 *   account survived (a migration that dropped a `via` leaves the provider unnamed, never one tap away);
 * - a provider: an account a sign-in goes via. Its password belongs on its own login domains, where it is matched.
 */
function handPickable(
  account: AccountSummary,
  roles: readonly LoginFieldRole[],
  throughProvider: boolean,
  providers: ReadonlySet<AccountId>,
): boolean {
  return !roles.includes('totp') && !throughProvider && !providers.has(account.id);
}

/**
 * WHAT THE OWNER'S CARD MAY OFFER, for a card whose fields need `roles`, filled from ONE account that holds them all:
 *
 * 1. the sign-ins the daemon MATCHED to the key (exact), of accounts that hold every field;
 * 2. the primary: {@link chosenSignIn} among those ONLY — the ferret's hint, a default, or the only one. Two or more
 *    matched and nothing chose one: no primary, and the owner picks. A hint or a default naming an account with no
 *    sign-in matched here is never promoted (a hinted one is still tagged);
 * 3. then, by hand, the other accounts that hold the fields ({@link handPickable}), hinted first, then by label.
 *
 * Nothing here types anything: the owner's tap is the permission.
 */
function offered(
  roles: readonly LoginFieldRole[],
  fills: LoginFieldRole,
  matchKey: string | undefined,
  listing: SavedListing,
  context: SavedChoiceContext,
): {
  readonly offers: readonly InputSavedOffer[];
  readonly signIn: InputSignIn | undefined;
  readonly differentFrom: InputSaved['differentFrom'];
} {
  // A code the daemon makes is offered only where it may type one ({@link codeTargetProblem}): nowhere else, not even
  // as a button that would then be refused.
  const makesCode = roles.includes('totp');
  if (makesCode && context.codesHere !== true)
    return { offers: [], signIn: signInFor(matchKey, listing), differentFrom: undefined };
  const holders = listing.accounts.filter(account => roles.every(role => holds(account, role)));
  const byId = new Map(holders.map(account => [account.id, account]));
  const matched = signInsAt(matchKey, listing).filter(signIn => byId.has(signIn.account));
  const chosen = chosenSignIn(matchKey, matched, context);
  // The page is signing in someone else (the ferret typed another username there): the one-tap is REMOVED, never moved
  // to another account. A typed username only ever takes a choice away.
  const chosenAccount = chosen === undefined ? undefined : accountOfSignIn(chosen.signIn, matched, byId);
  const differs = chosenAccount !== undefined && someoneElse(context.typedUsername, chosenAccount);
  const choice = differs ? undefined : chosen;
  const hinted = hintedAccount(context.hint, listing);
  const signIn = signInFor(matchKey, listing);
  const providers = new Set(listing.signIns.flatMap(each => (each.via === undefined ? [] : [each.via.account.id])));
  const base = (account: AccountSummary) => ({
    id: account.id,
    label: account.label,
    ...(account.username === undefined ? {} : { username: account.username }),
    fills,
  });
  const atKey: InputSavedOffer[] = matched
    .map(each => {
      const account = byId.get(each.account) as AccountSummary;
      const primary = choice?.signIn === each.id;
      const codes = makesCode ? codeKeysOf(account) : [];
      return {
        ...base(account),
        matched: true,
        signIn: each.id,
        ...(hinted === account.id ? { hinted: true } : {}),
        ...(codes.length === 0 ? {} : { codes }),
        ...(primary && choice !== undefined
          ? {
              primary: true as const,
              why: choice.why,
              ...(choice.project === undefined ? {} : { project: choice.project }),
            }
          : {}),
      };
    })
    .sort(
      (left, right) =>
        Number(right.primary === true) - Number(left.primary === true) || left.label.localeCompare(right.label),
    );
  const here = new Set(matched.map(each => each.account));
  const byHand: InputSavedOffer[] = holders
    .filter(account => !here.has(account.id) && handPickable(account, roles, signIn !== undefined, providers))
    .map(account => ({ ...base(account), matched: false, ...(hinted === account.id ? { hinted: true } : {}) }))
    .sort(
      (left, right) =>
        Number(right.hinted === true) - Number(left.hinted === true) || left.label.localeCompare(right.label),
    );
  return {
    offers: [...atKey, ...byHand],
    signIn,
    differentFrom: differs && chosenAccount !== undefined ? refOf(chosenAccount) : undefined,
  };
}

/** The account of a sign-in among those matched here. */
function accountOfSignIn(
  signInId: string,
  matched: readonly SignInSummary[],
  byId: ReadonlyMap<AccountId, AccountSummary>,
): AccountSummary | undefined {
  const signIn = matched.find(each => each.id === signInId);
  return signIn === undefined ? undefined : byId.get(signIn.account);
}

/** An account as a card names it: handle, label, and its username when it has one. */
const refOf = (account: AccountSummary): NonNullable<InputSaved['update']> => ({
  id: account.id,
  label: account.label,
  ...(account.username === undefined ? {} : { username: account.username }),
});

/**
 * Whether the username typed on the page is NOT this account's: it differs (ignoring case and surrounding space), or
 * the account has none saved, so nothing says it is the same person. No typed username: nothing is known, so no.
 */
export function someoneElse(typed: string | undefined, account: Pick<AccountSummary, 'username'>): boolean {
  if (typed === undefined) return false;
  const saved = account.username?.trim().toLowerCase();
  return saved === undefined || saved !== typed.trim().toLowerCase();
}

/**
 * WHERE "SAVE AS" COULD KEEP A TYPED VALUE:
 *
 * - `update`: the account {@link chosenSignIn} picks among EVERY sign-in matched here (whatever fields it holds; the
 *   ferret's hint is not asked). Two or more sign in here and nothing chose one: none, so a password never lands on
 *   "the first". The typed username never CHOOSES it; it only takes it away: when the page is signing in someone the
 *   account is not ({@link someoneElse}, which an account with no username saved always is), there is no `update` and
 *   the daemon refuses one (the owner can add the username in Settings › Accounts first).
 * - `newAccount`: a new one named from the place and the typed username ({@link suggestedNewAccount}), whose CLI name
 *   no account has.
 *
 * Neither saves anything: the owner picks "Save as a new account" or "Update" on the card. `suggest` is what an older
 * app pre-fills: `update`, else `newAccount` (two or more here, nothing chosen and no one typed: nothing, as before).
 */
function suggestFor(
  matchKey: string | undefined,
  listing: SavedListing,
  context: SavedChoiceContext,
): Pick<InputSaved, 'suggest' | 'update' | 'newAccount'> {
  if (matchKey === undefined) return {};
  const atKey = signInsAt(matchKey, listing);
  const typed = context.typedUsername;
  const choice = atKey.length === 0 ? undefined : chosenSignIn(matchKey, atKey, { ...context, hint: undefined });
  const signIn = choice === undefined ? undefined : atKey.find(each => each.id === choice.signIn);
  const chosen = signIn === undefined ? undefined : listing.accounts.find(each => each.id === signIn.account);
  const account = chosen !== undefined && !someoneElse(typed, chosen) ? chosen : undefined;
  const newAccount = suggestedNewAccount(matchKey, typed, new Set(listing.accounts.map(each => each.id)));
  const suggest =
    account !== undefined
      ? { id: account.id, label: account.label }
      : atKey.length > 0 && chosen === undefined && typed === undefined
        ? undefined
        : newAccount;
  return {
    ...(suggest === undefined ? {} : { suggest }),
    ...(account === undefined ? {} : { update: refOf(account) }),
    newAccount,
  };
}

/**
 * How a card's offers are chosen: the sign-in choice ({@link SignInChoiceContext}) and `codesHere`, the DAEMON's word
 * that the target may take a one-time code it makes ({@link codeTargetProblem} found nothing). Absent: no offer that
 * makes a code, so a caller that has not looked never offers one.
 */
export type SavedChoiceContext = SignInChoiceContext & {
  readonly codesHere?: boolean;
  /**
   * The username the ferret typed into this page's identifier field (typed-identities.ts): the DAEMON's record of the
   * ferret's own act, so only ever the ferret's word. It removes a one-tap and names a new account; nothing more.
   */
  readonly typedUsername?: string;
};

/** The "Use code from Ferretry" buttons of an account: each key whose seed Ferretry holds, in offer order. */
function codeKeysOf(account: AccountSummary): readonly InputCodeKey[] {
  return automaticKeysInOfferOrder(account.factors).map(key => ({
    factor: key.id,
    label: key.label,
    ...(key.kind === 'totp' && key.verified !== undefined
      ? { checked: key.verified.worked ? 'worked' : 'failed' }
      : {}),
  }));
}

/**
 * WHY THE DAEMON MAY NOT TYPE A ONE-TIME CODE IT MADE into these fields of what it saw, or `undefined` when it may. A
 * code it makes is a second factor typed by the machine itself, so where it lands is not the owner's call on a flag:
 *
 * - never into the secret store, and never before the daemon has looked at the target again;
 * - a page: only on https, into a field the browser reported visible and uncovered, in the page's own frame (a frame
 *   from another origin could be anyone's), so the code goes exactly where the matched sign-in signs in;
 * - a terminal: the card's one prompt, whose key (`tool@host` of a PROVED program in line mode) the sign-in matched.
 *
 * Fixed sentences only: they reach the owner and the log.
 */
export function codeTargetProblem(
  facts: InputTargetFacts | undefined,
  fieldIds: readonly string[],
): string | undefined {
  if (facts === undefined) return 'Ferretry is looking at the target again';
  if (facts.kind === 'secret') return 'a code Ferretry makes is typed only into a sign-in';
  if (facts.kind === 'terminal') return undefined;
  if (!facts.secure) return 'the page is not https';
  for (const id of fieldIds) {
    const found = facts.fields.find(field => field.fieldId === id);
    if (found === undefined || !found.visible) return 'Ferretry cannot see the code field on the page';
    if (found.covered === true) return 'something on the page covers the code field';
    if (found.frameOrigin !== facts.origin) return 'the code field is inside a frame from another site';
  }
  return undefined;
}

/**
 * THE ACCOUNT A CODE CARD IS ABOUT, and its 2FA keys, for the card's title (`factorAskWords`): from the sign-ins the
 * daemon matched to the key, WHATEVER fields their accounts hold (so whether a seed is held never changes the title).
 * The ferret's `factor` names one key when it is a key of such an account; otherwise it is ignored, never an error.
 * Without it, {@link chosenSignIn} picks the account (the hint, a default, or the only one); none chosen: none.
 */
export function codeCardKeys(
  matchKey: string | undefined,
  listing: SavedListing,
  context: Omit<SignInChoiceContext, 'hint'> & { readonly hint?: string; readonly factor?: TwoFactorId },
): { readonly account: AccountSummary; readonly keys: readonly TwoFactorKeySummary[] } | undefined {
  const matched = signInsAt(matchKey, listing);
  const accountOf = (id: AccountId): AccountSummary | undefined => listing.accounts.find(each => each.id === id);
  const named = context.factor;
  if (named !== undefined) {
    for (const signIn of matched) {
      const account = accountOf(signIn.account);
      const key = account?.factors.find(each => each.id === named);
      if (account !== undefined && key !== undefined) return { account, keys: [key] };
    }
  }
  const { factor: _factor, ...order } = context;
  const choice = chosenSignIn(matchKey, matched, order);
  const signIn = choice === undefined ? undefined : matched.find(each => each.id === choice.signIn);
  const account = signIn === undefined ? undefined : accountOf(signIn.account);
  return account === undefined ? undefined : { account, keys: account.factors };
}

/** What a card of one field may offer, and what "Save as" would keep. */
export function savedFor(
  sensitivity: InputSensitivity,
  matchKey: string | undefined,
  listing: SavedListing,
  context: SavedChoiceContext = {},
): InputSaved {
  const role = fillRoleFor(sensitivity);
  const { offers, signIn, differentFrom } = offered([role], role, matchKey, listing, context);
  const saves = savedFieldFor(sensitivity);
  return {
    ...(matchKey === undefined ? {} : { match: matchKey }),
    ...(saves === undefined ? {} : suggestFor(matchKey, listing, context)),
    ...(saves === undefined ? {} : { saves }),
    offers,
    ...(signIn === undefined ? {} : { signIn }),
    ...identityOf(context, differentFrom),
    ...projectOf(context),
  };
}

/** Who the page is signing in, as the ferret typed it, and the one-tap that took away: the owner's view only. */
const identityOf = (
  context: SavedChoiceContext,
  differentFrom: InputSaved['differentFrom'],
): Pick<InputSaved, 'typedUsername' | 'differentFrom'> => ({
  ...(context.typedUsername === undefined ? {} : { typedUsername: context.typedUsername }),
  ...(differentFrom === undefined ? {} : { differentFrom }),
});

/** The project the session works on, for the card's "Always use for <project>": the daemon's reading, never the ferret's. */
const projectOf = (context: SavedChoiceContext): Pick<InputSaved, 'project'> => {
  if (context.project === undefined) return {};
  // A name that is not one short line would make the whole card unreadable; the card then just has no such link.
  const shown = InputSavedSchema.shape.project.safeParse({ id: context.project.id, name: context.project.name });
  return shown.success && shown.data !== undefined ? { project: shown.data } : {};
};

/**
 * What a card of one or more fields may offer. One field is {@link savedFor}. Several are filled from ONE account, so
 * only an account that holds every field's value is offered (a login with a username and a password for "Email" +
 * "Password"). "Save as" keeps the card's username and password together in one account ({@link savedRolesOf}); it is
 * suggested only for a card that can be kept that way, and `saves` names the password when there is one, else the
 * username.
 */
export function savedForFields(
  fields: readonly { readonly id: string; readonly sensitivity: InputSensitivity }[],
  matchKey: string | undefined,
  listing: SavedListing,
  context: SavedChoiceContext = {},
): InputSaved {
  const [only] = fields;
  if (fields.length === 1 && only !== undefined) return savedFor(only.sensitivity, matchKey, listing, context);
  const roles = fields.map(field => fillRoleFor(field.sensitivity));
  const fills = fillRoleFor(strongestSensitivity(fields));
  const { offers, signIn, differentFrom } = offered(roles, fills, matchKey, listing, context);
  const kept = savedRolesOf(fields);
  return {
    ...(matchKey === undefined ? {} : { match: matchKey }),
    ...(kept === undefined ? {} : suggestFor(matchKey, listing, context)),
    ...(kept === undefined ? {} : { saves: [...kept.values()].includes('password') ? 'password' : 'username' }),
    offers,
    ...(signIn === undefined ? {} : { signIn }),
    ...identityOf(context, differentFrom),
    ...projectOf(context),
  };
}
