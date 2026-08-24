/**
 * Logging the fleet in with the fewest browser approvals it can be done in.
 *
 * The order is the whole capability, and it is deliberately the opposite of the obvious one. The
 * obvious implementation walks the accounts and runs a login for each, which costs a human one browser
 * approval per wrapper — thirty wrappers, thirty approvals. This one walks **identities**:
 *
 * 1. **Renew what can renew itself.** An identity whose token has expired but still holds a refresh
 *    token needs no human at all: the harness will rotate it down a path that invokes no model. It
 *    happens first — for a pass composed with a renewal — so the donor the next step picks is a
 *    *valid* credential rather than an expired one whose refresh token every sibling would then be
 *    handed a spent copy of.
 * 2. **Sync.** Read every home in the identity, pick the freshest usable credential as donor,
 *    and copy it onto the siblings that need one. Most "logins" are this and nothing more.
 * 3. **Ask a human only when nobody has one.** An identity with no usable credential anywhere is the
 *    only thing that costs an approval, and one approval covers all of its lanes.
 * 4. **Fan the fresh credential out.** After the approval, re-read the identity and copy the new
 *    credential to the siblings, so the approval is not spent again next time.
 *
 * Thirty wrappers on six provider accounts therefore cost six approvals.
 *
 * ## The account a caller names is the account that ends up authenticated
 *
 * Cheapness is not a licence to log in something else. A login runs for an IDENTITY, but it is asked
 * for by an ACCOUNT, and those had drifted apart: the approval went through whichever lane was
 * declared `interactive`, the credential landed in that lane's home, and the account somebody named
 * was reported on as if the two were interchangeable. They are not — every home keeps its own copy,
 * so two homes are two credentials.
 *
 * The named accounts are therefore the pass's **subjects**, and a subject is proved rather than
 * assumed: after the approval every home is read again, the credential is copied onto the lanes that
 * need one, and each subject's OWN home is read once more and must hold something usable. When it does
 * not, that account's row is `failed` and the message names it. A silent success that authenticated a
 * sibling is the worst outcome available here and is the one thing this refuses to produce.
 *
 * ## What this refuses to do is as important as what it does
 *
 * An identity it could not classify is reported, not logged in and not overwritten: see
 * {@link ./identity.ts} for why `unreadable` is a state and what it forbids.
 */
import {
  chooseLoginDriver,
  type CredentialReading,
  type FleetIdentity,
  type FleetIdentityMember,
  type FleetIdentityService,
  type FleetIdentityStatus,
  selectIdentities,
} from './identity.ts';
import type { HarnessKind } from './manifest.ts';
import type { FleetTokenRefreshResult, FleetTokenRenewal } from './token-refresh.ts';

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
  /** Its expired token renewed itself, with no browser and nobody asked. */
  | 'renewed'
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

/**
 * How much this pass is allowed to do.
 *
 * - `full` — the cheapest path to a signed-in fleet: renew, clone, and ask a human only for an
 *   identity where no home holds anything usable.
 * - `sync-only` — clone credentials and stop; it never opens a browser.
 * - `reauthenticate` — get a credential the provider has just accepted, whatever the homes currently
 *   hold.
 *
 * `reauthenticate` exists because a local reading cannot see a REVOKED token. A credential the
 * provider answers `401` for still classifies as `valid` here — it has an access token and its expiry
 * is in the future — so `full` decides the identity is `complete`, reports every lane `usable`, and
 * changes nothing. That is what made `fy fleet health`'s printed remedy, and the browser's Sign in
 * button, do nothing at all on exactly the accounts they were offered for. Naming an account is a
 * statement that what it holds is not working, so a named account gets a real sign-in.
 *
 * It still renews first. A refresh token that rotates itself IS the provider accepting a credential
 * again, and it costs nobody an approval — so a renewal that succeeds settles a `reauthenticate` pass
 * and no browser is opened.
 */
export type FleetLoginMode = 'full' | 'sync-only' | 'reauthenticate';

