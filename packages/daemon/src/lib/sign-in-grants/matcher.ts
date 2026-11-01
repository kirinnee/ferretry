import {
  type AccountId,
  type AccountKey,
  automaticKeysInOfferOrder,
  fillRoleFor,
  type GrantMissReason,
  type InputRequestField,
  type InputTargetFacts,
  type LoginFieldRole,
  type PlaceKey,
  placeKeys,
  type SignInField,
  type SignInId,
  TASK_PLAN_TERMINAL_TOOLS,
  type TwoFactorId,
} from '@ferretry/protocol';
import { terminalHides } from '../input-requests/lock.ts';
import { identityOf } from '../input-requests/login-observer.ts';
import { codeTargetProblem, type SavedListing } from '../input-requests/saved-logins.ts';

/**
 * THE SHARED MATCHER (docs/input-requests.md, "Task plan fills"): whether ONE permission to fill a sign-in without a tap
 * (a task-plan line now, a standing rule later) covers ONE card, on what the DAEMON saw. Pure: no clock, no I/O, no
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
  /** The field identities the sign-in had history with, or `undefined`: the first fill of each field set pins it. */
  readonly identities: readonly string[] | undefined;
}

/** One permission to fill one sign-in without a tap: a task-plan line (R3a) or a standing rule (R3c). */
export interface SignInGrant {
  /** `plan:<planId>:<line>`, or a rule's id. */
  readonly id: string;
  readonly source: 'plan' | 'rule';
  /** A plan line: the plan and its 0-based line. */
  readonly plan?: { readonly id: string; readonly line: number };
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
 * WHETHER `grant` COVERS THIS CARD, in the order of the checks (docs/input-requests.md): in force (1); the sign-in still
 * the account's (2); its place (3) and recipe (4) unchanged since the owner approved; this target one of its pinned keys
 * EXACTLY (5); every field a role the grant covers (6); the ferret's hint not naming another account (7); the account
 * holding every value it must type (8); then the page's or the terminal's own checks, and the form's identity (17, 13t).
 * `pinned` holds the identity each field set was first filled with under this grant. The rate limit and the uses are the
 * ledger's (check 9).
 */
export function matchSignInGrant(
  grant: SignInGrant,
  seen: GrantSighting,
  pinned: ReadonlyMap<string, string>,
): GrantMatch {
  // 1. In force.
  if (grant.state === 'stopped') return miss('stopped');
  if (grant.state === 'used-up' || grant.remaining <= 0) return miss('used-up');
  if (grant.expiresAt <= seen.now) return miss('expired');
  if (grant.source === 'plan' && grant.sessionId !== seen.sessionId) return miss('other-session');
  if (grant.sessionId !== undefined && grant.sessionId !== seen.sessionId) return miss('other-session');
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
  // 8. The account holds every value it must type now.
  const factor = roles.includes('totp') ? automaticKeysInOfferOrder(account.factors)[0]?.id : undefined;
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
  // 17 / 13t. The form is one the sign-in has history with (for a password), and the one first filled for this field set.
  const identity = identityOf(facts, seen.matchKey);
  if (identity === undefined) return miss('form-changed');
  const fieldSet = fieldSetOf(roles);
  if (roles.includes('password') && grant.pins.identities !== undefined && !grant.pins.identities.includes(identity))
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
