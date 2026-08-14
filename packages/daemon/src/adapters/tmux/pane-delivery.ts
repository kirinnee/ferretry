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
 * times and only ever RE-filled when nothing landed. Once landing is proven, Enter may be pressed
 * again, but the text is never typed again — the harness may have consumed it and performed a side
 * effect even when no turn started.
 */

import {
  classifySubmit,
  composerEvidence,
  composerTransport,
  landingEvidence,
  nextReadinessStep,
  retryDelays,
  type DeliveryFrame,
  type InjectionOutcome,
  type LandingEvidence,
  type StartupDialogAction,
  type StartupDialogOptions,
  type TmuxController,
} from '../../lib/tmux/index.ts';

/** Waiting is a capability, not a decision: the composition root owns how this process sleeps. */
export type DeliverySleep = (milliseconds: number) => Promise<void>;

export interface PaneDeliveryOptions {
  /** Frames to look at while waiting for a prompt before giving up. */
  readonly readinessAttempts?: number;
  /** How long to let a dialog's keys take effect before looking again. */
  readonly dialogSettleMs?: number;
  /** Times the composer may be filled from scratch. */
  readonly composerAttempts?: number;
  /** Frames to look at for landing evidence after each fill. */
  readonly composerPolls?: number;
  /** Times Enter may be pressed for one proven payload. */
  readonly submitAttempts?: number;
  /** Frames to look at after each Enter. */
  readonly submitPolls?: number;
  /** How long to wait between composer and submit observations. */
  readonly pollMs?: number;
}

const DEFAULTS = {
  readinessAttempts: 30,
  dialogSettleMs: 750,
  composerAttempts: 3,
  composerPolls: 6,
  submitAttempts: 3,
  submitPolls: 12,
  pollMs: 250,
} as const;

/** A payload could not be delivered, and the message says which half failed. */
export class PaneDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaneDeliveryError';
  }
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
  async waitReady(session: string, options: StartupDialogOptions = {}): Promise<void> {
    const attemptsByKind = new Map<StartupDialogAction['kind'], number>();
    // Backoff rather than a fixed interval: a harness that is slow to draw is usually slow because
    // the box is loaded, and polling it hardest exactly then is the wrong shape.
    const delays = retryDelays(this.settings.readinessAttempts);
    for (let attempt = 0; attempt < delays.length; ) {
      const step = nextReadinessStep(await this.frame(session), attemptsByKind, options);
      if (step.kind === 'ready') return;
      if (step.kind === 'exited' || step.kind === 'stuck')
        throw new PaneDeliveryError(`${step.reason}; tmux session ${session}`);
      if (step.kind === 'answer_dialog') {
        attemptsByKind.set(step.action.kind, step.attempt);
        for (const key of step.action.keys) await this.tmux.sendKey(session, key);
        await this.sleep(this.settings.dialogSettleMs);
        continue;
      }
      await this.sleep(delays[attempt]!);
      attempt++;
    }
    throw new PaneDeliveryError(`tmux session ${session} did not become ready to accept a turn`);
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
    const evidence = await this.fill(session, text);
    return await this.submit(session, text, evidence);
  }

  /** One capture, shaped the way the decision layer reads a pane. */
  private async frame(session: string): Promise<DeliveryFrame> {
    const state = await this.tmux.state(session);
    return {
      alive: state.alive,
      dead: state.dead,
      promptReady: state.promptReady,
      visible: state.visible,
      ...(state.exitCode === undefined ? {} : { exitCode: state.exitCode }),
    };
  }

  /**
   * Fill the composer and return the evidence that proved it.
   *
   * The composer is cleared before a RETRY only, and only on the path where nothing landed — the
   * placeholder guard below returns first otherwise, so clearing can never destroy a paste the
   * harness already took.
   */
  private async fill(session: string, text: string): Promise<LandingEvidence> {
    for (let attempt = 0; attempt < this.settings.composerAttempts; attempt++) {
      if (attempt > 0) {
        await this.tmux.sendKey(session, 'C-u');
        await this.sleep(this.settings.pollMs);
      }
      const before = composerEvidence(await this.tmux.capture(session, false), text);
      if (composerTransport(text) === 'paste') await this.tmux.paste(session, text);
      else await this.tmux.sendLiteral(session, text);
      for (let poll = 0; poll < this.settings.composerPolls; poll++) {
        await this.sleep(this.settings.pollMs);
        const proved = landingEvidence(before, composerEvidence(await this.tmux.capture(session, false), text));
        if (proved !== undefined) return proved;
      }
      // No NEW evidence, but a placeholder is nonetheless sitting in the composer: a paste of ours is
      // in there (a repaint can hide the counter bump, and re-pasting identical text may not move it).
      // Submitting that is correct; retyping would duplicate or destroy it.
      if (composerEvidence(await this.tmux.capture(session, false), text).placeholders > 0) return 'placeholder';
    }
    throw new PaneDeliveryError(`the turn did not land in the composer of tmux session ${session}`);
  }

  /**
   * Press Enter until the payload has demonstrably left the composer.
   *
   * Enter can be swallowed by a repaint, so it is safe to press again — but ONLY while the original
   * payload is still visibly there. Once it is gone, delivery is final.
   */
  private async submit(session: string, text: string, evidence: LandingEvidence): Promise<InjectionOutcome> {
    for (let attempt = 0; attempt < this.settings.submitAttempts; attempt++) {
      await this.tmux.sendKey(session, 'Enter');
      for (let poll = 0; poll < this.settings.submitPolls; poll++) {
        await this.sleep(this.settings.pollMs);
        const step = classifySubmit(await this.frame(session), text, evidence);
        if (step.kind === 'delivered') return step.outcome;
      }
    }
    throw new PaneDeliveryError(`the turn landed but stayed in the composer of tmux session ${session}`);
  }
}
