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

import {
  composerHoldsOtherText,
  composerInput,
  countlessPasteOf,
  frameCursor,
  needsQueueKey,
  queuedWhere,
  readComposer,
  type TmuxController,
} from '../../lib/tmux/index.ts';
import {
  type ComposerLanding,
  ComposerUnconfirmedError,
  captureFrame,
  type DeliverySleep,
  fillComposerLanding,
} from './composer-fill.ts';
import { blockedByDialog } from './pane-delivery.ts';

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
  // One: after a typing, only a PERSON (a forced retry) types the same send into this pane again —
  // the owner's Mac showed one message typed three times by fills that each read the composer empty.
  composerAttempts: 1,
  windowMs: 6_000,
  stalledWindowMs: 12_000,
  settleMs: 2_000,
  pollMs: 250,
  submitSettleMs: 500,
  queueKeySettleMs: 300,
} as const;

/** A message could not be put into the pane's queue, and the message says which half failed. @pending terminals: GAP(ferrets): the tmux adapter daemon/adapters/tmux/pane-queue.ts is ported and tested but nothing composes it until the Runner queue seam of Ferrets is wired to it (gustavo) */
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
    const { evidence, chip } = await this.fill(session, text);
    // Somebody typed beside the payload after the fill: Enter would queue their words with it (B144).
    const before = await captureFrame(this.tmux, session);
    // &B153: a prompt or dialog that came up after the fill would take Enter as its answer.
    if (blockedByDialog(before.visible))
      throw new ComposerUnconfirmedError(
        `the message was typed into tmux session ${session}, and a prompt came up on screen before Enter; Enter was not pressed`,
        1,
      );
    // &B153: except the countless chip (`[Pasted text #30]`) Claude draws a one-line paste as, carrying the counter the
    // fill read off the very frame that proved its own paste landed in an empty composer — the chip has no count.
    // A person who replaced it draws a new counter.
    const ownChip =
      chip !== undefined &&
      countlessPasteOf(composerInput(readComposer(before.visible, frameCursor(before))), text) === chip;
    if (!ownChip && composerHoldsOtherText(before.visible, frameCursor(before), text))
      throw new ComposerUnconfirmedError(
        `the message was typed into tmux session ${session}, and other text joined it in the composer before Enter; Enter was not pressed`,
        1,
      );
    const submitted = await this.tmux.sendKey(session, 'Enter').then(
      () => true,
      () => false,
    );
    if (!submitted) throw new PaneQueueError(`tmux could not submit into the queue of session ${session}`);
    await this.sleep(this.settings.submitSettleMs);
    let frame = await captureFrame(this.tmux, session);
    // Tab moves a selection in a prompt that came up meanwhile: it is pressed only at an undialogued pane.
    if (needsQueueKey(frame, text, evidence) && !blockedByDialog(frame.visible)) {
      await this.tmux.sendKey(session, 'Tab');
      await this.sleep(this.settings.queueKeySettleMs);
      frame = await captureFrame(this.tmux, session);
    }
    const where = queuedWhere(frame, text, evidence);
    if (where === 'queue') return 'held';
    return where === 'composer' ? 'typed' : 'left';
  }

  private async fill(session: string, text: string): Promise<ComposerLanding> {
    return await fillComposerLanding(this.tmux, this.sleep, this.settings, session, text);
  }
}
