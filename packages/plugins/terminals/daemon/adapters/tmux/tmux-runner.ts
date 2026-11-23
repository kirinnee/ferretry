import {
  type AttachRefusal,
  type FerretId,
  type DeliveryOutcome,
  FORM_KEYS,
  type FormKey,
  PICKER_KEYS,
  type PickerKey,
  HARNESS_STOP_KEYS,
  type RunnerFormCapture,
  type QueueOutcome,
  type RunnerComposerCleared,
  type RunnerComposerSubmitted,
  type RunnerHeldAt,
  type RunnerPaneIdentity,
  type RunnerPaneObservation,
  type Runner,
  type RunnerDelivery,
  type RunnerDeliveryFailure,
  type RunnerExit,
  type RunnerHandle,
  type RunnerLook,
  type RunnerStop,
  type RunnerStopOutcome,
  runnerDeliveryFailure,
  type RunningFerret,
  type RunSpec,
  shouldPressStopKey,
  type StartRefusal,
} from '@ferretry/core-ferrets/contract';
import type { RunnerKey } from '@ferretry/core-ferrets/contract';
import {
  type ActRunner,
  type Log,
  type Redaction,
  type RefusalCode,
  REFUSAL_SENTENCES,
  type SpawnPort,
} from '@ferretry/kernel/contract';
import { targetRef } from '@ferretry/core-vault/contract';
import { err, type Instant, ok, type Result } from '@ferretry/std';
import { MANAGER_ENVIRONMENT_NAMES } from '../../lib/cgroups/scope.ts';
import { sessionTarget } from '../../lib/tmux/address.ts';
import { tmuxStartDirectory } from '../../lib/tmux/format-escape.ts';
import { maskedScreen } from '../../lib/tmux/screen-mask.ts';
import { PANE_EXIT_FACTS, parsePaneExits } from '../../lib/tmux/pane-exit.ts';
import { killSessionArguments, paneActivityFormat, remainOnExitArguments } from '../../lib/tmux/commands.ts';
import type { TmuxCommandPort, TmuxCommandResult } from '../../lib/tmux/contracts.ts';
import { TmuxController } from '../../lib/tmux/controller.ts';
import type { ProcessTreeRead } from '../../lib/session/processes/ports.ts';
import { isTmuxServerAbsent } from '../../lib/tmux/server-absent.ts';
import { scriptLine } from '../../lib/tmux/script.ts';
import { guardedWriteArguments, GUARD_REFUSED } from '../../lib/tmux/write-guard.ts';
import { TERMINAL_TMUX_PREFIX } from '../../lib/terminal/runtime-policy.ts';
import { paneBlockingDialog } from '../../lib/tmux/harness-dialog.ts';
import { paneBlockingPermission } from '../../lib/tmux/permission-prompt.ts';
import { LaunchGuardRefusal, RealHarnessRefusedError, type TmuxLaunchGuard } from '../../lib/tmux/harness-guard.ts';
import { TMUX_PROGRAM } from './kernel-tmux-process.ts';
import { captureFrame, ComposerUnconfirmedError, type DeliverySleep } from './composer-fill.ts';
import {
  type CapturedFrame,
  capturedFrameIsCurrent,
  paneShowsActiveWork,
  paneShowsStartupWait,
  paneStateFrom,
  parsePaneActivity,
} from '../../lib/tmux/pane.ts';
import { type FrameDigest, turnLookOf } from '../../lib/tmux/turn-look.ts';
import {
  PaneDeliveryError,
  type PaneNotReadyCause,
  PaneNotReadyError,
  blockedByDialog,
  PaneStrandedError,
  TmuxPaneDelivery,
} from './pane-delivery.ts';
import { TmuxPaneQueue } from './pane-queue.ts';
import { ComposerActs } from './composer-acts.ts';

/** A read waits for nothing. */
const noSleep: DeliverySleep = async () => undefined;

/**
 * Why the binding itself wrote nothing for one write: the pane behind the handle is not the one first bound (it died,
 * or its session, process, birth or foreground program changed) — `gone` — or it is, but its cursor row moved between
 * the frame read and the write, so the screen was redrawing under the write — `moved`.
 */
type BindingBlock = 'gone' | 'moved';

/** What a binding block means for a write that typed nothing: a gone pane exited; a redrawing one was busy. */
const BLOCKED_WHY: Readonly<Record<BindingBlock, PaneNotReadyCause>> = { gone: 'exited', moved: 'busy' };

/** What the guarded binding knows about why a write did not happen (read when a delivery or a stop fails). */
interface WriteRecord {
  readonly typings: number;
  /** The closed code of the first write this binding's act refused, if any. */
  readonly refused: RefusalCode | undefined;
  /** The first write the binding itself refused because the pane changed, if any. */
  readonly blocked: BindingBlock | undefined;
}

/**
 * A failure after something was typed is reported as typed-but-unconfirmed, never as a loss a retry should re-type;
 * `ComposerUnconfirmedError` and `PaneStrandedError` already say so and pass through unchanged. With nothing typed, a
 * hold that refused a write is the answer, then a failure that already knows its cause, then a write the binding
 * refused because the pane changed: that one is `not_ready` (nothing typed), never an unclassified rejection.
 */
function typedNotLost(error: unknown, written: WriteRecord): unknown {
  const { typings, refused, blocked } = written;
  if (typings > 0 && !(error instanceof ComposerUnconfirmedError) && !(error instanceof PaneStrandedError))
    return new ComposerUnconfirmedError('the payload was typed but delivery could not be confirmed', typings);
  if (typings > 0) return error;
  // Nothing typed and a hold refused a write: the hold is why, said as its closed code (never the tmux error's text).
  if (refused !== undefined) return new PaneHeldError(refused);
  if (runnerDeliveryFailure(error) !== undefined) return error;
  if (blocked !== undefined) return new PaneNotReadyError(BLOCKED_SENTENCES[blocked], BLOCKED_WHY[blocked]);
  return error;
}

/** The fixed sentence for a write the binding refused (never the tmux error's text). */
const BLOCKED_SENTENCES: Readonly<Record<BindingBlock, string>> = {
  gone: 'the ferret pane is no longer live',
  moved: 'the ferret pane changed before the write, so nothing was typed',
};

/**
 * A write the runner's own act was refused (a Vault hold, a quarantine, an input card, or no hold check at all), with
 * NOTHING of the payload typed: the kernel's closed code, carried as the runner contract's `held` failure and said in
 * the kernel's fixed sentence.
 */
class PaneHeldError extends PaneDeliveryError {
  readonly deliveryFailure: RunnerDeliveryFailure;
  constructor(readonly code: RefusalCode) {
    super(REFUSAL_SENTENCES[code]);
    this.name = 'PaneHeldError';
    this.deliveryFailure = { kind: 'held', code };
  }
}

const STOP_KEYS: ReadonlySet<string> = new Set(HARNESS_STOP_KEYS);

/**
 * The `runners:tmux` provider (§2.3): a ferret's harness runs in its own tmux session, `fy-<ferret>`, on Terminals'
 * tmux server, and its HANDLE IS THE PANE ID (`%12`).
 *
 * WHY THE PANE ID: tmux never reuses one while its server lives, and Ferrets persists the handle in `ferret.json`, so a
 * restarted daemon finds the pane again by asking tmux about exactly that id (`attach`) — never by a name a person or
 * a second launch could have taken meanwhile. A v4→v5 switch hands v5 the pane ids of the panes already running, and
 * `attach` adopts each WITHOUT restarting it (spine D15).
 *
 * THE ENVIRONMENT NEVER PASSES THROUGH THIS PLUGIN. `spec.env` is the Vault's opaque handle: the kernel's spawn adapter
 * opens it for the ONE tmux client that runs the launch, and tmux copies exactly the variables the handle names
 * (`update-environment`, set for this launch and put back in the same script) from that client into the new
 * session. The names are not secret (`ChildEnvironment.names` is "for the launch record"); the values exist only in
 * that client's environment and the pane's. The server is started first, from a client WITHOUT the handle, so a
 * server this launch starts can never inherit a ferret's values into its global environment.
 */

