/**
 * Getting a turn into a pane, and knowing it arrived.
 *
 * This is the IO half of `lib/tmux/delivery.ts`: it captures frames, sends keys, and sleeps between
 * attempts, but every judgement about what a frame MEANS is made in the domain module. Both the
 * launch path and the revive path used to carry their own copy of this loop, and both copies did the
 * same two unsafe things — they sent a multi-line turn brief as literal keystrokes, and they pressed
 * Enter without ever checking the payload had reached the composer.
 *
 * The invariant that governs the retry structure: the composer is filled at most `composerAttempts`
 * times, each time only into a composer a fresh frame proves EMPTY after a pane that visibly drew (see
 * `fillComposer`). Once landing is proven, Enter may be pressed again, but the text is never typed
 * again — the harness may have consumed it and performed a side effect even when no turn started.
 */

import {
  classifySubmit,
  composerHoldsOtherText,
  composerInput,
  countlessPasteOf,
  draftBlockingReadiness,
  frameCursor,
  type InjectionOutcome,
  nextReadinessStep,
  paneBlockingDialog,
  paneBlockingPermission,
  paneBlockingPrompt,
  paneResponded,
  readComposer,
  retryDelays,
  startupSettleStep,
  type StartupDialogAction,
  type StartupDialogOptions,
  type TmuxController,
} from '../../lib/tmux/index.ts';
import {
  ComposerOccupiedError,
  ComposerUnconfirmedError,
  captureFrame,
  type DeliverySleep,
  type ComposerLanding,
  fillComposerLanding,
} from './composer-fill.ts';

export interface PaneDeliveryOptions {
  /** Frames to look at while waiting for a prompt before giving up. */
  readonly readinessAttempts?: number;
  /** How long to let a dialog's keys take effect before looking again. */
  readonly dialogSettleMs?: number;
  /** Times the composer may be filled from scratch. */
  readonly composerAttempts?: number;
  /** How long a fill looks for its payload when the pane draws promptly. */
  readonly windowMs?: number;
  /** The longest a fill looks for its payload, reached only by a pane that draws late or not at all. */
  readonly stalledWindowMs?: number;
  /** How long past the pane's first repaint a fill keeps looking. */
  readonly settleMs?: number;
  /** Times Enter may be pressed for one proven payload. */
  readonly submitAttempts?: number;
  /** Frames to look at after each Enter. */
  readonly submitPolls?: number;
  /** How long to wait between composer and submit observations. */
  readonly pollMs?: number;
  /**
   * The longest `waitStartupSettled` watches a parked first turn, counted in `pollMs` steps. Past it the
   * wait ends without failing, answering `timed-out`: a harness that is merely slow is not a failed start.
   */
  readonly startupSettleMs?: number;
}

const DEFAULTS = {
  readinessAttempts: 30,
  dialogSettleMs: 750,
  // One: after a typing, only a PERSON (a forced retry) types the same send into this pane again —
  // the owner's Mac showed one message typed three times by fills that each read the composer empty
  // over Claude's ghost suggestion while the stalled pane had not yet read the keys.
  composerAttempts: 1,
  windowMs: 6_000,
  stalledWindowMs: 12_000,
  settleMs: 2_000,
  submitAttempts: 3,
  submitPolls: 12,
  pollMs: 250,
  startupSettleMs: 30_000,
} as const;

/** A payload could not be delivered, and the message says which half failed. */
export class PaneDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaneDeliveryError';
  }
}

/**
 * The pane never came to a prompt, so NOTHING OF THE PAYLOAD WAS TYPED: every way `waitReady` gives up.
 *
 * Its own type because a send must tell it from a failure after the keys (&B153). A send whose session record
 * said idle while its agent was still mid-turn waited here half a minute and threw a plain delivery error; the
 * send path could not tell "no key went" from "keys went somewhere", so it left the message `typing` behind a
 * row nothing ever looked at again, and eleven queues stalled for up to six hours. Keys a startup dialog's
 * known answer needed may have been pressed on the way, but never a character of the payload.
 */
export class PaneNotReadyError extends PaneDeliveryError {
  constructor(
    message: string,
    /** What the pane was doing instead: still at work, behind a dialog, or gone. */
    readonly why: PaneNotReadyCause,
  ) {
    super(message);
    this.name = 'PaneNotReadyError';
  }
}

/** Why a pane never came to a prompt. */
export type PaneNotReadyCause = 'busy' | 'dialog' | 'exited';

/**
 * The pane died while `waitStartupSettled` was watching it. `parked` is whether a frame showed the first turn
 * parked behind the harness's startup before it died: only then is the turn known never to have run.
 */
