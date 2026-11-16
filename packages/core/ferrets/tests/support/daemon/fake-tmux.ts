/**
 * A tmux the session tests own, as the session code sees it: the injected `TmuxController` and `TmuxPaneDelivery`
 * ports (`daemon/lib/session/peers/tmux-lifecycle.ts`), plus the raw `TmuxCommandPort` the exit observer asks.
 *
 * Ferrets is core and cannot import a plugin's code (§2.1); the real controller and delivery belong to the terminals
 * plugin, and THEIR behaviour (argv construction, composer modelling, paste handling) is tested there. What these
 * fakes keep is what the session code depends on: which panes exist, their identity (pane id, pid, the second their
 * session was created), whether they are dead and how they ended, and what was launched and delivered.
 *
 * Every controller call is recorded in `calls` as `[method, ...arguments]`; every raw command in `commands`. A
 * failure set in `failures` under a method or command name makes that call throw (or, for a raw command, answer
 * non-zero) with the given message.
 */
import type { ProcessIncarnation } from '../../../daemon/lib/protocol/process-incarnation.ts';
import {
  harnessExitReason,
  PANE_PROOF_FORMAT,
  type InjectionOutcome,
  type PaneIdentity,
  type PaneSighting,
  type PaneState,
  type StartupDialogOptions,
  type TmuxCommandPort,
  type TmuxCommandResult,
  type TmuxController,
  type TmuxLaunch,
  type TmuxPaneDelivery,
} from '../../../daemon/lib/session/peers/tmux-lifecycle.ts';

/** One pane the fake server holds, named by its tmux session. */
export interface FakePane {
  readonly session: string;
  paneId: string;
  pid: number;
  sessionCreated: number;
  dead: boolean;
  exitStatus?: number;
  signal?: number;
  /** Polls of `state` that still show a booting harness before its prompt appears. */
  bootPolls: number;
  history: string;
  visible: string;
  readonly launch?: TmuxLaunch;
}

const ok = (stdout = ''): TmuxCommandResult => ({ code: 0, stdout, stderr: '' });
const refused = (stderr: string): TmuxCommandResult => ({ code: 1, stdout: '', stderr });

/** The pane-exit read the exit observer makes. */
const PANE_EXIT_FORMAT = '#{pane_dead}|#{pane_dead_status}|#{pane_dead_signal}';

export class FakeTmux implements TmuxController, TmuxCommandPort {
  readonly calls: (readonly unknown[])[] = [];
  readonly commands: (readonly string[])[] = [];
  readonly launches: TmuxLaunch[] = [];
  readonly panes = new Map<string, FakePane>();
  readonly failures = new Map<string, string>();
  /** True once the whole server is gone: every command then answers "no server running". */
  serverGone = false;
  /** Prints a dead pane's pid as empty, as tmux 3.8 does once it reaped the process. */
  blankDeadPid = false;
  /** `paneIdentities` answers `undefined`, as a tmux that will not list does. */
  noListing = false;
  /** Polls of `state` a newly launched pane spends booting. */
  bootPolls = 0;
  readonly serverPid = 777;
  private nextPane = 0;
  private nextPid = 4100;

  constructor(private readonly createdSecond = 1_790_000_000) {}

  /** Plants a live pane for `session`, as if something had launched it. */
  open(session: string, overrides: Partial<Omit<FakePane, 'session'>> = {}): FakePane {
    const pane: FakePane = {
      session,
      paneId: `%${this.nextPane++}`,
      pid: this.nextPid++,
      sessionCreated: this.createdSecond + this.nextPane,
      dead: false,
      bootPolls: this.bootPolls,
      history: '',
      visible: '> ',
      ...overrides,
    };
    this.panes.set(session, pane);
    return pane;
  }

  /** Ends the harness in `session`'s pane; `remain-on-exit` keeps the pane, now dead. */
  exit(session: string, how: { readonly exitStatus?: number; readonly signal?: number } = {}): FakePane {
    const pane = this.pane(session);
    pane.dead = true;
    if (how.exitStatus !== undefined) pane.exitStatus = how.exitStatus;
    if (how.signal !== undefined) pane.signal = how.signal;
    return pane;
  }

  pane(session: string): FakePane {
    const pane = this.panes.get(session);
    if (pane === undefined) throw new Error(`no fake pane for ${session}`);
    return pane;
  }

  /** The controller method names called, in order. */
  methods(): readonly string[] {
    return this.calls.map(call => String(call[0]));
  }

  private record(method: string, ...arguments_: unknown[]): void {
    this.calls.push([method, ...arguments_]);
    const failure = this.failures.get(method);
    if (failure !== undefined) throw new Error(failure);
  }

  async alive(session: string): Promise<boolean> {
    this.record('alive', session);
    return !this.serverGone && this.panes.has(session);
  }

  async state(session: string, options?: { readonly history?: boolean }): Promise<PaneState> {
    this.record('state', session, options);
    const pane = this.serverGone ? undefined : this.panes.get(session);
    if (pane === undefined) return { alive: false, dead: false, promptReady: false, history: '', visible: '' };
    const booting = pane.bootPolls > 0;
    if (booting) pane.bootPolls -= 1;
    return {
      alive: true,
      dead: pane.dead,
      ...(pane.dead && pane.exitStatus !== undefined ? { exitCode: pane.exitStatus } : {}),
      promptReady: !pane.dead && !booting,
      history: pane.history,
      visible: booting ? 'Loading model…' : pane.visible,
    };
  }

