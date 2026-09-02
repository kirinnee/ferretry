/**
 * Renewing a credential that can already renew itself — deliberately, and without asking anybody.
 *
 * A provider access token expires in hours; the refresh token beside it lives for weeks. Between
 * those two facts sits the whole of this module. Ferretry has been **passive** about it: an expired
 * credential with a refresh token is `refreshable`, it may be donated across an identity, and it
 * renews itself the first time some session happens to run. Nothing renews it if nobody runs it.
 *
 * That passivity costs a human the one thing this product is trying to stop costing them. A home
 * nobody launches for long enough loses the refresh token too, and then the only way back is a
 * browser approval. Worse, a rotating refresh token is consumed by whichever copy renews first, so
 * the siblings that received a clone of it hold a token that is already spent — one lane renews and
 * the rest quietly need a human. Making the renewal **active** turns both of those into nothing.
 *
 * ## The technique, and why it costs nothing
 *
 * Each harness already knows how to renew its own credential; it does it as a side effect of being
 * used. So this drives each CLI down a path that is authenticated but **does not invoke a model**:
 * `claude mcp list` for Claude, and a `getAuthStatus` request to `codex app-server` for Codex. The
 * harness performs the OAuth round trip and rewrites its own store. Ferretry triggers it and then
 * observes the result; it never sees a token, which is the same `use, never read` rule the secret
 * store keeps (`docs/secrets.md`).
 *
 * ## The gate is the feature, and it cannot be reached around
 *
 * **Codex refresh tokens are single-use and rotating.** Firing this speculatively burns one, and a
 * burnt refresh token is exactly the browser approval this exists to avoid. So the eligibility
 * decision is not a caller's responsibility and not an optimisation:
 *
 * - {@link planTokenRefresh} is a pure function of what each home holds, and
 *   {@link FleetTokenRefreshService.renew} is the only door to the port. There is no argument, flag
 *   or overload that reaches a refresh without passing through it.
 * - The plan **chooses** the home; a fresh read of that home's own credential **decides** whether to
 *   fire. A survey happens once and identities are then renewed one after another, so minutes can
 *   pass between the reading that chose a candidate and the spawn — long enough for another session
 *   to have renewed it already. Firing on a stale reading would burn the token that was just minted.
 * - An identity that holds a valid credential anywhere is never refreshed. It has nothing to gain and
 *   a rotation to lose.
 * - **Two callers asking at once are one renewal.** See the note on {@link FleetTokenRefreshService}.
 *
 * ## What single-flight is, and what it is NOT
 *
 * The dedupe below is **in-process only**, and the limit is a fact about the architecture rather than
 * an unfinished corner. Ferretry never makes the token call — the harness CLI does, in its own child,
 * against its own store — so there is nothing here to observe a `Retry-After`, nothing to hold a
 * cross-process cooldown against, and no lock the harness would respect if there were. `fy fleet
 * login` in a terminal and a renewal inside the daemon still have nothing between them, exactly as
 * two logins do (`packages/daemon/src/lib/fleet-login/service.ts`).
 *
 * What makes that acceptable is the fresh read above rather than the dedupe: a second process that
 * arrives after the first has renewed reads `valid` and refuses to fire. The dedupe removes the
 * remaining window — two callers **inside one process** that both read `refreshable` before either
 * fired — which is the window a route and a launch actually race in.
 *
 * ## Success is read from the credential, never from the call
 *
 * {@link FleetTokenRefreshPort} has no way to report that a credential was renewed: its outcome type
 * has no such member. That is deliberate, and it is the generalisation of a defect found in the tool
 * this replaces — a usage endpoint that serves data on a stale token, so a probe succeeding proved
 * nothing about whether anybody was still signed in. An exit code proves the same nothing here:
 * `claude mcp list` exits non-zero when a configured MCP server is down, and zero whether or not a
 * token needed renewing. So `renewed` is concluded from one thing only — the credential's own expiry,
 * re-read locally after the harness has had its turn.
 *
 * Nothing in this module reads credential material. It reads *classifications* through
 * {@link FleetCredentialStore}, exactly as {@link FleetIdentityService} does, and the material stays
 * behind that boundary in an adapter.
 */
import type {
  CredentialState,
  FleetCredentialStore,
  FleetIdentity,
  FleetIdentityMember,
  FleetIdentityMemberStatus,
} from './identity.ts';
import { failureMessage } from './identity.ts';
import type { HarnessKind } from './manifest.ts';

