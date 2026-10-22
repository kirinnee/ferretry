import type { DaemonServiceFacts, HealthView, LivenessView, TunnelStatusView } from '@ferretry/protocol';
import { type IProgress, NO_PROGRESS, withStep } from '../progress/index.ts';
import { passMidTurn } from '../update/mid-turn.ts';
import { type DaemonUpdateStatus, renderUpdateStatus } from '../update/status.ts';
import type { InstalledDaemonBinary } from './binary.ts';
import type { DaemonLayout } from './layout.ts';
import { nixStorePathOf } from './nix-store.ts';
import type {
  DaemonLifecycleVerb,
  DaemonStartHandle,
  IClockPort,
  IDaemonHealthPort,
  IDaemonLifecycleClaim,
  IDaemonLifecycleLockPort,
  IDaemonLogPort,
  IDaemonOutput,
  IDaemonPrompt,
  IDaemonRestartMarkerPort,
  IDaemonSupervisor,
  INixGcRootPort,
  IResetInventoryPort,
  IResetTreePort,
  IRetiredArtifactPort,
  IServiceDefinitionSupervisor,
  ISessionTerminalServerPort,
  IStateHomeClaimPort,
  RetiredArtifactOutcome,
} from './ports.ts';
import { launchdThrottled, livenessOf, servesOutsideSupervisor } from './probe.ts';
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
  type DaemonStatusView,
  decideDaemonStatus,
  megabytes,
  renderDaemonStatus,
  renderDaemonStatusJson,
  renderInstalled,
  statusExitCode,
} from './render.ts';
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

/** Options the daemon commands accept. */
export interface DaemonCommandOptions {
  /** Emit the machine shape instead of the human summary. */
  readonly json?: boolean;
  /** Keep streaming the log as it grows. */
  readonly follow?: boolean;
}

/**
 * What the caller must type, in full, to authorize a reset by hand.
 *
 * The same shape `fy worktree rm` asks for — a word, not a `y/N` — because this repository already has
 * one ritual for authorizing something irreversible, and a stronger ritual invented for this verb alone
 * would be a second thing to learn for the same class of act.
 */
const RESET_CONFIRMATION_WORD = 'reset';

/** Flags `restart` accepts. */
export interface DaemonRestartOptions {
  /** Wait until no ferret is mid-turn. Without it the restart goes ahead: ferrets keep running. */
  readonly whenIdle?: boolean;
  /** The caller has already said what the restart means for ferrets mid-turn (`fy daemon update`). */
  readonly midTurnSaid?: boolean;
  /** How many ferrets are mid-turn and will keep running through it, for the line the restart shows. */
  readonly ferretsKeepRunning?: number;
}

/**
 * How long a restart marker vouches for a restart in progress. Longer than any restart takes, so it
 * never expires under one; short enough that a marker a killed `fy` left behind stops mattering.
 */
const RESTART_MARKER_TTL_MS = 2 * 60_000;

/** How often the boot step is read while waiting: often enough to move, rarely enough to be no load. */
const BOOT_POLL_MS = 1_000;

/** `" (3 ferrets keep running)"`, or nothing when none are mid-turn or the count is unknown. */
function keepRunningNote(count: number | undefined): string {
  if (count === undefined || count < 1) return '';
  return ` (${String(count)} ${count === 1 ? 'ferret keeps' : 'ferrets keep'} running)`;
}

/** Flags `reset` accepts. */
export interface DaemonResetOptions {
  /** Skip the typed confirmation; required when there is no terminal to type it at. */
  readonly yes?: boolean;
}

/** Raised when a reset will not proceed, so the caller sees a refusal rather than a half-reset. */
export class DaemonResetRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonResetRefusedError';
  }
}

export class DaemonStartupFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonStartupFailedError';
  }
}

/**
 * What a holder may spend outside its readiness and shutdown waits: locating the installed daemon,
 * holding its closure, and retiring what an earlier release left behind. A peer waits this much
 * longer before refusing.
 */
const LIFECYCLE_RECONCILIATION_ALLOWANCE_MS = 30_000;

