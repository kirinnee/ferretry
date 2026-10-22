import {
  classifyInstallMethod,
  DAEMON_UPDATE_CODES,
  DaemonUpdateSettingsPatchSchema,
  type DaemonUpdateStartRequest,
  type DaemonUpdateView,
  type InstallMethod,
  isUpdateAvailable,
  knownLatestRelease,
  planUpdate,
  UPDATE_CHECK_INTERVAL_MS,
  type UpdateCheck,
  UpdateCheckSchema,
  type UpdateJob,
  type UpdatePlan,
  type UpdateReport,
  UpdateReportSchema,
} from '@ferretry/protocol';
import type {
  InstallFactsSource,
  LatestReleaseSource,
  UpdateActivity,
  UpdateClock,
  UpdateDocuments,
  UpdateLauncher,
  UpdateScheduler,
} from './ports.ts';

/**
 * The backstop: how often the loop looks again with nothing to tell it to. NOT how often GitHub is
 * asked — that is at most every `UPDATE_CHECK_INTERVAL_MS`, at the first look after it falls due.
 *
 * An update waiting for idle no longer waits on this. The daemon tells the service whenever a session's
 * state is written ({@link DaemonUpdateService.activityChanged}), and a write is how the last ferret's
 * turn ends; this cadence is left to what has no event — a settings document edited by hand, the
 * six-hourly ask.
 */
export const UPDATE_BACKSTOP_INTERVAL_MS = 15 * 60_000;

/**
 * How long a started update may go without reporting back before it is called failed. Long enough
 * for a slow `nix profile upgrade` to build; short enough that one lost report does not block the
 * next update forever.
 */
export const UPDATE_REPORT_TIMEOUT_MS = 15 * 60_000;

type DaemonUpdateCode = (typeof DAEMON_UPDATE_CODES)[keyof typeof DAEMON_UPDATE_CODES];

/** A request the update cannot honour, with the code the app says the right sentence for. */
export class DaemonUpdateRefusal extends Error {
  constructor(
    readonly code: DaemonUpdateCode,
    message: string,
  ) {
    super(message);
    this.name = 'DaemonUpdateRefusal';
  }
}

export interface DaemonUpdateServiceOptions {
  /** The version this daemon runs. */
  readonly current: string;
  readonly product: string;
  /** The client binary name, which the plan's steps are typed with. */
  readonly clientName: string;
  readonly install: InstallFactsSource;
  readonly releases: LatestReleaseSource;
  readonly documents: UpdateDocuments;
  readonly launcher: UpdateLauncher;
  readonly activity: UpdateActivity;
  readonly clock: UpdateClock;
  /** Defaults to `UPDATE_CHECK_INTERVAL_MS`. */
  readonly checkIntervalMs?: number;
  /**
   * Whether this daemon asks for the latest release at all. Off for a development build, which has
   * no release to compare against, and when the operator says so (`FY_UPDATE_CHECK=off`) — which is
   * also how a suite that boots a real daemon keeps it off the network.
   */
  readonly checks: boolean;
}

/** The update in flight, as only this boot knows it. A finished one lives in the `report` document. */
type Pending =
  | { readonly state: 'waiting-for-idle'; readonly target: string; readonly requestedAt: string }
  | { readonly state: 'running'; readonly target: string; readonly startedAtMs: number }
  | { readonly state: 'finished'; readonly report: UpdateReport };

/** The route-facing surface. */
export interface DaemonUpdateSubsystem {
  view(): Promise<DaemonUpdateView>;
  start(request: DaemonUpdateStartRequest): Promise<DaemonUpdateView>;
  setAutoInstall(autoInstall: boolean): Promise<DaemonUpdateView>;
  /** Arms the boot check and the backstop; answers the disarm. */
  arm(): () => void;
  /** A session's state was written: a turn may have ended, so an update waiting for idle may go now. */
  activityChanged(): void;
}

/**
 * Knowing the latest release, and starting an update — see `docs/updating.md`.
 *
 * THE DAEMON NEVER UPDATES ITSELF IN-PROCESS. It starts `<client> daemon update`, which outlives the
 * restart it performs and leaves a report for whichever daemon comes up. Everything here is deciding
 * WHETHER and WHEN: a check at boot and at most every six hours, one update at a time, and
 * automatically only when somebody turned that on.
 *
 * A FERRET MID-TURN DOES NOT STOP AN UPDATE ASKED FOR NOW. It runs in tmux, outside this process; the
 * next daemon adopts its pane again with its turn state on disk, and its Ferretry calls wait for that
 * daemon instead of failing (docs/updating.md § Ferrets keep running). Waiting for idle is still
 * offered — `when-idle` — and is what an AUTOMATIC update always does, because nobody chose that moment.
 */
