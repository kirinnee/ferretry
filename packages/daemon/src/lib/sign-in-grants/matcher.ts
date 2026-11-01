import {
  type AccountId,
  type AccountKey,
  automaticKeysInOfferOrder,
  factorFingerprint,
  fillRoleFor,
  type GrantMissReason,
  type InputRequestField,
  type InputTargetFacts,
  type LoginFieldRole,
  type PlaceKey,
  placeKeys,
  type SignInField,
  type SignInId,
  type SignInRuleId,
  type SignInRuleScope,
  TASK_PLAN_TERMINAL_TOOLS,
  type TwoFactorId,
} from '@ferretry/protocol';
import { terminalHides } from '../input-requests/lock.ts';
import { identityOf } from '../input-requests/login-observer.ts';
import { codeTargetProblem, type SavedListing } from '../input-requests/saved-logins.ts';

/**
 * THE SHARED MATCHER (docs/input-requests.md, "Task plan fills"): whether ONE permission to fill a sign-in without a tap
 * (a task-plan line or a standing rule) covers ONE card, on what the DAEMON saw. Pure: no clock, no I/O, no
 * state. Every check holds or nothing is typed, and a miss names the first check that failed.
 *
 * Nothing the ferret said is an input except its `secretHint`, and that can only PREVENT a fill (check 7). Where a value
 * may go is the sign-in's own login domains (or its `tool@host`) as pinned when the owner approved: never a site's
 * `match` hosts, never a host the ferret named, never a parent domain.
 */

/** What a grant was pinned to when the owner approved it: part of the bytes the passkey was bound to. */
export interface GrantPins {
  /** Login domains, or `tool@host`; never a site's `match` hosts. */
  readonly placeKeys: readonly PlaceKey[];
  readonly recipeVersion: number | undefined;
  /** The field identities the sign-in had history with, or `undefined`: a plan line's first fill of each field set pins it. */
  readonly identities: readonly string[] | undefined;
}

/** What a standing rule pinned of its account, beside the key: its handle, its username and its 2FA keys' fingerprint. */
export interface GrantAccountPins {
  readonly id: AccountId;
  readonly username: string | undefined;
  readonly factors: string;
}

/** One permission to fill one sign-in without a tap: a task-plan line (R3a) or a standing rule (R3c). */
export interface SignInGrant {
  /** `plan:<planId>:<line>`, or `rule:<sr_…>:<revision>`. */
  readonly id: string;
  readonly source: 'plan' | 'rule';
  /** A plan line: the plan and its 0-based line. */
  readonly plan?: { readonly id: string; readonly line: number };
  /** A standing rule: its id and the revision the owner's passkey approved. */
  readonly rule?: { readonly id: SignInRuleId; readonly revision: number };
  /** A standing rule: which sessions it fills for (check 1b). A rule without one fills for none. */
  readonly scope?: SignInRuleScope;
  /** A standing rule: the one 2FA key its code comes from, chosen when it was approved (never by `verified`). */
  readonly factor?: TwoFactorId;
  /** A standing rule: its account's handle, username and 2FA-key fingerprint as approved (checks 2b and 8). */
  readonly accountPins?: GrantAccountPins;
  /** A standing rule: when the body the passkey approved was made. A page script on its places since taints it. */
  readonly approvedAt?: number;
  /** The session a plan line belongs to; a plan line always has one. */
  readonly sessionId?: string;
  /** A page sign-in or a terminal one (sudo, su, doas). */
  readonly surface: 'page' | 'terminal';
  readonly signIn: SignInId;
  /** The immutable `L…` key: a rename can't redirect a grant. */
  readonly accountKey: AccountKey;
  readonly fields: ReadonlySet<SignInField>;
  readonly pins: GrantPins;
  readonly expiresAt: number;
  /** In force, or why not: a line whose uses are spent, or that the daemon stopped, still says so on the card. */
  readonly state: 'in-force' | 'used-up' | 'stopped';
  /** Uses left (a line in force has at least one). */
  readonly remaining: number;
}

/**
 * WHERE A PAGE SCRIPT RAN, machine-wide (`browser.eval`, any session): the last time per host, and the last time one ran
 * on a page whose origin could not be read (`everywhere`: it may have been any).
 */
export interface ScriptedOriginsView {
  readonly hosts: ReadonlyMap<string, number>;
  readonly everywhere?: number;
}