export class PaneStartupExitedError extends PaneDeliveryError {
  constructor(
    message: string,
    readonly parked: boolean,
  ) {
    super(message);
    this.name = 'PaneStartupExitedError';
  }
}

/**
 * The payload is in the composer and every bounded Enter left it there: typed, and not sent.
 *
 * Its own type because the remedy is different from every other failure: nothing needs retyping, and
 * retyping would put a second copy beside the first. The text is still on the agent's screen, where a
 * single Enter — or a cancel that clears it — finishes the job.
 */
export class PaneStrandedError extends PaneDeliveryError {
  constructor(message: string) {
    super(message);
    this.name = 'PaneStrandedError';
  }
}

/** Whether a frame shows a prompt, permission request or dialog that would take an Enter as its answer. */
export function blockedByDialog(visible: string): boolean {
  return (
    paneBlockingPrompt(visible) !== undefined ||
    paneBlockingPermission(visible) !== undefined ||
    paneBlockingDialog(visible) !== undefined
  );
}

export class TmuxPaneDelivery {
  private readonly settings: Required<PaneDeliveryOptions>;

  constructor(
    private readonly tmux: TmuxController,
    private readonly sleep: DeliverySleep,
    options: PaneDeliveryOptions = {},
  ) {
    this.settings = { ...DEFAULTS, ...options };
  }

  /**
   * Wait until the pane will accept input, answering the startup dialogs whose affirmative path is
   * known along the way.
   *
   * Answering a dialog does not consume a readiness attempt: clearing a trust prompt is progress,
   * and charging it against the budget meant a fresh install could run out of attempts before the
   * harness had even drawn its prompt.
   */
  // read-scoped: none — it reads the pane only to decide readiness; no pane text leaves it or is kept
  async waitReady(session: string, options: StartupDialogOptions = {}): Promise<void> {
    const attemptsByKind = new Map<StartupDialogAction['kind'], number>();
    // Backoff rather than a fixed interval: a harness that is slow to draw is usually slow because
    // the box is loaded, and polling it hardest exactly then is the wrong shape.
    const delays = retryDelays(this.settings.readinessAttempts);
    let blocked: string | undefined;
    let occupied = 0;
    for (let attempt = 0; attempt < delays.length; ) {
      const frame = await captureFrame(this.tmux, session);
      blocked =
        paneBlockingPrompt(frame.visible) ?? paneBlockingPermission(frame.visible) ?? paneBlockingDialog(frame.visible);
      const step = nextReadinessStep(frame, attemptsByKind, options);
      if (step.kind === 'ready') return;
      if (step.kind === 'exited' || step.kind === 'stuck')
        throw new PaneNotReadyError(
          `${step.reason}; tmux session ${session}`,
          step.kind === 'exited' ? 'exited' : 'dialog',
        );
      // A composer holding typed input will never become ready by waiting, and the wait is long. Two
      // frames in a row, so a repaint caught halfway through clearing a submit is not mistaken for one.
      // Text parked behind Codex's startup wait is not a draft: Codex accepted it, so just keep waiting.
      const draft = step.kind === 'wait' ? draftBlockingReadiness(frame) : undefined;
      occupied = draft === undefined ? 0 : occupied + 1;
      if (draft !== undefined && occupied >= 2)
        throw new ComposerOccupiedError(
          `the composer of tmux session ${session} already holds unsent text; nothing was typed`,
          draft,
        );
      if (step.kind === 'answer_dialog') {
        attemptsByKind.set(step.action.kind, step.attempt);
        for (const key of step.action.keys) await this.tmux.sendKey(session, key);
        await this.sleep(this.settings.dialogSettleMs);
        continue;
      }
      await this.sleep(delays[attempt]!);
      attempt++;
    }
    // Name the dialog when one is why: "not ready" sent the reader to the transcript, which was fine.
    throw new PaneNotReadyError(
      blocked === undefined
        ? `tmux session ${session} did not become ready to accept a turn`
        : `tmux session ${session} is blocked by a prompt on screen: "${blocked}" — answer it in the terminal`,
      blocked === undefined ? 'busy' : 'dialog',
    );
  }

  /**
   * Put `text` in the composer, prove it is there, and submit it.
   *
   * The caller gets back which kind of delivery happened, because a slash command the TUI handles
   * itself is a success with no turn behind it.
   */
  async deliver(
    session: string,
    text: string,
    options: StartupDialogOptions = {},
    beforeWrite?: () => Promise<void>,
  ): Promise<InjectionOutcome> {
    await this.waitReady(session, options);
    await beforeWrite?.();
    const landing = await this.fill(session, text);
    return await this.submit(session, text, landing);
  }