export class DaemonUpdateService implements DaemonUpdateSubsystem {
  readonly #options: DaemonUpdateServiceOptions;
  readonly #intervalMs: number;
  #method: Promise<InstallMethod> | undefined;
  #check: UpdateCheck | undefined;
  #checking: Promise<UpdateCheck> | undefined;
  #pending: Pending | undefined;
  /** The last pass stopped only because a ferret was mid-turn: the next idle moment is worth a look. */
  #idleWanted = false;
  /** The pass running now, which every other ask joins: two passes could each launch the update. */
  #passing: Promise<void> | undefined;

  constructor(
    options: DaemonUpdateServiceOptions,
    private readonly scheduler: UpdateScheduler,
  ) {
    this.#options = options;
    this.#intervalMs = options.checkIntervalMs ?? UPDATE_CHECK_INTERVAL_MS;
  }

  arm(): () => void {
    void this.tick();
    return this.scheduler.every(UPDATE_BACKSTOP_INTERVAL_MS, () => void this.tick());
  }

  /**
   * Looks again when, and only when, the last pass was held back by a ferret mid-turn. Every other write
   * costs one comparison: this is called for every state document the daemon writes.
   */
  activityChanged(): void {
    if (this.#idleWanted) void this.tick();
  }

  /**
   * One pass: ask for the latest release when it is due, then move a waiting or automatic update on. An
   * ask while a pass runs joins it.
   */
  async tick(): Promise<void> {
    this.#passing ??= this.#pass().finally(() => {
      this.#passing = undefined;
    });
    await this.#passing;
  }

  async #pass(): Promise<void> {
    this.#idleWanted = false;
    try {
      const check = await this.#refreshIfDue();
      const job = await this.#job();
      if (job?.state === 'running') return;
      const target = job?.state === 'waiting-for-idle' ? job.target : await this.#automaticTarget(check, job);
      if (target === undefined) return;
      if ((await this.#options.activity.midTurn()) > 0) {
        this.#idleWanted = true;
        return;
      }
      await this.#launch(target);
    } catch {
      // A pass that failed changes nothing; the next one tries again and the view says what it knows.
    }
  }

  /** The release an automatic update would install now, if one is turned on and due. */
  async #automaticTarget(check: UpdateCheck, job: UpdateJob | null): Promise<string | undefined> {
    const latest = knownLatestRelease(check);
    if (!(await this.#autoInstall()) || latest === undefined) return undefined;
    if (!isUpdateAvailable(this.#options.current, latest)) return undefined;
    if ((await this.#plan()).kind !== 'self') return undefined;
    // Never retry the release the last automatic attempt already failed or rolled back.
    if (job?.state === 'finished' && job.report.target === latest.version) return undefined;
    return latest.version;
  }

  async view(): Promise<DaemonUpdateView> {
    const [method, check, midTurn, autoInstall] = await Promise.all([
      this.#installMethod(),
      this.#loadedCheck(),
      this.#options.activity.midTurn(),
      this.#autoInstall(),
    ]);
    const job = await this.#job(midTurn);
    return {
      current: this.#options.current,
      method,
      plan: this.#planFor(method),
      check,
      available: isUpdateAvailable(this.#options.current, knownLatestRelease(check)),
      midTurn,
      autoInstall,
      job,
    };
  }

  async start(request: DaemonUpdateStartRequest): Promise<DaemonUpdateView> {
    const job = await this.#job();
    if (job?.state === 'running' || job?.state === 'waiting-for-idle') {
      throw new DaemonUpdateRefusal(
        DAEMON_UPDATE_CODES.inProgress,
        `an update to ${job.target} is already ${job.state === 'running' ? 'running' : 'waiting for the ferrets to finish their turns'}`,
      );
    }
    const plan = await this.#plan();
    if (plan.kind !== 'self') {
      throw new DaemonUpdateRefusal(
        DAEMON_UPDATE_CODES.notSelfUpdatable,
        'this daemon cannot update itself; follow the steps shown for how it was installed',
      );
    }
    const latest = knownLatestRelease(await this.#loadedCheck());
    if (latest === undefined || !isUpdateAvailable(this.#options.current, latest)) {
      throw new DaemonUpdateRefusal(
        DAEMON_UPDATE_CODES.notAvailable,
        `no newer release than ${this.#options.current} is known`,
      );
    }
    if (request.target !== latest.version) {
      throw new DaemonUpdateRefusal(
        DAEMON_UPDATE_CODES.staleTarget,
        `${request.target} is not the latest release; the latest is ${latest.version}`,
      );
    }
    // `confirmMidTurn` is not read: a daemon from before this one asked for it, and this one never refuses.
    if (request.when === 'when-idle' && (await this.#options.activity.midTurn()) > 0) {
      this.#pending = { state: 'waiting-for-idle', target: request.target, requestedAt: this.#nowIso() };
      this.#idleWanted = true;
    } else {
      await this.#launch(request.target);
    }
    return await this.view();
  }

  async setAutoInstall(autoInstall: boolean): Promise<DaemonUpdateView> {
    await this.#options.documents.write('settings', { autoInstall });
    // Turned on, an available update installs at the next idle moment rather than the next backstop.
    if (autoInstall) {
      this.#idleWanted = true;
      this.activityChanged();
    }
    return await this.view();
  }

  async #launch(target: string): Promise<void> {
    await this.#options.documents.remove('report');
    const startedAtMs = this.#options.clock.now();
    const outcome = await this.#options.launcher.launch(target);
    this.#pending =
      outcome.kind === 'started'
        ? { state: 'running', target, startedAtMs }
        : {
            state: 'finished',
            report: this.#failed(target, `The update could not start: ${outcome.reason}.`),
          };
  }

  /** The job as the view shows it: what this boot started, else the last report on disk. */
  async #job(midTurn?: number): Promise<UpdateJob | null> {
    const pending = this.#pending;
    if (pending?.state === 'waiting-for-idle') {
      return { ...pending, midTurn: midTurn ?? (await this.#options.activity.midTurn()) };
    }
    if (pending?.state === 'finished') return pending;
    const report = await this.#report();
    if (pending?.state === 'running') {
      if (report !== undefined && Date.parse(report.finishedAt) >= pending.startedAtMs) {
        this.#pending = undefined;
        return { state: 'finished', report };
      }
      if (this.#options.clock.now() - pending.startedAtMs > UPDATE_REPORT_TIMEOUT_MS) {
        const timedOut = this.#failed(
          pending.target,
          'The update did not report back within 15 minutes; see the daemon log.',
        );
        this.#pending = { state: 'finished', report: timedOut };
        return this.#pending;
      }
      return { state: 'running', target: pending.target, startedAt: new Date(pending.startedAtMs).toISOString() };
    }
    return report === undefined ? null : { state: 'finished', report };
  }

  #failed(target: string, message: string): UpdateReport {
    return { from: this.#options.current, target, outcome: 'failed', message, finishedAt: this.#nowIso() };
  }

  async #report(): Promise<UpdateReport | undefined> {
    const parsed = UpdateReportSchema.safeParse(await this.#options.documents.read('report'));
    return parsed.success ? parsed.data : undefined;
  }

  async #autoInstall(): Promise<boolean> {
    const parsed = DaemonUpdateSettingsPatchSchema.safeParse(await this.#options.documents.read('settings'));
    return parsed.success && parsed.data.autoInstall;
  }

  async #installMethod(): Promise<InstallMethod> {
    this.#method ??= this.#options.install.facts().then(classifyInstallMethod);
    return await this.#method;
  }

  async #plan(): Promise<UpdatePlan> {
    return this.#planFor(await this.#installMethod());
  }

  #planFor(method: InstallMethod): UpdatePlan {
    return planUpdate(method, { product: this.#options.product, clientName: this.#options.clientName });
  }

  async #loadedCheck(): Promise<UpdateCheck> {
    if (this.#check === undefined) {
      const parsed = UpdateCheckSchema.safeParse(await this.#options.documents.read('latest'));
      this.#check = parsed.success ? parsed.data : { state: 'never' };
    }
    return this.#check;
  }

  /** Asks for the latest release when the last answer is older than the interval; one ask at a time. */
  async #refreshIfDue(): Promise<UpdateCheck> {
    const check = await this.#loadedCheck();
    const due = check.state === 'never' || this.#options.clock.now() - Date.parse(check.checkedAt) >= this.#intervalMs;
    if (!due || !this.#options.checks) return check;
    this.#checking ??= this.#refresh(check).finally(() => {
      this.#checking = undefined;
    });
    return await this.#checking;
  }

  async #refresh(previous: UpdateCheck): Promise<UpdateCheck> {
    const answer = await this.#options.releases.latest();
    const checkedAt = this.#nowIso();
    let next: UpdateCheck;
    if (answer.kind === 'ok') {
      next = { state: 'ok', checkedAt, latest: answer.release };
    } else {
      const lastKnown =
        previous.state === 'ok' ? { checkedAt: previous.checkedAt, latest: previous.latest } : undefined;
      const carried = previous.state === 'failed' ? previous.lastKnown : lastKnown;
      next = {
        state: 'failed',
        checkedAt,
        reason: answer.reason,
        ...(carried === undefined ? {} : { lastKnown: carried }),
      };
    }
    this.#check = next;
    await this.#options.documents.write('latest', next).catch(() => undefined);
    return next;
  }

  #nowIso(): string {
    return new Date(this.#options.clock.now()).toISOString();
  }
}
