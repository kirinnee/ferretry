import {
  type AccountId,
  type AccountList,
  type AccountSummary,
  chosenSignIn,
  fillRoleFor,
  type InputSaved,
  type InputSavedOffer,
  type InputSensitivity,
  type InputSignIn,
  type InputTargetFacts,
  type LoginFieldRole,
  LoginMatchSchema,
  matchedSignIns,
  namesSignIn,
  savedRolesOf,
  type SignInChoiceContext,
  signInMatches,
  type SignInSummary,
  strongestSensitivity,
  suggestedLoginId,
  suggestedLoginLabel,
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
  context: SignInChoiceContext,
): { readonly offers: readonly InputSavedOffer[]; readonly signIn: InputSignIn | undefined } {
  const holders = listing.accounts.filter(account => roles.every(role => holds(account, role)));
  const byId = new Map(holders.map(account => [account.id, account]));
  const matched = signInsAt(matchKey, listing).filter(signIn => byId.has(signIn.account));
  const choice = chosenSignIn(matchKey, matched, context);
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
      return {
        ...base(account),
        matched: true,
        signIn: each.id,
        ...(hinted === account.id ? { hinted: true } : {}),
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
  return { offers: [...atKey, ...byHand], signIn };
}

/**
 * The account "Save as" would update: the one {@link chosenSignIn} picks among EVERY sign-in matched here (whatever
 * fields it holds; the ferret's hint is not asked), or a new one named from the key when none signs in here. Two or
 * more sign in here and nothing chose one: none is suggested, so a typed password never lands on "the first" of them.
 */
function suggestFor(
  matchKey: string | undefined,
  listing: SavedListing,
  context: SignInChoiceContext,
): InputSaved['suggest'] {
  if (matchKey === undefined) return undefined;
  const atKey = signInsAt(matchKey, listing);
  if (atKey.length === 0) return { id: suggestedLoginId(matchKey), label: suggestedLoginLabel(matchKey) };
  const choice = chosenSignIn(matchKey, atKey, { ...context, hint: undefined });
  const signIn = choice === undefined ? undefined : atKey.find(each => each.id === choice.signIn);
  const account = signIn === undefined ? undefined : listing.accounts.find(each => each.id === signIn.account);
  return account === undefined ? undefined : { id: account.id, label: account.label };
}

/** What a card of one field may offer, and what "Save as" would keep. */
export function savedFor(
  sensitivity: InputSensitivity,
  matchKey: string | undefined,
  listing: SavedListing,
  context: SignInChoiceContext = {},
): InputSaved {
  const role = fillRoleFor(sensitivity);
  const { offers, signIn } = offered([role], role, matchKey, listing, context);
  const saves = savedFieldFor(sensitivity);
  const suggest = saves === undefined ? undefined : suggestFor(matchKey, listing, context);
  return {
    ...(matchKey === undefined ? {} : { match: matchKey }),
    ...(suggest === undefined ? {} : { suggest }),
    ...(saves === undefined ? {} : { saves }),
    offers,
    ...(signIn === undefined ? {} : { signIn }),
  };
}

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
  context: SignInChoiceContext = {},
): InputSaved {
  const [only] = fields;
  if (fields.length === 1 && only !== undefined) return savedFor(only.sensitivity, matchKey, listing, context);
  const roles = fields.map(field => fillRoleFor(field.sensitivity));
  const fills = fillRoleFor(strongestSensitivity(fields));
  const { offers, signIn } = offered(roles, fills, matchKey, listing, context);
  const kept = savedRolesOf(fields);
  const suggest = kept === undefined ? undefined : suggestFor(matchKey, listing, context);
  return {
    ...(matchKey === undefined ? {} : { match: matchKey }),
    ...(suggest === undefined ? {} : { suggest }),
    ...(kept === undefined ? {} : { saves: [...kept.values()].includes('password') ? 'password' : 'username' }),
    offers,
    ...(signIn === undefined ? {} : { signIn }),
  };
}
