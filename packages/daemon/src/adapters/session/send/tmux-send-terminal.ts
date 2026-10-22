import type {
  ComposerClearOutcome,
  ComposerSubmitOutcome,
  SendHeldAt,
  SendPaneObservation,
  SendQueueOutcome,
  SendTerminal,
} from '../../../lib/session/send/types.ts';
import {
  SendComposerOccupied,
  SendComposerUnreadable,
  SendLandingUnconfirmed,
} from '../../../lib/session/send/types.ts';
import type { SessionId } from '../../../lib/session-id.ts';
import {
  composerInput,
  composerTransport,
  occupiedComposer,
  type PaneHold,
  paneBlockingDialog,
  paneBlockingPermission,
  paneBlockingPrompt,
  paneHoldOf,
  paneShowsActiveWork,
  readComposer,
  showsPayload,
  type TmuxController,
} from '../../../lib/tmux/index.ts';
import {
  ComposerOccupiedError,
  ComposerUnconfirmedError,
  ComposerUnreadableError,
  captureFrame,
  type DeliverySleep,
} from '../../tmux/composer-fill.ts';
import type { TmuxPaneDelivery } from '../../tmux/pane-delivery.ts';
import type { TmuxPaneQueue } from '../../tmux/pane-queue.ts';

/** True while what the composer holds is the start of the payload: what erasing from its end leaves. */
function erasing(shown: string, text: string): boolean {
  const squeeze = (value: string): string => value.normalize('NFC').replace(/\s+/gu, '');
  return squeeze(text).startsWith(squeeze(shown));
}

/** How the composer keys are paced and bounded. */
export interface ComposerKeySettings {
  /**
   * Erase keys allowed beyond the two each line of the payload needs. Every key is verified by a
   * fresh read, so the margin only bounds a composer that stops responding.
   */
  readonly clearMargin: number;
  /** Frames to look at after one Enter before calling the payload still held. */
  readonly submitPolls: number;
  /** How long to let a key take effect before looking again. */
  readonly pollMs: number;
}

const COMPOSER_KEYS: ComposerKeySettings = { clearMargin: 2, submitPolls: 8, pollMs: 250 };

/**
 * The terminal side of a send, over the daemon's own isolated tmux socket.
 *
 * Every address goes through the injected controller, which refuses a bare executable name — so no
 * lookup can land on a tmux server the host already runs, and nothing here can touch a pane this
 * daemon did not create. That matters more on this path than on any other: a send TYPES, and a
 * keystroke sent to somebody else's terminal cannot be taken back.
 *
 * THE STOP KEY IS ESCAPE. It is the safe stop-the-current-turn key in both harness TUIs, while `C-c`
 * is the QUIT path — Codex exits on it at an idle prompt. Exactly one keystroke per call, with no
 * internal retries: a stop that did not take is something the caller re-decides.
 *
 * THE COMPOSER KEYS are `C-u`, which only edits the line being typed, and Enter, which is pressed
 * once and only for a composer holding exactly the payload. Neither is ever sent at a composer whose
 * contents this adapter has not just read and matched.
 */
export class TmuxSendTerminal implements SendTerminal {
  constructor(
    private readonly tmux: TmuxController,
    private readonly session: (id: SessionId) => Promise<string>,
    private readonly delivery: TmuxPaneDelivery,
    private readonly queueDelivery: TmuxPaneQueue,
    private readonly sleep: DeliverySleep,
    private readonly keys: ComposerKeySettings = COMPOSER_KEYS,
  ) {}

  async observe(id: SessionId): Promise<SendPaneObservation> {
    const frame = await captureFrame(this.tmux, await this.session(id));
    const draft = occupiedComposer(frame);
    return {
      alive: frame.alive,
      dead: frame.dead,
      promptReady: frame.promptReady,
      activeWork: paneShowsActiveWork(frame.visible),
      // A permission prompt blocks a send as surely as a dialog: a message typed into its choice list
      // could pick a row.
      blockingPrompt:
        paneBlockingPrompt(frame.visible) ?? paneBlockingPermission(frame.visible) ?? paneBlockingDialog(frame.visible),
      ...(draft === undefined ? {} : { draft }),
    };
  }

  async deliver(id: SessionId, text: string): Promise<void> {
    await this.untyped(async () => await this.delivery.deliver(await this.session(id), text));
  }

  async queue(id: SessionId, text: string): Promise<SendQueueOutcome> {
    const outcome = await this.untyped(async () => await this.queueDelivery.queue(await this.session(id), text));
    return outcome === 'held' ? 'held' : 'unproven';
  }

