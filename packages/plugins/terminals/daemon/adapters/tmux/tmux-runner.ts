import {
  type AttachRefusal,
  type FerretId,
  type DeliveryOutcome,
  HARNESS_STOP_KEYS,
  type QueueOutcome,
  type RunnerComposerCleared,
  type RunnerComposerSubmitted,
  type RunnerHeldAt,
  type RunnerPaneObservation,
  type Runner,
  type RunnerDelivery,
  type RunnerDeliveryFailure,
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
import { sessionTarget } from '../../lib/tmux/address.ts';
import { maskedScreen } from '../../lib/tmux/screen-mask.ts';
import { killSessionArguments, paneActivityFormat, remainOnExitArguments } from '../../lib/tmux/commands.ts';
import type { TmuxCommandPort, TmuxCommandResult } from '../../lib/tmux/contracts.ts';
import { TmuxController } from '../../lib/tmux/controller.ts';
import { isTmuxServerAbsent } from '../../lib/tmux/server-absent.ts';
import { scriptLine } from '../../lib/tmux/script.ts';
import { guardedWriteArguments, GUARD_REFUSED } from '../../lib/tmux/write-guard.ts';
import { TERMINAL_TMUX_PREFIX } from '../../lib/terminal/runtime-policy.ts';
import { LaunchGuardRefusal, RealHarnessRefusedError, type TmuxLaunchGuard } from '../../lib/tmux/harness-guard.ts';
import { TMUX_PROGRAM } from './kernel-tmux-process.ts';
import { captureFrame, ComposerUnconfirmedError, type DeliverySleep } from './composer-fill.ts';
import {
  type CapturedFrame,
  capturedFrameIsCurrent,
  paneShowsActiveWork,
  paneStateFrom,
  parsePaneActivity,
} from '../../lib/tmux/pane.ts';
import { type FrameDigest, turnLookOf } from '../../lib/tmux/turn-look.ts';
import {
  PaneDeliveryError,
  type PaneNotReadyCause,
  PaneNotReadyError,
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

/** What tmux is asked about a pane: id, process, dead, the session holding it, and when that session began. */
const PANE_FACTS = '#{pane_id}|#{pane_pid}|#{pane_dead}|#{session_name}|#{session_created}';
const DELIVERY_FACTS = `${PANE_FACTS}|#{pane_current_command}|#{cursor_y}`;
/** The only tmux commands a startup wait may run: questions about the pane. Anything else is refused before tmux. */
const STARTUP_READS: ReadonlySet<string> = new Set(['has-session', 'display-message', 'capture-pane']);

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

/** Whether a tmux session is a ferret's: `fy-…`, and not one of Terminals' own shells (`fy-webterm-…`). */
function isFerretSession(session: string): boolean {
  return session.startsWith(FERRET_TMUX_PREFIX) && !session.startsWith(TERMINAL_TMUX_PREFIX);
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
  /** Where a refused launch is said. */
  readonly log?: Pick<Log, 'warn'>;
  /**
   * The turn watch's read (`Runner.look`, U4): every look is an act on the pane (`kernel.act(terminal %n, 'read')`, so a
   * hold refuses it), its screen masked inside one `Redaction.read` before it is parsed. Absent: `look` answers nothing.
   */
  readonly look?: { readonly act: ActRunner; readonly redaction: Redaction; readonly digest: FrameDigest };
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

  async alive(handle: RunnerHandle): Promise<boolean> {
    if (!PANE_ID.test(handle)) return false;
    const facts = await this.facts(handle);
    return facts !== undefined && !facts.dead;
  }

  /**
   * Whether the ferret's own tmux session is PROVEN not there (W2-a, today's `TmuxSessionExitObserver.exitOf` `gone`):
   * tmux answers that it cannot find the session, or that the private server is not running (which takes every pane
   * with it). Asked by the ferret's session name, never by the handle: pane ids start again when the server does, so a
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
    const present = await this.options.tmux.execute(['has-session', '-t', session]).catch(() => undefined);
    if (present === undefined || present.code === 0) return false;
    return /can't find session/iu.test(present.stderr) || isTmuxServerAbsent(present.stderr);
  }

  async deliver(handle: RunnerHandle, delivery: RunnerDelivery): Promise<DeliveryOutcome> {
    const pane = await this.guardedPane(handle);
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
  async queue(handle: RunnerHandle, text: string): Promise<QueueOutcome> {
    const pane = await this.guardedPane(handle);
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
  async stopTurn(handle: RunnerHandle, stop: RunnerStop): Promise<RunnerStopOutcome> {
    // Closed by the contract's type; refused here as well, so no caller can make this press another key.
    if (!STOP_KEYS.has(stop.key)) throw new PaneDeliveryError('that is not a harness stop key');
    const pane = await this.guardedPane(handle);
    const tmux = new TmuxController(pane.port);
    try {
      const before = await captureFrame(tmux, pane.session).catch(() => undefined);
      if (before === undefined || !before.alive || before.dead)
        throw new PaneNotReadyError('the ferret pane is no longer live', 'exited');
      const working = paneShowsActiveWork(before.visible);
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
  async settled(handle: RunnerHandle): Promise<'settled' | 'timed-out'> {
    const pane = await this.guardedPane(handle);
    const reading: TmuxCommandPort = {
      execute: async (args, stdin) =>
        STARTUP_READS.has(args[0] ?? '')
          ? await pane.port.execute(args, stdin)
          : { code: 1, stdout: '', stderr: 'a startup wait writes nothing' },
    };
    return await new TmuxPaneDelivery(new TmuxController(reading), pane.sleep).waitStartupSettled(pane.session);
  }

  /**
   * Today's `PaneScreenReader.text`: the visible screen of the ferret pane behind `handle`, dead or alive, for its
   * harness to explain a failed start. Only a ferret's own pane is read (a person's shell answers `''`), only by its
   * exact id, and nothing is written. The text goes to the caller and is never logged here.
   */
  async lastScreen(handle: RunnerHandle): Promise<string> {
    if (!PANE_ID.test(handle)) return '';
    const facts = await this.facts(handle);
    if (facts === undefined || !isFerretSession(facts.session)) return '';
    const captured = await this.options.tmux.execute(['capture-pane', '-p', '-t', handle]);
    return captured.code === 0 ? captured.stdout : '';
  }

  /**
   * ONE read-only binding of the exact live ferret pane behind `handle` for a read: only questions reach tmux (anything
   * else is refused before it), and every read re-proves the pane is the one first seen. Not an act, like `settled`'s.
   */
  private async readingPane(
    handle: RunnerHandle,
  ): Promise<{ readonly tmux: TmuxController; readonly session: string }> {
    const pane = await this.guardedPane(handle);
    const reading: TmuxCommandPort = {
      execute: async (args, stdin) =>
        STARTUP_READS.has(args[0] ?? '')
          ? await pane.port.execute(args, stdin)
          : { code: 1, stdout: '', stderr: 'a pane read writes nothing' },
    };
    return { tmux: new TmuxController(reading), session: pane.session };
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
  async observe(handle: RunnerHandle): Promise<RunnerPaneObservation | undefined> {
    try {
      const { tmux, session } = await this.readingPane(handle);
      return await this.maskedObservation(await new ComposerActs(tmux, session, noSleep).observe());
    } catch {
      return undefined;
    }
  }

  /** Today's `TmuxSendTerminal.heldAt`: rejects when the pane cannot be read (an unread pane proves nothing). */
  async heldAt(handle: RunnerHandle, text: string): Promise<RunnerHeldAt | undefined> {
    const { tmux, session } = await this.readingPane(handle);
    return await new ComposerActs(tmux, session, noSleep).heldAt(text);
  }

  /** Today's `TmuxSendTerminal.clearComposer`, every `C-u` through the guarded binding (`kernel.act` on the pane). */
  async clearComposer(handle: RunnerHandle, text: string): Promise<RunnerComposerCleared> {
    const pane = await this.guardedPane(handle);
    try {
      return await new ComposerActs(new TmuxController(pane.port), pane.session, pane.sleep).clearComposer(text);
    } catch (error) {
      throw typedNotLost(error, { ...pane.written(), typings: 0 });
    }
  }

  /** Today's `TmuxSendTerminal.submitComposer`: one Enter through the guarded binding. */
  async submitComposer(handle: RunnerHandle, text: string, strict = false): Promise<RunnerComposerSubmitted> {
    const pane = await this.guardedPane(handle);
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
  async stopActiveTurn(handle: RunnerHandle, stop: RunnerStop): Promise<RunnerPaneObservation | undefined> {
    const stopped = await this.stopTurn(handle, stop);
    if (!stopped.pressed) return await this.observe(handle);
    const pane = await this.guardedPane(handle).catch(() => undefined);
    if (pane !== undefined)
      await new TmuxPaneDelivery(new TmuxController(pane.port), pane.sleep)
        .waitReady(pane.session)
        .catch(() => undefined);
    return await this.observe(handle);
  }
  /**
   * One look at the live ferret pane behind `handle` for the turn watch (`Runner.look`): the activity stamp, the screen
   * captured again only when it may have changed (re-proving then that the pane is still a live ferret's own), masked
   * by `maskedScreen` (a value wrapped at the pane's edge, or broken by the harness UI inside its indent or box,
   * included) and only then parsed. Everything inside ONE act on the pane: a hold refuses the whole read and nothing is captured. Total: a
   * pane that is gone, dead, not a ferret's, unreadable or held answers `undefined`. Never writes.
   */
  async look(handle: RunnerHandle): Promise<RunnerLook | undefined> {
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
        if (frame === undefined || !capturedFrameIsCurrent(frame, activity)) {
          // A fresh capture re-proves the pane is a live ferret's own: a person's shell is never read.
          const facts = await this.facts(handle);
          if (facts === undefined || facts.dead || !isFerretSession(facts.session)) {
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
        return await watch.redaction.read(scope => ({
          kind: 'content' as const,
          data: turnLookOf(paneStateFrom(activity, maskedScreen(scope, visible)), watch.digest) as never,
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
  private async guardedPane(handle: RunnerHandle): Promise<{
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
      original.command === undefined ||
      original.cursorRow === undefined
    )
      throw gone();
    const guard = this.options.delivery;
    // No act runner bound: nothing may write here (fail closed), said as the kernel's own code for it.
    if (guard === undefined) throw new PaneHeldError('holds_unavailable');
    const command = original.command;
    let observed = original;
    let typings = 0;
    let refused: RefusalCode | undefined;
    let blocked: BindingBlock | undefined;
    /** After the server's guard refused a write: `moved` when only the cursor row differs from the bound pane. */
    const whyRefused = async (): Promise<BindingBlock> => {
      const now = await this.facts(handle, true).catch(() => undefined);
      return now !== undefined && sameBinding(now, original) ? 'moved' : 'gone';
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
          if (current === undefined || !sameBinding(current, original)) {
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
              command,
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

  async stop(handle: RunnerHandle, how: 'polite' | 'now'): Promise<void> {
    if (!PANE_ID.test(handle)) return;
    // Any stop forgets the pane text kept for the look: a polite one only interrupts, but the pane text is not kept.
    // Forgotten again as it ends, so no look that overlaps the stop keeps any (`#stopEpoch`).
    this.#frames.delete(handle);
    try {
      const facts = await this.facts(handle);
      if (facts === undefined) return;
      if (how === 'polite' && !facts.dead) {
        // The harness's own interrupt first; the session goes once the pane is dead or the caller asks again `now`.
        await this.options.tmux.execute(['send-keys', '-t', handle, 'C-c']);
        return;
      }
      // Only a ferret's session is ever killed through a handle: a pane id of a person's shell is not ours to end.
      if (isFerretSession(facts.session)) await this.options.tmux.execute(killSessionArguments(facts.session));
    } finally {
      this.#stopEpoch += 1;
      this.#frames.delete(handle);
    }
  }

  async signal(handle: RunnerHandle, signal: 'interrupt' | 'terminate'): Promise<void> {
    if (!PANE_ID.test(handle)) return;
    const facts = await this.facts(handle);
    if (facts === undefined || facts.dead || !isFerretSession(facts.session)) return;
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
      await this.options.launchGuard?.check({ session, cwd: spec.cwd, command: [program, ...args], envNames: names });
    } catch (error) {
      if (!(error instanceof LaunchGuardRefusal)) throw error;
      this.options.log?.warn(error.message, {
        ferret: spec.ferret,
        ...(error instanceof RealHarnessRefusedError ? { harness: error.harness } : {}),
      });
      return err('real_harness');
    }
    if ((await this.options.tmux.execute(['has-session', '-t', session])).code === 0) return err('failed');
    // Started without the handle, so the server never holds a ferret's values in its own environment.
    if ((await this.options.tmux.execute(['start-server'])).code !== 0) return err('unavailable');
    const before = await this.options.tmux.execute(['show-options', '-gv', 'update-environment']);
    if (before.code !== 0) return err('unavailable');
    const kept = before.stdout
      .split(/\s+/u)
      .map(name => name.trim())
      .filter(name => name !== '');
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
        spec.cwd,
        '--',
        program,
        ...args,
      ]),
      scriptLine(['set-option', '-g', 'update-environment', kept.join(' ')]),
    ].join('');
    const created = await this.options.spawn.run(
      TMUX_PROGRAM,
      ['-u', '-S', this.options.socketPath, 'source-file', '-'],
      { stdin: script, env: spec.env, cwd: spec.cwd, forFerret: spec.ferret },
    );
    const [paneId = '', pid = ''] = created.stdout.trim().split('|');
    if (created.exitCode !== 0 || !PANE_ID.test(paneId)) {
      // Whatever the script did, the option is put back from a client that holds no values.
      await this.options.tmux.execute(['set-option', '-g', 'update-environment', kept.join(' ')]);
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
