/**
 * Logging the fleet in with the fewest browser approvals it can be done in.
 *
 * The order is the whole capability, and it is deliberately the opposite of the obvious one. The
 * obvious implementation walks the accounts and runs a login for each, which costs a human one browser
 * approval per wrapper — thirty wrappers, thirty approvals. This one walks **identities**:
 *
 * 1. **Sync first.** Read every home in the identity, pick the freshest usable credential as donor,
 *    and copy it onto the siblings that need one. Most "logins" are this and nothing more.
 * 2. **Ask a human only when nobody has one.** An identity with no usable credential anywhere is the
 *    only thing that costs an approval, and one approval covers all of its lanes.
 * 3. **Fan the fresh credential out.** After the approval, re-read the identity and copy the new
 *    credential to the siblings, so the approval is not spent again next time.
 *
 * Thirty wrappers on six provider accounts therefore cost six approvals.
 *
 * What this refuses to do is as important as what it does. An identity it could not classify is
 * reported, not logged in and not overwritten: see {@link ./identity.ts} for why `unreadable` is a
 * state and what it forbids.
 */
import {
  chooseLoginMember,
  type FleetIdentity,
  type FleetIdentityMember,
  type FleetIdentityService,
  type FleetIdentityStatus,
  selectIdentities,
} from './identity.ts';
import type { HarnessKind } from './manifest.ts';

/** What one account's wrapper needs to be launched for an interactive login. */
export interface FleetLoginTarget {
  readonly accountId: string;
  readonly kind: HarnessKind;
  readonly wrapper: string;
  readonly home: string;
}

export type FleetLoginOutcome =
  | { readonly status: 'logged-in' }
  | { readonly status: 'failed'; readonly message: string };

/** Running one interactive provider login. The only side of this that touches a terminal. */
export interface FleetLoginPort {
  login(target: FleetLoginTarget): Promise<FleetLoginOutcome>;
}

/**
 * What happened to one account.
 *
 * Every outcome is named. `usable`, `login-needed` and `indeterminate` are three different reasons
 * nothing was done, and collapsing them is how a report ends up implying a fleet is signed in when
 * two of its identities were never checked.
 */
export type FleetLoginStatus =
  /** A human approved a provider login for this account. */
  | 'logged-in'
  /** It received the identity's credential from a sibling. */
  | 'synced'
  /** Its own credential was already usable; nothing was done. */
  | 'usable'
  /** It authenticates with a key, so there is no provider login to run. */
  | 'not-required'
  /** A login is needed and this run did not attempt one. */
  | 'login-needed'
  /** Its credential could not be classified, so nothing was read from it or written to it. */
  | 'indeterminate'
  /** The manifest declares the account unavailable. */
  | 'unavailable'
  | 'failed';

export interface FleetLoginResult {
  readonly accountId: string;
  /** The identity whose credential this account shares. */
  readonly identity: string;
  readonly status: FleetLoginStatus;
  readonly message?: string;
}

/** `sync-only` clones credentials and stops; it never opens a browser. */
export type FleetLoginMode = 'full' | 'sync-only';

export interface FleetLoginRequest {
  readonly identities: readonly FleetIdentity[];
  /** Selects whole identities. Empty or absent means every identity. */
  readonly accountIds?: readonly string[];
  readonly mode: FleetLoginMode;
}

export interface FleetLoginServiceDeps {
  readonly identities: FleetIdentityService;
  readonly loginPort: FleetLoginPort;
}

const SYNC_ONLY_MESSAGE = 'no usable credential in this identity — rerun without --sync-only to log it in';
const STILL_UNRESOLVED = 'the login finished but this identity still has no usable credential';

export class FleetLoginService {
  constructor(private readonly deps: FleetLoginServiceDeps) {}