/** tmux session names for ferrets (today's `tmuxSessionPrefix` and `maxTmuxSessionNameLength`). */
const FERRET_TMUX_PREFIX = 'fy-';
const MAX_TMUX_SESSION_NAME_LENGTH = 80;

/** A pane id as tmux prints one. */
const PANE_ID = /^%(?:0|[1-9][0-9]*)$/u;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/**
 * The two names a pane's `systemd-run --user --scope` (the ferret-limits wrapper) finds the user manager by. The kernel
 * gives them, and only them, to every `tmux` client it spawns (its `MANAGER_ENVIRONMENT_NAMES`; a test holds the two
 * lists equal), so a server this daemon starts already has them. They are ALSO copied into each new ferret session from
 * the launching client, and kept in the server's `update-environment` afterwards, because a server started by an older
 * build has neither in its global environment and lives on across a daemon update: without them the wrapper exits 1
 * before the harness runs ("Failed to connect to bus: No medium found"). Neither is a secret: no value is a credential.
 */
export const PANE_MANAGER_NAMES: readonly string[] = MANAGER_ENVIRONMENT_NAMES;

/** What tmux is asked about a pane: id, process, dead, the session holding it, and when that session began. */
const PANE_FACTS = '#{pane_id}|#{pane_pid}|#{pane_dead}|#{session_name}|#{session_created}';
const DELIVERY_FACTS = `${PANE_FACTS}|#{pane_current_command}|#{cursor_y}`;
/** The only tmux commands a startup wait may run: questions about the pane. Anything else is refused before tmux. */
const STARTUP_READS: ReadonlySet<string> = new Set(['has-session', 'display-message', 'capture-pane']);

/** `port` narrowed to questions: any other command is answered `refusal` (exit 1) and never reaches tmux. */
const onlyReads = (port: TmuxCommandPort, refusal: string): TmuxCommandPort => ({
  execute: async (args, stdin) =>
    STARTUP_READS.has(args[0] ?? '') ? await port.execute(args, stdin) : { code: 1, stdout: '', stderr: refusal },
});

export function ferretTmuxSession(ferret: string): string {
  return sessionTarget(`${FERRET_TMUX_PREFIX}${ferret}`.slice(0, MAX_TMUX_SESSION_NAME_LENGTH));
}

interface PaneFacts {
  readonly paneId: string;
  readonly pid: number;
  readonly dead: boolean;
  readonly session: string;
  readonly created: number;
  readonly command?: string;
  readonly cursorRow?: number;
}

function parsePaneFacts(line: string): PaneFacts | undefined {
  const [paneId = '', pid = '', dead = '', session = '', created = '', command, cursorRow] = line.trim().split('|');
  if (!PANE_ID.test(paneId) || session === '') return undefined;
  const process = Number(pid);
  const began = Number(created);
  return {
    paneId,
    pid: Number.isInteger(process) && process > 0 ? process : 0,
    dead: dead === '1',
    session,
    created: Number.isInteger(began) && began > 0 ? began : 0,
    ...(command === undefined ? {} : { command }),
    ...(cursorRow !== undefined && /^(?:0|[1-9][0-9]*)$/u.test(cursorRow) ? { cursorRow: Number(cursorRow) } : {}),
  };
}

/**
 * Whether the pane read now is still the exact pane a binding was made for: live, same session, process, birth and
 * foreground program, with a cursor row to compare. The row itself may differ; the write's own guard compares it.
 */
/**
 * The same pane, process and session as `original`, alive, now running ANOTHER program: what a launch looks like while
 * its wrappers exec one into the next at one pid (`tmux` → `systemd-run` → `ionice` → … → the harness).
 */
function sameLaunch(current: PaneFacts, original: PaneFacts): boolean {
  return (
    !current.dead &&
    current.session === original.session &&
    current.pid === original.pid &&
    current.created === original.created &&
    current.command !== undefined &&
    current.cursorRow !== undefined
  );
}

function sameBinding(current: PaneFacts, original: PaneFacts): boolean {
  return (
    !current.dead &&
    current.session === original.session &&
    current.pid === original.pid &&
    current.created === original.created &&
    current.command === original.command &&
    current.cursorRow !== undefined
  );
}

/** `#{cursor_x}|#{cursor_y}` as two whole numbers, or nothing when tmux answered something else. */
function cursorOf(stdout: string): readonly [number, number] | readonly [] {
  const match = /^(\d+)\|(\d+)\s*$/u.exec(stdout);
  return match === null ? [] : [Number(match[1]), Number(match[2])];
}

/** Whether a tmux session is a ferret's: `fy-…`, and not one of Terminals' own shells (`fy-webterm-…`). */
/**
 * Whether a targeted command's refusal says the server holds NO session at all (measured, tmux 3.7b): a server kept up
 * with `exit-empty` off and nothing in it cannot even resolve a "current" session to start the lookup from, so
 * `has-session -t =<name>` answers `no current target` instead of `can't find session`. With any session there the
 * lookup proceeds and the ordinary `can't find session` answers. Either way the named session is not there.
 */
function isServerEmpty(stderr: string): boolean {
  return /^no current target\b/imu.test(stderr);
}

function isFerretSession(session: string): boolean {
  return session.startsWith(FERRET_TMUX_PREFIX) && !session.startsWith(TERMINAL_TMUX_PREFIX);
}

/**
 * What the runner asks of the machine to identify a pane's root process and to signal one proved descendant of it (c58-37).
 * Every member is a read except `signal`, which sends ONE signal to ONE pid and throws as `process.kill` does.
 */
export interface PaneProcessHost {
  /** The start value of `pid` now, read fresh (Linux start ticks, macOS epoch seconds); `undefined` once it exited. */
  startOf(pid: number): Promise<number | undefined>;
  /** Descendants of `rootPid`, parents before children, each with its own start. */
  tree(rootPid: number): Promise<ProcessTreeRead>;
  signal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void;
  /** Pids that are never signalled whatever the tree says: this daemon and every parent of it. Read fresh per call. */
  protectedPids(): Promise<readonly number[]>;
}

export interface TmuxRunnerOptions {
  readonly tmux: TmuxCommandPort;
  readonly spawn: SpawnPort;
  readonly socketPath: string;
  readonly instantOf: (epochSeconds: number) => Instant;
  readonly now: () => Instant;
  /** The argv the pane execs: the harness's command inside the ferret's limits (docs/ferret-limits.md). */
  readonly wrap?: (ferret: string, command: readonly string[]) => Promise<readonly string[]>;
  /** Told of every pane this runner started or adopted, with the ferret it runs (the processes and attach proof). */
  readonly remember?: (ferret: string, running: RunningFerret) => Promise<void>;
  /** The kernel guards every delivery write; sleeps use its clock. Absent: delivery refuses before any keys. */
  readonly delivery?: { readonly act: ActRunner; readonly sleep: DeliverySleep };
  /**
   * Armed under test mode (the kernel's `hostFacts.launchGuard()`): consulted before ANY tmux command of a launch, so a
   * real harness is never reached and no server is started for it. A refusal is LOUD: its sentence (a harness name, a
   * filesystem path and an install name, never an environment value) is logged as a warning, and the start answers
   * the closed refusal `real_harness`, which Ferrets turns into the start's reason. Anything else the guard throws
   * (a locator that failed) still rejects the start: it fails closed, never open.
   */
  readonly launchGuard?: TmuxLaunchGuard;
  /**
   * The machine reads behind `identify` (a pid's start) and `signalDescendant` (the tree, the protected pids, the one
   * signal). Absent: `identify` names the pane without a start, and `signalDescendant` signals nothing.
   */
  readonly processes?: PaneProcessHost;
  /** Where a refused launch is said. */
  readonly log?: Pick<Log, 'warn'>;
  /**
   * The turn watch's read (`Runner.look`, U4): every look is an act on the pane (`kernel.act(terminal %n, 'read')`, so a
   * hold refuses it), its screen masked inside one `Redaction.read` before it is parsed. Absent: `look` answers nothing.
   */
  readonly look?: {
    readonly act: ActRunner;
    readonly redaction: Redaction;
    readonly digest: FrameDigest;
    /** Gives the event loop back between a big screen's readings (the kernel clock's zero sleep); absent: no yield. */
    readonly yieldToLoop?: () => Promise<void>;
  };
}

