/**
 * Putting a payload into an EMPTY composer and proving it is there — the half of delivery the idle
 * path and the busy-queue path share.
 *
 * It was two copies of one loop, and both trusted a character count taken across the whole visible
 * frame. Codex's placeholder sentences contain ordinary words, so typing `hi` over
 * `Ask Codex to do anything` left that count unchanged; the loop cleared and retyped three times and
 * gave up with the message sitting typed in the composer. The proof now reads the composer line
 * itself, with the cursor saying whether it holds input or a placeholder, and the count survives only
 * as the fallback for a frame that has no readable composer.
 */

import {
  composerEvidence,
  composerLanding,
  composerTransport,
  type DeliveryFrame,
  type LandingEvidence,
  landingEvidence,
  occupiedComposer,
  type TmuxController,
} from '../../lib/tmux/index.ts';

/** Waiting is a capability, not a decision: the composition root owns how this process sleeps. */
export type DeliverySleep = (milliseconds: number) => Promise<void>;

/**
 * The composer already held input, so nothing was typed.
 *
 * Distinct from a failed delivery because NOTHING reached the pane: the caller may honestly withdraw
 * its record, and a person can be told exactly what is in the way.
 */
export class ComposerOccupiedError extends Error {
  constructor(
    message: string,
    /** What the composer was holding, so the person can recognise it. */
    readonly draft: string,
  ) {
    super(message);
    this.name = 'ComposerOccupiedError';
  }
}

export interface ComposerFillSettings {
  /** Times the composer may be filled from scratch. */
  readonly composerAttempts: number;
  /** Frames to look at for landing evidence after each fill. */
  readonly composerPolls: number;
  /** How long to wait between observations. */
  readonly pollMs: number;
}

/** One capture, shaped the way the decision layer reads a pane. */
export async function captureFrame(tmux: TmuxController, session: string): Promise<DeliveryFrame> {
  const state = await tmux.state(session);
  return {
    alive: state.alive,
    dead: state.dead,
    promptReady: state.promptReady,
    visible: state.visible,
    ...(state.dead ? { history: state.history } : {}),
    ...(state.exitCode === undefined ? {} : { exitCode: state.exitCode }),
    ...(state.cursorX === undefined ? {} : { cursorX: state.cursorX }),
    ...(state.cursorY === undefined ? {} : { cursorY: state.cursorY }),
  };
}

/**
 * Fill the composer and return the evidence that proved it.
 *
 * Refuses up front when the composer already holds input (see `occupiedComposer`). The composer is
 * cleared before a RETRY only, and only on the path where nothing landed — a proven landing returns
 * first, so clearing can never destroy a paste the harness already took. `fail` names the error the
 * caller wants when every attempt came up empty.
 */
export async function fillComposer(
  tmux: TmuxController,
  sleep: DeliverySleep,
  settings: ComposerFillSettings,
  session: string,
  text: string,
  fail: (message: string) => Error,
): Promise<LandingEvidence> {
  const paste = composerTransport(text) === 'paste';
  const draft = occupiedComposer(await captureFrame(tmux, session));
  if (draft !== undefined)
    throw new ComposerOccupiedError(
      `the composer of tmux session ${session} already holds unsent text; nothing was typed`,
      draft,
    );
  for (let attempt = 0; attempt < settings.composerAttempts; attempt++) {
    if (attempt > 0) {
      await tmux.sendKey(session, 'C-u');
      await sleep(settings.pollMs);
    }
    const before = composerEvidence(await tmux.capture(session, false), text);
    if (paste) await tmux.paste(session, text);
    else await tmux.sendLiteral(session, text);
    for (let poll = 0; poll < settings.composerPolls; poll++) {
      await sleep(settings.pollMs);
      const frame = await captureFrame(tmux, session);
      const read = composerLanding(frame, text, paste);
      if (read === 'chars' || read === 'placeholder') return read;
      if (read !== 'unreadable') continue;
      const proved = landingEvidence(before, composerEvidence(frame.visible, text));
      if (proved !== undefined) return proved;
    }
    // No NEW evidence, but a placeholder is nonetheless sitting in the composer: a paste of ours is in
    // there (a repaint can hide the counter bump, and re-pasting identical text may not move it).
    // Submitting that is correct; retyping would duplicate or destroy it.
    if (composerEvidence(await tmux.capture(session, false), text).placeholders > 0) return 'placeholder';
  }
  throw fail(`the turn did not land in the composer of tmux session ${session}`);
}
