/**
 * `fy daemon install|uninstall|stop|restart|logs|which|reset`: the process-control half of the daemon verbs, moved from
 * today's `DaemonController` (V-0233, V-0234, V-0236, V-0237, V-0244, V-0249, V-0251). `start` and `status` stay with
 * the shell's launcher and probe (`commands/daemon.ts`).
 *
 * The daemon's own answer (`GET /healthz` at the address its run record names, the pid in it) is the authority on
 * whether it is up, and the service manager on whether it is supervised. Nothing here reads a file under the state home
 * except to measure it for a reset.
 *
 * EVERY MUTATING VERB IS ONE SERIALIZED TRANSACTION, and the ones that only report are not. Each mutating verb holds the
 * executable's garbage-collection root and then writes a service definition or launches that executable; two
 * invocations that interleave them leave a unit file naming one executable while the root holds another's closure.
 * Claims keyed on every ownership target are what make the pair atomic against a peer invocation, and they are taken in
 * the public verb so no verb can ever nest inside another.
 */
import { passMidTurn } from '../update/mid-turn.ts';
import type { IClockPort, IDaemonOutput, IDaemonPrompt, InstalledDaemonBinary } from '../update/machine.ts';
import { type IProgress, NO_PROGRESS } from '../update/progress.ts';
import type { DaemonLayout } from './layout.ts';
import { nixStorePathOf } from './nix-store.ts';
import type {
  DaemonLifecycleVerb,
  DaemonStartHandle,
  IDaemonHealthPort,
  IDaemonLifecycleClaim,
  IDaemonLifecycleLockPort,
  IDaemonLogPort,
  IDaemonSupervisor,
  IDaemonTurnsPort,
  INixGcRootPort,
  IResetInventoryPort,
  IResetTreePort,
  IServiceDefinitionSupervisor,
  ISessionTerminalServerPort,
  IStateHomeClaimPort,
  LocalUpdateHealth,
} from './ports.ts';
import { servesOutsideSupervisor, livenessOf } from './probe.ts';
import {
  beginReadinessWait,
  decideReadiness,
  decideShutdown,
  defaultReadinessPolicy,
  defaultShutdownPolicy,
  type ReadinessPolicy,
  type ShutdownPolicy,
} from './readiness.ts';
import {
  assertResettableRoots,
  type ResetPlan,
  type ResetSurvey,
  renderResetOutcome,
  renderResetPlan,
  resetRoots,
  resetSurvivors,
} from './reset.ts';
import { UnsupportedServiceManagerError } from './supervisor.ts';

/** Options the reporting verbs accept. */
export interface DaemonCommandOptions {
  /** Emit the machine shape instead of the human summary. */
  readonly json?: boolean;
  /** Keep streaming the log as it grows. */
  readonly follow?: boolean;
}

/** Flags `restart` accepts. */
export interface DaemonRestartOptions {
  /** Wait until no ferret is mid-turn. Without it the restart goes ahead: ferrets keep running. */
  readonly whenIdle?: boolean;
  /** The caller has already said what the restart means for ferrets mid-turn (`fy update`). */
  readonly midTurnSaid?: boolean;
  /** How many ferrets are mid-turn and will keep running through it, for the line the restart shows. */
  readonly ferretsKeepRunning?: number;
}

/** Flags `reset` accepts. */
export interface DaemonResetOptions {
  /** Skip the typed confirmation; required when there is no terminal to type it at. */
  readonly yes?: boolean;
}

/**
 * What the caller must type, in full, to authorize a reset by hand: a word, not a `y/N`, because this repository
 * already has one ritual for authorizing something irreversible.
 */
const RESET_CONFIRMATION_WORD = 'reset';

/**
 * What a holder may spend outside its readiness and shutdown waits: locating the installed daemon, holding its
 * closure, and retiring what an earlier release left behind. A peer waits this much longer before refusing.
 */
const LIFECYCLE_RECONCILIATION_ALLOWANCE_MS = 30_000;