export interface FleetLoginRequest {
  readonly identities: readonly FleetIdentity[];
  /**
   * The accounts this login is FOR. Empty or absent means every identity, with no account named.
   *
   * Two jobs, and they are not the same job. It selects whole identities, because the credential is
   * shared and half an identity is not a thing that can be logged in — and it names the **subjects**:
   * the homes that must hold a usable credential when the pass ends, proved by reading them, whatever
   * lane's wrapper happened to drive the browser.
   */
  readonly accountIds?: readonly string[];
  readonly mode: FleetLoginMode;
  /**
   * Whether an expired-but-renewable credential may renew itself first. Absent means yes.
   *
   * A narrowing, like every other flag here. It exists because the renewal spawns the harness, and an
   * operator diagnosing a fleet is entitled to a pass that starts nothing.
   */
  readonly refresh?: boolean;
}

export interface FleetLoginServiceDeps {
  readonly identities: FleetIdentityService;
  readonly loginPort: FleetLoginPort;
  /**
   * Renewing an expired credential before anybody is asked for anything.
   *
   * Optional, and absent means the pass behaves exactly as it did before this existed. The renewal
   * starts harness processes, so an embedder gets it by deciding to rather than by upgrading: a login
   * driven from a browser and a login driven from a terminal are entitled to different answers about
   * whether spawning a CLI is acceptable, and that decision belongs to whoever composed the service.
   */
  readonly renewal?: FleetTokenRenewal;
}

const SYNC_ONLY_MESSAGE = 'no usable credential in this identity — rerun without --sync-only to log it in';
const STILL_UNRESOLVED = 'the login finished but this identity still has no usable credential';

/**
 * The statuses that CLAIM an account holds a credential, and are therefore the ones a named account
 * has to prove. Everything else already says what went wrong, in the words of whatever found out.
 */
const CLAIMED: ReadonlySet<FleetLoginStatus> = new Set<FleetLoginStatus>(['logged-in', 'renewed', 'synced', 'usable']);

/**
 * One pass's intent, carried as a value so no decision below has to reconstruct it.
 *
 * `subjects` are account ids, not members: they are the caller's words, narrowed to the lanes this
 * identity actually has available, and they outlive the surveys that get re-read around them.
 */
interface FleetLoginPass {
  readonly mode: FleetLoginMode;
  readonly subjects: readonly string[];
  /** Whether the provider must be reached again rather than the homes taken at their word. */
  readonly reauthenticate: boolean;
}

export class FleetLoginService {
  constructor(private readonly deps: FleetLoginServiceDeps) {}

  /**
   * Work through the selected identities, one at a time.
   *
   * Sequential on purpose: an interactive login is a browser approval a human performs in this
   * terminal, and running two at once races for both the terminal and the human.
   */
  async login(request: FleetLoginRequest): Promise<readonly FleetLoginResult[]> {
    const named = new Set(request.accountIds ?? []);
    const selected = named.size === 0 ? request.identities : selectIdentities(request.identities, [...named]);

    const results: FleetLoginResult[] = [];
    for (const identity of selected) {
      results.push(...(await this.#runIdentity(identity, request, named)));
    }
    return results;
  }

  async #runIdentity(
    identity: FleetIdentity,
    request: FleetLoginRequest,
    named: ReadonlySet<string>,
  ): Promise<readonly FleetLoginResult[]> {
    const surveyed = await this.deps.identities.surveyOne(identity);
    const renewal = await this.#renew(identity, surveyed, request.refresh !== false);
    // A renewal that ran may have moved the credential in either direction — renewed, or its refresh
    // token spent and gone. Either way the survey that chose it is now history, and every decision
    // below is about what the homes hold *now*.
    const status = renewal?.ran === true ? await this.deps.identities.surveyOne(identity) : surveyed;
    const skipped = status.unavailable.map(member =>
      row(identity, member.accountId, 'unavailable', member.unavailableReason ?? undefined),
    );

    // Narrowed to what this identity HAS. A named account the manifest declares unavailable already
    // has its own row above, saying so and saying why; promoting it to a subject would add a second,
    // vaguer sentence about the same account and prove nothing either way.
    const subjects = status.members.map(member => member.member.accountId).filter(accountId => named.has(accountId));

    const rows = await this.#decide(status, {
      mode: request.mode,
      subjects,
      // A renewal that renewed IS the provider accepting a credential again, so it settles this pass
      // and nobody is asked for an approval. A renewal that did not run, or ran and failed, leaves the
      // question exactly where a caller who named an account said it was.
      reauthenticate: request.mode === 'reauthenticate' && renewal?.status !== 'renewed',
    });
    return [...skipped, ...this.#withRenewal(await this.#prove(identity, rows, subjects), renewal)];
  }