/**
 * What happened to one identity's credential.
 *
 * Every outcome is named, and the four that did nothing are four different reasons for having done
 * nothing. `not-expired` is a refusal this product wants to be loud about — a still-valid credential
 * is the case where firing would be destructive — while `indeterminate` means the home was never read
 * successfully, so nothing at all is known. Collapsing them is how a report ends up implying a fleet
 * renewed itself when part of it was never looked at.
 */
export type FleetTokenRefreshStatus =
  /** The harness renewed it: the credential's own re-read expiry is now in the future. */
  | 'renewed'
  /** Some home in this identity already holds a valid access token, so nothing was fired. */
  | 'not-expired'
  /** Nothing here can renew itself — there is no refresh token to spend. */
  | 'not-renewable'
  /** This identity authenticates with a key, so there is no provider token to renew. */
  | 'not-required'
  /** A home could not be classified, so nothing was read from it or fired at it. */
  | 'indeterminate'
  /** The harness CLI this renewal needs is not installed on this host. */
  | 'unavailable'
  /** The path ran and the credential is still not valid. */
  | 'failed';

/** What one identity's renewal did, and to which home. */
export interface FleetTokenRefreshResult {
  /** The identity key, because a credential belongs to an identity rather than to an account. */
  readonly identity: string;
  readonly status: FleetTokenRefreshStatus;
  /** The account whose home was renewed, or chosen and then refused. Absent when none was chosen. */
  readonly accountId?: string;
  /** Why this status, in the terms of the credential — never of the credential's contents. */
  readonly reason?: string;
  /**
   * Whether the harness was given its turn — so the credential on disk may have changed.
   *
   * Not a success: a renewal that ran and achieved nothing has `ran` true and a status of `failed`. It
   * exists because a caller holding a survey needs to know whether that survey is now stale, and the
   * status alone cannot say: a spent refresh token leaves a home in a *worse* state than the reading
   * that chose it, and acting on the old reading would donate a credential that is now dead.
   */
  readonly ran: boolean;
}

/**
 * Renewing one identity's credential.
 *
 * The service below is the only implementation; this exists so a caller can depend on the capability
 * without depending on how it is built.
 */
export interface FleetTokenRenewal {
  renew(identity: FleetIdentity, members: readonly FleetIdentityMemberStatus[]): Promise<FleetTokenRefreshResult>;
}

/**
 * What should happen to one identity.
 *
 * A plan is either one home to renew or a named refusal. There is deliberately no third shape: a
 * caller cannot be handed "probably fine, do what you like".
 */
export type FleetTokenRefreshPlan =
  | { readonly kind: 'renew'; readonly member: FleetIdentityMember }
  | {
      readonly kind: 'skip';
      readonly status: Extract<
        FleetTokenRefreshStatus,
        'not-expired' | 'not-renewable' | 'not-required' | 'indeterminate'
      >;
      readonly reason: string;
    };

const skip = (
  status: Extract<FleetTokenRefreshStatus, 'not-expired' | 'not-renewable' | 'not-required' | 'indeterminate'>,
  reason: string,
): FleetTokenRefreshPlan => ({ kind: 'skip', status, reason });

/**
 * Decide, from what each home holds, whether anything should be renewed and which one.
 *
 * Pure, total, and the only thing that may authorise a refresh. The order encodes the cost of being
 * wrong in each direction: refusing when a renewal was possible costs a later browser approval, while
 * firing when one was not costs a rotating refresh token *now*. So every reading that is not
 * positively expired-with-a-way-back is a refusal.
 *
 * One home per identity, not all of them. The homes in an identity hold copies of one credential, and
 * a rotating refresh token is consumed by the first renewal — running the rest would spend a token
 * that no longer exists and could report a working identity as broken. Fanning the renewed credential
 * back out is the sync path's job, which already owns copying.
 *
 * The chosen home is the one whose access token expired last, then the lowest account id: the same
 * ordering the donor pick uses, so the account this reports on does not move between runs.
 */
export function planTokenRefresh(
  identity: FleetIdentity,
  members: readonly FleetIdentityMemberStatus[],
): FleetTokenRefreshPlan {
  if (identity.auth === 'api-key') {
    return skip('not-required', 'this account authenticates with a key, so it has no provider token to renew');
  }
  if (members.some(status => status.reading.state === 'valid')) {
    return skip('not-expired', 'a home in this identity already holds a valid access token');
  }
  const renewable = members
    .filter(status => status.reading.state === 'refreshable')
    .sort(
      (left, right) =>
        (right.reading.expiresAt ?? 0) - (left.reading.expiresAt ?? 0) ||
        left.member.accountId.localeCompare(right.member.accountId),
    );
  const chosen = renewable[0];
  if (chosen !== undefined) return { kind: 'renew', member: chosen.member };

  const unreadable = members.filter(status => status.reading.state === 'unreadable');
  return unreadable.length === 0
    ? skip('not-renewable', 'no home in this identity holds a refresh token, so nothing here can renew itself')
    : skip(
        'indeterminate',
        `${unreadable.length} of ${members.length} homes could not be read, and none of the rest can renew itself — refusing to decide`,
      );
}