/** No page script has run anywhere. */
export const NO_SCRIPTED_ORIGINS: ScriptedOriginsView = { hosts: new Map() };

/**
 * Whether a page script ran on one of a rule's login domains since the body its passkey approved was made (or ran
 * somewhere unreadable): ferret A's script on github.com can arm storage that github.com's own code reads when ferret
 * B's fill types, weeks later, in the one shared browser profile.
 */
export function scriptedSince(
  view: ScriptedOriginsView,
  keys: readonly PlaceKey[],
  approvedAt: number | undefined,
): boolean {
  const since = (at: number | undefined): boolean => at !== undefined && (approvedAt === undefined || at >= approvedAt);
  return since(view.everywhere) || keys.some(key => since(view.hosts.get(key)));
}

/**
 * Whether a standing rule's scope covers this session (check 1b): `any` ferret; exactly this `session` (never its
 * children); or the sessions STAMPED with this board `project` (a project read from a folder never matches).
 */
export function scopeCovers(scope: SignInRuleScope, sessionId: string, project: string | undefined): boolean {
  switch (scope.kind) {
    case 'any':
      return true;
    case 'session':
      return scope.session === sessionId;
    case 'project':
      return project !== undefined && project === scope.project;
  }
}

/** Everything the matcher reads. All of it the daemon observed or holds; nothing from the ferret but `hint`. */
export interface GrantSighting {
  readonly sessionId: string;
  /** From the daemon's own look: the same facts the card's digest covers. */
  readonly facts: InputTargetFacts;
  /** `targetMatchKey(facts, host)`: a page's host, or a PROVED program's `tool@host`. */
  readonly matchKey: string | undefined;
  /** The card's fields AFTER `observedAs`: a code going into a password is a secret. */
  readonly fields: readonly InputRequestField[];
  /** The account store now. */
  readonly listing: SavedListing;
  /** Each account's immutable key now. */
  readonly keys: ReadonlyMap<AccountId, AccountKey>;
  /** The ferret ran a page script in this session (the login observer); unknown counts as yes. */
  readonly scripted: boolean;
  /** The pages ANY session ran a script on, across the machine (check 15b): a standing rule fills for every ferret. */
  readonly scriptedOrigins: ScriptedOriginsView;
  /** The session's STAMPED board project, for a rule's project scope: never resolved from its folder, never Unfiled. */
  readonly project?: string;
  /** The ferret's `secretHint`: it can only prevent a fill. */
  readonly hint?: string;
  readonly now: number;
}

export type GrantMatch =
  | {
      readonly ok: true;
      /** The account a fill types from, and the role each card field takes, in the card's order. */
      readonly account: AccountId;
      readonly fills: readonly LoginFieldRole[];
      /** The automatic 2FA key a code is made from, when the card has a code field. */
      readonly factor?: TwoFactorId;
      /** The form's identity, and the field set it is pinned for (`username+password`, `totp`, …). */
      readonly identity: string;
      readonly fieldSet: string;
    }
  | { readonly ok: false; readonly reason: GrantMissReason };

const miss = (reason: GrantMissReason): GrantMatch => ({ ok: false, reason });

const sameKeys = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every(key => right.includes(key)) && right.every(key => left.includes(key));

/** The field set a card fills, as pins are kept: its roles, sorted and joined (`password`, `username+password`). */
export const fieldSetOf = (roles: readonly LoginFieldRole[]): string => [...new Set(roles)].sort().join('+');

/**
 * The roles a card's fields take under a grant, or why it can't: a `private` value is never covered, a code needs the
 * code tick, every other role must be one the grant covers, and a card fills at most one of each (a form asking for two
 * passwords is a change-password form, not a sign-in).
 */
function rolesUnder(
  grant: SignInGrant,
  fields: readonly InputRequestField[],
): readonly LoginFieldRole[] | GrantMissReason {
  if (fields.length === 0) return 'field-not-covered';
  const roles: LoginFieldRole[] = [];
  for (const field of fields) {
    if (field.sensitivity === 'private') return 'field-not-covered';
    const role = fillRoleFor(field.sensitivity);
    if (role === 'totp' && !grant.fields.has('totp')) return 'code-not-ticked';
    if (!grant.fields.has(role)) return 'field-not-covered';
    if (roles.includes(role)) return 'field-not-covered';
    roles.push(role);
  }
  return roles;
}