/** `" (3 ferrets keep running)"`, or nothing when none are mid-turn or the count is unknown. */
function keepRunningNote(count: number | undefined): string {
  if (count === undefined || count < 1) return '';
  return ` (${String(count)} ${count === 1 ? 'ferret keeps' : 'ferrets keep'} running)`;
}

/** Raised when a reset will not proceed, so the caller sees a refusal rather than a half-reset. */
export class DaemonResetRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonResetRefusedError';
  }
}

class DaemonStartupFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonStartupFailedError';
  }
}

class DaemonShutdownFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonShutdownFailedError';
  }
}

/** What the shell's launcher came to. */
type DaemonLaunchOutcome = { readonly started: true } | { readonly started: false; readonly why: string };

/** The two reads that need a connection to the daemon, supplied by the verb that runs. */
export interface DaemonControlReads {
  readonly resetInventory: IResetInventoryPort;
  readonly turns: IDaemonTurnsPort;
}

/** What the controller needs; a struct so the composition root reads as a wiring list. */
export interface DaemonControllerDeps {
  readonly layout: DaemonLayout;
  /** The service manager for this platform, or `undefined` where there is none. */
  readonly service: IServiceDefinitionSupervisor | undefined;
  /** The always-available fallback: the daemon as a detached child. */
  readonly direct: IDaemonSupervisor;
  readonly health: IDaemonHealthPort;
  readonly logs: IDaemonLogPort;
  /** Holds a Nix-store daemon against garbage collection; a no-op for any other installation. */
  readonly nix: INixGcRootPort;
  /** Serializes every mutating verb below against the same verbs in other invocations. */
  readonly lifecycle: IDaemonLifecycleLockPort;
  /** The daemon executable this host runs, or a THROW naming the remedy when there is none. */
  readonly installedDaemon: () => InstalledDaemonBinary;
  /** Measures and removes the two trees `reset` destroys. */
  readonly resetTrees: IResetTreePort;
  /** Counts what a reset destroys unrecoverably, from the daemon that still holds it. */
  readonly resetInventory: IResetInventoryPort;
  /** Ends every ferret's running agent before a reset removes the home they write into. */
  readonly sessionTerminals: ISessionTerminalServerPort;
  /** Whether the state home carries the Ferretry marker (`home.json`), which a reset requires before it deletes. */
  readonly claims: Pick<IStateHomeClaimPort, 'inspect'>;
  /**
   * The shell's own launcher: starts the daemon once and waits for it to answer. It is how a home that is absent or
   * empty (a fresh machine, or after a reset) comes to exist, because only the daemon's first start creates one.
   */
  readonly launcher?: () => Promise<DaemonLaunchOutcome>;
  /** Offers a nix profile install when `install` finds a daemon running from a `nix shell`. Absent: no offer. */
  readonly nixShellOffer?: { offer(daemon: InstalledDaemonBinary): Promise<InstalledDaemonBinary | undefined> };
  /** Where the typed reset confirmation is read from; never used off a terminal. */
  readonly prompt: IDaemonPrompt;
  /** Whether anybody is at a terminal, asked when the question is asked. */
  readonly interactive: () => boolean;
  /** The binary somebody types, so a reset can name the command that brings the machine back. */
  readonly clientName: string;
  readonly clock: IClockPort;
  readonly out: IDaemonOutput;
  readonly readiness?: ReadinessPolicy;
  readonly shutdown?: ShutdownPolicy;
  /** How many ferrets are mid-turn, for the line a restart says and for `--when-idle`. Absent: nothing is said. */
  readonly turns?: IDaemonTurnsPort;
  /** What a long verb shows while it works. Absent, it shows nothing. */
  readonly progress?: IProgress;
}

export class DaemonController {
  private readonly readiness: ReadinessPolicy;
  private readonly shutdown: ShutdownPolicy;
  private readonly progress: IProgress;