/** Which of the harness's blocking surfaces a frame is: a tool-permission prompt, a dialog, or neither (a question form is neither). */
function blockingOf(frame: string): 'permission' | 'dialog' | undefined {
  if (paneBlockingPermission(frame) !== undefined) return 'permission';
  return paneBlockingDialog(frame) !== undefined ? 'dialog' : undefined;
}

export class TmuxRunner implements Runner {
  readonly key = 'tmux' as RunnerKey;
  /** One launch at a time: `update-environment` is a server-wide option, set and put back inside one launch. */
  #launching: Promise<unknown> = Promise.resolve();

  /**
   * The last frame each watched pane was captured in (today's `PaneFrames`), by pane id: a look asks tmux ONE question
   * for the pane's activity stamp and captures the screen again only when that stamp says it may have changed. Held as
   * tmux printed it and masked on every look, so a value the Vault learns later is masked in a frame captured before.
   * Forgotten when the pane is gone, dead, or stopped (politely or not).
   */
  readonly #frames = new Map<string, CapturedFrame>();

  /**
   * Moved as every stop ENDS (after it forgot the frame again). A look keeps the frame it captured only when this did not
   * move while it ran: a look in flight across a stop's end would otherwise put back the pane text the stop forgot, and
   * after a stop the watch never looks again to forget it. A look that lands before the stop ends is forgotten by it.
   */
  #stopEpoch = 0;

  constructor(private readonly options: TmuxRunnerOptions) {}

  async start(spec: RunSpec): Promise<Result<RunningFerret, StartRefusal>> {
    const launch = this.#launching.then(async () => await this.launch(spec));
    this.#launching = launch.catch(() => undefined);
    return await launch;
  }

  async resume(spec: RunSpec, _harnessConversationId: string): Promise<Result<RunningFerret, StartRefusal>> {
    // The harness plugin built `spec.command` to resume its conversation; the runner starts it like any other.
    return await this.start(spec);
  }

  async attach(handle: RunnerHandle): Promise<Result<RunningFerret, AttachRefusal>> {
    if (!PANE_ID.test(handle)) return err('unsupported');
    const facts = await this.facts(handle);
    if (facts === undefined || facts.dead) return err('gone');
    if (!isFerretSession(facts.session)) return err('not-a-ferret');
    // Adopted as it is: nothing is sent to the pane, nothing restarted.
    const running: RunningFerret = {
      handle,
      ...(facts.pid > 0 ? { pid: facts.pid } : {}),
      startedAt: facts.created > 0 ? this.options.instantOf(facts.created) : this.options.now(),
    };
    await this.options.remember?.(facts.session.slice(FERRET_TMUX_PREFIX.length), running);
    return ok(running);
  }

  async alive(handle: RunnerHandle, ferret?: FerretId): Promise<boolean> {
    if (!PANE_ID.test(handle)) return false;
    const facts = await this.facts(handle);
    // Another ferret's live pane behind a stale handle is not THIS ferret's liveness.
    return facts !== undefined && !facts.dead && TmuxRunner.owns(facts, ferret);
  }

  /**
   * Whether the ferret's own tmux session is PROVEN not there (W2-a, today's `TmuxSessionExitObserver.exitOf` `gone`):
   * tmux answers that it cannot find the session, that the private server holds no session at all (`no current
   * target`: a server kept up empty, e.g. one started before the daemon with `exit-empty` off), or that the private
   * server is not running (which takes every pane with it). Asked by the ferret's session name, never by the handle: pane ids start again when the server does, so a
   * stale handle can name another ferret's pane. A live session, one tmux kept with a dead pane, and every refusal that
   * proves nothing (a socket this daemon may not open, a server that went away mid-request) answer false. Only asks.
   */
  async gone(ferret: FerretId): Promise<boolean> {
    let session: string;
    try {
      session = ferretTmuxSession(ferret);
    } catch {
      return false;
    }
    // `=` is tmux's exact-name match: without it `fy-abc` would also find a session named `fy-abcdef`.
    const present = await this.options.tmux.execute(['has-session', '-t', `=${session}`]).catch(() => undefined);
    if (present === undefined || present.code === 0) return false;
    return (
      /can't find session/iu.test(present.stderr) || isServerEmpty(present.stderr) || isTmuxServerAbsent(present.stderr)
    );
  }

  /**
   * Whether the pane `handle` of `ferret` is PROVEN to be there with its program ended (`Runner.exited`): the session is
   * the ferret's own (named by the ferret, every target the exact `=name`), and `list-panes -s` lists that exact pane id
   * with `pane_dead` 1. A live pane, a pane id the session does not hold (a relaunch replaced it), a session that is not
   * there (that is {@link TmuxRunner.gone}) and every refusal that proves nothing answer `undefined`. It answers the
   * status and signal only, never what the pane shows ({@link TmuxRunner.deadScreen}). Only asks.
   */
  async exited(ferret: FerretId, handle: RunnerHandle): Promise<RunnerExit | undefined> {
    if (!PANE_ID.test(handle)) return undefined;
    let session: string;
    try {
      session = ferretTmuxSession(ferret);
    } catch {
      return undefined;
    }
    const listed = await this.options.tmux
      .execute(['list-panes', '-s', '-t', `=${session}`, '-F', PANE_EXIT_FACTS])
      .catch(() => undefined);
    if (listed === undefined || listed.code !== 0) return undefined;
    const pane = parsePaneExits(listed.stdout).find(candidate => candidate.paneId === handle);
    if (pane === undefined || !pane.dead) return undefined;
    return {
      ...(pane.status === undefined ? {} : { status: pane.status }),
      ...(pane.signal === undefined ? {} : { signal: pane.signal }),
    };
  }

  /**
   * The masked screen of a pane {@link TmuxRunner.exited} proves dead (`Runner.deadScreen`), for the ferret's stored last
   * screen and nothing else: the proof is asked again here (a pane that is live, another ferret's or replaced answers
   * `undefined`), the screen is read through the same act and redaction a look uses, so a hold refuses it, and the whole
   * masked frame is returned (the keeper bounds it). `undefined` with no look wiring, a hold, or an unreadable screen.
   */
  async deadScreen(ferret: FerretId, handle: RunnerHandle): Promise<string | undefined> {
    if ((await this.exited(ferret, handle)) === undefined) return undefined;
    const watch = this.options.look;
    if (watch === undefined) return undefined;
    const acted = await watch
      .act(targetRef('terminal', handle), 'read', async () => {
        const captured = await this.options.tmux.execute(['capture-pane', '-p', '-t', handle]);
        if (captured.code !== 0) return { kind: 'content' as const };
        return await watch.redaction.read(async scope => ({
          kind: 'content' as const,
          data: (await maskedScreen(scope, captured.stdout, watch.yieldToLoop)) as never,
        }));
      })
      .catch(() => undefined);
    if (acted === undefined || !acted.ok || typeof acted.value.data !== 'string') return undefined;
    return acted.value.data;
  }