  /**
   * A named account claims a credential only if its OWN home was read and found to hold one.
   *
   * This is the guarantee, and it is applied here — after everything that could have written — rather
   * than inside any one branch, so no future route to a success row can bypass it. It re-reads the
   * whole identity because that is the only read this package has, and every home it looks at was
   * potentially written during this pass; a sibling's reading is never evidence about this account.
   *
   * Only rows that CLAIM the account has a credential are rewritten. A row that already failed, or
   * that already reports an unreadable home, carries the store's own specific reason — replacing that
   * with a general one would send somebody to look in the wrong place, and would invite them to
   * overwrite a credential that may be perfectly good.
   */
  async #prove(
    identity: FleetIdentity,
    rows: readonly FleetLoginResult[],
    subjects: readonly string[],
  ): Promise<readonly FleetLoginResult[]> {
    if (
      subjects.length === 0 ||
      !rows.some(result => subjects.includes(result.accountId) && CLAIMED.has(result.status))
    )
      return rows;

    const proven = await this.deps.identities.surveyOne(identity);
    return rows.map(result => {
      if (!subjects.includes(result.accountId) || !CLAIMED.has(result.status)) return result;
      const reading = proven.members.find(status => status.member.accountId === result.accountId)?.reading;
      if (reading?.state === 'valid' || reading?.state === 'refreshable') return result;
      return { ...result, status: 'failed' as const, message: undeliveredMessage(result.accountId, reading) };
    });
  }

  /**
   * What to do with one identity.
   *
   * `complete` and `sync` are the two verdicts a `reauthenticate` pass overrides, and overriding them
   * is the point of the mode: both mean "the homes hold something that reads as usable", which is
   * precisely the reading a revoked token produces. Cloning a sibling's copy would deliver the SAME
   * repudiated token, so the only honest answer to "this account is not working" is to ask the
   * provider again.
   *
   * `indeterminate` is NOT overridden. It means a home could not be read, and the refusal exists so a
   * credential that may be perfectly good is never overwritten by a copy — a human naming the account
   * does not make an unreadable home readable, and every member reports its own reason.
   */
  async #decide(status: FleetIdentityStatus, pass: FleetLoginPass): Promise<readonly FleetLoginResult[]> {
    switch (status.verdict.kind) {
      case 'no-login':
        return this.#uniform(status, 'not-required', status.verdict.reason);
      case 'indeterminate':
        return this.#refusals(status, status.verdict.reason);
      case 'complete':
        return pass.reauthenticate ? await this.#interactive(status, pass) : this.#settled(status);
      case 'sync':
        return pass.reauthenticate ? await this.#interactive(status, pass) : await this.#sync(status);
      default:
        return pass.mode === 'sync-only'
          ? this.#uniform(status, 'login-needed', SYNC_ONLY_MESSAGE)
          : await this.#interactive(status, pass);
    }
  }

  /**
   * Let the identity renew itself, when it can and when it was allowed to.
   *
   * Nothing is decided here: which home is eligible, and whether firing at it is safe, belong to the
   * renewal itself — a single-use refresh token is not something two modules get to have opinions
   * about. This asks, and reports what came back.
   */
  async #renew(
    identity: FleetIdentity,
    status: FleetIdentityStatus,
    refresh: boolean,
  ): Promise<FleetTokenRefreshResult | undefined> {
    const renewal = this.deps.renewal;
    if (renewal === undefined || !refresh) return undefined;
    return await renewal.renew(identity, status.members);
  }

  /**
   * Fold what the renewal did into the account it was done to.
   *
   * A renewed account reports `renewed` rather than `usable`, because "already had a usable
   * credential" would hide the one thing worth knowing: this run kept a browser approval from being
   * needed. A renewal that ran and failed leaves the row the flow decided — it may well now read
   * `logged-in` — and lends it the renewal's own sentence when the row has nothing else to say, so a
   * spent refresh token is never silent. A row that already failed is never rewritten: a failure
   * outranks anything that went right earlier.
   */
  #withRenewal(
    rows: readonly FleetLoginResult[],
    renewal: FleetTokenRefreshResult | undefined,
  ): readonly FleetLoginResult[] {
    if (renewal === undefined || !renewal.ran) return rows;
    return rows.map(result => {
      if (result.accountId !== renewal.accountId || result.status === 'failed') return result;
      if (renewal.status === 'renewed') return { ...result, status: 'renewed' as const };
      return result.message === undefined && renewal.reason !== undefined
        ? { ...result, message: renewal.reason }
        : result;
    });
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
   * Ask a human once, deliver the result to the account it was asked for, and prove it landed.
   *
   * Two steps here, and the third is {@link #prove}, which every route out of this class goes through:
   *
   * 1. **Approve.** One lane's wrapper is launched. It is the named account's own lane whenever that
   *    lane can talk to a person, and an interactive sibling otherwise — every lane of an identity is
   *    the same provider account, so borrowing one costs the same single approval and authenticates
   *    the same thing.
   * 2. **Deliver.** The credential arrives in the home of whichever lane was LAUNCHED, which is not
   *    necessarily the home anybody asked about. So every home is read again and the identity's own
   *    clone step copies it onto the lanes that need one, the named account included.
   *
   * The account whose wrapper was launched reports `logged-in`; an account that received the
   * credential by copy reports `synced`, which is what actually happened to it. A login that returns
   * success but leaves the identity without a usable credential anywhere is a failure here, not a
   * success — the provider page may have been closed halfway.
   */
  async #interactive(status: FleetIdentityStatus, pass: FleetLoginPass): Promise<readonly FleetLoginResult[]> {
    const driver = chooseLoginDriver(status.members, pass.subjects[0]);
    if (driver === undefined) return [];

    const outcome = await this.#attempt(status.identity.kind, driver);
    if (outcome.status === 'failed') return this.#uniform(status, 'failed', outcome.message);

    const settled = await this.deps.identities.surveyOne(status.identity);
    const rows =
      settled.verdict.kind === 'sync'
        ? await this.#sync(settled)
        : settled.verdict.kind === 'complete'
          ? this.#settled(settled)
          : this.#uniform(settled, 'failed', STILL_UNRESOLVED);

    // `logged-in` is a claim about where the credential CAME FROM, so it is credited only when this
    // home's credential is its own login's work. Two things disqualify it, and both were observed by
    // running the command rather than by reading it:
    //
    // - the launched lane received a COPY. Its own login exited zero and wrote nothing, so the
    //   identity's credential had to be cloned in; `synced` says that, and `logged-in` would credit a
    //   sign-in that produced nothing while hiding a harness that is failing silently.
    // - the row does not say this home holds a credential at all. The launched lane is now the account
    //   somebody named, so its home can perfectly well be the unreadable one — and an exit code is not
    //   evidence against a read that failed.
    const donated = new Set(settled.targets.map(target => target.accountId));
    return rows.map(result =>
      result.accountId === driver.accountId && CLAIMED.has(result.status) && !donated.has(result.accountId)
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

/**
 * Why a named account did not end up with a credential, in words a person can act on.
 *
 * Two sentences rather than one, because they send a reader to two different places: an unreadable
 * home is a machine problem to fix, and an unreadable home is never overwritten — saying "the copy
 * failed" there would invite somebody to delete a credential that may be perfectly good. Names the
 * account and the reason the store gave; never anything derived from credential material.
 */
function undeliveredMessage(accountId: string, reading: CredentialReading | undefined): string {
  if (reading?.state === 'unreadable') {
    return `the sign-in finished, but "${accountId}" was left as it was: its own home could not be read (${reading.reason ?? 'the credential could not be read'}), and a home that cannot be read is never overwritten`;
  }
  return `the sign-in finished, but "${accountId}" still holds no usable credential of its own — the approval authenticated this provider account through another lane and the copy into this account's home did not take`;
}
