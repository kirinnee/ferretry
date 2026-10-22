/**
 * Getting a message into a busy pane's own queue, and knowing it is being held.
 *
 * This is the IO half of `lib/tmux/queue.ts`: it captures frames, sends keys and sleeps between
 * observations, while every judgement about what a frame MEANS is made in the domain module.
 *
 * The composer is filled through the SAME evidence loop the delivery adapter uses, because the two
 * share the only hard part — proving text actually landed in a TUI that may be repainting. What
 * differs is everything after the fill: this path wants the payload to turn up in the harness's own
 * queue, and says so only when the pane shows it there.
 */

import { type LandingEvidence, needsQueueKey, queuedWhere, type TmuxController } from '../../lib/tmux/index.ts';
import { captureFrame, type DeliverySleep, fillComposer } from './composer-fill.ts';

export interface PaneQueueOptions {
  /** Times the composer may be filled from scratch. */
  readonly composerAttempts?: number;
  /** How long a fill looks for its payload when the pane draws promptly. */
  readonly windowMs?: number;
  /** The longest a fill looks for its payload, reached only by a pane that draws late or not at all. */
  readonly stalledWindowMs?: number;
  /** How long past the pane's first repaint a fill keeps looking. */
  readonly settleMs?: number;
  /** How long to wait between observations. */
  readonly pollMs?: number;
  /** How long to let the submit key take effect before looking for the queue hint. */
  readonly submitSettleMs?: number;
  /** How long to let the queue key take effect before the final proof. */
  readonly queueKeySettleMs?: number;
}

const DEFAULTS = {
  composerAttempts: 2,
  windowMs: 6_000,
  stalledWindowMs: 12_000,
  settleMs: 2_000,
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

/**
 * What a busy-pane transport proved.
 *
 * `held` — the harness shows it in its own queue. `typed` — it is still in the composer after the
 * submit and queue keys, which a TUI will NOT send on its own when the turn ends. `left` — it left
 * the composer and no queue shows it: the keys were taken, and only the transcript can say where to.
 * That is the ordinary answer from Codex 0.163, whose Enter mid-turn steers the message straight
 * into the running turn (measured), and from a pane that went idle between the fill and the submit —
 * in both the message was submitted, so failing the send would report a delivered message as lost.
 */
export type PaneQueueOutcome = 'held' | 'typed' | 'left';

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
   * Put `text` into the pane's queue and report what the pane proves about it.
   *
   * The proof at the end is not optional politeness. Without it a submit that landed on a prompt that
   * had just gone idle would be reported as `queued`, and the caller would wait at a turn boundary
   * for a message the harness consumed seconds earlier.
   */
  async queue(session: string, text: string): Promise<PaneQueueOutcome> {
    const evidence = await this.fill(session, text);
    const submitted = await this.tmux.sendKey(session, 'Enter').then(
      () => true,
      () => false,
    );
    if (!submitted) throw new PaneQueueError(`tmux could not submit into the queue of session ${session}`);
    await this.sleep(this.settings.submitSettleMs);
    let frame = await captureFrame(this.tmux, session);
    if (needsQueueKey(frame, text, evidence)) {
      await this.tmux.sendKey(session, 'Tab');
      await this.sleep(this.settings.queueKeySettleMs);
      frame = await captureFrame(this.tmux, session);
    }
    const where = queuedWhere(frame, text, evidence);
    if (where === 'queue') return 'held';
    return where === 'composer' ? 'typed' : 'left';
  }

  private async fill(session: string, text: string): Promise<LandingEvidence> {
    return await fillComposer(this.tmux, this.sleep, this.settings, session, text);
  }
}
