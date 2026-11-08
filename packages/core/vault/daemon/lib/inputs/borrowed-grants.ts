import {
  type AccountId,
  type AccountKey,
  automaticKeysInOfferOrder,
  factorFingerprint,
  fillRoleFor,
  GRANT_STOPPING_REASONS,
  type GrantMissReason,
  type LoginFieldRole,
  type PlaceKey,
  placeKeys,
  ruleMissSuspends,
  type SignInField,
  type SignInId,
  type SignInRuleId,
  type SignInRuleScope,
  signInRuleSuspensionOf,
  TASK_PLAN_TERMINAL_TOOLS,
  type TwoFactorId,
} from './borrowed.ts';
import type { ClearJob, InputTargetFacts } from '../../../contract/index.ts';
import type { InputRequestField } from './wire.ts';
import { identityOf, SECOND_FACTOR_WINDOW_MS } from './login-observer.ts';
import { terminalHides } from './lock.ts';
import { codeTargetProblem, type SavedListing } from './saved-logins.ts';

/**
 * THE SIGN-INS THE OWNER APPROVED IN ADVANCE (task-plan lines and standing sign-in rules), as the input service reads
 * them: copied, not owned. Today's `daemon/src/lib/sign-in-grants/{ledger,matcher,plans,reasons,clear}.ts` belong to
 * Accounts in 5.0; only the declarations the input service calls are copied here, byte for byte from rebuild-ref
 * (bb89d054d), with their imports pointed at this folder. The grant source itself is optional (`grants` absent: no
 * card is filled in advance) and is the Accounts end of the proposed `input.saved` hook.
 */

// ─── from sign-in-grants/ledger.ts ───

/**
 * USES, ATTEMPTS AND THE RATE LIMIT of grant fills (docs/input-requests.md, "Task plan fills", "Standing rule fills").
 * ONE instance, shared by every grant source (plan lines and standing rules), so the rate counts both. In memory: a
 * restart forgets the attempts, pins and rate; a standing rule's count of uses is the rule service's, on disk.
 *
 * - **Synchronous.** {@link SignInGrantLedger.reserve} runs inside the session lock right before the write, and counts
 *   what is reserved and not yet settled, so two raises can never both spend a line's last use (the paste rules'
 *   pattern). {@link SignInGrantLedger.spent} and {@link SignInGrantLedger.release} settle a reservation once.
 * - **One use is one sign-in attempt, and each ROLE is typed once per use.** An attempt opens at the first fill under a
 *   grant and records the roles it typed (username, password, code). A later fill joins it, for no new use, only within
 *   {@link SECOND_FACTOR_WINDOW_MS} and only when it types no role the attempt already typed. So username page →
 *   password page → code page within three minutes is ONE use, and a second password (a "confirm your password" form)
 *   always needs a use of its own.
 * - **Rate.** At most {@link FILLS_PER_HOUR_PER_SIGN_IN} fills an hour of one sign-in, across every grant, and
 *   {@link FILLS_PER_HOUR_PER_SESSION} grant fills an hour in one session. Over either: `rate`.
 * - **Pins.** The form identity each field set was first filled with, per grant: every later fill must equal it.
 */

/** The most grant fills of one sign-in in an hour, across every grant and session. */
const FILLS_PER_HOUR_PER_SIGN_IN = 10;

/** The most grant fills in one session in an hour. */
const FILLS_PER_HOUR_PER_SESSION = 30;

const HOUR_MS = 3_600_000;

/**
 * WHERE A FILL TYPES, as the daemon saw it: the match key, and for a page the tab and its document. `untouchedSince`
 * says whether the ferret did nothing to the session's pages since a moment (its own Enter, pressed by the daemon, is
 * no act of the ferret's). A rule's code step reads all of it; a missing part fails closed.
 */
interface GrantTarget {
  readonly place?: string | undefined;
  readonly pageId?: string | undefined;
  readonly navigationId?: string | undefined;
  readonly untouchedSince?: (at: number) => boolean;
}

