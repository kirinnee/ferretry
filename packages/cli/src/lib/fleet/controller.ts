import { FleetApplyFailureError, type FleetIdentity, type FleetManifest, selectIdentities } from '@ferretry/fleet';
import type {
  IFleetApplier,
  IFleetAuthorizationGateway,
  IFleetClock,
  IFleetConfigSource,
  IFleetHealthCollectorFactory,
  IFleetIdentitySource,
  IFleetLoginService,
  IFleetManifestSource,
  IFleetOutput,
  IFleetPlanner,
  IFleetScaffolder,
  IFleetSharingGateway,
  IFleetUsageCollectorFactory,
  IRecommendationGateway,
} from './ports.ts';
import {
  renderApplyPlan,
  renderApplyResult,
  renderFleetApplyFailure,
  renderFleetApproval,
  renderFleetSharing,
  renderHealth,
  renderIdentityStatus,
  renderLoginResults,
  renderManifest,
  renderRecommendation,
  renderScaffoldResult,
  renderUsage,
} from './render.ts';

/** Options every fleet command accepts. */
export interface FleetCommandOptions {
  readonly json?: boolean;
}

/** Flags that shape the first configuration only; an existing file is always left alone. */
export interface FleetInitOptions extends FleetCommandOptions {
  readonly firstAccount?: 'claude' | 'codex' | 'detected';
}

/** Flags that shape an apply. */
export interface FleetApplyOptions extends FleetCommandOptions {
  /** Print every write the configuration implies and stop. */
  readonly dryRun?: boolean;
}

/** Flags that shape a recommendation. */
export interface FleetRecommendOptions extends FleetCommandOptions {
  /** commander's `--no-usage` sets this false; absent means probe. */
  readonly usage?: boolean;
}

/** Flags that shape a login. Both narrow what it may do; neither widens it. */
export interface FleetLoginOptions extends FleetCommandOptions {
  /** Report what each home holds and change nothing — no copy, no browser. */
  readonly status?: boolean;
  /** Copy credentials across identities, but never ask a human to approve one. */
  readonly syncOnly?: boolean;
}

/** The collaborators the fleet group is wired with. */
export interface FleetControllerDeps {
  readonly config: IFleetConfigSource;
  readonly manifests: IFleetManifestSource;
  readonly scaffolder: IFleetScaffolder;
  readonly planner: IFleetPlanner;
  readonly applier: IFleetApplier;
  readonly usage: IFleetUsageCollectorFactory;
  /** Optional while embedders migrate; the production composition always supplies it. */
  readonly health?: IFleetHealthCollectorFactory;
  readonly identities: IFleetIdentitySource;
  readonly logins: IFleetLoginService;
  readonly clock: IFleetClock;
  readonly recommendations: IRecommendationGateway;
  /** Required, not optional: four construction sites is cheaper than a runtime absence check. */
  readonly authorizations: IFleetAuthorizationGateway;
  /** Reading the sharing report the Fleet tab reads, from the one resolver that owns it. */
  readonly sharing: IFleetSharingGateway;
  readonly out: IFleetOutput;
}

/**
 * The machine-readable form of a failed apply.
 *
 * `outcome` is lifted to the top rather than left inside `failure`, so a caller can branch on one
 * well-known key without first learning the union's shape — and `rolled-back` versus
 * `history-failed-after-commit` is exactly the branch a script must not get wrong. `error` repeats
 * the provisioner's own sentence so a caller that only logs the payload still says something true.
 *
 * `failure` is included whole and unsummarized on purpose: it IS the exact post-state, and a
 * flattened version here would be a second contract to keep in step with the first, which is the
 * failure mode this whole change exists to remove.
 *
 * `lockResidue` has to be lifted explicitly because it is a sibling of `failure` on the error rather
 * than a member of it. Left out, a machine caller would be told which post-state it is in but not
 * that the NEXT apply is already blocked — which is the one thing an automated retry needs to know
 * before it tries.
 */
function applyFailurePayload(error: FleetApplyFailureError): Record<string, unknown> {
  return {
    outcome: error.failure.kind,
    error: error.message,
    failure: error.failure,
    ...(error.lockResidue === undefined ? {} : { lockResidue: error.lockResidue }),
  };
}