  constructor(private readonly deps: DaemonControllerDeps) {
    this.readiness = deps.readiness ?? defaultReadinessPolicy();
    this.shutdown = deps.shutdown ?? defaultShutdownPolicy();
    this.progress = deps.progress ?? NO_PROGRESS;
  }

  async install(): Promise<void> {
    // Before the claim: a host with no daemon executable cannot install one, and learning that after waiting out
    // another invocation's claim is up to 140 seconds spent on a foregone refusal.
    const found = this.deps.installedDaemon();
    // Before the claim too: the offer can wait on a person, and on `nix profile install`.
    const daemon = (await this.deps.nixShellOffer?.offer(found)) ?? found;
    await this.#serialized('install', () => this.#install(daemon));
  }

  async uninstall(): Promise<void> {
    await this.#serialized('uninstall', () => this.#uninstall());
  }

  async stop(): Promise<void> {
    await this.#serialized('stop', () => this.#stop());
  }

  /**
   * Restarts the daemon, with ferrets mid-turn too, because they keep running. The mid-turn line, and any
   * `--when-idle` wait, come BEFORE the claim, so waiting for a turn to end never holds every other `fy daemon …`
   * invocation on this host.
   */
  async restart(options: DaemonRestartOptions = {}): Promise<void> {
    this.deps.installedDaemon();
    const turns = this.deps.turns;
    if (turns !== undefined && options.midTurnSaid !== true) {
      await passMidTurn(
        {
          midTurn: () => turns.midTurn(),
          sleep: ms => this.deps.clock.sleep(ms),
          warn: line => this.deps.out.warn(line),
        },
        options.whenIdle === true,
        'restarting',
      );
    }
    await this.#serialized('restart', () => this.#restart(keepRunningNote(options.ferretsKeepRunning)));
  }

  /**
   * Removes every trace of this daemon's persistent data, after showing what that costs. INSIDE THE LIFECYCLE CLAIM,
   * and the prompt is inside it too: a reset that released the claim to ask its question would let a peer `start`
   * bring the daemon back up between the answer and the deletion.
   */
  async reset(options: DaemonResetOptions): Promise<void> {
    await this.#serialized('reset', () => this.#reset(options));
  }

  /**
   * The two daemon identities that still exist, and whether they agree: the installed executable, and the daemon
   * serving right now. A daemon that cannot be located is REPORTED WITH ITS REASON rather than as a bare absence.
   */
  async which(options: DaemonCommandOptions): Promise<void> {
    const located = this.#locateDaemon();
    const running = await this.deps.health.probe();
    const payload = {
      installed:
        'reason' in located
          ? { state: 'not-found' as const, reason: located.reason }
          : { state: 'found' as const, path: located.path, source: located.source, version: located.version ?? null },
      running:
        running === undefined
          ? { state: 'not-running' as const }
          : { state: 'running' as const, pid: running.pid, version: running.version },
    };
    if (options.json === true) {
      this.deps.out.success(JSON.stringify(payload, null, 2));
      return;
    }
    const lines = [
      payload.installed.state === 'found'
        ? `installed: ${payload.installed.path} (${payload.installed.source}, version ${payload.installed.version ?? 'unknown'})`
        : `installed: ${payload.installed.reason}`,
      payload.running.state === 'running'
        ? `running: pid ${String(payload.running.pid)} version ${payload.running.version}`
        : 'running: daemon is not running',
    ];
    if (running !== undefined && !('reason' in located) && located.version !== undefined) {
      lines.push(
        running.version === located.version
          ? 'the running daemon is the installed one'
          : `running and installed differ; run ${this.deps.clientName} daemon restart to use the installed daemon`,
      );
    }
    this.deps.out.success(lines.join('\n'));
  }

  async logs(options: DaemonCommandOptions): Promise<void> {
    const file = this.deps.layout.logFile;
    const follow = options.follow === true;
    // A missing log is reported, not silently rendered as an empty one: that reads identically to a daemon that
    // ran and logged nothing.
    if (!follow && !(await this.deps.logs.exists(file))) {
      this.deps.out.warn(`no ${this.#name} log at ${file} yet`);
      return;
    }
    const code = await this.deps.logs.show(file, follow);
    if (code !== 0) this.deps.out.setExitCode(code);
  }