/** What a reservation is for: one grant, its sign-in, the session asking, and the uses it has left now. */
interface LedgerGrant {
  readonly id: string;
  readonly signIn: SignInId;
  /** `Infinity` for a standing rule with no cap. */
  readonly remaining: number;
  /**
   * A code-only fill must JOIN an open attempt of this grant, in the same session, that already typed the password, as
   * the NEXT STEP OF THAT SIGN-IN (a standing rule): the same tab, at the same place, on a document the tab navigated to
   * from the password's, with no act of the ferret in between ({@link GrantTarget}). A stored code is never typed into a
   * "confirm with 2FA" form outside a sign-in the grant filled. Otherwise `code-without-sign-in`.
   */
  readonly codeJoinsPassword?: boolean;
}

/** Where a rule typed an attempt's password, and when: its code step must follow it there. */
interface PasswordWrite {
  readonly place: string | undefined;
  readonly pageId: string | undefined;
  readonly navigationId: string | undefined;
  readonly at: number;
}

/** A fill held against the ledger until it is spent or released. */
export interface GrantReservation {
  readonly grant: string;
  readonly signIn: SignInId;
  readonly sessionId: string;
  /** The roles this fill types. */
  readonly roles: readonly LoginFieldRole[];
  /** The field set its form identity is pinned for. */
  readonly fieldSet: string;
  /** This fill opens a new attempt, so it spends a use. */
  readonly opens: boolean;
  readonly at: number;
  /** Where this fill types, as the daemon saw it. */
  readonly target: GrantTarget;
}

interface Attempt {
  readonly opened: number;
  readonly roles: Set<LoginFieldRole>;
  /** Where and when the attempt typed its password: a rule's code step joins only right after it, in that tab. */
  password: PasswordWrite | undefined;
}

const recent = (times: readonly number[] | undefined, now: number): number[] =>
  (times ?? []).filter(at => at > now - HOUR_MS);

/**
 * Whether a code step is the next step of the sign-in whose password this rule typed: the same place, the same tab, a
 * document that tab navigated to since, and no act of the ferret's on the session's pages since the password.
 */
function followsPassword(password: PasswordWrite | undefined, target: GrantTarget): boolean {
  return (
    password !== undefined &&
    password.place !== undefined &&
    target.place === password.place &&
    password.pageId !== undefined &&
    target.pageId === password.pageId &&
    password.navigationId !== undefined &&
    target.navigationId !== undefined &&
    target.navigationId !== password.navigationId &&
    target.untouchedSince?.(password.at) === true
  );
}

class SignInGrantLedger {
  /** Per grant, per session: a standing rule fills for many sessions, and one session's steps never join another's. */
  readonly #attempts = new Map<string, Map<string, Attempt>>();
  readonly #pins = new Map<string, Map<string, string>>();
  readonly #bySignIn = new Map<SignInId, number[]>();
  readonly #bySession = new Map<string, number[]>();
  readonly #open = new Set<GrantReservation>();

  /** Whether a grant has an attempt open now in this session: a later step of that sign-in may still join it. */
  joinable(grant: string, sessionId: string, now: number): boolean {
    const attempt = this.#attempts.get(grant)?.get(sessionId);
    return attempt !== undefined && now - attempt.opened < SECOND_FACTOR_WINDOW_MS;
  }