  /**
   * The pane behind `handle` now, read only (`list-panes -a`: the one question tmux answers EXACTLY by pane id, where
   * `display-message -t %n` answers the current pane for an id that is gone). `'gone'` only when a server that answered
   * does not list the pane, or tmux says it has no server; every other failure proves nothing and is `undefined`. A pane
   * outside a ferret's session, or (with `ferret` named) in another ferret's, is not vouched for (`undefined`). A dead pane
   * tmux keeps has no pid.
   */
  async identify(handle: RunnerHandle, ferret?: FerretId): Promise<RunnerPaneIdentity | 'gone' | undefined> {
    if (!PANE_ID.test(handle)) return undefined;
    const listed = await this.options.tmux.execute(['list-panes', '-a', '-F', PANE_FACTS]).catch(() => undefined);
    if (listed === undefined) return undefined;
    if (listed.code !== 0) return isTmuxServerAbsent(listed.stderr) ? 'gone' : undefined;
    const facts = listed.stdout
      .split('\n')
      .map(parsePaneFacts)
      .find(candidate => candidate?.paneId === handle);
    if (facts === undefined) return 'gone';
    // Another ferret's pane behind a stale handle: it is not THIS ferret's pane, so nothing about it (its process tree
    // above all) is told for this ferret. Not `'gone'` either: the ferret's own pane may be elsewhere, so it is unknown.
    if (!isFerretSession(facts.session)) {
      this.options.log?.warn(
        `Not telling which process pane ${handle} runs: its tmux session name "${facts.session}" is not a ferret's session.`,
        { handle },
      );
      return undefined;
    }
    if (!TmuxRunner.owns(facts, ferret)) {
      this.options.log?.warn(
        `Not telling which process pane ${handle} runs: its tmux session name "${facts.session}" is not this ferret's session "${ferret === undefined ? '' : ferretTmuxSession(ferret)}", so the handle is stale and the pane belongs to another ferret.`,
        { handle },
      );
      return undefined;
    }
    if (facts.dead || facts.pid <= 0) return { handle };
    const start = await this.options.processes?.startOf(facts.pid).catch(() => undefined);
    if (start === undefined && this.options.processes !== undefined)
      this.options.log?.warn(
        `Pane ${handle} is named without a process start: the start ticks of its process (pid ${String(facts.pid)}) could not be read, so a later signal cannot prove it is the same process.`,
        { handle },
      );
    return { handle, pid: facts.pid, ...(start === undefined ? {} : { processStart: String(start) }) };
  }

  /**
   * ONE signal to ONE pid, and only a pid PROVED to be a descendant of this pane's root with this start at this moment.
   * The proof is the tree read now (`rootPid`'s descendants, each with its own start), never what the caller remembers;
   * the start is read again immediately before the signal, and the root must be the same run on both sides of the tree
   * read. Refused (`false`, nothing sent): no process host, a signal other than SIGTERM or SIGKILL, a pid that is not a
   * plain pid above init, a caller that could not read the start, a pane that is gone, dead or not a ferret's, a tree that
   * could not be read, a pid that is the root, not below it or reused, and a protected pid (the daemon or a parent of
   * it, which a daemon started from inside a ferret's pane would otherwise be). Nothing is written to the pane. The
   * `ferret` is required: a pane that is another ferret's (a stale handle a restarted server handed out again) is refused
   * as `identify` refuses it, so its process tree is never read or signalled for this ferret.
   */
  async signalDescendant(
    handle: RunnerHandle,
    pid: number,
    start: string | undefined,
    signal: 'SIGTERM' | 'SIGKILL',
    ferret: FerretId,
  ): Promise<boolean> {
    const host = this.options.processes;
    if (host === undefined || (signal !== 'SIGTERM' && signal !== 'SIGKILL')) return false;
    if (!Number.isSafeInteger(pid) || pid <= 1 || start === undefined || start === '') return false;
    // The type says the ferret is there; a caller that is not typed (or a cast) must not turn "no ferret" into "any ferret".
    if ((ferret as FerretId | undefined) === undefined) return false;
    const pane = await this.identify(handle, ferret);
    if (pane === undefined || pane === 'gone' || pane.pid === undefined || pane.processStart === undefined)
      return false;
    if (pid === pane.pid || (await host.protectedPids()).includes(pid)) return false;
    const tree = await host.tree(pane.pid).catch(() => undefined);
    if (tree === undefined || tree.kind !== 'read') return false;
    const target = tree.rows.find(candidate => candidate.pid === pid && String(candidate.start) === start);
    if (target === undefined) return false;
    // The pane root must still be the run identified above, and the target still the run proved below it.
    const rootNow = await host.startOf(pane.pid).catch(() => undefined);
    const targetNow = await host.startOf(pid).catch(() => undefined);
    if (rootNow === undefined || String(rootNow) !== pane.processStart) return false;
    if (targetNow === undefined || String(targetNow) !== start) return false;
    try {
      host.signal(pid, signal);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH' || code === 'EPERM') return false;
      throw error;
    }
  }

  async deliver(handle: RunnerHandle, delivery: RunnerDelivery, ferret?: FerretId): Promise<DeliveryOutcome> {
    const pane = await this.guardedPane(handle, ferret);
    // In particular, ComposerUnconfirmedError and PaneStrandedError propagate without a retry: typed is not lost.
    try {
      return await new TmuxPaneDelivery(new TmuxController(pane.port), pane.sleep).deliver(
        pane.session,
        delivery.text,
        { resumeMenuChoice: delivery.resumeMenuChoice },
        delivery.beforeWrite,
      );
    } catch (error) {
      throw typedNotLost(error, pane.written());
    }
  }

  /**
   * Puts one message into a BUSY ferret pane's own queue (today's `TmuxPaneQueue`, unchanged), through the SAME guarded
   * binding `deliver` uses: every write is acted on under `kernel.act(terminal %n, 'keys')` by this runner itself (a hold
   * types nothing), re-checked against the exact live pane in the write, and never raw. A caller must not wrap it again.
   */
  async queue(handle: RunnerHandle, text: string, ferret?: FerretId): Promise<QueueOutcome> {
    const pane = await this.guardedPane(handle, ferret);
    try {
      return await new TmuxPaneQueue(new TmuxController(pane.port), pane.sleep).queue(pane.session, text);
    } catch (error) {
      throw typedNotLost(error, pane.written());
    }
  }

  /**
   * Today's interrupt (`SessionSendService.interruptLocked` over `TmuxSendTerminal.pressStopKey`): reads the exact
   * ferret pane once, and presses the HARNESS's stop key — one keystroke, no retry — only when `shouldPressStopKey`
   * says so for what it read; then reads the pane again so the caller can tell a turn interrupted from a pane handed
   * back. Through the same guarded binding `deliver` uses: the keystroke is acted on under
   * `kernel.act(terminal %n, 'keys')` by this runner itself (a hold presses nothing) and re-checked against the live
   * pane in the write. NEVER `C-c`: that is `signal`'s raw interrupt, which quits Codex at an idle prompt.
   *
   * Every failure before the press is answered as `not_ready`/`exited` with NOTHING pressed: a first read that
   * failed, a pane not live, or a press the binding refused because the pane changed (a stop at a pane that is no
   * longer the one bound is a stop at a gone ferret pane). A hold that refused the press is its closed code.
   */
  async stopTurn(handle: RunnerHandle, stop: RunnerStop, ferret?: FerretId): Promise<RunnerStopOutcome> {
    return await this.#stop(handle, stop, false, ferret);
  }