/** A page's checks (10–16): https, one origin, real password boxes, everything visible, no human check, no script. */
function pageProblem(
  facts: Extract<InputTargetFacts, { readonly kind: 'browser' }>,
  fields: readonly InputRequestField[],
  roles: readonly LoginFieldRole[],
  scripted: boolean,
): GrantMissReason | undefined {
  let https: boolean;
  try {
    https = new URL(facts.origin).protocol === 'https:';
  } catch {
    https = false;
  }
  if (!https) return 'not-https';
  const found = fields.map(field => facts.fields.find(each => each.fieldId === field.id));
  if (found.some(each => each !== undefined && each.frameOrigin !== facts.origin)) return 'frame';
  for (const [index, role] of roles.entries()) {
    const seen = found[index];
    if (role !== 'password') continue;
    if (
      seen === undefined ||
      seen.field.tag.toLowerCase() !== 'input' ||
      seen.field.type?.toLowerCase() !== 'password' ||
      !seen.visible ||
      seen.covered === true
    )
      return 'password-field';
  }
  if (found.some(each => each === undefined || !each.visible || each.covered === true)) return 'field-hidden';
  if (facts.challenge !== undefined) return 'challenge';
  if (scripted) return 'scripted';
  const codes = fields.filter((_, index) => roles[index] === 'totp').map(field => field.id);
  if (codes.length > 0 && codeTargetProblem(facts, codes) !== undefined) return 'code-target';
  return undefined;
}

/** A terminal's checks (10t–12t): a PROVED program, line mode, echo off, sudo / su / doas running setuid root, one password. */
function terminalProblem(
  facts: Extract<InputTargetFacts, { readonly kind: 'terminal' }>,
  roles: readonly LoginFieldRole[],
): GrantMissReason | undefined {
  if (
    facts.program === undefined ||
    facts.canonical !== true ||
    facts.echo !== 'off' ||
    facts.recognisedConsumer !== true
  )
    return 'not-proved';
  if (!terminalHides(facts) || !(TASK_PLAN_TERMINAL_TOOLS as readonly string[]).includes(facts.program))
    return 'not-system';
  if (roles.length !== 1 || roles[0] !== 'password') return 'field-not-covered';
  return undefined;
}

/**
 * WHETHER `grant` COVERS THIS CARD, in the order of the checks (docs/input-requests.md): in force (1), and for a standing
 * rule inside its scope (1b); the sign-in still the account's (2), and for a rule the account's handle and username as
 * approved (2b); its place (3) and recipe (4) unchanged since the owner approved; this target one of its pinned keys
 * EXACTLY (5); every field a role the grant covers (6); the ferret's hint not naming another account (7); the account
 * holding every value it must type, a rule's code only from its PINNED key with the 2FA keys as approved (8); then the
 * page's or the terminal's own checks, for a rule no page script on its places anywhere on the machine (15b), and the
 * form's identity (17, 13t): a rule fills only forms the owner's own taps have history with, for every field set.
 * `pinned` holds the identity each field set was first filled with under this grant. The rate limit and the uses are the
 * ledger's (check 9).
 */