  /**
   * Work through the selected identities, one at a time.
   *
   * Sequential on purpose: an interactive login is a browser approval a human performs in this
   * terminal, and running two at once races for both the terminal and the human.
   */
  async login(request: FleetLoginRequest): Promise<readonly FleetLoginResult[]> {
    const selected =
      request.accountIds === undefined || request.accountIds.length === 0
        ? request.identities
        : selectIdentities(request.identities, request.accountIds);

    const results: FleetLoginResult[] = [];
    for (const identity of selected) results.push(...(await this.#runIdentity(identity, request.mode)));
    return results;
  }

  async #runIdentity(identity: FleetIdentity, mode: FleetLoginMode): Promise<readonly FleetLoginResult[]> {
    const status = await this.deps.identities.surveyOne(identity);
    const skipped = status.unavailable.map(member =>
      row(identity, member.accountId, 'unavailable', member.unavailableReason ?? undefined),
    );

    switch (status.verdict.kind) {
      case 'no-login':
        return [...skipped, ...this.#uniform(status, 'not-required', status.verdict.reason)];
      case 'indeterminate':
        return [...skipped, ...this.#refusals(status, status.verdict.reason)];
      case 'complete':
        return [...skipped, ...this.#settled(status)];
      case 'sync':
        return [...skipped, ...(await this.#sync(status))];
      default:
        return mode === 'sync-only'
          ? [...skipped, ...this.#uniform(status, 'login-needed', SYNC_ONLY_MESSAGE)]
          : [...skipped, ...(await this.#interactive(status))];
    }
  }

  /**
   * Clone the donor's credential across the identity.
   *
   * A sibling that was refused — its own credential could not be read — is reported as
   * `indeterminate` with its own reason, never as a success and never overwritten.
   */
  async #sync(status: FleetIdentityStatus): Promise<readonly FleetLoginResult[]> {
    const clones = new Map((await this.deps.identities.sync(status)).map(clone => [clone.accountId, clone.outcome]));
    return status.members.map(member => {
      const outcome = clones.get(member.member.accountId);
      if (outcome === undefined) return this.#untouched(status, member.member.accountId);
      return outcome.ok
        ? row(status.identity, member.member.accountId, 'synced')
        : row(status.identity, member.member.accountId, 'failed', outcome.reason);
    });
  }

  /**
   * Ask a human once, then fan the result out.
   *
   * The account whose wrapper was launched reports `logged-in`; its siblings report what the copy did.
   * A login that returns success but leaves the identity without a usable credential is a failure
   * here, not a success — the provider may have been cancelled halfway.
   */
  async #interactive(status: FleetIdentityStatus): Promise<readonly FleetLoginResult[]> {
    const member = chooseLoginMember(status.members);
    if (member === undefined) return [];

    const outcome = await this.#attempt(status.identity.kind, member);
    if (outcome.status === 'failed') return this.#uniform(status, 'failed', outcome.message);

    const settled = await this.deps.identities.surveyOne(status.identity);
    const rows =
      settled.verdict.kind === 'sync'
        ? await this.#sync(settled)
        : settled.verdict.kind === 'complete'
          ? this.#settled(settled)
          : this.#uniform(settled, 'failed', STILL_UNRESOLVED);

    return rows.map(result =>
      result.accountId === member.accountId && result.status !== 'failed'
        ? { ...result, status: 'logged-in' as const }
        : result,
    );
  }

  async #attempt(kind: HarnessKind, member: FleetIdentityMember): Promise<FleetLoginOutcome> {
    try {
      return await this.deps.loginPort.login({
        accountId: member.accountId,
        kind,
        wrapper: member.wrapper,
        home: member.home,
      });
    } catch (error) {
      return { status: 'failed', message: error instanceof Error ? error.message : String(error) };
    }
  }

  #uniform(status: FleetIdentityStatus, result: FleetLoginStatus, message?: string): readonly FleetLoginResult[] {
    return status.members.map(member => row(status.identity, member.member.accountId, result, message));
  }

  /** Every member reports its own reading, so one unreadable home does not accuse the others. */
  #refusals(status: FleetIdentityStatus, fallback: string): readonly FleetLoginResult[] {
    return status.members.map(member =>
      row(status.identity, member.member.accountId, 'indeterminate', member.reading.reason ?? fallback),
    );
  }

  #settled(status: FleetIdentityStatus): readonly FleetLoginResult[] {
    return status.members.map(member => this.#untouched(status, member.member.accountId));
  }

  #untouched(status: FleetIdentityStatus, accountId: string): FleetLoginResult {
    const refused = status.refused.find(member => member.member.accountId === accountId);
    return refused === undefined
      ? row(status.identity, accountId, 'usable')
      : row(status.identity, accountId, 'indeterminate', refused.reading.reason);
  }
}

function row(identity: FleetIdentity, accountId: string, status: FleetLoginStatus, message?: string): FleetLoginResult {
  return { accountId, identity: identity.key, status, ...(message === undefined ? {} : { message }) };
}