  /**
   * Holds one fill typing `roles` under `grant`, or says why it can't: `used-up` when it would open an attempt and no use
   * is left (counting those already reserved), `rate` when the sign-in or the session is over its hourly limit. A fill
   * joins the open attempt only when none of its roles was typed in it, or is being typed by a fill still in flight.
   */
  reserve(
    grant: LedgerGrant,
    sessionId: string,
    roles: readonly LoginFieldRole[],
    fieldSet: string,
    now: number,
    target: GrantTarget = {},
  ): GrantReservation | GrantMissReason {
    const pending = [...this.#open];
    const attempt = this.#attempts.get(grant.id)?.get(sessionId);
    const typed = new Set([
      ...(attempt?.roles ?? []),
      ...pending
        .filter(each => each.grant === grant.id && each.sessionId === sessionId && !each.opens)
        .flatMap(each => each.roles),
    ]);
    const joins = this.joinable(grant.id, sessionId, now) && roles.every(role => !typed.has(role));
    if (
      grant.codeJoinsPassword === true &&
      roles.length > 0 &&
      roles.every(role => role === 'totp') &&
      !(joins && followsPassword(attempt?.password, target))
    )
      return 'code-without-sign-in';
    if (!joins) {
      const opening = pending.filter(each => each.grant === grant.id && each.opens).length;
      if (grant.remaining - opening <= 0) return 'used-up';
    }
    const signInFills =
      recent(this.#bySignIn.get(grant.signIn), now).length +
      pending.filter(each => each.signIn === grant.signIn).length;
    const sessionFills =
      recent(this.#bySession.get(sessionId), now).length + pending.filter(each => each.sessionId === sessionId).length;
    if (signInFills >= FILLS_PER_HOUR_PER_SIGN_IN || sessionFills >= FILLS_PER_HOUR_PER_SESSION) return 'rate';
    const reservation: GrantReservation = {
      grant: grant.id,
      signIn: grant.signIn,
      sessionId,
      roles: [...roles],
      fieldSet,
      opens: !joins,
      target,
      at: now,
    };
    this.#open.add(reservation);
    return reservation;
  }

  /**
   * The fill was typed, or may have been: it counts against the rate, opens or joins its attempt with its roles, and pins
   * the form's identity for its field set when none was pinned. Whether it spent a use (`opens`) is the caller's to
   * record on the grant. A reservation already settled is ignored.
   */
  spent(reservation: GrantReservation, identity: string | undefined): boolean {
    if (!this.#open.delete(reservation)) return false;
    const { grant, at, fieldSet } = reservation;
    this.#bySignIn.set(reservation.signIn, [...recent(this.#bySignIn.get(reservation.signIn), at), at]);
    this.#bySession.set(reservation.sessionId, [...recent(this.#bySession.get(reservation.sessionId), at), at]);
    const attempts = this.#attempts.get(grant) ?? new Map<string, Attempt>();
    this.#attempts.set(grant, attempts);
    const attempt = attempts.get(reservation.sessionId);
    const password: PasswordWrite | undefined = reservation.roles.includes('password')
      ? {
          place: reservation.target.place,
          pageId: reservation.target.pageId,
          navigationId: reservation.target.navigationId,
          at,
        }
      : undefined;
    if (reservation.opens || attempt === undefined)
      attempts.set(reservation.sessionId, { opened: at, roles: new Set(reservation.roles), password });
    else {
      for (const role of reservation.roles) attempt.roles.add(role);
      if (password !== undefined) attempt.password = password;
    }
    if (identity !== undefined) {
      const pins = this.#pins.get(grant) ?? new Map<string, string>();
      if (!pins.has(fieldSet)) pins.set(fieldSet, identity);
      this.#pins.set(grant, pins);
    }
    return reservation.opens;
  }

  /** Nothing was typed: the reservation is given back, and nothing is counted. */
  release(reservation: GrantReservation): void {
    this.#open.delete(reservation);
  }

  /** The identity each field set was first filled with under `grant`. */
  pinned(grant: string): ReadonlyMap<string, string> {
    return this.#pins.get(grant) ?? new Map();
  }

  /** Forgets the attempts and pins of every grant `keep` lets go: they die with their grant. The rate counts stay. */
  retain(keep: (grant: string) => boolean): void {
    for (const grant of [...this.#attempts.keys()]) if (!keep(grant)) this.#attempts.delete(grant);
    for (const grant of [...this.#pins.keys()]) if (!keep(grant)) this.#pins.delete(grant);
  }
}

// ─── from sign-in-grants/reasons.ts ───

const STOPPING: ReadonlySet<GrantMissReason> = new Set(GRANT_STOPPING_REASONS);

/** Whether a miss stops the line it was tried under: the form, the recipe or the place changed, or a value was left behind. */
const stopsTheLine = (reason: GrantMissReason): boolean => STOPPING.has(reason);

// ─── from sign-in-grants/matcher.ts ───

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
interface GrantPins {
  /** Login domains, or `tool@host`; never a site's `match` hosts. */
  readonly placeKeys: readonly PlaceKey[];
  readonly recipeVersion: number | undefined;
  /** The field identities the sign-in had history with, or `undefined`: a plan line's first fill of each field set pins it. */
  readonly identities: readonly string[] | undefined;
}

/** What a standing rule pinned of its account, beside the key: its handle, its username and its 2FA keys' fingerprint. */
interface GrantAccountPins {
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

// ─── from sign-in-grants/reasons.ts ───

/**
 * Whether a miss stops `grant`: a plan line by {@link stopsTheLine}; a standing rule when the miss is one the owner's
 * line says suspends it AND is a suspension a rule can carry (so the line never claims a suspension that didn't happen).
 */
export const grantStops = (grant: Pick<SignInGrant, 'source'>, reason: GrantMissReason): boolean =>
  grant.source === 'rule'
    ? ruleMissSuspends(reason) && signInRuleSuspensionOf(reason) !== undefined
    : stopsTheLine(reason);

/**
 * The line an input card's agenda context carries when a PLAN line did not apply. The REASON is not in it: a ferret can
 * read its own session's agenda, so the card's words are the same whatever the reason; the owner reads the reason on
 * the input card itself, from the owner-only request. A standing rule's miss adds no line at all.
 */
export const GRANT_MISS_CONTEXT_LINE = "A task plan line didn't apply here, so you're asked as usual.";

// ─── from sign-in-grants/plans.ts ───

/** What a grant's last check before typing reads, beside the grant itself: who asks, from where, typing what. */
interface GrantFillAt {
  readonly sessionId: string;
  /** The session's stamped board project, as the fill's sighting read it. */
  readonly project: string | undefined;
  readonly roles: readonly LoginFieldRole[];
  readonly now: number;
}

/** A grant checked again right before its write: still good, or why not (`reason` absent: it could not be told). */
type GrantVerdict = { readonly ok: true } | { readonly ok: false; readonly reason?: GrantMissReason };

// ─── from sign-in-grants/matcher.ts ───

/**
 * WHERE A PAGE SCRIPT RAN, machine-wide (`browser.eval`, any session): the last time per host, and the last time one ran
 * on a page whose origin could not be read (`everywhere`: it may have been any).
 */
export interface ScriptedOriginsView {
  readonly hosts: ReadonlyMap<string, number>;
  readonly everywhere?: number;
  /** An agent script is running somewhere now, so the host it really runs on is not known yet (a page card's lock). */
  readonly running?: boolean;
}

// ─── from sign-in-grants/plans.ts ───

/** What the input service asks of the grants: which apply to a session, an account's key, and the writes back. */
export interface SignInGrantSource {
  /**
   * Whether grant fills run at all. A grant fill closes the card itself, and an app that can't show that would refuse
   * the request list, so a source fills only while the daemon reports its feature (`task-plan.1`, `sign-in-rules.1`;
   * this build reports both).
   */
  enabled(): boolean;
  /** The grants that are about a sign-in in this session: in force, spent or stopped, the soonest to expire first. */
  of(sessionId: string): readonly SignInGrant[];
  /** An account's immutable key now, or nothing when the store can't say. */
  keyOf(account: AccountId): Promise<AccountKey | undefined>;
  readonly ledger: SignInGrantLedger;
  /** A fill opened a new attempt: one use of the grant is spent, in `sessionId`. */
  used(grant: SignInGrant, at: number, sessionId: string): void;
  /** A miss that stops the grant: every later fill under it asks. */
  stopped(grant: SignInGrant, because: GrantMissReason): Promise<void>;
  /**
   * Checks a grant again, with I/O, right before the second match (a standing rule's stored proof and pinned facts).
   * A plan line has nothing more to check.
   */
  verify(grant: SignInGrant): Promise<GrantVerdict>;
  /**
   * The LAST check before typing, synchronous (it runs as `held()` / `proceed()`, with nothing awaited before the
   * write): whatever the source alone knows about the grant still holds. A plan line's state is read by the caller.
   */
  holds(grant: SignInGrant, at: GrantFillAt): boolean;
  /** The session's STAMPED board project (a rule's project scope), or nothing. Never resolved from a folder. */
  projectOf(sessionId: string): Promise<string | undefined>;
  /** Where page scripts ran across the machine (a rule's check 15b). */
  scriptedOrigins(): ScriptedOriginsView;
}

// ─── from sign-in-grants/clear.ts ───

/** The clear job for the password fields of a page write: each typed `secret` field's node. `undefined` when there is none. */
export function clearJobOf(facts: InputTargetFacts, secretFields: readonly string[]): ClearJob | undefined {
  if (facts.kind !== 'page') return undefined;
  const fields = facts.fields
    .filter(field => secretFields.includes(field.fieldId))
    .map(field => ({ frameId: field.frameId, backendNodeId: field.backendNodeId }));
  return fields.length === 0 ? undefined : { navigationId: facts.navigationId, fields };
}

// ─── from sign-in-grants/matcher.ts ───

/**
 * Whether a page script ran on one of a rule's login domains since the body its passkey approved was made (or ran
 * somewhere unreadable): ferret A's script on github.com can arm storage that github.com's own code reads when ferret
 * B's fill types, weeks later, in the one shared browser profile.
 */
function scriptedSince(view: ScriptedOriginsView, keys: readonly PlaceKey[], approvedAt: number | undefined): boolean {
  const since = (at: number | undefined): boolean => at !== undefined && (approvedAt === undefined || at >= approvedAt);
  return since(view.everywhere) || keys.some(key => since(view.hosts.get(key)));
}

/**
 * Whether a standing rule's scope covers this session (check 1b): `any` ferret; exactly this `session` (never its
 * children); or the sessions STAMPED with this board `project` (a project read from a folder never matches).
 */
function scopeCovers(scope: SignInRuleScope, sessionId: string, project: string | undefined): boolean {
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
      /**
       * A standing rule's code-only step on a form outside the owner's history: it fills ONLY as a join to this rule's
       * open password attempt (the ledger decides, `codeJoinsPassword`), and it never pins the form.
       */
      readonly joinOnly?: true;
    }
  | { readonly ok: false; readonly reason: GrantMissReason };

const miss = (reason: GrantMissReason): GrantMatch => ({ ok: false, reason });

const sameKeys = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every(key => right.includes(key)) && right.every(key => left.includes(key));

/** The field set a card fills, as pins are kept: its roles, sorted and joined (`password`, `username+password`). */
const fieldSetOf = (roles: readonly LoginFieldRole[]): string => [...new Set(roles)].sort().join('+');

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
  facts: Extract<InputTargetFacts, { readonly kind: 'page' }>,
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
    (facts.kind === 'page' ? 'page' : 'terminal') !== grant.surface ||
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
    facts.kind === 'page' ? pageProblem(facts, seen.fields, roles, seen.scripted) : terminalProblem(facts, roles);
  if (problem !== undefined) return miss(problem);
  // 15b. A rule on a page: no page script ran on its login domains since it was approved, in ANY session.
  if (rule && facts.kind === 'page' && scriptedSince(seen.scriptedOrigins, grant.pins.placeKeys, grant.approvedAt))
    return miss('scripted-origin');
  // 17 / 13t. The form is one the sign-in has history with, and the one first filled for this field set. A plan line
  //    with no history pins the first password form it fills; a rule NEVER pins a new form: every field set it fills
  //    must be a form the owner's own taps have history with. A password form outside that is a changed form (it
  //    suspends); a username-only step outside it only asks. ONE exception: a code-only step (exactly one code box)
  //    outside the history may fill as a JOIN to this same rule's open password attempt, in this session at this same
  //    place, within the join window (the ledger's `codeJoinsPassword`): the history counts only password boxes, so a
  //    code page could never be in it. It never pins the code form and never starts an attempt.
  const identity = identityOf(facts, seen.matchKey);
  if (identity === undefined) return miss('form-changed');
  const fieldSet = fieldSetOf(roles);
  if (rule) {
    const known = grant.pins.identities;
    if (known === undefined || known.length === 0) return miss('no-history');
    if (!known.includes(identity)) {
      if (roles.length === 1 && roles[0] === 'totp' && seen.fields.length === 1)
        return {
          ok: true,
          account: account.id,
          fills: roles,
          ...(factor === undefined ? {} : { factor }),
          identity,
          fieldSet,
          joinOnly: true,
        };
      return miss(roles.includes('password') ? 'form-changed' : 'no-history');
    }
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