/**
 * The home whose credential a renewal rotates.
 *
 * Carries no material and no wrapper. The home is what decides *which* credential the harness
 * renews, and it comes from the manifest — never parsed back out of a wrapper's text or a name.
 */
export interface FleetTokenRefreshTarget {
  readonly accountId: string;
  readonly kind: HarnessKind;
  /** Absolute harness configuration directory. */
  readonly home: string;
}

/**
 * Whether the credential has renewed itself yet.
 *
 * A **stop condition**, not a result. One of the two harnesses is a server that never exits on its
 * own, so something has to say when its work is done; asking the credential is better than sleeping
 * for a guessed interval. The port is given this so it can stop early, and it has nowhere to put the
 * answer: judging the outcome stays with the service that owns the read.
 */
export type FleetTokenRefreshSettled = () => Promise<boolean>;

/**
 * What running the renewal path did — and, pointedly, not whether it worked.
 *
 * There is no `ok` member and no exit code, because neither means anything here. `ran` says only that
 * the harness was given its chance. Whether a credential is now usable is decided by re-reading the
 * credential, which is the one source that cannot be fooled by a call that succeeded for an unrelated
 * reason.
 */
export type FleetTokenRefreshAttempt =
  | { readonly outcome: 'ran' }
  | { readonly outcome: 'unavailable'; readonly reason: string }
  | { readonly outcome: 'error'; readonly reason: string };

/** Driving one harness down its non-inference authenticated path. The only impure side of this. */
export interface FleetTokenRefreshPort {
  refresh(target: FleetTokenRefreshTarget, settled: FleetTokenRefreshSettled): Promise<FleetTokenRefreshAttempt>;
}

export interface FleetTokenRefreshDeps {
  /** Reads classifications, never material — the same boundary the identity service reads through. */
  readonly store: FleetCredentialStore;
  readonly port: FleetTokenRefreshPort;
}

/**
 * What a reading means when it is found *before* the refresh fires.
 *
 * `valid` here is the race this exists to catch: something renewed the credential between the survey
 * and this moment, and firing anyway would spend the refresh token that renewal just minted.
 */
const BEFORE: Readonly<
  Record<Exclude<CredentialState, 'refreshable'>, { readonly status: FleetTokenRefreshStatus; readonly reason: string }>
> = {
  valid: {
    status: 'not-expired',
    reason: 'this home was renewed between the survey and now, so nothing was fired at it',
  },
  missing: {
    status: 'not-renewable',
    reason: 'this home lost its refresh token between the survey and now, so it cannot renew itself',
  },
  unreadable: {
    status: 'indeterminate',
    reason: 'this home could not be read a second time, so nothing was fired at it',
  },
};

/**
 * What a reading means when it is found *after* the harness has had its turn.
 *
 * `missing` is the outcome worth naming separately even though it reports as a failure, and it is a
 * measured one rather than a hypothetical: a harness whose rotation is rejected **clears its own
 * tokens**, so a home whose refresh token was already dead comes back with nothing at all. This
 * identity really does need a human, and that is the one thing a caller must not learn by finding out
 * later. Nothing of value was lost — a refresh token the provider refuses was worth nothing — but the
 * sentence has to say so.
 */
const AFTER: Readonly<Record<CredentialState, { readonly status: FleetTokenRefreshStatus; readonly reason: string }>> =
  {
    valid: { status: 'renewed', reason: 'the harness renewed it, and no browser was opened' },
    refreshable: {
      status: 'failed',
      reason: 'the renewal ran and this access token is still expired',
    },
    missing: {
      status: 'failed',
      reason: 'the refresh token is gone and the access token is still expired — this identity needs a login',
    },
    unreadable: {
      status: 'indeterminate',
      reason: 'this home could not be read after the renewal, so whether it worked is unknown',
    },
  };