/**
 * Drives `fy fleet …`.
 *
 * Provisioning is a local operation: the fleet is directories, wrappers and settings on this host,
 * and for most of these verbs the daemon is not involved. Two of them cross to it. `recommend` does
 * because deciding which agent should do a piece of work needs the routing catalog the daemon owns.
 * `authorize` does because a change proposed in a paired browser can only be approved by whoever
 * holds this host's credential, and this terminal is where that person is.
 */
export class FleetController {
  constructor(private readonly deps: FleetControllerDeps) {}

  /**
   * Prepares a host that has never had a fleet.
   *
   * Everything else here reads a configuration; on a fresh machine there is none, and there is no
   * external configuration manager behind Ferretry to have placed one. Creates only what is absent,
   * so running it on a live fleet fills in anything a newer release added and disturbs nothing else.
   */
  async init(options: FleetInitOptions): Promise<void> {
    const result = await this.deps.scaffolder.scaffold({ firstAccount: options.firstAccount });
    this.#report(result, options, () => renderScaffoldResult(result, options.firstAccount));
  }

  /**
   * Realizes the declared configuration.
   *
   * The plan is built first and always, so `--dry-run` and a real apply share one decision. A plan
   * that cannot be built — an asset the harness has no destination for, a duplicate wrapper — throws
   * before a single byte is written.
   *
   * A FAILED APPLY IS NOT FLATTENED. The provisioner distinguishes three post-states — the host put
   * back, the host left unverified, and the fleet genuinely committed with a later step failing — and
   * which one it is decides what a person does next. Collapsing them into "apply failed" is how a
   * fleet that did land gets applied again blindly. Both surfaces preserve the distinction, and both
   * remain backward compatible:
   *
   * - Human: the failure is thrown carrying its full typed rendering, so the composition root prints
   *   that to stderr and exits non-zero. stderr already carried a one-line message here; it now
   *   carries a fuller one, and it is not also echoed to stdout, because saying it twice in two
   *   different amounts of detail is how a reader learns to trust neither.
   * - `--json`: the structured payload goes to stdout, which on a failed apply was previously empty —
   *   so a machine caller that reads it is reading something new rather than something changed. The
   *   original error is then rethrown for the exit code, so `outcome` and the exit status agree.
   *
   * A SUCCESSFUL apply is untouched on both surfaces.
   */
  async apply(options: FleetApplyOptions): Promise<void> {
    const config = await this.deps.config.load();
    const plan = this.deps.planner.build(config, this.deps.clock.now());
    if (options.dryRun === true) {
      const preview = await this.deps.applier.preview(plan);
      this.#report(preview, options, () => renderApplyPlan(preview));
      return;
    }
    try {
      const result = await this.deps.applier.apply(plan);
      this.#report(result, options, () => renderApplyResult(result));
    } catch (error) {
      if (!(error instanceof FleetApplyFailureError)) throw error;
      if (options.json === true) {
        this.deps.out.success(JSON.stringify(applyFailurePayload(error), null, 2));
        throw error;
      }
      // `cause` keeps the typed failure reachable for any embedder that wants it; the message is
      // replaced because the root prints exactly one thing and it should be the useful one.
      throw new Error(renderFleetApplyFailure(error.failure, error.lockResidue), { cause: error });
    }
  }

  async list(options: FleetCommandOptions): Promise<void> {
    const manifest = await this.#manifest();
    this.#report(manifest, options, () => renderManifest(manifest));
  }

