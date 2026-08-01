/**
 * Getting a message into a busy pane's own queue, and knowing it is being held.
 *
 * This is the IO half of `lib/tmux/queue.ts`: it captures frames, sends keys and sleeps between
 * observations, while every judgement about what a frame MEANS is made in the domain module.
 *
 * The composer is filled through the SAME evidence loop the delivery adapter uses, because the two
 * share the only hard part — proving text actually landed in a TUI that may be repainting. What
 * differs is everything after the fill: this path wants the payload to STAY visible.
 */

import {
  composerEvidence,
  composerTransport,
  landingEvidence,
  needsQueueKey,
  queueAccepted,
  type LandingEvidence,
  type TmuxController,
} from '../../lib/tmux/index.ts';
import type { DeliverySleep } from './pane-delivery.ts';

export interface PaneQueueOptions {
  /** Times the composer may be filled from scratch. */
  readonly composerAttempts?: number;
  /** Frames to look at after each fill. */
  readonly composerPolls?: number;
  /** How long to wait between observations. */
  readonly pollMs?: number;
  /** How long to let the submit key take effect before looking for the queue hint. */
  readonly submitSettleMs?: number;
  /** How long to let the queue key take effect before the final proof. */
  readonly queueKeySettleMs?: number;
}

const DEFAULTS = {
  composerAttempts: 3,
  composerPolls: 6,
  pollMs: 250,
  submitSettleMs: 500,
  queueKeySettleMs: 300,
} as const;

/** A message could not be put into the pane's queue, and the message says which half failed. */
export class PaneQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaneQueueError';
  }
}

export class TmuxPaneQueue {
  private readonly settings: Required<PaneQueueOptions>;

  constructor(
    private readonly tmux: TmuxController,
    private readonly sleep: DeliverySleep,
    options: PaneQueueOptions = {},
  ) {
    this.settings = { ...DEFAULTS, ...options };
  }

  /**
   * Put `text` into the pane's queue and prove it is being held.
   *
   * The proof at the end is not optional politeness. Without it a submit that landed on a prompt that
   * had just gone idle would be reported as `queued`, and the caller would wait at a turn boundary
   * for a message the harness consumed — or dropped — seconds earlier.
   */
  async queue(session: string, text: string): Promise<void> {
    const evidence = await this.fill(session, text);
    const submitted = await this.tmux.sendKey(session, 'Enter').then(
      () => true,
      () => false,
    );
    if (!submitted) throw new PaneQueueError(`tmux could not submit into the queue of session ${session}`);
    await this.sleep(this.settings.submitSettleMs);
    if (needsQueueKey(await this.tmux.capture(session, false), text, evidence)) {
      await this.tmux.sendKey(session, 'Tab');
      await this.sleep(this.settings.queueKeySettleMs);
    }
    if (queueAccepted(await this.tmux.capture(session, false), text, evidence)) return;
    throw new PaneQueueError(
      `the message left the composer of tmux session ${session} without queue evidence; ` +
        'the pane may have gone idle mid-type',
    );
  }

  /**
   * Fill the composer and return the evidence that proved it.
   *
   * The composer is cleared before a RETRY only, and only where nothing landed: clearing a paste the
   * harness has already taken would destroy a message that is on its way.
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
      // No NEW evidence, but a placeholder is nonetheless in the composer: a paste of ours is in
      // there, and a repaint can hide the counter bump. Submitting that is right; retyping would
      // duplicate it.
      if (composerEvidence(await this.tmux.capture(session, false), text).placeholders > 0) return 'placeholder';
    }
    throw new PaneQueueError(`the message did not land in the composer of tmux session ${session}`);
  }
}