  /**
   * Wait, boundedly, until the harness has finished its OWN startup after a first turn was delivered.
   *
   * Codex 0.166 takes a submission before its startup ends and parks it under `Waiting for startup`
   * (`paneShowsStartupWait`), so delivery is already proven while the harness is not yet running. Any
   * other pane answers on the first frame. A pane that dies meanwhile fails the wait with the harness's
   * own exit reason (a `PaneStartupExitedError` saying whether the park was seen first), so the start reports it instead of a session that dies later; a bound that passes
   * answers `timed-out` rather than failing, because a slow harness is not a failed one and the caller
   * must not mistake the bound for a measured startup time.
   */
  // read-scoped: none — it reads the pane only to decide whether startup settled; no pane text leaves it
  async waitStartupSettled(session: string): Promise<'settled' | 'timed-out'> {
    // A step below one millisecond would never advance `waited`, so the bound could not end the loop.
    const step = Math.max(1, this.settings.pollMs);
    let parked = false;
    for (let waited = 0; ; waited += step) {
      const frame = startupSettleStep(await captureFrame(this.tmux, session));
      if (frame.kind === 'settled') return 'settled';
      if (frame.kind === 'exited') throw new PaneStartupExitedError(`${frame.reason}; tmux session ${session}`, parked);
      parked = true;
      if (waited >= this.settings.startupSettleMs) return 'timed-out';
      await this.sleep(step);
    }
  }

  private async fill(session: string, text: string): Promise<ComposerLanding> {
    return await fillComposerLanding(this.tmux, this.sleep, this.settings, session, text);
  }

  /**
   * Press Enter until the payload has demonstrably left the composer.
   *
   * Enter can be swallowed by a repaint, so it is safe to press again — but ONLY while the original
   * payload is still visibly there. Once it is gone, delivery is final.
   *
   * A pane that has drawn NOTHING since an Enter has not read it yet: its frame still shows the payload
   * because it is stalled, not because the key was lost. Such a pane is watched up to the stalled
   * window before the next Enter, which would otherwise only queue behind the first and spend the
   * bounded attempts on a pane that was always going to submit.
   */
  private async submit(session: string, text: string, landing: ComposerLanding): Promise<InjectionOutcome> {
    // &B153: a countless chip (`[Pasted text #30]`) is pressed only when it carries the counter the fill read off the
    // very frame that proved its own paste landed: a person who cleared ours and pasted their own line draws a new one.
    const { evidence, chip: ownChip } = landing;
    for (let attempt = 0; attempt < this.settings.submitAttempts; attempt++) {
      const before = await captureFrame(this.tmux, session);
      // &B153: a prompt, permission request or dialog that came up after the fill takes Enter as its answer — a
      // background agent's permission prompt was up beside marge's turn on 2026-11-06. Nothing is pressed; the send
      // is typed and unconfirmed, and the stranded-send repair presses only at an undialogued pane.
      if (blockedByDialog(before.visible))
        throw new ComposerUnconfirmedError(
          `the turn was typed into tmux session ${session}, and a prompt came up on screen before Enter; Enter was not pressed`,
          1,
        );
      // A person who typed after the fill shares the composer with the payload now: Enter would submit their
      // words with it. Nothing is pressed; the send is typed and unconfirmed, and never typed again.
      if (composerHoldsOtherText(before.visible, frameCursor(before), text)) {
        const chip =
          evidence === 'placeholder'
            ? countlessPasteOf(composerInput(readComposer(before.visible, frameCursor(before))), text)
            : undefined;
        if (chip === undefined || chip !== ownChip)
          throw new ComposerUnconfirmedError(
            `the turn was typed into tmux session ${session}, and other text joined it in the composer before Enter; Enter was not pressed`,
            1,
          );
      }
      await this.tmux.sendKey(session, 'Enter');
      // Polls counted from the pane's first repaint after this Enter; until then, time against the ceiling.
      let sinceResponse: number | undefined;
      for (
        let waited = 0;
        sinceResponse === undefined
          ? waited < this.settings.stalledWindowMs
          : sinceResponse < this.settings.submitPolls;
      ) {
        await this.sleep(this.settings.pollMs);
        waited += this.settings.pollMs;
        const frame = await captureFrame(this.tmux, session);
        const step = classifySubmit(frame, text, evidence);
        if (step.kind === 'delivered') return step.outcome;
        if (sinceResponse !== undefined) sinceResponse += 1;
        else if (paneResponded(before, frame)) sinceResponse = 1;
      }
    }
    throw new PaneStrandedError(`the turn landed but stayed in the composer of tmux session ${session}`);
  }
}
