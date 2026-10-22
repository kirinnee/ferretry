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
 *
 * AN EMPTY COMPOSER AFTER TYPING PROVES NOTHING UNTIL THE PANE HAS DRAWN. Typed keys wait in the pty
 * until the harness reads them, and a stalled harness — a throttled or napping host, a long render —
 * reads and draws nothing for seconds. The fill used to look six times, 250 ms apart, then read the
 * still-empty composer as "the keys never arrived" and type again: on Claude Code 2.1.281 frozen for
 * 6 s that typed every message three times and then failed it with "did not land", all three copies
 * appearing once the pane woke. So the wait is now a window in TIME that stretches with the pane's own
 * latency (`landingDeadlineMs`), and a second fill happens only when the pane has visibly drawn since
 * the first and still shows an empty composer holding nothing — keys a live pane dropped. Anything
 * else is `ComposerUnconfirmedError`: typed, not proven, and never typed again by this loop.
 */

import {
  type ComposerState,
  composerEvidence,
  composerLanding,
  composerState,
  composerTransport,
  type DeliveryFrame,
  type LandingEvidence,
  type LandingWindow,
  landingDeadlineMs,
  landingEvidence,
  paneHoldOf,
  paneResponded,
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

/**
 * The payload WAS typed and no frame proved it landed, so it was not typed again.
 *
 * Its own type because it is neither a refusal nor a loss: the keys reached the pane's pty and may be
 * sitting in the composer, or on their way to it, right now. The only safe next step is a look or a
 * person — never another fill, which is how one message became three.
 */
export class ComposerUnconfirmedError extends Error {
  constructor(
    message: string,
    /** How many times the payload was typed, each into a composer proven empty first. */
    readonly typings: number,
  ) {
    super(message);
    this.name = 'ComposerUnconfirmedError';
  }
}

export interface ComposerFillSettings extends LandingWindow {
  /** Times the composer may be filled, each only into a composer proven empty again. */
  readonly composerAttempts: number;
  /** How long to wait between the reads that prove a composer empty before typing. */
  readonly pollMs: number;
}

/** The first look for landing evidence: an echo on a healthy host is drawn within a few tens of ms. */
export const LANDING_FIRST_LOOK_MS = 100;

/** Looks back off to this, so a stalled pane is not polled hot for the whole of its window. */
export const LANDING_LOOK_CEILING_MS = 1_000;

/**
 * Fresh frames a fill always reads before it stops looking, however the time is spent. A host where
 * one capture takes half a second (measured on the owner's Mac: p50 193 ms, max 571 ms) spends its
 * window on captures, not sleeps — and the window counts only the sleeps — so this floor matters only
 * when a caller configures a window too short to hold it.
 */
export const LANDING_MIN_LOOKS = 5;

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

/** The composer as the first readable frame shows it — with that frame — or `unreadable`. */
async function readComposerState(
  tmux: TmuxController,
  sleep: DeliverySleep,
  settings: ComposerFillSettings,
  session: string,
): Promise<{ readonly state: ComposerState; readonly frame: DeliveryFrame }> {
  let frame = await captureFrame(tmux, session);
  let state = composerState(frame);
  for (let read = 1; read < COMPOSER_READS && state.kind === 'unreadable'; read++) {
    await sleep(settings.pollMs);
    frame = await captureFrame(tmux, session);
    state = composerState(frame);
  }
  return { state, frame };
}

/** What watching one fill proved. */
type LandingWatch =
  | { readonly kind: 'landed'; readonly evidence: LandingEvidence }
  /** The pane drew after the keys and still shows an empty composer holding nothing: they were dropped. */
  | { readonly kind: 'dropped' }
  /** Neither: the pane may not have read the keys yet, or shows something that does not prove them. */
  | { readonly kind: 'unproven'; readonly waitedMs: number; readonly responded: boolean };

/**
 * Looks for the payload in fresh frames, backing off, until the pane's own latency says to stop.
 *
 * Every look is a new capture — nothing here reuses a frame — and the clock is the sum of the waits,
 * which only ever undercounts the real time and so errs towards waiting longer: on a host whose
 * captures are slow the window stretches by exactly that much, and never fewer than
 * `LANDING_MIN_LOOKS` frames are read.
 */
async function watchLanding(
  tmux: TmuxController,
  sleep: DeliverySleep,
  settings: ComposerFillSettings,
  session: string,
  text: string,
  paste: boolean,
  before: DeliveryFrame,
): Promise<LandingWatch> {
  const baseline = composerEvidence(before.visible, text);
  let waited = 0;
  let look = LANDING_FIRST_LOOK_MS;
  let respondedAt: number | undefined;
  let last = before;
  let looks = 0;
  for (let deadline = landingDeadlineMs(settings, undefined); waited < deadline || looks < LANDING_MIN_LOOKS; looks++) {
    const wait = waited < deadline ? Math.min(look, deadline - waited) : LANDING_FIRST_LOOK_MS;
    await sleep(wait);
    waited += wait;
    look = Math.min(look * 2, LANDING_LOOK_CEILING_MS);
    last = await captureFrame(tmux, session);
    if (respondedAt === undefined && paneResponded(before, last)) respondedAt = waited;
    deadline = landingDeadlineMs(settings, respondedAt);
    const read = composerLanding(last, text, paste);
    if (read === 'chars' || read === 'placeholder') return { kind: 'landed', evidence: read };
    if (read !== 'unreadable') continue;
    const proved = landingEvidence(baseline, composerEvidence(last.visible, text));
    if (proved !== undefined) return { kind: 'landed', evidence: proved };
  }
  // No NEW evidence, but a placeholder is nonetheless sitting in the composer: a paste of ours is in
  // there (a repaint can hide the counter bump, and re-pasting identical text may not move it). A
  // literal payload never draws one, so for it a placeholder somewhere in the frame proves nothing.
  // Submitting that is correct; retyping would duplicate it.
  if (paste && composerEvidence(last.visible, text).placeholders > 0)
    return { kind: 'landed', evidence: 'placeholder' };
  const responded = respondedAt !== undefined;
  const empty = composerState(last).kind === 'empty';
  const held = paneHoldOf(last.visible, { x: last.cursorX, y: last.cursorY }, text, paste);
  return responded && empty && held === 'absent'
    ? { kind: 'dropped' }
    : { kind: 'unproven', waitedMs: waited, responded };
}

/** Seconds, for a sentence. */
const seconds = (milliseconds: number): string => `${Math.round(milliseconds / 100) / 10} s`;

/**
 * Fill the composer and return the evidence that proved it.
 *
 * Refuses before any key when the composer holds input (`ComposerOccupiedError`) or cannot be read
 * (`ComposerUnreadableError`). Types the payload once; only when the pane has drawn since and still
 * shows an EMPTY composer holding nothing — the keys never arrived — may it type once more, and only
 * into a composer a fresh read proves empty again. Anything short of proof after a typing is
 * `ComposerUnconfirmedError`, and the composer is left exactly as it is.
 */
export async function fillComposer(
  tmux: TmuxController,
  sleep: DeliverySleep,
  settings: ComposerFillSettings,
  session: string,
  text: string,
): Promise<LandingEvidence> {
  const paste = composerTransport(text) === 'paste';
  let typings = 0;
  for (let attempt = 0; attempt < settings.composerAttempts; attempt++) {
    const { state, frame } = await readComposerState(tmux, sleep, settings, session);
    if (state.kind !== 'empty') {
      if (typings > 0)
        throw new ComposerUnconfirmedError(
          `the turn was typed into tmux session ${session} and dropped, and its composer now holds text that does not prove it; it was not typed again`,
          typings,
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
    if (paste) await tmux.paste(session, text);
    else await tmux.sendLiteral(session, text);
    typings += 1;
    const watched = await watchLanding(tmux, sleep, settings, session, text, paste, frame);
    if (watched.kind === 'landed') return watched.evidence;
    if (watched.kind === 'unproven')
      throw new ComposerUnconfirmedError(
        watched.responded
          ? `the turn was typed into tmux session ${session}, and in ${seconds(watched.waitedMs)} its composer never showed it; it was not typed again`
          : `the turn was typed into tmux session ${session}, which drew nothing for ${seconds(watched.waitedMs)}; it may still be reading it, so it was not typed again`,
        typings,
      );
  }
  throw new ComposerUnconfirmedError(
    `the turn was typed into tmux session ${session} ${typings} times and the pane dropped it every time`,
    typings,
  );
}
