import {
  type AccountKey,
  type AccountSummary,
  type AccountList,
  chosenSignIn,
  type GrantMissReason,
  type LoginObserved,
  placeKeys,
  type SignInChoiceContext,
  type SignInField,
  type SignInSummary,
  TASK_PLAN_MAX_CANDIDATES,
  type TaskPlanCandidate,
  type TaskPlanLine,
  type TaskPlanLineAsk,
  type TaskPlanLineFlag,
  type TaskPlanLinePins,
  taskPlanCoversTool,
  taskPlanKeysFitLine,
} from '@ferretry/protocol';

/**
 * RESOLVING A FERRET'S ASKS AGAINST THE OWNER'S ACCOUNTS (docs/secure-copy.md, "Task plans").
 *
 * A line names a sign-in (`si_…`), a host the owner saved, or a `tool@host`: a LOOKUP KEY, never a place of its own. The
 * daemon finds the sign-ins it stands for in the account listing, and the card is drawn from what was found. Pure: the
 * listing and the owner's defaults come in, a line comes out; nothing here reads a page, a terminal or a clock.
 */

/** The accounts and sign-ins a line is resolved against. */
export type PlanListing = Pick<AccountList, 'accounts' | 'signIns'>;

/** A sign-in line whose ask the daemon resolved, before it is numbered. */
type SignInLine = Extract<TaskPlanLine, { readonly kind: 'sign-in' | 'terminal-sign-in' }>;

/**
 * HISTORY: an identity seen at one of the sign-in's own match keys with its secret field masked and the page moving on
 * after the submit, twice or more (the daemon's own looks only, #1183). The identities with history, or `undefined`
 * for none: then the first fill must pass every check and pins the form.
 */
export function historyIdentities(signIn: Pick<SignInSummary, 'place' | 'observed'>): readonly string[] | undefined {
  const keys = new Set(placeKeys(signIn.place));
  const seen = (signIn.observed ?? []).filter(
    (fact: LoginObserved) =>
      keys.has(fact.at) &&
      fact.masked?.value === true &&
      fact.navigatedAway?.value === true &&
      fact.navigatedAway.count >= 2,
  );
  return seen.length === 0 ? undefined : [...new Set(seen.map(fact => fact.identity))].sort();
}

/** The last second factor the daemon saw at the sign-in's match keys: informational, it gates nothing. */
function lastSecondFactor(signIn: Pick<SignInSummary, 'place' | 'observed'>): TaskPlanCandidate['lastSecondFactor'] {
  const keys = new Set(placeKeys(signIn.place));
  let last: TaskPlanCandidate['lastSecondFactor'];
  for (const fact of signIn.observed ?? [])
    if (keys.has(fact.at) && fact.secondFactor !== undefined)
      if (last === undefined || Date.parse(fact.secondFactor.observedAt) > Date.parse(last.observedAt))
        last = fact.secondFactor;
  return last;
}

/** Whether a sign-in types a password the daemon holds: not a provider sign-in ("ClickUp via Google"). */
const isPassword = (signIn: SignInSummary): boolean => signIn.method.kind === 'password' && signIn.via === undefined;

/** The candidate the owner's card shows for one sign-in. OWNER VIEW ONLY: `can` and `history` say what is held. */
export function candidateOf(signIn: SignInSummary, account: AccountSummary): TaskPlanCandidate {
  const factor = lastSecondFactor(signIn);
  return {
    signIn: signIn.id,
    account: { id: account.id, label: account.label },
    ...(account.username === undefined ? {} : { username: account.username }),
    place: signIn.place,
    can: { username: account.username !== undefined, password: account.fields.password, totp: account.fields.totp },
    history: historyIdentities(signIn) !== undefined,
    ...(factor === undefined ? {} : { lastSecondFactor: factor }),
  };
}

const accountOf = (listing: PlanListing, signIn: SignInSummary): AccountSummary | undefined =>
  listing.accounts.find(account => account.id === signIn.account);

/** Whether a sign-in is of the kind a line covers: a page line a site with login domains, a terminal line a terminal. */
const ofKind = (kind: SignInLine['kind'], signIn: SignInSummary): boolean =>
  kind === 'sign-in'
    ? signIn.place.kind === 'site' && signIn.place.domains.length > 0
    : signIn.place.kind === 'terminal';

