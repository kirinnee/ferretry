import { type FleetIdentity, type FleetManifest, selectIdentities } from '@ferretry/fleet';
import type {
  IFleetApplier,
  IFleetClock,
  IFleetConfigSource,
  IFleetIdentitySource,
  IFleetLoginService,
  IFleetManifestSource,
  IFleetOutput,
  IFleetPlanner,
  IFleetScaffolder,
  IFleetUsageCollectorFactory,
  IRecommendationGateway,
} from './ports.ts';
import {
  renderApplyPlan,
  renderApplyResult,
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
  readonly identities: IFleetIdentitySource;
  readonly logins: IFleetLoginService;
  readonly clock: IFleetClock;
  readonly recommendations: IRecommendationGateway;
  readonly out: IFleetOutput;
}

/**
 * Drives `fy fleet …`.
 *
 * Provisioning is a local operation: the fleet is directories, wrappers and settings on this host,
 * and the daemon is not involved. Only `recommend` crosses to the daemon, because deciding which
 * agent should do a piece of work needs the routing catalog the daemon owns.
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
  async init(options: FleetCommandOptions): Promise<void> {
    const result = await this.deps.scaffolder.scaffold();
    this.#report(result, options, () => renderScaffoldResult(result));
  }

  /**
   * Realizes the declared configuration.
   *
   * The plan is built first and always, so `--dry-run` and a real apply share one decision. A plan
   * that cannot be built — an asset the harness has no destination for, a duplicate wrapper — throws
   * before a single byte is written.
   */
  async apply(options: FleetApplyOptions): Promise<void> {
    const config = await this.deps.config.load();
    const plan = this.deps.planner.build(config, this.deps.clock.now());
    if (options.dryRun === true) {
      this.#report(plan, options, () => renderApplyPlan(plan));
      return;
    }
    const result = await this.deps.applier.apply(plan);
    this.#report(result, options, () => renderApplyResult(result));
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
