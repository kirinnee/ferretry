import type {
  RunnerComposerCleared,
  RunnerComposerSubmitted,
  RunnerHeldAt,
  RunnerPaneObservation,
} from '@ferretry/core-ferrets/contract';
import {
  composerInput,
  composerTransport,
  type DeliveryFrame,
  draftBlockingReadiness,
  frameCursor,
  lonePasteOf,
  type PaneHold,
  paneBlockingDialog,
  paneBlockingPermission,
  paneBlockingPrompt,
  paneHoldOf,
  paneShowsActiveWork,
  paneShowsStartupWait,
  readComposer,
  showsPayload,
  type TmuxController,
} from '../../lib/tmux/index.ts';
import { captureFrame, type DeliverySleep } from './composer-fill.ts';

/**
 * The send path's reads and composer keys over one ferret pane (today's `TmuxSendTerminal.observe`, `heldAt`,
 * `clearComposer` and `submitComposer`, copied: no new tmux behaviour). The controller it is given is the runner's
 * GUARDED binding, so every key goes through `kernel.act` on that exact pane and is re-checked in the write; this file
 * never opens a pane of its own.
 */

/** Whether a frame's composer holds this payload and nothing else, at a pane where Enter submits it. */
function holdsExactly(frame: DeliveryFrame, text: string, strict = false): boolean {
  if (!frame.alive || frame.dead || paneShowsActiveWork(frame.visible) || paneShowsStartupWait(frame.visible))
    return false;
  if (
    paneBlockingPrompt(frame.visible) !== undefined ||
    paneBlockingPermission(frame.visible) !== undefined ||
    paneBlockingDialog(frame.visible) !== undefined
  )
    return false;
  const composer = readComposer(frame.visible, frameCursor(frame));
  if (composer === undefined || composer.placeholder === true) return false;
  const input = composerInput(composer);
  if (strict) return sameDrawnText(input, text);
  return showsPayload(input, text) || (composerTransport(text) === 'paste' && lonePasteOf(input, text));
}

const squeeze = (value: string): string => value.normalize('NFC').replace(/\s+/gu, '');

/** The whole of `text`, however the TUI wrapped it, and nothing clipped or added (&B153's strict press). */
function sameDrawnText(shown: string, text: string): boolean {
  return squeeze(shown) !== '' && squeeze(shown) === squeeze(text);
}

/** True while what the composer holds is the start of the payload: what erasing from its end leaves. */
function erasing(shown: string, text: string): boolean {
  return squeeze(text).startsWith(squeeze(shown));
}

/** How the composer keys are paced and bounded. */
export interface ComposerKeySettings {
  /** Erase keys allowed beyond the two each line of the payload needs (each is verified by a fresh read). */
  readonly clearMargin: number;
  /** Frames to look at after one Enter before calling the payload still held. */
  readonly submitPolls: number;
  /** How long to let a key take effect before looking again. */
  readonly pollMs: number;
}

const COMPOSER_KEYS: ComposerKeySettings = { clearMargin: 2, submitPolls: 8, pollMs: 250 };

/** What a frame shows, as the send path reads it (the prompt text is NOT yet masked: the runner masks it). */
function observationOf(frame: DeliveryFrame): RunnerPaneObservation {
  // A composer under Codex's `Waiting for startup` line holds a message Codex already accepted, not a draft.
  const draft = draftBlockingReadiness(frame);
  // A permission prompt blocks a send as surely as a dialog: a message typed into its choice list could pick a row.
  const blocking =
    paneBlockingPrompt(frame.visible) ?? paneBlockingPermission(frame.visible) ?? paneBlockingDialog(frame.visible);
  return {
    alive: frame.alive,
    dead: frame.dead,
    promptReady: frame.promptReady,
    activeWork: paneShowsActiveWork(frame.visible),
    startupParked: paneShowsStartupWait(frame.visible),
    ...(blocking === undefined ? {} : { blockingPrompt: blocking }),
    ...(draft === undefined ? {} : { draft }),
  };
}

export class ComposerActs {
  constructor(
    private readonly tmux: TmuxController,
    private readonly session: string,
    private readonly sleep: DeliverySleep,
    private readonly keys: ComposerKeySettings = COMPOSER_KEYS,
  ) {}

  async observe(): Promise<RunnerPaneObservation> {
    return observationOf(await captureFrame(this.tmux, this.session));
  }

  /**
   * Where the visible pane holds the payload: typed in the composer, or in the harness's own queue. Read from those two
   * places only. A queue that runs past the top of the pane THROWS rather than answering "not held": the payload may be
   * in the part that cannot be seen, and "not held" is what licenses typing it again.
   */
  async heldAt(text: string): Promise<RunnerHeldAt | undefined> {
    const hold = await this.hold(text);
    if (hold === 'unknown')
      throw new Error("the agent's queue runs past what its pane shows, so a held message cannot be ruled out");
    return hold === 'absent' ? undefined : hold;
  }

  private async hold(text: string): Promise<PaneHold> {
    const frame = await captureFrame(this.tmux, this.session);
    return paneHoldOf(frame.visible, frameCursor(frame), text, composerTransport(text) === 'paste');
  }

  /**
   * Erases the payload from the composer, one `C-u` at a time, reading the composer before each key. `BSpace` is never
   * sent. Between keys the composer must still be the payload or a shrinking prefix of it, and anything else stops the
   * clear, so a person who typed beside it keeps their draft.
   */
  async clearComposer(text: string): Promise<RunnerComposerCleared> {
    const paste = composerTransport(text) === 'paste';
    let rounds = 2 * text.split('\n').length + this.keys.clearMargin;
    for (let round = 0; round <= rounds; round += 1) {
      const frame = await captureFrame(this.tmux, this.session);
      // A parked composer holds a message Codex already accepted: C-u would erase text that is about to be sent.
      if (paneShowsStartupWait(frame.visible)) return 'stuck';
      const composer = readComposer(frame.visible, frameCursor(frame));
      if (composer?.placeholder === undefined) return 'stuck';
      if (round === 0)
        rounds = 2 * Math.max(text.split('\n').length, composer.text.split('\n').length) + this.keys.clearMargin;
      const input = composerInput(composer);
      if (input === '') return round === 0 ? 'absent' : 'cleared';
      const ours = showsPayload(input, text) || (paste && composer.pasted);
      if (!ours && (round === 0 || !erasing(input, text))) return round === 0 ? 'foreign' : 'stuck';
      if (round === rounds) break;
      await this.tmux.sendKey(this.session, 'C-u');
      await this.sleep(this.keys.pollMs);
    }
    return 'stuck';
  }

  /** One Enter, for a composer holding exactly the payload on a frame captured right before the key, then watched. */
  async submitComposer(text: string, strict = false): Promise<RunnerComposerSubmitted> {
    if (!holdsExactly(await captureFrame(this.tmux, this.session), text, strict)) return 'absent';
    await this.tmux.sendKey(this.session, 'Enter');
    for (let poll = 0; poll < this.keys.submitPolls; poll += 1) {
      await this.sleep(this.keys.pollMs);
      if ((await this.hold(text)) !== 'composer') return 'submitted';
    }
    return 'holding';
  }
}
