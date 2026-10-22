/**
 * Putting a payload into an EMPTY composer and proving it is there — the half of delivery the idle
 * path and the busy-queue path share.
 *
 * It was two copies of one loop, and both trusted a character count taken across the whole visible
 * frame. Codex's placeholder sentences contain ordinary words, so typing `hi` over
 * `Ask Codex to do anything` left that count unchanged; the loop cleared and retyped three times and
 * gave up with the message sitting typed in the composer. The proof now reads the composer line
 * itself, with the cursor saying whether it holds input or a placeholder, and the count survives only
 * as the fallback for a frame whose cursor could not place the composer.
 *
 * THE INVARIANT: a key is typed only into a composer one frame PROVES empty, and a fill types its
 * payload into it at most once per proof. Both halves were missing. A composer the cursor could not
 * place read as empty, so a turn pointer was typed onto a person's half-written question; and a fill
 * that could not prove its own landing sent `C-u` and typed again — but Claude Code's `C-u` erases one
 * wrapped row, not the message, so every retry left a clipped copy and appended a whole one. That is
 * six copies of one pointer glued to a person's draft, never submitted. Now a composer holding
 * anything, or one that cannot be read, is never typed into, and nothing is ever erased to retype.
 */

import {
  type ComposerState,
  composerEvidence,
  composerLanding,
  composerState,
  composerTransport,
  type DeliveryFrame,
  type LandingEvidence,
  landingEvidence,
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

/**
 * The composer could not be read well enough to prove it empty, so nothing was typed.
 *
 * Not an occupied composer — there may be nothing there — and not a failed delivery, because no key
 * was sent. The caller withdraws or restores its record exactly as for an occupied one, and says so.
 */
export class ComposerUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComposerUnreadableError';
  }
}

export interface ComposerFillSettings {
  /** Times the composer may be filled, each only into a composer proven empty again. */
  readonly composerAttempts: number;
  /** Frames to look at for landing evidence after each fill. */
  readonly composerPolls: number;
  /** How long to wait between observations. */
  readonly pollMs: number;
}

/**
 * Frames a fill reads, a poll apart, for a composer it can place before it gives up typing nothing.
 * A repaint caught halfway is gone by the next frame; a composer that stays unreadable is a refusal.
 */
export const COMPOSER_READS = 4;

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

/** The composer as the first readable frame shows it, or `unreadable` after `COMPOSER_READS` frames. */
async function readComposerState(
  tmux: TmuxController,
  sleep: DeliverySleep,
  settings: ComposerFillSettings,
  session: string,
): Promise<ComposerState> {
  let state: ComposerState = { kind: 'unreadable' };
  for (let read = 0; read < COMPOSER_READS; read++) {
    if (read > 0) await sleep(settings.pollMs);
    state = composerState(await captureFrame(tmux, session));
    if (state.kind !== 'unreadable') return state;
  }
  return state;
}

/**
 * Fill the composer and return the evidence that proved it.
 *
 * Refuses before any key when the composer holds input (`ComposerOccupiedError`) or cannot be read
 * (`ComposerUnreadableError`). Types the payload once; only when the composer is later proven EMPTY
 * again — the keys never arrived — may it type once more. A composer holding anything after a fill,
 * this payload included, is left exactly as it is, because the next keys would sit beside it. `fail`
 * names the error the caller wants when that happens, or when every attempt came up empty.
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
  for (let attempt = 0; attempt < settings.composerAttempts; attempt++) {
    const state = await readComposerState(tmux, sleep, settings, session);
    if (state.kind !== 'empty') {
      if (attempt > 0)
        throw fail(
          `the turn did not provably land in the composer of tmux session ${session}, which is no longer empty; it was not typed again`,
        );
      if (state.kind === 'input')
        throw new ComposerOccupiedError(
          `the composer of tmux session ${session} already holds unsent text; nothing was typed`,
          state.text,
        );
      throw new ComposerUnreadableError(
        `the composer of tmux session ${session} could not be read to prove it empty; nothing was typed`,
      );
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
    // there (a repaint can hide the counter bump, and re-pasting identical text may not move it). A
    // literal payload never draws one, so for it a placeholder somewhere in the frame proves nothing.
    // Submitting that is correct; retyping would duplicate it.
    if (paste && composerEvidence(await tmux.capture(session, false), text).placeholders > 0) return 'placeholder';
  }
  throw fail(`the turn did not land in the composer of tmux session ${session}`);
}