/**
 * Renews one identity's credential, or says why it did not.
 *
 * Every path out of {@link renew} is a named result. Nothing throws: a store that fails is an
 * unreadable home and a port that throws is a failure with the port's own sentence, because a
 * renewal that cannot happen must never be able to take down the login it was trying to make
 * unnecessary.
 *
 * ## One renewal per identity at a time, and both callers get its answer
 *
 * A refresh token that rotates is spent by whoever uses it first, so two concurrent renewals of one
 * identity are not merely wasteful — the second fires at a home whose token the first has already
 * consumed, and reports a working identity as broken. The fresh read inside {@link renew} closes most
 * of that window; it cannot close the part where both callers read `refreshable` before either spawns,
 * because nothing between the read and the spawn is atomic.
 *
 * So a renewal already in flight for an identity is **joined, not queued and not refused**. The
 * second caller awaits the first and receives its result, which is honest on both fields it turns on:
 * the credential really was renewed, and `ran` really is true — that caller's survey is stale either
 * way, which is the only thing `ran` exists to say.
 *
 * Keyed on `identity.key`, because a credential belongs to an identity rather than to an account, and
 * the whole point of the key is that every lane sharing one credential shares one entry.
 *
 * INSTANCE STATE, so it dedupes exactly as far as the instance is shared and no further. A composition
 * root that builds two services gets two windows — see the module note on what in-process means here.
 */
export class FleetTokenRefreshService implements FleetTokenRenewal {
  /** One entry per identity being renewed right now. Removed when that renewal settles, never before. */
  readonly #inFlight = new Map<string, Promise<FleetTokenRefreshResult>>();

  constructor(private readonly deps: FleetTokenRefreshDeps) {}

  /**
   * Renew one identity from a survey somebody already has.
   *
   * Takes the readings rather than reading everything again, because the caller that wants this has
   * just surveyed the identity and a keychain read is not free. The readings only *choose*; the fresh
   * read below is what authorises the spawn, so a stale survey can cost a wasted decision but never a
   * spent refresh token.
   *
   * The lookup and the registration happen with no `await` between them, which is what makes this a
   * gate rather than a suggestion: an interleaving caller cannot arrive after the miss and before the
   * entry exists.
   */
  async renew(
    identity: FleetIdentity,
    members: readonly FleetIdentityMemberStatus[],
  ): Promise<FleetTokenRefreshResult> {
    const joined = this.#inFlight.get(identity.key);
    if (joined !== undefined) return await joined;
    const attempt = this.#renewOnce(identity, members).finally(() => this.#inFlight.delete(identity.key));
    this.#inFlight.set(identity.key, attempt);
    return await attempt;
  }

  async #renewOnce(
    identity: FleetIdentity,
    members: readonly FleetIdentityMemberStatus[],
  ): Promise<FleetTokenRefreshResult> {
    const plan = planTokenRefresh(identity, members);
    if (plan.kind === 'skip') {
      return { identity: identity.key, status: plan.status, reason: plan.reason, ran: false };
    }

    const member = plan.member;
    const before = await this.#read(identity.kind, member);
    if (before !== 'refreshable') {
      const refusal = BEFORE[before];
      return {
        identity: identity.key,
        accountId: member.accountId,
        status: refusal.status,
        reason: refusal.reason,
        ran: false,
      };
    }

    const attempt = await this.#attempt(identity.kind, member);
    if (attempt.outcome !== 'ran') {
      // A missing CLI spawned nothing, so nothing moved. Any other failure may have been raised after
      // the child was already speaking, and a survey wrongly believed fresh is the expensive mistake
      // while re-reading a credential that did not move is a wasted read — so `error` claims it ran.
      const unavailable = attempt.outcome === 'unavailable';
      return {
        identity: identity.key,
        accountId: member.accountId,
        status: unavailable ? 'unavailable' : 'failed',
        reason: attempt.reason,
        ran: !unavailable,
      };
    }

    const settled = AFTER[await this.#read(identity.kind, member)];
    return {
      identity: identity.key,
      accountId: member.accountId,
      status: settled.status,
      reason: settled.reason,
      ran: true,
    };
  }

  /** A store that throws is a read that failed, never a home with no credential. */
  async #read(kind: HarnessKind, member: FleetIdentityMember): Promise<CredentialState> {
    try {
      return (await this.deps.store.read(kind, member)).state;
    } catch {
      return 'unreadable';
    }
  }

  async #attempt(kind: HarnessKind, member: FleetIdentityMember): Promise<FleetTokenRefreshAttempt> {
    const target: FleetTokenRefreshTarget = { accountId: member.accountId, kind, home: member.home };
    try {
      return await this.deps.port.refresh(target, async () => (await this.#read(kind, member)) === 'valid');
    } catch (error) {
      return { outcome: 'error', reason: failureMessage(error, 'the renewal could not be run') };
    }
  }
}