/** The sign-ins a lookup key stands for, of the line's kind: a site's login domain or `match` host, or a `tool@host`. */
function signInsFor(listing: PlanListing, ask: Exclude<TaskPlanLineAsk, { readonly kind: 'paste' }>): SignInSummary[] {
  if (ask.signIn !== undefined) return listing.signIns.filter(signIn => signIn.id === ask.signIn);
  if (ask.kind === 'sign-in') {
    const site = ask.site;
    return listing.signIns.filter(
      signIn =>
        signIn.place.kind === 'site' &&
        site !== undefined &&
        (signIn.place.domains.includes(site) || signIn.place.match.includes(site)),
    );
  }
  const place = ask.place;
  return listing.signIns.filter(signIn => signIn.place.kind === 'terminal' && placeKeys(signIn.place)[0] === place);
}

/** Why a resolved line can't be pre-approved at all, or `undefined` when it can be ticked. */
function unavailableBecause(
  ask: Exclude<TaskPlanLineAsk, { readonly kind: 'paste' }>,
  found: readonly SignInSummary[],
  usable: readonly SignInSummary[],
): GrantMissReason | undefined {
  if (found.length === 0) return 'not-in-accounts';
  if (ask.kind === 'terminal-sign-in' && !usable.some(signIn => taskPlanCoversTool(placeKeys(signIn.place)[0] ?? '')))
    return found.some(signIn => signIn.place.kind === 'terminal') ? 'tool-not-covered' : 'not-in-accounts';
  if (usable.length === 0) return found.some(signIn => !isPassword(signIn)) ? 'via-provider' : 'not-in-accounts';
  return undefined;
}

/** The line a ferret named a sign-in of the other kind on: it asked for something that line can't be. */
export class PlanAskMismatch extends Error {
  constructor(readonly index: number) {
    super(
      `line ${String(index + 1)} names a sign-in of the other kind: a page sign-in is a "sign-in" line, sudo/su/doas a "terminal-sign-in" line`,
    );
    this.name = 'PlanAskMismatch';
  }
}

/**
 * ONE LINE, AS THE DAEMON RESOLVED IT. A sign-in line lists the password sign-ins its key stands for (at most
 * {@link TASK_PLAN_MAX_CANDIDATES}), preselects only the account the ferret NAMED by id or the owner's own default (the
 * ferret's hint is never asked), and is `unavailable` when nothing can be ticked: not in Accounts, a provider sign-in,
 * a terminal tool other than sudo / su / doas. `why` is the ferret's words, already redacted.
 */
export function resolveLine(
  ask: TaskPlanLineAsk,
  index: number,
  why: string,
  listing: PlanListing,
  choice: Omit<SignInChoiceContext, 'hint'>,
): TaskPlanLine {
  if (ask.kind === 'paste')
    return { kind: 'paste', line: index, uses: ask.uses, why, state: 'waiting', from: ask.from, to: ask.to };
  const found = signInsFor(listing, ask);
  if (
    ask.signIn !== undefined &&
    found.some(signIn => signIn.place.kind !== (ask.kind === 'sign-in' ? 'site' : 'terminal'))
  )
    throw new PlanAskMismatch(index);
  const usable = found.filter(
    signIn =>
      isPassword(signIn) &&
      ofKind(ask.kind, signIn) &&
      accountOf(listing, signIn) !== undefined &&
      (ask.kind === 'sign-in' || taskPlanCoversTool(placeKeys(signIn.place)[0] ?? '')),
  );
  const because = unavailableBecause(ask, found, usable);
  // An unavailable line shows the owner what was found (a provider sign-in, an ssh sign-in), and can't be ticked.
  const shown = (because === undefined ? usable : found)
    .filter(signIn => accountOf(listing, signIn) !== undefined)
    .slice(0, TASK_PLAN_MAX_CANDIDATES);
  const candidates = shown.map(signIn => candidateOf(signIn, accountOf(listing, signIn) as AccountSummary));
  const fields: SignInField[] = ask.kind === 'sign-in' ? [...ask.fields] : ['password'];
  const flags: TaskPlanLineFlag[] = [
    ...(ask.kind === 'terminal-sign-in' ? (['root'] as const) : []),
    ...(fields.includes('totp') ? (['one-factor'] as const) : []),
    ...(because === undefined && candidates.some(candidate => !candidate.history) ? (['no-history'] as const) : []),
  ];
  const base = {
    line: index,
    uses: ask.uses,
    why,
    fields: [...fields],
    candidates: because === undefined ? candidates : candidates.filter(fitsUnavailable(ask.kind)),
    flags,
  };
  if (because !== undefined) return { kind: ask.kind, ...base, state: 'unavailable', because };
  const preselect = preselectOf(ask, candidates, choice);
  return { kind: ask.kind, ...base, state: 'waiting', ...(preselect === undefined ? {} : { preselect }) };
}