export class DaemonShutdownFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonShutdownFailedError';
  }
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
  /**
   * The daemon executable this host runs, or a THROW naming the remedy when there is none.
   *
   * Required, and required to be total in the sense that it either answers or explains. There is no
   * second candidate to fall back to now that no copy of the executable is kept: an invocation that
   * cannot say which file to launch cannot launch anything, and saying so is strictly better than a
   * unit file naming a path chosen by default.
   */
  readonly installedDaemon: () => InstalledDaemonBinary;
  /** Removes CLI-owned artifact trees an earlier release wrote and this one no longer keeps. */
  readonly retired: IRetiredArtifactPort;
  /** Measures and removes the two trees `reset` destroys. */
  readonly resetTrees: IResetTreePort;
  /** Counts what a reset destroys unrecoverably, from the daemon that still holds it. */
  readonly resetInventory: IResetInventoryPort;
  /** Ends every session's running agent before a reset removes the home they write into. */
  readonly sessionTerminals: ISessionTerminalServerPort;
  /** Whether the state home carries the Ferretry marker, which a reset requires before it deletes. */
  readonly claims: IStateHomeClaimPort;
  /** Where the typed reset confirmation is read from; never used off a terminal. */
  readonly prompt: IDaemonPrompt;
  /**
   * Whether anybody is at a terminal, asked when the question is asked rather than captured here.
   *
   * A function so the answer belongs to the terminal at the moment somebody would have to type, not to
   * the moment this controller was built.
   */
  readonly interactive: () => boolean;
  /** The binary somebody types, so a reset can name the command that brings the machine back. */
  readonly clientName: string;
  readonly clock: IClockPort;
  readonly out: IDaemonOutput;
  /** The one line a start ends with when this machine is not set up yet. See `MachineSetupNotice`. */
  readonly setupNotice: IMachineSetupNotice;
  readonly readiness?: ReadinessPolicy;
  readonly shutdown?: ShutdownPolicy;
  /**
   * The install-method and update lines `status` adds. Optional so the many suites that are about
   * process control need not stage an install method; the composition root always supplies it.
   */
  readonly updateStatus?: IDaemonUpdateStatusReader;
  /**
   * The `Tunnel:` line `status` adds, read only while the daemon serves; `undefined` from a daemon that
   * has no `/v1/tunnel` yet, and the line is then left out. Optional for the reason `updateStatus` is.
   */
  readonly tunnel?: { read(): Promise<TunnelStatusView | undefined> };
  /** Offers a nix profile install when `install` finds a daemon running from a `nix shell`. */
  readonly nixShellOffer?: INixShellOffer;
  /**
   * How many ferrets are mid-turn, for the line a restart says and for `--when-idle`. Answers 0 when
   * the daemon cannot tell. Absent, a restart says nothing about ferrets.
   */
  readonly turns?: { midTurn(): Promise<number> };
  /** Tells every `fy` on this host that a restart is underway, so their calls wait it out. */
  readonly restartMarker?: IDaemonRestartMarkerPort;
  /** What a long verb shows while it works. Absent, it shows nothing. */
  readonly progress?: IProgress;
}

/** Everything `status` concluded, unrendered. See `DaemonController.inspect`. */
export interface DaemonInspection {
  readonly view: DaemonStatusView;
  /** The installed daemon, or why this host has none. */
  readonly located: InstalledDaemonBinary | { readonly reason: string };
  readonly update: DaemonUpdateStatus | undefined;
  /** Whether this platform has a service manager `install` can write a definition for. */
  readonly serviceManager: boolean;
}

/** Reading what `status` says about installing and updating. Satisfied by `DaemonUpdateStatusReader`. */
interface IDaemonUpdateStatusReader {
  read(daemon: InstalledDaemonBinary | undefined, serving: boolean): Promise<DaemonUpdateStatus>;
}

/** The nix shell → nix profile offer. Satisfied by `NixProfileSwitch`; answers the daemon to install instead. */
interface INixShellOffer {
  offer(daemon: InstalledDaemonBinary): Promise<InstalledDaemonBinary | undefined>;
}

/** Saying, once, that this machine is not set up yet. Satisfied by `MachineSetupNotice`. */
interface IMachineSetupNotice {
  say(): Promise<void>;
}