  /**
   * Probes every account's quota.
   *
   * The manifest is the source of accounts, never the wrappers on disk: kteam discovered accounts by
   * globbing the bin directory, so a stale executable produced a usage row for an account that no
   * longer existed.
   */
  async usage(options: FleetCommandOptions): Promise<void> {
    const collector = this.deps.usage.forConfig(await this.deps.config.load());
    const snapshot = await collector.collect(await this.#manifest());
    const exhausted = snapshot.accounts.filter(account => account.atLimit);
    if (options.json !== true && exhausted.length === snapshot.accounts.length && exhausted.length > 0) {
      this.deps.out.warn('Every account is at its limit — nothing can be launched until a window resets.');
    }
    this.#report(snapshot, options, () => renderUsage(snapshot));
  }

  /** Explicit only: this spends a tiny provider turn, so it is never an incidental list refresh. */
  async health(options: FleetCommandOptions): Promise<void> {
    if (this.deps.health === undefined) throw new Error('fleet health probing is not configured for this CLI');
    const collector = this.deps.health.forConfig(await this.deps.config.load());
    const snapshot = await collector.collect(await this.#manifest());
    this.#report(snapshot, options, () => renderHealth(snapshot));
  }

  /**
   * Logs the fleet in, by identity rather than by account.
   *
   * Naming an account selects its whole identity, because the credential is shared: every lane of one
   * provider account keeps its own copy, so "log this one in" and "log its siblings in" are the same
   * request. Most of the work is copying — only an identity with no usable credential anywhere costs a
   * human an approval, which is what turns thirty browser approvals into one per provider account.
   *
   * Sequential and in the foreground, because an approval is something a human does in this terminal
   * and two at once race for both.
   */
  async login(accountIds: readonly string[], options: FleetLoginOptions): Promise<void> {
    const identities = await this.#identities();
    if (options.status === true) {
      const surveyed = await this.deps.identities.survey(
        accountIds.length === 0 ? identities : selectIdentities(identities, accountIds),
      );
      this.#report(surveyed, options, () => renderIdentityStatus(surveyed));
      return;
    }

    const results = await this.deps.logins.login({
      identities,
      ...(accountIds.length === 0 ? {} : { accountIds }),
      mode: options.syncOnly === true ? 'sync-only' : 'full',
    });
    this.#report(results, options, () => renderLoginResults(results));
  }

  async recommend(words: readonly string[], options: FleetRecommendOptions): Promise<void> {
    const task = words.join(' ').replaceAll(/\s+/gu, ' ').trim();
    if (task === '') throw new Error('describe the task: fy fleet recommend "<what needs doing>"');
    const recommendation = await this.deps.recommendations.recommend({ task, usage: options.usage !== false });
    this.#report(recommendation, options, () => renderRecommendation(recommendation));
  }

  /**
   * Approves exactly one change a paired browser has proposed.
   *
   * The device boundary this closes is deliberate: a browser that paired once may inspect this
   * daemon and may build a write-free proposal, but pairing is not host authority and never becomes
   * it. So the authority is given here, one change at a time, as a short-lived single-use code bound
   * to one proposal — and the credential that mints it is this host's, which never leaves this
   * machine and is never printed.
   *
   * `--json` IS REFUSED RATHER THAN INHERITED, and refused loudly rather than ignored. The flag is
   * declared on the `fleet` group, so it reaches every verb whether or not the verb wants it, and
   * `#report` would faithfully serialize a live bearer secret into something a pipe can capture and
   * a script can spend. That would delete the property the whole detour exists for: the code is the
   * evidence that a human on this host looked at the change and said yes. Ignoring the flag silently
   * would be worse than refusing it — a pipeline would read a human screen as JSON and misparse it —
   * so this says what it will not do and why.
   */
  async authorize(proposalId: string, options: FleetCommandOptions): Promise<void> {
    if (options.json === true) {
      throw new Error(
        'fy fleet authorize has no --json: an approval code is a bearer secret for the couple of minutes it lives, ' +
          'and a machine-readable mint is one a script can spend without the human this approval exists to ask',
      );
    }
    const mint = await this.deps.authorizations.authorize(proposalId);
    this.deps.out.success(renderFleetApproval(mint));
  }

  /**
   * Which documents this fleet shares, and whether each account uses one or its own copy.
   *
   * Asked of the daemon rather than derived here. This process holds the same configuration, so it
   * could resolve the report itself — and that is precisely the second description that eventually
   * disagrees with the one the Fleet tab is reading. One resolver, one answer, two surfaces.
   */
  async sharing(options: FleetCommandOptions): Promise<void> {
    const sharing = await this.deps.sharing.sharing();
    this.#report(sharing, options, () => renderFleetSharing(sharing));
  }

  /** The provider logins this host has, joined from the declared configuration and the manifest. */
  async #identities(): Promise<readonly FleetIdentity[]> {
    return this.deps.identities.identities(await this.deps.config.load(), await this.#manifest());
  }

  /** The provisioned manifest, or a message naming the command that would create one. */
  async #manifest(): Promise<FleetManifest> {
    const manifest = await this.deps.manifests.load();
    if (manifest === undefined) throw new Error('no fleet manifest on this host — run "fy fleet apply" first');
    return manifest;
  }

  #report(payload: unknown, options: FleetCommandOptions, human: () => string): void {
    this.deps.out.success(options.json === true ? JSON.stringify(payload, null, 2) : human());
  }
}