  /**
   * Where the visible pane holds the payload: typed in the composer, or in the harness's own queue.
   *
   * Read from those two places only. The whole-screen search this replaced answered "still held" for a
   * message whose words were anywhere in view — including the conversation it had already been
   * submitted into — so a row waited on "Sending" for the two-hour ceiling.
   *
   * A queue that runs past the top of the pane THROWS rather than answering "not held": the payload
   * may be in the part that cannot be seen, and "not held" is what licenses typing it again.
   */
  async heldAt(id: SessionId, text: string): Promise<SendHeldAt | undefined> {
    const hold = await this.hold(id, text);
    if (hold === 'unknown')
      throw new Error(
        `the agent's queue in session ${id} runs past what its pane shows, so a held message cannot be ruled out`,
      );
    return hold === 'absent' ? undefined : hold;
  }

  private async hold(id: SessionId, text: string): Promise<PaneHold> {
    const frame = await captureFrame(this.tmux, await this.session(id));
    return paneHoldOf(frame.visible, { x: frame.cursorX, y: frame.cursorY }, text, composerTransport(text) === 'paste');
  }

  /**
   * Erases the payload from the composer, one `C-u` at a time, reading the composer before each key.
   *
   * `C-u` erases to the start of the line; on an already-empty line Codex (0.145–0.163, measured)
   * joins it onto the line above instead, so a draft of N lines takes 2N keys and a draft left with a
   * trailing newline by a swallowed Enter takes two. Claude Code (2.1.281, measured) erases only the
   * WRAPPED ROW the cursor is on, so its budget is counted in the rows the composer draws, not in the
   * payload's lines. `BSpace` is never sent: after such a join it deletes a real character. Between keys the composer must still be the payload or a shrinking
   * prefix of it — the shape erasing from the end leaves — and anything else stops the clear, so a
   * person who typed beside it keeps their draft.
   */
  async clearComposer(id: SessionId, text: string): Promise<ComposerClearOutcome> {
    const session = await this.session(id);
    const paste = composerTransport(text) === 'paste';
    let rounds = 2 * text.split('\n').length + this.keys.clearMargin;
    for (let round = 0; round <= rounds; round += 1) {
      const frame = await captureFrame(this.tmux, session);
      const composer = readComposer(frame.visible, { x: frame.cursorX, y: frame.cursorY });
      if (composer?.placeholder === undefined) return 'stuck';
      if (round === 0)
        rounds = 2 * Math.max(text.split('\n').length, composer.text.split('\n').length) + this.keys.clearMargin;
      const input = composerInput(composer);
      if (input === '') return round === 0 ? 'absent' : 'cleared';
      const ours = showsPayload(input, text) || (paste && composer.pasted);
      if (!ours && (round === 0 || !erasing(input, text))) return round === 0 ? 'foreign' : 'stuck';
      if (round === rounds) break;
      await this.tmux.sendKey(session, 'C-u');
      await this.sleep(this.keys.pollMs);
    }
    return 'stuck';
  }

  /** One Enter, for a composer holding exactly the payload, then watched until it leaves or does not. */
  async submitComposer(id: SessionId, text: string): Promise<ComposerSubmitOutcome> {
    const session = await this.session(id);
    if ((await this.hold(id, text)) !== 'composer') return 'absent';
    await this.tmux.sendKey(session, 'Enter');
    for (let poll = 0; poll < this.keys.submitPolls; poll += 1) {
      await this.sleep(this.keys.pollMs);
      if ((await this.hold(id, text)) !== 'composer') return 'submitted';
    }
    return 'holding';
  }

  /**
   * Ends the active turn and waits for the pane to come back to a prompt.
   *
   * The readiness wait is bounded and its failure is swallowed on purpose: whether the pane settled
   * is answered by READING it afterwards, not by whether a wait returned. A caller that treated a
   * timeout as fatal would refuse a send into a pane that was, by then, perfectly ready.
   */
  async stopActiveTurn(id: SessionId): Promise<SendPaneObservation> {
    const session = await this.session(id);
    await this.tmux.sendKey(session, 'Escape');
    await this.delivery.waitReady(session).catch(() => undefined);
    return await this.observe(id);
  }

  async pressStopKey(id: SessionId): Promise<void> {
    await this.tmux.sendKey(await this.session(id), 'Escape');
  }

  /**
   * The terminal's refusal-before-typing, and its typed-but-unproven, said in the send domain's own
   * words — the two outcomes the service must tell apart from a transport that simply failed.
   */
  private async untyped<T>(transport: () => Promise<T>): Promise<T> {
    try {
      return await transport();
    } catch (error) {
      if (error instanceof ComposerOccupiedError) throw new SendComposerOccupied(error.draft);
      if (error instanceof ComposerUnreadableError) throw new SendComposerUnreadable();
      if (error instanceof ComposerUnconfirmedError) throw new SendLandingUnconfirmed(error.message);
      throw error;
    }
  }
}