  async #install(daemon: InstalledDaemonBinary): Promise<void> {
    const service = this.#service();
    // Before anything is written: one definition per host, and it may belong to another state home.
    await service.assertServes(undefined);
    // A fresh machine has no home yet, and a definition cannot be written under one that is not ours: the daemon's
    // first start makes it. That daemon is then an orphan, and the hand-over below moves it under the manager.
    await this.#ensureHome();
    // A daemon `fy daemon start` ran before there was a definition holds the state home's lock, so the manager's own
    // daemon would exit at once and leave that one serving with nothing supervising it. It is handed over first.
    const orphan = await this.#orphanOf(service, await this.deps.health.probe());
    if (orphan !== undefined) await this.#stopOrphan(service, orphan);
    // Before the definition is written, so a unit file never names a store path nothing is holding.
    await this.#holdDaemonClosure(daemon.path);
    await this.#step(`Installing the ${this.#name} service`, () => service.install(daemon.path));
    const health = await this.#awaitReady(service, {});
    this.deps.out.success(
      `${this.#name} user service installed from ${service.definitionPath} and started (pid ${String(health.pid)})`,
    );
  }

  async #uninstall(): Promise<void> {
    const service = this.#service();
    await service.assertServes(undefined);
    await service.uninstall();
    // Removing supervision does not uninstall the daemon, so it does not release the daemon's root: a later
    // `fy daemon start` still runs the daemon as a direct child from the same store path.
    this.deps.out.success(
      `${this.#name} user service removed; the installed daemon's Nix closure stays held by ${this.deps.layout.nixGcRoot} so a later ${this.deps.clientName} daemon start still works`,
    );
  }

  async #stop(): Promise<void> {
    const owner = await this.#owner();
    const health = await this.deps.health.probe();
    await owner.assertServes(health?.pid);
    if (!(await this.#bringDown(owner, health))) {
      this.deps.out.warn(`${this.#name} is not running`);
      return;
    }
    this.deps.out.success(`${this.#name} stopped`);
  }

  async #restart(note: string): Promise<void> {
    // Locate the executable BEFORE stopping the incumbent: an operator must learn that a host has no daemon on its
    // PATH while the healthy daemon is still serving, never only after the restart created downtime it cannot undo.
    const daemon = this.deps.installedDaemon();
    // Who owns the daemon, and whether that definition serves THIS home, are judged BEFORE anything is launched: a
    // refusal must leave the host untouched, as it does for `install`.
    const owner = await this.#owner();
    await owner.assertServes(undefined);
    // After a reset the home is gone; the restart then has a daemon to stop, which is the one that makes the home.
    await this.#ensureHome();
    const health = await this.deps.health.probe();
    await owner.assertServes(health?.pid);
    const ready = await this.#restartUnder(owner, daemon.path, health, note);
    this.deps.out.success(`${this.#name} restarted (pid ${String(ready.pid)})`);
  }

  /**
   * Take the daemon down and bring it back under `owner`. A manager that can restart in one command is asked to, so
   * the daemon is never down with nothing owning the transition; only a daemon serving OUTSIDE it is stopped by this
   * CLI first. Every other owner is stopped, watched until it is down, and started. Either way the root is reconciled
   * before the launch, because restart is when an upgraded executable is picked up.
   */
  async #restartUnder(
    owner: IDaemonSupervisor,
    executable: string,
    health: LocalUpdateHealth | undefined,
    note: string,
  ): Promise<LocalUpdateHealth> {
    const service = this.deps.service;
    if (service === undefined || owner !== service || service.restartInPlace === undefined) {
      if (!(await this.#bringDown(owner, health, note)))
        this.deps.out.warn(`${this.#name} was not running; starting it`);
      await this.#holdDaemonClosure(executable);
      const handle = await this.#step(`Starting ${this.#name}`, () => owner.start(executable));
      return await this.#awaitReady(owner, handle);
    }
    const orphan = await this.#orphanOf(owner, health);
    if (orphan !== undefined) await this.#stopOrphan(owner, orphan);
    else if (!(await this.#running(owner, health))) this.deps.out.warn(`${this.#name} was not running; starting it`);
    await this.#holdDaemonClosure(executable);
    await this.#step(`Restarting ${this.#name}${note}`, () => service.restartInPlace?.(executable));
    return await this.#awaitReady(owner, {});
  }

  /**
   * Measure, show, ask, stop, remove, in that order, and the order is the whole design.
   *
   * MEASURED AND COUNTED WHILE THE DAEMON IS STILL UP, because the counts only exist there. STOPPED BEFORE ANYTHING IS
   * REMOVED, and a stop that will not take REFUSES the whole verb: moving state out from under a running daemon is
   * how a half-reset happens. THE FERRETS' AGENTS ARE ENDED TOO, because stopping the daemon does not stop them: they
   * run under a private tmux server that outlives a stop. The home is NOT created again: the kernel makes a new one
   * on the next start, and a reset is not an install.
   */
  async #reset(options: DaemonResetOptions): Promise<void> {
    const layout = this.deps.layout;
    const roots = resetRoots(layout);
    // Before any measurement, let alone any removal: an operator-supplied FY_HOME that resolves somewhere
    // unresettable must fail while nothing has been touched.
    assertResettableRoots(roots, layout.homeDirectory);
    await this.#assertClaimedStateHome();

    const owner = await this.#owner();
    const health = await this.deps.health.probe();
    // Before a single count is shown: the counts, the stop and the removal must all be of ONE daemon.
    await owner.assertServes(health?.pid);
    const counted = health === undefined ? undefined : await this.deps.resetInventory.count();
    const surveys: ResetSurvey[] = [];
    for (const root of roots) surveys.push({ root, measure: await this.deps.resetTrees.measure(root.path) });
    const plan: ResetPlan = {
      daemon: this.#name,
      surveys,
      inventory: counted,
      survivors: resetSurvivors(layout),
    };
    this.deps.out.warn(renderResetPlan(plan));
    await this.#confirmReset(options);

    await this.#bringDown(owner, health);
    await this.#endSessionTerminals();
    const removals: ResetSurvey[] = [];
    for (const root of roots) removals.push({ root, measure: await this.deps.resetTrees.remove(root.path) });
    this.deps.out.success(renderResetOutcome(this.#name, removals, this.deps.clientName));
  }

  /**
   * End the private terminal server every ferret's agent runs under, or say why it could not be. NEVER A REFUSAL: by
   * this point the daemon is down and the owner has authorized the removal.
   */
  async #endSessionTerminals(): Promise<void> {
    const socket = this.deps.layout.sessionTerminalSocket;
    const ending = await this.deps.sessionTerminals.end(socket);
    if (ending.kind === 'ended') {
      this.deps.out.warn(`ended every ${this.#name} ferret's running agent (terminal server ${socket})`);
      return;
    }
    if (ending.kind === 'none') return;
    this.deps.out.warn(
      `could not end the ${this.#name} ferret terminal server at ${socket} (${ending.reason}); agents it ` +
        `still runs may keep writing — end them with \`tmux -S ${socket} kill-server\``,
    );
  }

  /**
   * Make sure a home exists before a verb writes anything under it. A home that is absent or empty is made by the
   * daemon's own first start, so the daemon is brought up ONCE through the shell's launcher; this CLI never writes
   * `home.json` itself. A home that is there but is not ours is left alone: the supervisors refuse it.
   */
  async #ensureHome(): Promise<void> {
    const home = this.deps.layout.stateHome;
    const state = await this.deps.claims.inspect(home);
    if (state !== 'absent' && state !== 'empty') return;
    this.deps.out.warn(`${home} is not a ${this.#name} home yet; starting ${this.#name} once so it creates it`);
    const launched = (await this.deps.launcher?.()) ?? {
      started: false as const,
      why: `${this.#name} cannot be started here to create ${home}`,
    };
    if (!launched.started) throw new DaemonStartupFailedError(launched.why);
    // The launcher's "up" only says a daemon answers: with no run record yet it may be another home's daemon on the
    // default address. The home is made only when it now carries the marker.
    if ((await this.deps.claims.inspect(home)) !== 'claimed')
      throw new DaemonStartupFailedError(
        `${this.#name} was started but ${home} is still not a ${this.#name} home: the daemon that answered is ` +
          `serving another home, so nothing was changed here`,
      );
  }

  /** Refuse to reset a state home that exists but carries no Ferretry marker. */
  async #assertClaimedStateHome(): Promise<void> {
    const home = this.deps.layout.stateHome;
    const state = await this.deps.claims.inspect(home);
    if (state !== 'unclaimed' && state !== 'empty') return;
    throw new DaemonResetRefusedError(
      `refusing to reset ${home}: it carries no Ferretry marker (home.json), so it may not be a Ferretry state ` +
        `home and nothing was removed. Point FY_HOME at the state home you meant`,
    );
  }

  /**
   * The typed confirmation, unless `--yes` waived it. Off a terminal there is nobody to type it, so an unattended run
   * has to pass `--yes` explicitly rather than have the guard silently skipped.
   */
  async #confirmReset(options: DaemonResetOptions): Promise<void> {
    if (options.yes === true) return;
    if (!this.deps.interactive()) {
      throw new DaemonResetRefusedError(
        `refusing to reset ${this.#name} without a confirmation — pass --yes to authorize it`,
      );
    }
    const answer = await this.deps.prompt.ask(`Type ${JSON.stringify(RESET_CONFIRMATION_WORD)} to confirm:`);
    if (answer.trim() !== RESET_CONFIRMATION_WORD) throw new DaemonResetRefusedError('reset cancelled');
  }

  get #name(): string {
    return this.deps.layout.daemonName;
  }

  /**
   * Run one mutating verb as an exclusive daemon-keyed transaction. The wait bound is this controller's own policy: a
   * peer inside a `restart` may legitimately hold the claim for a whole shutdown followed by a whole startup.
   */
  async #serialized<T>(verb: DaemonLifecycleVerb, work: () => Promise<T>): Promise<T> {
    const waitMs = this.shutdown.deadlineMs + this.readiness.deadlineMs + LIFECYCLE_RECONCILIATION_ALLOWANCE_MS;
    const claims: IDaemonLifecycleClaim[] = [];
    try {
      // The layout supplies one semantic order, so holding an earlier claim while waiting for a later one is
      // deadlock-free even when two invocations overlap on only one target.
      for (const lockPath of this.deps.layout.lifecycleLocks) {
        claims.push(
          await this.deps.lifecycle.acquire({
            lockPath,
            verb,
            waitMs,
            waiting: holder =>
              this.deps.out.warn(
                `${this.#name} ${verb} is waiting up to ${String(Math.round(waitMs / 1_000))}s for another lifecycle command to finish (${holder})`,
              ),
            reclaimed: holder =>
              this.deps.out.warn(`${this.#name} ${verb} removed a lifecycle claim left behind by ${holder}`),
          }),
        );
      }
      return await work();
    } finally {
      // Reverse acquisition order; also gives back a partial set when a later acquisition is refused.
      for (let index = claims.length - 1; index >= 0; index -= 1) {
        const residue = await claims[index]?.release();
        if (residue !== undefined) {
          this.deps.out.warn(
            `${this.#name} lifecycle claim ${residue} could not be released; remove it once no ${this.#name} lifecycle command is running`,
          );
        }
      }
    }
  }

  /**
   * Hold the Nix closure of the executable this verb is about to record or launch. NOTHING HERE MAY FAIL A VERB: a pin
   * is protection against a collection that may never happen, so a refusal is a warning naming the sturdier
   * installation method.
   */
  async #holdDaemonClosure(binaryPath: string): Promise<void> {
    const root = this.deps.layout.nixGcRoot;
    const storePath = nixStorePathOf(await this.deps.nix.realPath(binaryPath));
    if (storePath === undefined) {
      await this.deps.nix.release(root);
      return;
    }
    const failure = await this.deps.nix.pin(storePath, root);
    if (failure === undefined) return;
    this.deps.out.warn(
      `${this.#name} runs from the Nix store but its runtime closure could not be pinned against ` +
        `garbage collection (${failure}); a later nix-collect-garbage may remove ${storePath} and the ` +
        `service will not start — install with \`nix profile install\` to have Nix hold it instead`,
    );
  }

  /** The supervisor that currently owns the daemon: the service manager when one is installed. */
  async #owner(): Promise<IDaemonSupervisor> {
    const service = this.deps.service;
    if (service !== undefined && (await service.installed())) return service;
    return this.deps.direct;
  }

  #service(): IServiceDefinitionSupervisor {
    const service = this.deps.service;
    if (service === undefined) throw new UnsupportedServiceManagerError();
    return service;
  }

  /** The installed daemon, or why this host has none, for the verbs that only REPORT. */
  #locateDaemon(): InstalledDaemonBinary | { readonly reason: string } {
    try {
      return this.deps.installedDaemon();
    } catch (error: unknown) {
      return { reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async #running(owner: IDaemonSupervisor, health: LocalUpdateHealth | undefined): Promise<boolean> {
    if (health !== undefined) return true;
    return (await owner.inspect()).state === 'running';
  }

  /** The answering daemon, when it serves this state home outside the installed service manager. */
  async #orphanOf(
    owner: IDaemonSupervisor,
    health: LocalUpdateHealth | undefined,
  ): Promise<LocalUpdateHealth | undefined> {
    if (owner === this.deps.direct || health === undefined) return undefined;
    return servesOutsideSupervisor(await owner.inspect(), health) ? health : undefined;
  }

  /**
   * Stop a daemon the service manager did not start, the way a direct one is stopped. The direct supervisor signals
   * the pid only once it is proved to hold THIS state home's lock, so an unrelated process on the port is never touched.
   */
  async #stopOrphan(owner: IDaemonSupervisor, orphan: LocalUpdateHealth): Promise<void> {
    this.deps.out.warn(
      `${this.#name} pid ${String(orphan.pid)} serves ${this.deps.layout.stateHome} outside ${owner.manager}; ` +
        `stopping it so ${owner.manager} owns the daemon`,
    );
    await this.#pressStop(this.deps.direct, orphan.pid);
  }

  /**
   * Stop whatever serves this state home; `false` when nothing was running. An orphan is stopped directly, and then the
   * manager too if it reports its own daemon running: a launchd `KeepAlive` job can have respawned one the moment the
   * orphan let go of the lock.
   */
  async #bringDown(owner: IDaemonSupervisor, health: LocalUpdateHealth | undefined, note = ''): Promise<boolean> {
    const orphan = await this.#orphanOf(owner, health);
    if (orphan !== undefined) {
      await this.#stopOrphan(owner, orphan);
      if ((await owner.inspect()).state === 'running') await this.#pressStop(owner, undefined);
      return true;
    }
    if (!(await this.#running(owner, health))) return false;
    await this.#pressStop(owner, health?.pid, note);
    return true;
  }

  /** Run `work` as one named step of the progress line. */
  async #step<T>(label: string, work: () => T | Promise<T>): Promise<T> {
    this.progress.start(label);
    try {
      const result = await work();
      this.progress.succeed();
      return result;
    } catch (error: unknown) {
      this.progress.fail();
      throw error;
    }
  }

  /** Wait for the daemon to serve. */
  async #awaitReady(owner: IDaemonSupervisor, handle: DaemonStartHandle): Promise<LocalUpdateHealth> {
    this.progress.start(`Waiting for ${this.#name} to serve`);
    try {
      const health = await this.#pollReady(owner, handle);
      this.progress.succeed();
      return health;
    } catch (error: unknown) {
      this.progress.fail();
      throw error;
    }
  }

  /** Poll until the daemon serves HTTP, it is observed to have died, or the deadline passes. */
  async #pollReady(owner: IDaemonSupervisor, handle: DaemonStartHandle): Promise<LocalUpdateHealth> {
    let state = beginReadinessWait(this.deps.clock.now());
    while (true) {
      const health = await this.deps.health.probe();
      if (health !== undefined && owner === this.deps.direct) return health;
      const report = await owner.inspect(handle);
      // An answer from a daemon the manager did not start is not THIS start coming up.
      if (health !== undefined && !servesOutsideSupervisor(report, health)) return health;
      if (health !== undefined && report.state !== 'running') {
        throw new DaemonStartupFailedError(
          `${this.#name} pid ${String(health.pid)} serves ${this.deps.layout.stateHome} outside ${owner.manager}, so ` +
            `${owner.manager}'s own daemon could not take the state home; run ${this.deps.clientName} daemon restart to hand it over`,
        );
      }
      const decision = decideReadiness(state, livenessOf(report), this.deps.clock.now(), this.readiness);
      if (decision.kind === 'exited') {
        throw new DaemonStartupFailedError(
          `${this.#name} started but its process exited during startup; inspect ${this.deps.layout.logFile}`,
        );
      }
      if (decision.kind === 'timeout') {
        throw new DaemonStartupFailedError(
          `${this.#name} did not become ready within ${String(Math.round(this.readiness.deadlineMs / 1_000))}s; inspect ${this.deps.layout.logFile}`,
        );
      }
      state = decision.state;
      if (decision.kind === 'progress') {
        this.deps.out.warn(
          `${this.#name} starting — still initializing (${String(decision.elapsedSeconds)}s); waiting up to ${String(Math.round(this.readiness.deadlineMs / 1_000))}s…`,
        );
      }
      await this.deps.clock.sleep(this.readiness.cadenceMs);
    }
  }

  /** Ask the daemon to stop and confirm it actually did, escalating once a polite stop has had time. */
  async #pressStop(owner: IDaemonSupervisor, pidHint: number | undefined, note = ''): Promise<void> {
    this.progress.start(`Stopping ${this.#name}${note}`);
    try {
      await this.#stopAndWatch(owner, pidHint);
      this.progress.succeed();
    } catch (error: unknown) {
      this.progress.fail();
      throw error;
    }
  }

  async #stopAndWatch(owner: IDaemonSupervisor, pidHint: number | undefined): Promise<void> {
    await owner.stop({ pidHint, escalate: false });
    const startedAtMs = this.deps.clock.now();
    let escalated = false;
    while (true) {
      if (await this.#down(owner, pidHint)) return;
      const decision = decideShutdown(this.deps.clock.now() - startedAtMs, escalated, this.shutdown);
      if (decision === 'give-up') {
        throw new DaemonShutdownFailedError(
          `${this.#name} did not stop within ${String(Math.round(this.shutdown.deadlineMs / 1_000))}s; inspect ${this.deps.layout.logFile}`,
        );
      }
      if (decision === 'escalate') {
        escalated = true;
        this.deps.out.warn(`${this.#name} has not stopped; escalating to an unconditional kill`);
        await owner.stop({ pidHint, escalate: true });
      }
      await this.deps.clock.sleep(this.shutdown.cadenceMs);
    }
  }

  async #down(owner: IDaemonSupervisor, pidHint: number | undefined): Promise<boolean> {
    if ((await this.deps.health.probe()) !== undefined) return false;
    const report = await owner.inspect(pidHint === undefined ? undefined : { pid: pidHint });
    return report.state !== 'running';
  }
}