  async paneIdentities(): Promise<ReadonlyMap<string, PaneIdentity> | undefined> {
    this.record('paneIdentities');
    if (this.noListing || this.serverGone) return undefined;
    return new Map([...this.panes].map(([session, pane]) => [session, { paneId: pane.paneId, pid: pane.pid }]));
  }

  async paneIdentity(session: string): Promise<PaneIdentity | undefined> {
    this.record('paneIdentity', session);
    const pane = this.serverGone ? undefined : this.panes.get(session);
    return pane === undefined ? undefined : { paneId: pane.paneId, pid: pane.pid };
  }

  async paneSighting(session: string): Promise<PaneSighting | undefined> {
    this.record('paneSighting', session);
    const pane = this.serverGone ? undefined : this.panes.get(session);
    return pane === undefined ? undefined : this.sighting(pane);
  }

  private sighting(pane: FakePane): PaneSighting {
    const blank = pane.dead && this.blankDeadPid;
    return {
      paneId: pane.paneId,
      dead: pane.dead,
      sessionCreated: pane.sessionCreated,
      ...(blank ? {} : { pid: pane.pid }),
    };
  }

  async killPaneExact(paneId: string): Promise<void> {
    this.record('killPaneExact', paneId);
    for (const [session, pane] of this.panes) if (pane.paneId === paneId) this.panes.delete(session);
  }

  async launch(launch: TmuxLaunch): Promise<void> {
    this.record('launch', launch.session);
    this.launches.push(launch);
    this.open(launch.session, { launch });
  }

  async stop(session: string): Promise<void> {
    this.record('stop', session);
    this.panes.delete(session);
  }

  /** The raw vocabulary the exit observer speaks: `has-session`, the pane proof and exit reads, the reap nudge. */
  async execute(arguments_: readonly string[], _stdin?: string): Promise<TmuxCommandResult> {
    this.commands.push(arguments_);
    const command = arguments_[0] ?? '';
    const failure = this.failures.get(command);
    if (failure !== undefined) return refused(failure);
    if (this.serverGone) return refused('no server running on /tmp/fake-tmux.sock');
    if (command === 'kill-server') {
      this.serverGone = true;
      return ok();
    }
    if (command === 'run-shell') return ok();
    const target = arguments_[arguments_.indexOf('-t') + 1];
    if (command === 'has-session') {
      return target !== undefined && this.panes.has(target) ? ok() : refused(`can't find session: ${target}`);
    }
    if (command === 'display-message') {
      const format = arguments_.at(-1);
      if (format === '#{pid}') return ok(`${this.serverPid}\n`);
      const pane = target === undefined ? undefined : this.panes.get(target);
      if (pane === undefined) return refused(`can't find session: ${target}`);
      if (format === PANE_PROOF_FORMAT) {
        const sighting = this.sighting(pane);
        return ok(`${pane.paneId}|${sighting.pid ?? ''}|${pane.dead ? 1 : 0}|${pane.sessionCreated}\n`);
      }
      if (format === PANE_EXIT_FORMAT)
        return ok(`${pane.dead ? 1 : 0}|${pane.exitStatus ?? ''}|${pane.signal ?? ''}\n`);
    }
    return ok();
  }
}

/** A start time for every pid the fake hands out; `gone` pids have none, as a reaped process has not. */
export class FakeIncarnation implements ProcessIncarnation {
  readonly gone = new Set<number>();

  async startOf(pid: number): Promise<number | undefined> {
    return this.gone.has(pid) ? undefined : pid * 10;
  }
}

export interface FakePaneDeliveryOptions {
  /** How many `state` polls readiness waits through before giving up. */
  readonly readinessAttempts?: number;
  /** Records each wait between polls; nothing actually sleeps. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * Delivery as the launchers see it: it waits for the pane's prompt, refuses a pane that is gone or dead with the
 * harness's own exit reason, and records what it typed.
 */
export class FakePaneDelivery implements TmuxPaneDelivery {
  readonly delivered: { readonly session: string; readonly text: string }[] = [];
  readonly calls: (readonly unknown[])[] = [];
  readonly failures = new Map<string, string>();
  outcome: InjectionOutcome = 'turn-started';
  settled: 'settled' | 'timed-out' = 'settled';

  constructor(
    private readonly tmux: FakeTmux,
    private readonly options: FakePaneDeliveryOptions = {},
  ) {}

  private record(method: string, ...arguments_: unknown[]): void {
    this.calls.push([method, ...arguments_]);
    const failure = this.failures.get(method);
    if (failure !== undefined) throw new Error(failure);
  }

  async waitReady(session: string, options?: StartupDialogOptions): Promise<void> {
    this.record('waitReady', session, options);
    const attempts = this.options.readinessAttempts ?? 10;
    for (let attempt = 0; ; attempt += 1) {
      const state = await this.tmux.state(session);
      if (!state.alive || state.dead) throw new Error(harnessExitReason(state));
      if (state.promptReady) return;
      if (attempt >= attempts) throw new Error(`tmux session ${session} did not become ready to accept a turn`);
      await this.options.sleep?.(100 * (attempt + 1));
    }
  }

  async deliver(
    session: string,
    text: string,
    options?: StartupDialogOptions,
    beforeWrite?: () => Promise<void>,
  ): Promise<InjectionOutcome> {
    await this.waitReady(session, options);
    await beforeWrite?.();
    this.record('deliver', session, text);
    this.delivered.push({ session, text });
    return this.outcome;
  }

  async waitStartupSettled(session: string): Promise<'settled' | 'timed-out'> {
    this.record('waitStartupSettled', session);
    return this.settled;
  }
}