/**
 * The candidates an unavailable line may show: of its own place kind (a page line shows sites, a terminal line
 * terminals), so the record's own rule holds; the line can't be ticked whatever it shows.
 */
const fitsUnavailable =
  (kind: SignInLine['kind']) =>
  (candidate: TaskPlanCandidate): boolean =>
    candidate.place.kind === (kind === 'sign-in' ? 'site' : 'terminal');

/**
 * The account chosen before the owner looks: the one the ferret named by id ("Ferret chose this"), else the owner's own
 * default for the session's project, folder or the site, else the only candidate. Never a ferret's pick on a picker:
 * the hint is not asked.
 */
function preselectOf(
  ask: Exclude<TaskPlanLineAsk, { readonly kind: 'paste' }>,
  candidates: readonly TaskPlanCandidate[],
  choice: Omit<SignInChoiceContext, 'hint'>,
): SignInLine['preselect'] {
  const [only] = candidates;
  if (ask.signIn !== undefined) return only === undefined ? undefined : { signIn: only.signIn, why: 'ferret' };
  if (candidates.length === 1 && only !== undefined) return { signIn: only.signIn, why: 'only' };
  const key = ask.kind === 'sign-in' ? ask.site : ask.place;
  const picked = chosenSignIn(
    key,
    candidates.map(candidate => ({ id: candidate.signIn, account: candidate.account.id, place: candidate.place })),
    { ...choice, hint: undefined },
  );
  if (picked === undefined || picked.why === 'ferret') return undefined;
  return { signIn: picked.signIn, why: picked.why };
}

/**
 * Whether two sign-in lines would both be one sign-in: each has exactly one candidate it can be ticked for, and they
 * are the same. One sign-in, one line, or their uses would add together (secrev-1258 L1). The index of the later line.
 */
export function repeatedSignIn(lines: readonly TaskPlanLine[]): number | undefined {
  const seen = new Set<string>();
  for (const line of lines) {
    if (line.kind === 'paste' || line.state !== 'waiting' || line.candidates.length !== 1) continue;
    const signIn = line.candidates[0]?.signIn;
    if (signIn === undefined) continue;
    if (seen.has(signIn)) return line.line;
    seen.add(signIn);
  }
  return undefined;
}

/** What a ticked sign-in is pinned to now, or why it can't be: it was removed, moved account, or changed kind or place. */
export type PinsRead =
  | { readonly ok: true; readonly pins: TaskPlanLinePins }
  | { readonly ok: false; readonly reason: string };

/**
 * THE PINS OF ONE TICKED LINE, snapshotted when the selection is staged: the account's immutable key, the sign-in's
 * match keys (login domains or `tool@host`, never a site's `match` hosts), its recipe version and the identities it has
 * history with. Refused when the sign-in no longer is what the card showed: gone, on another account, or at another
 * place than the candidate the owner was shown (the card would be describing something else).
 */
export function pinsOf(
  kind: SignInLine['kind'],
  candidate: TaskPlanCandidate,
  listing: PlanListing,
  accountKey: AccountKey | undefined,
): PinsRead {
  const signIn = listing.signIns.find(each => each.id === candidate.signIn);
  if (signIn === undefined || signIn.account !== candidate.account.id || accountKey === undefined)
    return { ok: false, reason: 'the sign-in was removed or moved to another account since the plan was raised' };
  const keys = placeKeys(signIn.place);
  const shown = placeKeys(candidate.place);
  if (keys.length !== shown.length || keys.some(key => !shown.includes(key)))
    return { ok: false, reason: "the sign-in's login domains changed since the plan was raised" };
  if (!isPassword(signIn) || !taskPlanKeysFitLine(kind, keys))
    return { ok: false, reason: 'the sign-in is no longer one a plan can cover' };
  const identities = historyIdentities(signIn);
  return {
    ok: true,
    pins: {
      accountKey,
      placeKeys: [...keys],
      ...(signIn.recipeVersion === undefined ? {} : { recipeVersion: signIn.recipeVersion }),
      ...(identities === undefined ? {} : { identities: [...identities] }),
    },
  };
}