export function matchSignInGrant(
  grant: SignInGrant,
  seen: GrantSighting,
  pinned: ReadonlyMap<string, string>,
): GrantMatch {
  const rule = grant.source === 'rule';
  // 1. In force: not stopped (a rule: not suspended), not expired, this very session. Uses are the ledger's: a later
  //    step of an open attempt continues on the use it spent, even when none is left.
  if (grant.state === 'stopped') return miss(rule ? 'suspended' : 'stopped');
  if (grant.expiresAt <= seen.now) return miss('expired');
  if (grant.source === 'plan' && grant.sessionId !== seen.sessionId) return miss('other-session');
  if (grant.sessionId !== undefined && grant.sessionId !== seen.sessionId) return miss('other-session');
  // 1b. A rule's scope: any ferret, exactly one session, or the sessions stamped with one project. Not a suspension.
  if (rule && (grant.scope === undefined || !scopeCovers(grant.scope, seen.sessionId, seen.project)))
    return miss('out-of-scope');
  // 2. The sign-in still exists, is still a password sign-in of its own (not through a provider), and still the account's.
  const signIn = seen.listing.signIns.find(each => each.id === grant.signIn);
  const account = signIn === undefined ? undefined : seen.listing.accounts.find(each => each.id === signIn.account);
  if (
    signIn === undefined ||
    account === undefined ||
    seen.keys.get(account.id) !== grant.accountKey ||
    signIn.method.kind !== 'password' ||
    signIn.via !== undefined
  )
    return miss('sign-in-gone');
  // 2b. A rule's account as approved: the same handle and the same username (a rename or a new username suspends).
  if (
    rule &&
    (grant.accountPins === undefined ||
      account.id !== grant.accountPins.id ||
      account.username !== grant.accountPins.username)
  )
    return miss('account-changed');
  // 3. The place as pinned: the same login domains (or `tool@host`), of the same kind.
  const kind = grant.surface === 'page' ? 'site' : 'terminal';
  if (signIn.place.kind !== kind || !sameKeys(placeKeys(signIn.place), grant.pins.placeKeys))
    return miss('place-changed');
  // 4. The recipe as pinned.
  if (signIn.recipeVersion !== grant.pins.recipeVersion) return miss('recipe-changed');
  // 5. This target is one of the pinned keys, exactly, on the surface the grant is for.
  const { facts } = seen;
  if (
    facts.kind === 'secret' ||
    (facts.kind === 'browser' ? 'page' : 'terminal') !== grant.surface ||
    seen.matchKey === undefined ||
    !grant.pins.placeKeys.includes(seen.matchKey)
  )
    return miss('not-here');
  // 6. Every field is a role the grant covers.
  const roles = rolesUnder(grant, seen.fields);
  if (typeof roles === 'string') return miss(roles);
  // 7. The ferret's words can only prevent: a hint naming another sign-in or account stops the fill.
  if (seen.hint !== undefined && seen.hint !== grant.signIn && seen.hint !== account.id)
    return miss('ferret-named-another');
  // 8. The account holds every value it must type now. A rule's 2FA keys are as approved (any change suspends), and its
  //    code comes only from the key it pinned, which must still be one Ferretry makes codes for: never the first key by
  //    `verified` order, which a ferret can steer (secrev-1241 I1).
  if (rule && (grant.accountPins === undefined || factorFingerprint(account.factors) !== grant.accountPins.factors))
    return miss('factor-changed');
  let factor: TwoFactorId | undefined;
  if (roles.includes('totp')) {
    if (grant.factor !== undefined) {
      factor = account.factors.find(key => key.id === grant.factor && key.automatic)?.id;
      if (factor === undefined) return miss('factor-changed');
    } else if (rule) return miss('factor-changed');
    else factor = automaticKeysInOfferOrder(account.factors)[0]?.id;
  }
  if (
    (roles.includes('username') && account.username === undefined) ||
    (roles.includes('password') && !account.fields.password) ||
    (roles.includes('totp') && factor === undefined)
  )
    return miss('account-lacks-field');
  // 10–16 / 10t–12t. The surface's own checks.
  const problem =
    facts.kind === 'browser' ? pageProblem(facts, seen.fields, roles, seen.scripted) : terminalProblem(facts, roles);
  if (problem !== undefined) return miss(problem);
  // 15b. A rule on a page: no page script ran on its login domains since it was approved, in ANY session.
  if (rule && facts.kind === 'browser' && scriptedSince(seen.scriptedOrigins, grant.pins.placeKeys, grant.approvedAt))
    return miss('scripted-origin');
  // 17 / 13t. The form is one the sign-in has history with, and the one first filled for this field set. A plan line
  //    with no history pins the first password form it fills; a rule NEVER pins a new form: every field set it fills
  //    must be a form the owner's own taps have history with. A password form outside that is a changed form (it
  //    suspends); a username-only or code-only step outside it only asks.
  const identity = identityOf(facts, seen.matchKey);
  if (identity === undefined) return miss('form-changed');
  const fieldSet = fieldSetOf(roles);
  if (rule) {
    const known = grant.pins.identities;
    if (known === undefined || known.length === 0) return miss('no-history');
    if (!known.includes(identity)) return miss(roles.includes('password') ? 'form-changed' : 'no-history');
  } else if (
    roles.includes('password') &&
    grant.pins.identities !== undefined &&
    !grant.pins.identities.includes(identity)
  )
    return miss('form-changed');
  const pin = pinned.get(fieldSet);
  if (pin !== undefined && pin !== identity) return miss('form-changed');
  return {
    ok: true,
    account: account.id,
    fills: roles,
    ...(factor === undefined ? {} : { factor }),
    identity,
    fieldSet,
  };
}