/**
 * Drives `fy daemon …`: installs and removes the service definition, brings the daemon up and down,
 * reports on it and streams its log.
 *
 * The daemon's own HTTP API is the authority on whether it is up, and the service manager is the
 * authority on whether it is supervised. Neither answer comes from a file under the state home — the
 * CLI does not read the daemon's state, which is the seam the whole package split exists to enforce.
 *
 * THE DAEMON THAT RUNS IS THE DAEMON THIS HOST HAS INSTALLED. There is no copy, no promotion and no
 * pointer of our own: `install`, `start` and `restart` resolve the installed executable and record or
 * launch that absolute path. An upgrade is therefore whatever the package manager already did plus a
 * `restart`, and a rollback is the same — this CLI never became a second, worse package manager for
 * one file.
 *
 * EVERY MUTATING VERB IS ONE SERIALIZED TRANSACTION, and the ones that only report are not. Each
 * mutating verb holds the executable's garbage-collection root and then writes a service definition
 * or launches that executable, and those two halves have to agree about which file is in play: two
 * invocations that interleave them leave a unit file naming one executable while the root holds
 * another's closure. Claims keyed on every ownership target are what make the pair atomic against a
 * peer invocation, and they are taken in the public verb rather than deeper down so no verb can ever
 * nest inside another.
 */
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
    // Before the claim: a host with no daemon executable cannot install one, and learning that
    // after waiting out another invocation's claim is up to 140 seconds spent on a foregone refusal.
    const found = this.deps.installedDaemon();
    // Before the claim too: the offer can wait on a person, and on `nix profile install`.
    const daemon = (await this.deps.nixShellOffer?.offer(found)) ?? found;
    await this.#serialized('install', () => this.#install(daemon));
  }

  async uninstall(): Promise<void> {
    await this.#serialized('uninstall', () => this.#uninstall());
  }

  /**
   * Brings the daemon up, then says — outside the lifecycle claim — whether the machine is set up.
   *
   * THE NOTICE IS OUTSIDE THE CLAIM so nothing it does can hold every other `fy daemon …` invocation
   * on this host. A FAILED START SAYS NOTHING, because `#serialized` throws before this line.
   */
  async start(): Promise<void> {
    await this.#requireDaemonUnlessServing();
    await this.#serialized('start', () => this.#start());
    await this.deps.setupNotice.say();
  }

  async stop(): Promise<void> {
    await this.#serialized('stop', () => this.#stop());
  }

  /**
   * Restarts the daemon — with ferrets mid-turn, too, because they keep running (`mid-turn.ts`).
   * The mid-turn line, and any `--when-idle` wait, come BEFORE the claim, so waiting for a turn to end
   * never holds every other `fy daemon …` invocation on this host.
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
   * Removes every trace of this daemon's persistent data, after showing what that costs.
   *
   * INSIDE THE LIFECYCLE CLAIM, and the prompt is inside it too. That placement is the opposite of
   * `start`'s notice and both are right: `start` must not hold every other
   * invocation on this host while somebody reads an optional line, whereas a reset that released
   * the claim to ask its question would let a peer `start` bring the daemon back up between the answer
   * and the deletion — recreating a state home underneath a removal that had already been authorized.
   * The claim is what makes measure-show-ask-stop-remove one transaction rather than five moments.
   *
   * A person waiting at the prompt therefore does block other `fy daemon …` invocations, and a peer
   * says so out loud through the same wait notice every other verb uses. That is the correct trade for
   * the one verb that is destroying the thing they contend for.
   */
  async reset(options: DaemonResetOptions): Promise<void> {
    await this.#serialized('reset', () => this.#reset(options));
  }

  async #install(daemon: InstalledDaemonBinary): Promise<void> {
    const service = this.#service();
    // Before anything is written: one definition per host, and it may belong to another state home.
    await service.assertServes(undefined);
    // A daemon `fy daemon start` ran before there was a definition holds the state home's lock, so the
    // manager's own daemon would exit at once and leave that one serving with nothing supervising it —
    // while this verb reported success with the stray's pid. It is handed over first.
    const orphan = await this.#orphanOf(service, await this.deps.health.probe());
    if (orphan !== undefined) await this.#stopOrphan(service, orphan);
    // Before the definition is written, so a unit file never names a store path nothing is holding.
    await this.#holdDaemonClosure(daemon.path);
    await this.#step(`Installing the ${this.#name} service`, () => service.install(daemon.path));
    const health = await this.#awaitReady(service, {});
    await this.#retireLegacyArtifacts();
    this.deps.out.success(renderInstalled(this.#name, service.definitionPath, health.pid));
  }

  async #uninstall(): Promise<void> {
    const service = this.#service();
    await service.assertServes(undefined);
    await service.uninstall();
    // REMOVING SUPERVISION DOES NOT UNINSTALL THE DAEMON, so it does not release the daemon's root.
    //
    // The asymmetry with `stop` was always the point: in a `nix shell`, releasing the root when the
    // daemon goes down means a garbage collection can leave the next `start` with no executable at
    // all — and `fy daemon start` still runs the daemon as a direct child on a host with no service
    // definition. The root belongs to the executable on this host's PATH, and that executable is
    // exactly as installed after this verb as it was before it. It is released when the installed
    // daemon stops being a store path, and named here because a held store path an operator cannot
    // account for is its own kind of surprise.
    await this.#retireLegacyArtifacts();
    this.deps.out.success(
      `${this.#name} user service removed; the installed daemon's Nix closure stays held by ${this.deps.layout.nixGcRoot} so a later ${this.deps.clientName} daemon start still works`,
    );
  }

  async #start(): Promise<void> {
    const owner = await this.#owner();
    let serving = await this.deps.health.probe();
    // "Already serving" is a claim about THIS state home, and so is the rewrite a start does below.
    await owner.assertServes(serving?.pid);
    // Serving outside the installed manager is not "already serving": the manager owns this daemon
    // once it has a definition, so the stray is stopped and the manager starts its own below.
    const orphan = await this.#orphanOf(owner, serving);
    if (orphan !== undefined) {
      await this.#stopOrphan(owner, orphan);
      serving = undefined;
    }
    if (serving !== undefined) {
      this.#warnIfRunningIsStale(serving);
      this.deps.out.success(`${this.#name} is already serving (pid ${String(serving.pid)})`);
      return;
    }
    const incumbent = await owner.inspect();
    if (incumbent.state === 'running') {
      // A service manager reports `activating` as running. Leave that incumbent's executable and its
      // root untouched, but still honor `start`'s contract to wait until its API serves.
      const ready = await this.#awaitReady(owner, {}, true);
      this.#warnIfRunningIsStale(ready);
      this.deps.out.success(`${this.#name} ready (pid ${String(ready.pid)})`);
      return;
    }
    const daemon = this.deps.installedDaemon();
    await this.#holdDaemonClosure(daemon.path);
    const handle = await this.#step(`Starting ${this.#name}`, () => owner.start(daemon.path));
    const health = await this.#awaitReady(owner, handle);
    await this.#retireLegacyArtifacts();
    this.deps.out.success(`${this.#name} ready (pid ${String(health.pid)})`);
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
    // Locate the executable BEFORE stopping the incumbent. A host with no daemon on its PATH cannot
    // start one, and an operator must learn that while the healthy daemon is still serving — never
    // only after restart has already created downtime it cannot undo.
    const daemon = this.deps.installedDaemon();
    const owner = await this.#owner();
    const health = await this.deps.health.probe();
    await owner.assertServes(health?.pid);
    const marker = this.deps.restartMarker;
    await marker?.mark(this.deps.clock.now() + RESTART_MARKER_TTL_MS);
    let ready: HealthView;
    try {
      ready = await this.#restartUnder(owner, daemon.path, health, note);
    } finally {
      await marker?.clear();
    }
    await this.#retireLegacyArtifacts();
    this.deps.out.success(`${this.#name} restarted (pid ${String(ready.pid)})`);
  }

  /**
   * Take the daemon down and bring it back under `owner`.
   *
   * A manager that can restart in one command is asked to, so the daemon is never down with nothing
   * owning the transition; only a daemon serving OUTSIDE it is stopped by this CLI first, because the
   * manager cannot stop what it did not start. Every other owner is stopped, watched until it is
   * down, and started. Either way the root is reconciled before the launch, because restart is when
   * an upgraded executable is picked up.
   */
  async #restartUnder(
    owner: IDaemonSupervisor,
    executable: string,
    health: HealthView | undefined,
    note: string,
  ): Promise<HealthView> {
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
   * Measure, show, ask, stop, remove — in that order, and the order is the whole design.
   *
   * MEASURED AND COUNTED WHILE THE DAEMON IS STILL UP, because the counts only exist there: the daemon
   * owns the secrets, the paired devices and the sessions, and it is the thing that can say how many.
   * Stopping first would leave "3 paired devices" unavailable at the exact moment somebody needs it to
   * decide, which is the difference between a confirmation and a formality.
   *
   * STOPPED BEFORE ANYTHING IS REMOVED, and a stop that will not take REFUSES the whole verb. Moving
   * state out from under a running daemon is how a half-reset happens — an owner hit exactly that, with
   * a log written into a state directory that had already been cleared — and `#pressStop` throwing is
   * the refusal, before a single entry has been unlinked.
   *
   * THE SESSIONS' AGENTS ARE ENDED TOO, because stopping the daemon does not stop them: they run under
   * its private tmux server, which outlives a stop so a session survives a restart. Left running, the
   * first thing each agent wrote after the removal recreated `<FY_HOME>/fleet/…` with no marker, and
   * the very next `install` refused that home as one it could not prove was ours.
   *
   * AND THE HOME IS CLAIMED AGAIN, EMPTY, once it is gone — the same first step a fresh install takes.
   * An agent that was mid-write when its server ended, or any other late writer, then lands in a home
   * that carries our marker, and nothing that happens after a reset can leave the machine refusing to
   * come back up. A home that was never there is not created: a reset is not an install.
   */
  async #reset(options: DaemonResetOptions): Promise<void> {
    const layout = this.deps.layout;
    const roots = resetRoots(layout);
    // Before any measurement, let alone any removal: an operator-supplied FY_HOME that resolves
    // somewhere unresettable must fail while nothing has been touched.
    assertResettableRoots(roots, layout.homeDirectory);
    await this.#assertClaimedStateHome();

    const owner = await this.#owner();
    const health = await this.deps.health.probe();
    // Before a single count is shown: the counts, the stop and the removal must all be of ONE daemon,
    // and it has to be this state home's.
    await owner.assertServes(health?.pid);
    const counted = health === undefined ? undefined : await this.deps.resetInventory.count();
    const surveys: ResetSurvey[] = [];
    for (const root of roots) surveys.push({ root, measure: await this.deps.resetTrees.measure(root.path) });
    const plan: ResetPlan = {
      daemon: this.#name,
      surveys,
      inventory: health === undefined || counted === undefined ? undefined : { ...counted, sessions: health.sessions },
      survivors: resetSurvivors(layout),
    };
    this.deps.out.warn(renderResetPlan(plan));
    await this.#confirmReset(options);

    await this.#bringDown(owner, health);
    await this.#endSessionTerminals();
    const removals: ResetSurvey[] = [];
    for (const root of roots) removals.push({ root, measure: await this.deps.resetTrees.remove(root.path) });
    const home = removals.find(removal => removal.root.path === layout.stateHome);
    const reclaimed = home !== undefined && home.measure.kind !== 'absent' && (await this.#reclaimStateHome());
    this.deps.out.success(
      renderResetOutcome(this.#name, removals, this.deps.clientName, reclaimed ? layout.stateHome : undefined),
    );
  }

  /**
   * End the private terminal server every session's agent runs under, or say why it could not be.
   *
   * NEVER A REFUSAL. By this point the daemon is down and the owner has authorized the removal, so a
   * reset that stopped here would leave them on exactly the half-state this verb exists to remove.
   * The re-claim below keeps the next install working either way; what is said here is that agents
   * may still be running, and the one command that ends them.
   */
  async #endSessionTerminals(): Promise<void> {
    const socket = this.deps.layout.sessionTerminalSocket;
    const ending = await this.deps.sessionTerminals.end(socket);
    if (ending.kind === 'ended') {
      this.deps.out.warn(`ended every ${this.#name} session's running agent (terminal server ${socket})`);
      return;
    }
    if (ending.kind === 'none') return;
    this.deps.out.warn(
      `could not end the ${this.#name} session terminal server at ${socket} (${ending.reason}); agents it ` +
        `still runs may keep writing — end them with \`tmux -S ${socket} kill-server\``,
    );
  }

  /**
   * Claim the just-removed state home again, empty, so nothing written afterwards leaves it unmarked.
   *
   * A refusal here is REPORTED rather than thrown: it means something wrote into the home in the
   * moment between the removal and this claim, and the removal itself — the thing the owner asked
   * for — has already happened. The refusal names what it found and the command that claims it.
   */
  async #reclaimStateHome(): Promise<boolean> {
    try {
      await this.deps.claims.claim(this.deps.layout.stateHome);
      return true;
    } catch (error: unknown) {
      this.deps.out.warn(
        `something wrote into ${this.deps.layout.stateHome} as it was removed, so it could not be claimed again: ` +
          (error instanceof Error ? error.message : String(error)),
      );
      return false;
    }
  }

  /**
   * Refuse to reset a state home that exists but carries no Ferretry marker.
   *
   * The path guards stop the home directory and its ancestors; they cannot stop `FY_HOME` pointing at
   * `~/Documents`, which `--yes` would then delete without anybody reading the plan. The marker is
   * the one thing that says Ferretry made a directory. An older release's home, which predates it, is
   * exactly what `adopt` exists for: it shows what is inside and claims it only if every entry is ours.
   */
  async #assertClaimedStateHome(): Promise<void> {
    const home = this.deps.layout.stateHome;
    if ((await this.deps.claims.inspect(home)) !== 'unclaimed') return;
    throw new DaemonResetRefusedError(
      `refusing to reset ${home}: it carries no Ferretry marker, so it may not be a Ferretry state home and ` +
        `nothing was removed. If it is one, run \`${this.deps.clientName} daemon adopt\` to inspect and claim it ` +
        `first; otherwise point FY_HOME at the state home you meant`,
    );
  }

  /**
   * The typed confirmation, unless `--yes` waived it.
   *
   * Off a terminal there is nobody to type it, so an unattended run has to pass `--yes` explicitly
   * rather than have the guard silently skipped — the failure mode that makes a safety prompt
   * decorative. The word is `reset` and the flag is `--yes` because `fy worktree rm` already asks for a
   * typed word and takes `--yes`, and one ritual for irreversible acts is worth more than a stronger
   * ritual invented for this verb alone.
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

  /**
   * What `status` reads, before it is rendered: for a caller that decides from the facts rather than
   * printing them — `fy setup` asks this to choose between install, start and nothing at all.
   */
  async inspect(): Promise<DaemonInspection> {
    const owner = await this.#owner();
    const health = await this.deps.health.probe();
    const liveness = await this.deps.health.liveness?.();
    const supervisor = await owner.inspect(this.#handleFor(health) ?? this.#handleForLiveness(liveness));
    const view = decideDaemonStatus(this.#name, supervisor, health, liveness);
    const located = this.#locateDaemon();
    const update = await this.deps.updateStatus?.read('reason' in located ? undefined : located, health !== undefined);
    return { view, located, update, serviceManager: this.deps.service !== undefined };
  }

  /**
   * How this daemon is run, for a performance report: its manager, and on macOS the launchd job's
   * `ProcessType` read from the plist on disk. A direct daemon has no definition to read.
   */
  async serviceFacts(): Promise<DaemonServiceFacts> {
    const service = this.deps.service;
    if (service === undefined || !(await service.installed())) return { manager: 'direct' };
    const report = await service.inspect();
    return {
      manager: report.manager,
      ...(report.processType === undefined ? {} : { processType: report.processType }),
    };
  }

  /**
   * Why the installed service definition must be rewritten, or `undefined` when it need not be or
   * none is installed. Read from the definition on disk, so it answers whether or not the daemon runs.
   */
  async staleDefinition(): Promise<string | undefined> {
    const service = this.deps.service;
    if (service === undefined || !(await service.installed())) return undefined;
    const report = await service.inspect();
    if (!launchdThrottled(report)) return undefined;
    return report.processType === null
      ? 'its launchd job declares no ProcessType, so macOS throttles it'
      : `its launchd job declares ProcessType ${report.processType}, so macOS throttles it`;
  }

  async status(options: DaemonCommandOptions): Promise<void> {
    const { view, update } = await this.inspect();
    const health = view.health;
    const supervisor = view.supervisor;
    const code = statusExitCode(view);
    const tunnel = health === undefined ? undefined : await this.deps.tunnel?.read();
    const human = [
      renderDaemonStatus(view, this.deps.clientName),
      ...(tunnel === undefined ? [] : [tunnel.sentence]),
      ...(update === undefined ? [] : renderUpdateStatus(update, this.deps.clientName)),
    ];
    if (options.json === true) {
      this.deps.out.success(
        renderDaemonStatusJson(view, {
          ...(tunnel === undefined ? {} : { tunnel }),
          ...(update === undefined ? {} : { install: update.install ?? null, update: update.update ?? null }),
        }),
      );
    } else if (code === 0 && !view.orphan && !launchdThrottled(supervisor)) this.deps.out.success(human.join('\n'));
    else this.deps.out.warn(human.join('\n'));
    // Still exit 0: an orphan serves, which is the question a script asks. The remedy is said instead.
    if (options.json !== true && view.orphan && health !== undefined) {
      this.deps.out.warn(
        `pid ${String(health.pid)} was not started by ${supervisor.manager}, so ${supervisor.manager} cannot start its own; ` +
          `run ${this.deps.clientName} daemon restart to stop it and have ${supervisor.manager} own the daemon`,
      );
    }
    if (options.json !== true && health !== undefined) this.#warnIfRunningIsStale(health);
    if (code !== 0) this.deps.out.setExitCode(code);
  }

  /**
   * The two daemon identities that still exist, and whether they agree.
   *
   * It used to report three — installed, promoted, running — and the middle one is what this command
   * was mostly for: an operator who had upgraded the executable and was still being served by a
   * snapshot promoted weeks earlier had no other way to see it. There is no third identity now.
   * `install`, `start` and `restart` record and launch the installed executable, so the only question
   * left is whether the daemon serving right now predates the executable on this host's PATH, which is
   * answered by comparing the two versions and naming the one command that closes the gap.
   *
   * A daemon that cannot be located is REPORTED WITH ITS REASON rather than as a bare absence, because
   * the two causes need different remedies: not installed at all, and installed at a path a service
   * manager could never launch.
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
    // A missing log is reported, not silently rendered as an empty one — kteam swallowed the error and
    // printed nothing, which reads identically to a daemon that ran and logged nothing.
    if (!follow && !(await this.deps.logs.exists(file))) {
      this.deps.out.warn(`no ${this.#name} log at ${file} yet`);
      return;
    }
    const code = await this.deps.logs.show(file, follow);
    if (code !== 0) this.deps.out.setExitCode(code);
  }

  get #name(): string {
    return this.deps.layout.daemonName;
  }

  /**
   * Run one mutating verb as an exclusive daemon-keyed transaction.
   *
   * The wait bound is this controller's own policy rather than the adapter's guess: a peer inside a
   * `restart` may legitimately hold the claim for a whole shutdown followed by a whole startup, and a
   * bound shorter than that would refuse commands that were only ever queued behind a healthy one.
   * The allowance on top is the work those two policies do not describe — holding the root and
   * retiring what an earlier release left behind — because a bound equal to the holder's best case
   * refuses a peer for no reason but the holder having been thorough.
   */
  async #serialized<T>(verb: DaemonLifecycleVerb, work: () => Promise<T>): Promise<T> {
    const waitMs = this.shutdown.deadlineMs + this.readiness.deadlineMs + LIFECYCLE_RECONCILIATION_ALLOWANCE_MS;
    const claims: IDaemonLifecycleClaim[] = [];
    try {
      // The layout supplies one semantic order, independent of unresolved path spelling. Holding an
      // earlier claim while waiting for a later one is therefore deadlock-free even when two
      // invocations overlap on only one target or reach it through different aliases.
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
      // Release in the reverse acquisition order. This also gives back a partial set when a later
      // acquisition is refused, before any lifecycle work has run.
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
   * Hold the Nix closure of the executable this verb is about to record or launch.
   *
   * `nix shell github:…` is a supported way to run this, and a store path is a root only while that
   * shell is open. The absolute path a unit file has to name is therefore a path a later
   * `nix-collect-garbage` can delete, and an installed user service that names a collected path does
   * not start at the next login. THAT is the failure this holds against — not a person's own shell
   * going stale afterwards, which is an accepted cost.
   *
   * One root, because there is one executable. An installation outside the store cannot be collected
   * and asks for nothing, and any root left over from an earlier Nix installation is RELEASED there:
   * it would otherwise hold a closure of something this host no longer runs, forever.
   *
   * NOTHING HERE MAY FAIL A VERB. A pin is protection against a collection that may never happen; the
   * daemon in front of the operator is the thing that has to keep working, so a refusal is a warning
   * naming the sturdier installation method and the verb carries on.
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

  /**
   * Remove the daemon snapshot store, and its roots, that an earlier release left on this host.
   *
   * **Only ever called after a verb has actually recorded or removed a service definition**, and that
   * ordering is the whole safety argument. An upgraded host's unit file still names an artifact inside
   * the store, so deleting the store first would leave a service that cannot launch. `install`,
   * `start` and `restart` rewrite the definition with the installed executable's absolute path before
   * they reach this, and `uninstall` has removed it; only then is nothing pointing at the store.
   *
   * It runs rather than telling somebody to run it because the store is roughly 100MB of copies of an
   * executable that is already installed, it is ours, and an instruction in release notes is an
   * instruction almost nobody follows. What it removed is said OUT LOUD, once, on the one invocation
   * that does it — a machine quietly deleting 100MB and mentioning nothing is worse than the disk.
   *
   * NOTHING HERE MAY FAIL A VERB either. Reclaiming disk is tidying; the daemon is the work.
   */
  async #retireLegacyArtifacts(): Promise<void> {
    const layout = this.deps.layout;
    for (const root of await this.deps.nix.held(layout.legacySnapshotGcRootDirectory)) {
      await this.deps.nix.release(root.path);
    }
    const attempts: ReadonlyArray<readonly [string, RetiredArtifactOutcome]> = [
      [layout.legacySnapshotGcRootDirectory, await this.deps.retired.retire(layout.legacySnapshotGcRootDirectory)],
      [layout.legacySnapshotRoot, await this.deps.retired.retire(layout.legacySnapshotRoot)],
    ];
    let files = 0;
    let bytes = 0;
    for (const [path, outcome] of attempts) {
      if (outcome.kind === 'removed') {
        files += outcome.files;
        bytes += outcome.bytes;
      }
      if (outcome.kind === 'failed') {
        this.deps.out.warn(
          `${this.#name} could not remove its retired snapshot store at ${path} (${outcome.reason}); ` +
            `nothing reads it any more, so it is safe to delete by hand`,
        );
      }
    }
    if (files === 0) return;
    this.deps.out.warn(
      `removed the retired ${this.#name} snapshot store (${String(files)} files, ${megabytes(bytes)}); ` +
        `${this.#name} now runs the daemon installed on this host instead of a copy of it`,
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

  /**
   * Refuse a `start` that cannot launch anything BEFORE taking the host-wide claim.
   *
   * The claim is host-wide, so waiting for it can cost the whole 140-second budget behind somebody
   * else's restart — and on a host with no daemon executable that wait used to end in "cannot find
   * fyd", which was knowable before it began. A daemon already serving needs no executable, so it is
   * asked first and a start against it still succeeds; the probe is read-only, and `#start` asks again
   * inside the claim because the answer can change while it waits.
   */
  async #requireDaemonUnlessServing(): Promise<void> {
    try {
      this.deps.installedDaemon();
    } catch (error: unknown) {
      if ((await this.deps.health.probe()) === undefined) throw error;
    }
  }

  /** The installed daemon, or why this host has none — for the verbs that only REPORT. */
  #locateDaemon(): InstalledDaemonBinary | { readonly reason: string } {
    try {
      return this.deps.installedDaemon();
    } catch (error: unknown) {
      return { reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Say so when the daemon already serving is older than the one installed here.
   *
   * The version is the only honest comparison left. Comparing PATHS would report a difference every
   * time a package manager moved its own files around, and it cannot see the case that matters — an
   * upgrade in place, where the path is identical and the code is not. A daemon whose version cannot
   * be read says nothing rather than guessing, because a wrong "restart me" is worse than silence.
   */
  #warnIfRunningIsStale(running: HealthView): void {
    const located = this.#locateDaemon();
    if ('reason' in located || located.version === undefined || located.version === running.version) return;
    this.deps.out.warn(
      `the running ${this.#name} is version ${running.version} but ${located.path} is ${located.version}; ` +
        `run ${this.deps.clientName} daemon restart to use the installed daemon`,
    );
  }

  /** The daemon reports its own pid, so a supervisor with no unit can still watch the right target. */
  #handleFor(health: HealthView | undefined): DaemonStartHandle | undefined {
    return health === undefined ? undefined : { pid: health.pid };
  }

  /** A booting daemon's pid, from its liveness answer, so a direct-run daemon reads as running. */
  #handleForLiveness(liveness: LivenessView | undefined): DaemonStartHandle | undefined {
    return liveness?.pid === undefined ? undefined : { pid: liveness.pid };
  }

  async #running(owner: IDaemonSupervisor, health: HealthView | undefined): Promise<boolean> {
    if (health !== undefined) return true;
    return (await owner.inspect()).state === 'running';
  }

  /** The answering daemon, when it serves this state home outside the installed service manager. */
  async #orphanOf(owner: IDaemonSupervisor, health: HealthView | undefined): Promise<HealthView | undefined> {
    if (owner === this.deps.direct || health === undefined) return undefined;
    return servesOutsideSupervisor(await owner.inspect(), health) ? health : undefined;
  }

  /**
   * Stop a daemon the service manager did not start, the way a direct one is stopped.
   *
   * The manager cannot do it: `systemctl stop` on a failed unit is a no-op that succeeds, and the
   * daemon it was asked about keeps serving. The direct supervisor signals the pid only once it is
   * proved to hold THIS state home's lock, so an unrelated process on the port is never touched.
   */
  async #stopOrphan(owner: IDaemonSupervisor, orphan: HealthView): Promise<void> {
    this.deps.out.warn(
      `${this.#name} pid ${String(orphan.pid)} serves ${this.deps.layout.stateHome} outside ${owner.manager}; ` +
        `stopping it so ${owner.manager} owns the daemon`,
    );
    await this.#pressStop(this.deps.direct, orphan.pid);
  }

  /**
   * Stop whatever serves this state home; `false` when nothing was running.
   *
   * An orphan is stopped directly, and then the manager too if it reports its own daemon running — a
   * launchd `KeepAlive` job can have respawned one the moment the orphan let go of the lock.
   */
  async #bringDown(owner: IDaemonSupervisor, health: HealthView | undefined, note = ''): Promise<boolean> {
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
    return await withStep(this.progress, label, async () => await work());
  }

  /** Wait for the daemon to serve, showing what it says it is booting. */
  async #awaitReady(owner: IDaemonSupervisor, handle: DaemonStartHandle, initiallyAlive = false): Promise<HealthView> {
    this.progress.start(`Waiting for ${this.#name} to serve`);
    try {
      const health = await this.#pollReady(owner, handle, initiallyAlive);
      this.progress.succeed();
      return health;
    } catch (error: unknown) {
      this.progress.fail();
      throw error;
    }
  }

  /** Poll until the daemon serves HTTP, it is observed to have died, or the deadline passes. */
  async #pollReady(owner: IDaemonSupervisor, handle: DaemonStartHandle, initiallyAlive: boolean): Promise<HealthView> {
    let state = beginReadinessWait(this.deps.clock.now());
    let bootShownAt = Number.NEGATIVE_INFINITY;
    if (initiallyAlive) state = { ...state, sawAlive: true };
    while (true) {
      const health = await this.deps.health.probe();
      if (health !== undefined && owner === this.deps.direct) return health;
      const report = await owner.inspect(handle);
      // An answer from a daemon the manager did not start is not THIS start coming up: reporting it as
      // ready is how `install` once said "started (pid N)" about a stray while the unit had failed.
      if (health !== undefined && !servesOutsideSupervisor(report, health)) return health;
      if (health !== undefined && report.state !== 'running') {
        throw new DaemonStartupFailedError(
          `${this.#name} pid ${String(health.pid)} serves ${this.deps.layout.stateHome} outside ${owner.manager}, so ` +
            `${owner.manager}'s own daemon could not take the state home; run ${this.deps.clientName} daemon restart to hand it over`,
        );
      }
      const liveness = livenessOf(report);
      const decision = decideReadiness(state, liveness, this.deps.clock.now(), this.readiness);
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
      if (this.deps.clock.now() - bootShownAt >= BOOT_POLL_MS) {
        bootShownAt = this.deps.clock.now();
        const boot = (await this.deps.health.liveness?.())?.boot;
        if (boot !== undefined) this.progress.detail(boot.step);
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