  /**
   * `stopTurn`'s press. `overPrompt: false` is the person's own interrupt (today's rule: pressed whenever
   * `shouldPressStopKey` says so). `true` is a send-now's stop: the frame read INSIDE the act must also show no
   * blocking prompt and no startup wait, since a permission that came up after the caller's own read can sit beneath a
   * still-drawn active-work line, and Escape would then answer it "no" for the person. Nothing is pressed then.
   */
  async #stop(
    handle: RunnerHandle,
    stop: RunnerStop,
    overPrompt: boolean,
    ferret?: FerretId,
  ): Promise<RunnerStopOutcome> {
    // Closed by the contract's type; refused here as well, so no caller can make this press another key.
    if (!STOP_KEYS.has(stop.key)) throw new PaneDeliveryError('that is not a harness stop key');
    const pane = await this.guardedPane(handle, ferret);
    const tmux = new TmuxController(pane.port);
    try {
      const before = await captureFrame(tmux, pane.session).catch(() => undefined);
      if (before === undefined || !before.alive || before.dead)
        throw new PaneNotReadyError('the ferret pane is no longer live', 'exited');
      const working = paneShowsActiveWork(before.visible);
      if (overPrompt && (blockedByDialog(before.visible) || paneShowsStartupWait(before.visible)))
        return { pressed: false, working };
      if (!shouldPressStopKey(working, stop)) return { pressed: false, working };
      await tmux.sendKey(pane.session, stop.key);
      const after = await captureFrame(tmux, pane.session).catch(() => undefined);
      return {
        pressed: true,
        ...(after === undefined || !after.alive || after.dead ? {} : { working: paneShowsActiveWork(after.visible) }),
      };
    } catch (error) {
      const written = pane.written();
      if (written.refused === undefined && written.blocked !== undefined && runnerDeliveryFailure(error) === undefined)
        throw new PaneNotReadyError('the ferret pane changed before the stop key, so nothing was pressed', 'exited');
      throw typedNotLost(error, { ...written, typings: 0 });
    }
  }

  /**
   * Today's `TmuxSessionLifecycleLauncher.settled`: waits, boundedly, for the harness to finish its own startup now
   * that its first turn is in (`TmuxPaneDelivery.waitStartupSettled`, unchanged). It reads the SAME exact pane
   * `deliver` bound, through that binding (every read re-proves the pane is the one first seen, so a pane that died or
   * was replaced reads as exited), and it writes NOTHING: any write it asked for would be refused before tmux saw it.
   * Its reads are not acted on, exactly like `deliver`'s own frame reads. A pane that dies rejects with
   * `PaneStartupExitedError`, whose `parked` says whether a frame showed the first turn parked first.
   */
  async settled(handle: RunnerHandle, ferret?: FerretId): Promise<'settled' | 'timed-out'> {
    const pane = await this.guardedPane(handle, ferret);
    const reading = onlyReads(pane.port, 'a startup wait writes nothing');
    return await new TmuxPaneDelivery(new TmuxController(reading), pane.sleep).waitStartupSettled(pane.session);
  }

  /**
   * `Runner.answerDevChannels`: Claude Code's development-channels confirm, answered at launch through the SAME guarded
   * binding a delivery uses (its one key is acted on under `kernel.act(terminal %n, 'keys')`), and nothing else.
   */
  async answerDevChannels(handle: RunnerHandle, ferret?: FerretId): Promise<'answered' | 'absent'> {
    const pane = await this.guardedPane(handle, ferret);
    return await new TmuxPaneDelivery(new TmuxController(pane.port), pane.sleep).answerDevChannels(pane.session);
  }

  /**
   * Today's `PaneScreenReader.text`: the visible screen of the ferret pane behind `handle`, dead or alive, for its
   * harness to explain a failed start. Only a ferret's own pane is read (a person's shell answers `''`), only by its
   * exact id, and nothing is written. The text goes to the caller and is never logged here.
   */
  async lastScreen(handle: RunnerHandle, ferret?: FerretId): Promise<string> {
    if (!PANE_ID.test(handle)) return '';
    const facts = await this.facts(handle);
    if (facts === undefined || !isFerretSession(facts.session) || !TmuxRunner.owns(facts, ferret)) return '';
    const captured = await this.options.tmux.execute(['capture-pane', '-p', '-t', handle]);
    return captured.code === 0 ? captured.stdout : '';
  }

  /**
   * ONE read-only binding of the exact live ferret pane behind `handle` for a read: only questions reach tmux (anything
   * else is refused before it), and every read re-proves the pane is the one first seen. Not an act, like `settled`'s.
   */
  private async readingPane(
    handle: RunnerHandle,
    ferret?: FerretId,
  ): Promise<{ readonly tmux: TmuxController; readonly session: string }> {
    const pane = await this.guardedPane(handle, ferret);
    return { tmux: new TmuxController(onlyReads(pane.port, 'a pane read writes nothing')), session: pane.session };
  }

  /** A blocking prompt's words, masked inside one `Redaction.read`; with no redaction bound, a fixed sentence. */
  private async maskedObservation(seen: RunnerPaneObservation): Promise<RunnerPaneObservation> {
    const { blockingPrompt, ...rest } = seen;
    if (blockingPrompt === undefined) return seen;
    const redaction = this.options.look?.redaction;
    if (redaction === undefined) return { ...rest, blockingPrompt: 'a prompt on its screen' };
    const [masked] = await redaction.read(scope => scope.lines([blockingPrompt]));
    return { ...rest, blockingPrompt: masked ?? 'a prompt on its screen' };
  }

  /** Today's `TmuxSendTerminal.observe`: one read of the pane for a send. Total: nothing live reads `undefined`. */
  async observe(handle: RunnerHandle, ferret?: FerretId): Promise<RunnerPaneObservation | undefined> {
    try {
      const { tmux, session } = await this.readingPane(handle, ferret);
      return await this.maskedObservation(await new ComposerActs(tmux, session, noSleep).observe());
    } catch {
      return undefined;
    }
  }

  /** Today's `TmuxSendTerminal.heldAt`: rejects when the pane cannot be read (an unread pane proves nothing). */
  async heldAt(handle: RunnerHandle, text: string, ferret?: FerretId): Promise<RunnerHeldAt | undefined> {
    const { tmux, session } = await this.readingPane(handle, ferret);
    return await new ComposerActs(tmux, session, noSleep).heldAt(text);
  }

  /** Today's `TmuxSendTerminal.clearComposer`, every `C-u` through the guarded binding (`kernel.act` on the pane). */
  async clearComposer(handle: RunnerHandle, text: string, ferret?: FerretId): Promise<RunnerComposerCleared> {
    const pane = await this.guardedPane(handle, ferret);
    try {
      return await new ComposerActs(new TmuxController(pane.port), pane.session, pane.sleep).clearComposer(text);
    } catch (error) {
      throw typedNotLost(error, { ...pane.written(), typings: 0 });
    }
  }

  /** Today's `TmuxSendTerminal.submitComposer`: one Enter through the guarded binding. */
  async submitComposer(
    handle: RunnerHandle,
    text: string,
    strict = false,
    ferret?: FerretId,
  ): Promise<RunnerComposerSubmitted> {
    const pane = await this.guardedPane(handle, ferret);
    try {
      return await new ComposerActs(new TmuxController(pane.port), pane.session, pane.sleep).submitComposer(
        text,
        strict,
      );
    } catch (error) {
      throw typedNotLost(error, { ...pane.written(), typings: 0 });
    }
  }

  /**
   * Today's `TmuxSendTerminal.stopActiveTurn`: the harness's stop under `stopTurn`'s rule (one keystroke, never `C-c`),
   * then a bounded wait for a prompt that is NOT a failure when it gives up, then one read of the pane.
   */
  async stopActiveTurn(
    handle: RunnerHandle,
    stop: RunnerStop,
    ferret?: FerretId,
  ): Promise<RunnerPaneObservation | undefined> {
    const stopped = await this.#stop(handle, stop, true, ferret);
    if (!stopped.pressed) return await this.observe(handle, ferret);
    const pane = await this.guardedPane(handle, ferret).catch(() => undefined);
    if (pane !== undefined)
      await new TmuxPaneDelivery(new TmuxController(pane.port), pane.sleep)
        .waitReady(pane.session)
        .catch(() => undefined);
    return await this.observe(handle, ferret);
  }

  /**
   * Structured questions: ONE capture of the live ferret pane for the question-form driver (today's `TmuxController.state`):
   * the visible screen and the scrollback, each masked inside one `Redaction.read` (the scrollback tailed to what the masker
   * takes, at a line boundary) and only then handed on, everything inside ONE `kernel.act(terminal %n, 'read')` so a hold
   * refuses the whole read. Reads only. Total: a pane that is gone, not a ferret's own, unreadable or held reads `undefined`.
   */
  async formCapture(handle: RunnerHandle, ferret?: FerretId): Promise<RunnerFormCapture | undefined> {
    const watch = this.options.look;
    if (watch === undefined || !PANE_ID.test(handle)) return undefined;
    const tmux = this.options.tmux;
    const acted = await watch
      .act(targetRef('terminal', handle), 'read', async () => {
        const facts = await this.facts(handle);
        if (facts === undefined || !isFerretSession(facts.session) || !TmuxRunner.owns(facts, ferret))
          return { kind: 'content' as const };
        if (facts.dead)
          return {
            kind: 'content' as const,
            data: { alive: true, dead: true, promptReady: false, activeWork: false, visible: '', history: '' } as never,
          };
        const [visible, history, cursor] = await Promise.all([
          tmux.execute(['capture-pane', '-p', '-t', handle]),
          tmux.execute(['capture-pane', '-p', '-S', '-', '-t', handle]),
          tmux.execute(['display-message', '-p', '-t', handle, '#{cursor_x}|#{cursor_y}']),
        ]);
        const [cursorX, cursorY] = cursor.code === 0 ? cursorOf(cursor.stdout) : [];
        if (visible.code !== 0) return { kind: 'content' as const };
        const earlier = history.code === 0 ? tailAtLine(history.stdout, FORM_HISTORY_CHARS) : '';
        return await watch.redaction.read(async scope => {
          const shown = await maskedScreen(scope, visible.stdout, watch.yieldToLoop);
          const state = paneStateFrom(
            { dead: false },
            shown,
            earlier === '' ? '' : await maskedScreen(scope, earlier, watch.yieldToLoop),
          );
          return {
            kind: 'content' as const,
            data: {
              alive: true,
              dead: false,
              promptReady: state.promptReady,
              activeWork: paneShowsActiveWork(shown),
              visible: state.visible,
              history: state.history,
              ...(blockingOf(shown) === undefined ? {} : { blocking: blockingOf(shown) }),
              ...(cursorX === undefined || cursorY === undefined ? {} : { cursorX, cursorY }),
            } satisfies RunnerFormCapture as never,
          };
        });
      })
      .catch(() => undefined);
    if (acted === undefined || !acted.ok) return undefined;
    return acted.value.data === undefined ? undefined : (acted.value.data as unknown as RunnerFormCapture);
  }

  /**
   * Structured questions: ONE key of the closed {@link FORM_KEYS} typed at the pane through the guarded binding (every
   * write is `kernel.act(terminal %n, 'keys')`, so a Vault hold types nothing and rejects `held`), exactly as `deliver`'s.
   */
  async formKey(handle: RunnerHandle, key: FormKey, ferret?: FerretId): Promise<void> {
    if (!(FORM_KEYS as readonly string[]).includes(key))
      throw new TypeError('that key is not one a form is driven with');
    const pane = await this.guardedPane(handle, ferret);
    try {
      await new TmuxController(pane.port).sendKey(pane.session, key);
    } catch (error) {
      throw typedNotLost(error, { ...pane.written(), typings: 0 });
    }
  }

  /** Live model switch: ONE row digit of the closed {@link PICKER_KEYS}, guarded exactly as {@link TmuxRunner.formKey}. */
  async pickerKey(handle: RunnerHandle, key: PickerKey, ferret?: FerretId): Promise<void> {
    if (!(PICKER_KEYS as readonly string[]).includes(key))
      throw new TypeError('that key is not one a model picker is driven with');
    const pane = await this.guardedPane(handle, ferret);
    try {
      await new TmuxController(pane.port).sendKey(pane.session, key);
    } catch (error) {
      throw typedNotLost(error, { ...pane.written(), typings: 0 });
    }
  }

  /** Structured questions: `text` pasted as one bracketed paste through the guarded binding, as {@link TmuxRunner.formKey}. */
  async formPaste(handle: RunnerHandle, text: string, ferret?: FerretId): Promise<void> {
    const pane = await this.guardedPane(handle, ferret);
    try {
      await new TmuxController(pane.port).paste(pane.session, text);
    } catch (error) {
      throw typedNotLost(error, pane.written());
    }
  }
  /**
   * One look at the live ferret pane behind `handle` for the turn watch (`Runner.look`): the activity stamp, the screen
   * captured again only when it may have changed (re-proving then that the pane is still a live ferret's own), masked
   * by `maskedScreen` (a value wrapped at the pane's edge, or broken by the harness UI inside its indent or box,
   * included) and only then parsed. Everything inside ONE act on the pane: a hold refuses the whole read and nothing is captured. Total: a
   * pane that is gone, dead, not a ferret's, unreadable or held answers `undefined`. Never writes.
   */
  async look(handle: RunnerHandle, ferret?: FerretId): Promise<RunnerLook | undefined> {
    const watch = this.options.look;
    if (watch === undefined || !PANE_ID.test(handle)) return undefined;
    const tmux = this.options.tmux;
    const nothing = { kind: 'content' as const };
    const epoch = this.#stopEpoch;
    const acted = await watch
      .act(targetRef('terminal', handle), 'read', async () => {
        const asked = await tmux.execute(['display-message', '-p', '-t', handle, paneActivityFormat]);
        const activity = asked.code === 0 ? parsePaneActivity(asked.stdout) : undefined;
        if (activity === undefined || activity.dead || activity.paneId !== handle) {
          this.#frames.delete(handle);
          return nothing;
        }
        let frame = this.#frames.get(handle);
        // A cached frame is keyed by the pane id, which another ferret's pane can take over: a look FOR a ferret proves the
        // pane is that ferret's own before the cache is used (a fresh capture proves it below).
        if (ferret !== undefined && frame !== undefined && capturedFrameIsCurrent(frame, activity)) {
          const facts = await this.facts(handle);
          if (facts === undefined || !TmuxRunner.owns(facts, ferret)) {
            this.#frames.delete(handle);
            return nothing;
          }
        }
        if (frame === undefined || !capturedFrameIsCurrent(frame, activity)) {
          // A fresh capture re-proves the pane is a live ferret's own: a person's shell is never read.
          const facts = await this.facts(handle);
          if (facts === undefined || facts.dead || !isFerretSession(facts.session) || !TmuxRunner.owns(facts, ferret)) {
            this.#frames.delete(handle);
            return nothing;
          }
          const capturedAtSecond = Math.floor(Date.parse(this.options.now()) / 1_000);
          const captured = await tmux.execute(['capture-pane', '-p', '-t', handle]);
          if (captured.code !== 0) {
            this.#frames.delete(handle);
            return nothing;
          }
          frame = { activity, visible: captured.stdout, capturedAtSecond };
          if (this.#stopEpoch === epoch) this.#frames.set(handle, frame);
        }
        const visible = frame.visible;
        return await watch.redaction.read(async scope => ({
          kind: 'content' as const,
          data: turnLookOf(
            paneStateFrom(activity, await maskedScreen(scope, visible, watch.yieldToLoop)),
            watch.digest,
          ) as never,
        }));
      })
      .catch(() => undefined);
    if (acted === undefined || !acted.ok) return undefined;
    return acted.value.data === undefined ? undefined : (acted.value.data as unknown as RunnerLook);
  }

  /**
   * The exact live ferret pane behind `handle`, bound for writing: every target is rebound to this handle, every read
   * re-proves the pane is the one first seen, and every write is acted on under `kernel.act` and guarded in the server.
   */
  private async guardedPane(
    handle: RunnerHandle,
    ferret?: FerretId,
  ): Promise<{
    readonly port: TmuxCommandPort;
    readonly session: string;
    readonly sleep: DeliverySleep;
    /** What this binding's writes did so far: payload typings, an act's refusal, a write the binding refused. */
    readonly written: () => WriteRecord;
  }> {
    const gone = (): PaneNotReadyError => new PaneNotReadyError('the ferret pane is no longer live', 'exited');
    if (!PANE_ID.test(handle)) throw gone();
    const original = await this.facts(handle, true);
    if (
      original === undefined ||
      original.dead ||
      !isFerretSession(original.session) ||
      // Another ferret's pane behind a stale handle: nothing is typed, pressed or read, as for a pane that is gone.
      !TmuxRunner.owns(original, ferret) ||
      original.command === undefined ||
      original.cursorRow === undefined
    )
      throw gone();
    const guard = this.options.delivery;
    // No act runner bound: nothing may write here (fail closed), said as the kernel's own code for it.
    if (guard === undefined) throw new PaneHeldError('holds_unavailable');
    // The binding's program is the one the pane runs when the FIRST key is sent, not when the binding was made: a first
    // turn is bound while the launch's wrappers are still exec'ing at the pane's one pid (`systemd-run --user --scope`
    // takes ~60 ms to reach the harness), and a program pinned then made the harness's own first frame read as a pane
    // that was no longer live, so every limited ferret's first turn failed untyped. Until a write is attempted, a read
    // at the same pane, pid and session adopts the program it finds; from the first write on it is fixed, and every
    // write is still compared against it by the server in the write itself.
    let binding = original;
    let wrote = false;
    let observed = original;
    let typings = 0;
    let refused: RefusalCode | undefined;
    let blocked: BindingBlock | undefined;
    /** After the server's guard refused a write: `moved` when only the cursor row differs from the bound pane. */
    const whyRefused = async (): Promise<BindingBlock> => {
      const now = await this.facts(handle, true).catch(() => undefined);
      return now !== undefined && sameBinding(now, binding) ? 'moved' : 'gone';
    };
    // Reuse today's delivery unchanged. Its commands use a validated session name, but every target is rebound to
    // this exact live handle, so a changed active pane or a replacement session cannot receive the message.
    const bound: TmuxCommandPort = {
      execute: async (args, stdin) => {
        const writing = ['load-buffer', 'paste-buffer', 'send-keys'].includes(args[0] ?? '');
        const run = async (): Promise<TmuxCommandResult> => {
          // Cleanup must still work after a disappearing pane or a refused paste.
          if (args[0] === 'delete-buffer') return await this.options.tmux.execute(args, stdin);
          const current = await this.facts(handle, true);
          if (!writing && !wrote && current !== undefined && sameLaunch(current, binding)) binding = current;
          if (writing) wrote = true;
          if (current === undefined || !sameBinding(current, binding)) {
            if (writing) blocked ??= 'gone';
            return { code: 1, stdout: '', stderr: 'the ferret pane is no longer live' };
          }
          if (args[0] === 'has-session') return { code: 0, stdout: '', stderr: '' };
          const rebound = args.map((arg, i) => (args[i - 1] === '-t' ? handle : arg));
          if (!writing) {
            observed = current;
            return await this.options.tmux.execute(rebound, stdin);
          }
          // Keep the row from the frame delivery validated, including across load and paste. The server compares
          // it again with the foreground and ownership IN the write, closing the final observation/write gap.
          const guarded = guardedWriteArguments(
            handle,
            {
              panePid: original.pid,
              command: binding.command ?? '',
              cursorRow: observed.cursorRow ?? -1,
              session: original.session,
              sessionCreated: original.created,
            },
            scriptLine(
              args[0] === 'load-buffer'
                ? // if-shell's stdin belongs to its script. Carry the buffer value in that script too, never in argv.
                  ['set-buffer', '-b', args[2] ?? '', '--', stdin ?? '']
                : rebound,
            ),
          );
          if (guarded === undefined) return { code: 1, stdout: '', stderr: 'the ferret pane binding changed' };
          const result = await this.options.tmux.execute(guarded);
          if (result.stdout.includes(GUARD_REFUSED)) {
            blocked ??= await whyRefused();
            return { code: 1, stdout: '', stderr: 'the ferret pane binding changed' };
          }
          if (result.code === 0 && (args[0] === 'paste-buffer' || (args[0] === 'send-keys' && args.includes('-l'))))
            typings++;
          return result;
        };
        if (!writing) return await run();
        let result: TmuxCommandResult | undefined;
        const acted = await guard.act(targetRef('terminal', handle), 'keys', async () => {
          result = await run();
          return { status: 'done' };
        });
        if (!acted.ok) {
          refused ??= acted.error.refused;
          return { code: 1, stdout: '', stderr: REFUSAL_SENTENCES[acted.error.refused] };
        }
        if (result === undefined) throw new PaneDeliveryError('terminal delivery did not run');
        return result;
      },
    };
    return {
      port: bound,
      session: original.session,
      sleep: guard.sleep,
      written: () => ({ typings, refused, blocked }),
    };
  }

  /**
   * Whether the pane `facts` describes is `ferret`'s own. A pane id is not an identity: the private server hands `%0` out
   * again after it restarts, so a handle a record kept can name ANOTHER ferret's pane, and a stop through it would end
   * that ferret. With no `ferret` the caller vouches for the handle itself (a launch cleaning up a pane it just made).
   */
  private static owns(facts: PaneFacts, ferret: FerretId | undefined): boolean {
    return ferret === undefined || facts.session === ferretTmuxSession(ferret);
  }

  async stop(handle: RunnerHandle, how: 'polite' | 'now', ferret?: FerretId): Promise<void> {
    if (!PANE_ID.test(handle)) return;
    // Any stop forgets the pane text kept for the look: a polite one only interrupts, but the pane text is not kept.
    // Forgotten again as it ends, so no look that overlaps the stop keeps any (`#stopEpoch`).
    this.#frames.delete(handle);
    try {
      const facts = await this.facts(handle);
      // Nothing, or ANOTHER ferret's pane (or a person's shell), behind this handle: the pane id says nothing about this
      // ferret, so nothing is pressed or killed through it. Its own session is stopped by its exact name, as v4 did.
      if (facts === undefined || !TmuxRunner.owns(facts, ferret)) {
        if (ferret !== undefined) await this.stopByName(ferret, how);
        return;
      }
      if (how === 'polite' && !facts.dead) {
        // The harness's own interrupt first; the session goes once the pane is dead or the caller asks again `now`.
        // A refusal is thrown: a polite stop that reached nothing is never taken for one that did.
        const pressed = await this.options.tmux.execute(['send-keys', '-t', handle, 'C-c']);
        if (pressed.code !== 0)
          throw new Error(
            `could not interrupt ${facts.session}: ${pressed.stderr.trim() || `tmux exited ${String(pressed.code)}`}`,
          );
        return;
      }
      // Only a ferret's session is ever killed through a handle: a pane id of a person's shell is not ours to end.
      if (isFerretSession(facts.session)) {
        const killed = await this.options.tmux.execute(killSessionArguments(facts.session));
        // A session that went away between the read and the kill is the stop already made; any other refusal is not.
        if (killed.code !== 0 && !/can't find session/iu.test(killed.stderr) && !isTmuxServerAbsent(killed.stderr))
          throw new Error(
            `could not stop ${facts.session}: ${killed.stderr.trim() || `tmux exited ${String(killed.code)}`}`,
          );
      }
    } finally {
      this.#stopEpoch += 1;
      this.#frames.delete(handle);
    }
  }

  /**
   * Stops `ferret`'s own session by its EXACT name (`=fy-<id>`: a bare name is a prefix match that could name another
   * ferret's), for a handle that does not lead to it. Polite sends the harness's interrupt to a session that still has a live
   * pane and otherwise (every pane dead, or `now`) kills the session. A session that is not there stops nothing.
   */
  private async stopByName(ferret: FerretId, how: 'polite' | 'now'): Promise<void> {
    let session: string;
    try {
      session = ferretTmuxSession(ferret);
    } catch {
      return;
    }
    const exact = `=${session}`;
    // Only an ANSWER that the session is not there stops nothing. A has-session that throws, or fails any other way, proves
    // nothing about the session, and returning quietly would let the caller settle a possibly live ferret `stopped`.
    const present = await this.options.tmux.execute(['has-session', '-t', exact]).catch((error: unknown) => {
      throw new Error(
        `could not check whether ${session} is running (${error instanceof Error ? error.message : String(error)}), so it was not stopped; it may still be running`,
      );
    });
    if (present.code !== 0) {
      if (
        /can't find session/iu.test(present.stderr) ||
        isServerEmpty(present.stderr) ||
        isTmuxServerAbsent(present.stderr)
      )
        return;
      const why = present.stderr.trim() || `tmux exited ${String(present.code)}`;
      this.options.log?.warn(`Could not check whether ${session} is running, so it was not stopped: ${why}`, {
        session,
      });
      throw new Error(
        `could not check whether ${session} is running (${why}), so it was not stopped; it may still be running`,
      );
    }
    if (how === 'polite') {
      const panes = await this.options.tmux
        .execute(['list-panes', '-s', '-t', exact, '-F', '#{pane_dead}'])
        .catch((error: unknown) => ({
          code: 1,
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
        }));
      // A failed read is not proof that no pane is live: it says nothing, and the answer to nothing is not a kill.
      // `can't find session` IS an answer (the session ended between the check and the read: already stopped).
      if (panes.code !== 0) {
        if (/can't find session/iu.test(panes.stderr) || isTmuxServerAbsent(panes.stderr)) return;
        const why = panes.stderr.trim() || `tmux exited ${String(panes.code)}`;
        this.options.log?.warn(`Could not read the panes of ${session}, so it was not stopped: ${why}`, { session });
        throw new Error(
          `could not read the panes of ${session} (${why}), so it was not stopped; it may still be running`,
        );
      }
      const live = panes.stdout.split('\n').some(line => line.trim() === '0');
      if (live) {
        // `send-keys` wants a PANE target: `=fy-<id>` alone is parsed as a pane name and tmux answers "can't find pane",
        // while `=fy-<id>:` is the exact session's active pane. A refusal is thrown, so a polite stop that reached
        // nothing is never taken for one that did (the caller would settle the ferret `stopped` over a running session).
        const pressed = await this.options.tmux.execute(['send-keys', '-t', `${exact}:`, 'C-c']);
        if (pressed.code !== 0)
          throw new Error(`could not interrupt ${session}: ${pressed.stderr.trim() || `tmux exited ${pressed.code}`}`);
        return;
      }
    }
    const killed = await this.options.tmux.execute(['kill-session', '-t', exact]);
    // A session that went away between the check and the kill is the stop already made; any other refusal is not.
    if (killed.code !== 0 && !/can't find session/iu.test(killed.stderr) && !isTmuxServerAbsent(killed.stderr))
      throw new Error(`could not stop ${session}: ${killed.stderr.trim() || `tmux exited ${killed.code}`}`);
  }

  async signal(handle: RunnerHandle, signal: 'interrupt' | 'terminate', ferret?: FerretId): Promise<void> {
    if (!PANE_ID.test(handle)) return;
    const facts = await this.facts(handle);
    if (facts === undefined || facts.dead || !isFerretSession(facts.session) || !TmuxRunner.owns(facts, ferret)) return;
    if (signal === 'interrupt') await this.options.tmux.execute(['send-keys', '-t', handle, 'C-c']);
    else await this.options.tmux.execute(killSessionArguments(facts.session));
  }

  private async facts(paneId: string, delivery = false): Promise<PaneFacts | undefined> {
    const result = await this.options.tmux.execute([
      'display-message',
      '-p',
      '-t',
      paneId,
      delivery ? DELIVERY_FACTS : PANE_FACTS,
    ]);
    if (result.code !== 0) return undefined;
    const facts = parsePaneFacts(result.stdout);
    // tmux answers `-t %n` for a pane that is gone with the CURRENT pane; only the exact id is an answer.
    return facts?.paneId === paneId ? facts : undefined;
  }

  private async launch(spec: RunSpec): Promise<Result<RunningFerret, StartRefusal>> {
    const command = this.options.wrap === undefined ? spec.command : await this.options.wrap(spec.ferret, spec.command);
    const [program, ...args] = command;
    if (program === undefined) return err('failed');
    const names = spec.env.names.filter(name => ENVIRONMENT_NAME.test(name));
    if (names.length !== spec.env.names.length) return err('failed');
    const session = ferretTmuxSession(spec.ferret);
    try {
      await this.options.launchGuard?.check({
        session,
        cwd: spec.cwd,
        command: [program, ...args],
        envNames: names,
        handle: spec.env,
      });
    } catch (error) {
      if (!(error instanceof LaunchGuardRefusal)) throw error;
      this.options.log?.warn(error.message, {
        ferret: spec.ferret,
        ...(error instanceof RealHarnessRefusedError ? { harness: error.harness } : {}),
      });
      return err('real_harness');
    }
    // A session that is still there is refused (it is somebody's ferret), EXCEPT the corpse of this ferret's last run: a
    // polite stop only sends the interrupt and `remain-on-exit` keeps the dead pane, so a Resume / Restart would otherwise
    // meet its own old session and fail "duplicate session" for ever. Only a session whose every pane, in EVERY window
    // (`list-panes -s`), is dead is cleared. Every target is the EXACT name (`=`): a bare name is a tmux prefix match, so
    // `fy-abc` could name `fy-abcd` and the check or the kill would land on another ferret's session.
    const exact = `=${session}`;
    if ((await this.options.tmux.execute(['has-session', '-t', exact])).code === 0) {
      const panes = await this.options.tmux.execute(['list-panes', '-s', '-t', exact, '-F', '#{pane_dead}']);
      const flags = panes.stdout
        .split('\n')
        .map(line => line.trim())
        .filter(line => line !== '');
      if (panes.code !== 0 || flags.length === 0 || !flags.every(flag => flag === '1')) return err('failed');
      await this.options.tmux.execute(['kill-session', '-t', exact]);
    }
    // Started without the handle, so the server never holds a ferret's values in its own environment. ONE client does
    // all of it: a server with no session exits at once (`exit-empty`), so a bare `start-server` does not outlive the
    // call that made it, and the read that follows would find no server on a machine that had none (every reboot).
    // Inside the one client the server is alive for each command after it; it is kept alive past the client by turning
    // `exit-empty` off, and the launch script (or the failure path below) puts the value read here back.
    const before = await this.options.tmux.execute([
      'start-server',
      ';',
      'show-options',
      '-sv',
      'exit-empty',
      ';',
      'set-option',
      '-s',
      'exit-empty',
      'off',
      ';',
      'show-options',
      '-gv',
      'update-environment',
    ]);
    if (before.code !== 0) return err('unavailable');
    const [exitEmptyLine = '', ...optionLines] = before.stdout.split('\n');
    const exitEmpty = exitEmptyLine.trim() === 'off' ? 'off' : 'on';
    const read = optionLines
      .join('\n')
      .split(/\s+/u)
      .map(name => name.trim())
      .filter(name => name !== '');
    // What is put back: the server's own list plus the manager names, so a later session (an agent terminal or job,
    // whose client carries them too) is given them as well. Only the launch's OWN names are ever taken out again.
    const kept = [...read, ...PANE_MANAGER_NAMES.filter(name => !read.includes(name))];
    const script = [
      scriptLine(['set-option', '-g', 'update-environment', [...kept, ...names].join(' ')]),
      scriptLine([
        'new-session',
        '-d',
        '-P',
        '-F',
        '#{pane_id}|#{pane_pid}',
        '-s',
        session,
        '-c',
        tmuxStartDirectory(spec.cwd),
        '--',
        program,
        ...args,
      ]),
      scriptLine(['set-option', '-g', 'update-environment', kept.join(' ')]),
      scriptLine(['set-option', '-s', 'exit-empty', exitEmpty]),
    ].join('');
    const created = await this.options.spawn.run(
      TMUX_PROGRAM,
      ['-u', '-S', this.options.socketPath, 'source-file', '-'],
      { stdin: script, env: spec.env, cwd: spec.cwd, forFerret: spec.ferret },
    );
    const [paneId = '', pid = ''] = created.stdout.trim().split('|');
    if (created.exitCode !== 0 || !PANE_ID.test(paneId)) {
      // Whatever the script did, the option is put back from a client that holds no values.
      await this.options.tmux.execute([
        'set-option',
        '-g',
        'update-environment',
        kept.join(' '),
        ';',
        'set-option',
        '-s',
        'exit-empty',
        exitEmpty,
      ]);
      return err('failed');
    }
    await this.options.tmux.execute(remainOnExitArguments(session));
    const process = Number(pid);
    const running: RunningFerret = {
      handle: paneId as RunnerHandle,
      ...(Number.isInteger(process) && process > 0 ? { pid: process } : {}),
      startedAt: this.options.now(),
    };
    await this.options.remember?.(spec.ferret, running);
    return ok(running);
  }
}

/** The most scrollback characters a form capture masks: the masker refuses a screen past its cap, so the tail is kept. */
const FORM_HISTORY_CHARS = 200_000;

/** The last `max` characters of `text`, starting at a line boundary so no half line is read. */
function tailAtLine(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(text.length - max);
  const newline = cut.indexOf('\n');
  return newline < 0 ? '' : cut.slice(newline + 1);
}
