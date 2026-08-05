import type { FleetManifest } from '@ferretry/fleet';
import type {
  IFleetApplier,
  IFleetClock,
  IFleetConfigSource,
  IFleetLoginServiceFactory,
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

/** The collaborators the fleet group is wired with. */
export interface FleetControllerDeps {
  readonly config: IFleetConfigSource;
  readonly manifests: IFleetManifestSource;
  readonly scaffolder: IFleetScaffolder;
  readonly planner: IFleetPlanner;
  readonly applier: IFleetApplier;
  readonly usage: IFleetUsageCollectorFactory;
  readonly logins: IFleetLoginServiceFactory;
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
   * Logs the named accounts in, or every account when none are named.
   *
   * One account at a time and in the foreground, because a provider login is a browser approval a
   * human performs — parallelising it would open several at once and race for the same terminal.
   * An account the manifest declares unavailable is reported as such rather than launched.
   *
   * This is *not* kteam's fleet login: it does not group an account's wrappers by the provider
   * account behind them, nor clone one credential across them, so an operator with four wrappers on
   * one account still approves four times. The fleet survey under `docs/migration/surveys/` carries the row.
   */
  async login(accountIds: readonly string[], options: FleetCommandOptions): Promise<void> {
    const manifest = await this.#manifest();
    const logins = this.deps.logins.forConfig(await this.deps.config.load());
    const results = await logins.login(manifest, accountIds.length === 0 ? undefined : accountIds);
    this.#report(results, options, () => renderLoginResults(results));
  }

  async recommend(words: readonly string[], options: FleetRecommendOptions): Promise<void> {
    const task = words.join(' ').replaceAll(/\s+/gu, ' ').trim();
    if (task === '') throw new Error('describe the task: fy fleet recommend "<what needs doing>"');
    const recommendation = await this.deps.recommendations.recommend({ task, usage: options.usage !== false });
    this.#report(recommendation, options, () => renderRecommendation(recommendation));
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
