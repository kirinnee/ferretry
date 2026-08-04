/**
 * CO-CONTROL — the decisions behind one shared terminal stream.
 *
 * Handover #64 asks for a shell an authorized agent and the reader drive AT THE
 * SAME TIME: the agent types, the reader watches it happen, and the reader can
 * take over mid-command without ending the agent's session. This module owns the
 * rules that make that true, with no socket, no timer and no DOM — the deck owns
 * those and applies what is decided here.
 *
 * THERE IS NO LOCK, AND THAT IS THE FEATURE. The daemon attaches every viewer
 * socket to the same pane and writes whatever any of them sends, so control is
 * not something to be held or handed over. `mayType` therefore depends on the
 * LINK and never on who owns the terminal: a reader who has to ask for a turn is
 * not co-controlling anything, and a UI that greys out the keyboard while an
 * agent is working would be inventing a lock the protocol does not have.
 *
 * WHAT THE READER IS OWED INSTEAD is knowing what they are typing INTO. Ownership
 * and the live viewer count are both stated, and the wording is chosen so the
 * two cases a reader must not confuse read differently: a shell nobody else is
 * attached to, and a shell an agent is driving right now.
 *
 * A CLOSED SOCKET IS NOT A CLOSED TERMINAL. The daemon closes a stream with 1000
 * when the viewer detached and with a policy code when the frame was refused; a
 * transport that simply died reports something else entirely. Reconnecting after
 * a refusal would loop against a daemon that has already explained itself, and
 * refusing to reconnect after a dropped connection would strand a phone that
 * merely changed network — so the code decides, and the decision is here rather
 * than inline in an effect where nobody could test it.
 */

import type { SurfaceOwnership } from './surface-references.ts';

/** Where one viewer socket stands, as the deck's lamp and status line read it. */
export type TerminalLinkState =
  /** Not attached, and not trying to be — the tab is not the active one. */
  | 'idle'
  /** A ticket is being bought, or the socket is opening. */
  | 'connecting'
  /** Attached: bytes flow both ways. */
  | 'live'
  /** The socket dropped and will be retried. */
  | 'reconnecting'
  /** The daemon refused, and retrying would only ask it the same question. */
  | 'refused';

/** WebSocket close codes this client can be given, and what they mean for retry. */
export const TERMINAL_CLOSE_NORMAL = 1000;

/**
 * Whether a closed stream should be reopened.
 *
 * 1000 is the deck detaching on purpose. 1008 and 1009 are the daemon's own
 * framing and queue refusals — it has judged this client and reconnecting would
 * put the same client back with the same behaviour. Everything else is a
 * transport that failed for reasons neither side chose, which is exactly what a
 * phone changing network looks like.
 */
export function shouldReopenTerminalStream(code: number): boolean {
  if (code === TERMINAL_CLOSE_NORMAL) return false;
  return code !== 1008 && code !== 1009;
}

/** How long before retry number `attempt` (1-based). */
export const TERMINAL_REOPEN_BASE_MS = 1_200;
export const TERMINAL_REOPEN_MAX_MS = 15_000;

/**
 * Backoff that starts where the original's fixed 1.2s did.
 *
 * The first retry keeps the original's feel — a shell that blinks and comes back
 * is what a reader expects — and later ones back off so a daemon that is down
 * does not get hammered by a page left open on a desk.
 */
export function terminalReopenDelayMs(attempt: number): number {
  const ordinal = Math.max(1, Math.trunc(attempt));
  return Math.min(TERMINAL_REOPEN_MAX_MS, TERMINAL_REOPEN_BASE_MS * 2 ** (ordinal - 1));
}

/** The one JSON control frame the stream accepts, as the protocol describes it. */
export function terminalResizeFrame(cols: number, rows: number): string {
  return JSON.stringify({ type: 'resize', cols: Math.trunc(cols), rows: Math.trunc(rows) });
}

export interface CoControlStanding {
  /** Whether keystrokes would reach the pane right now. */
  readonly mayType: boolean;
  /** One line naming who else is in this shell. */
  readonly sharing: string;
  /** The link, in the original's own four words. */
  readonly link: string;
}

/**
 * The link word the original deck printed, preserved verbatim.
 *
 * `offline` was shown as "reconnecting" there because that is what the deck was
 * about to do; a refusal is new here and says so rather than promising a retry
 * that will not happen.
 */
function linkWord(state: TerminalLinkState): string {
  if (state === 'live') return 'live';
  if (state === 'connecting') return 'connecting';
  if (state === 'reconnecting') return 'reconnecting';
  if (state === 'refused') return 'refused';
  return 'detached';
}

/**
 * How many OTHER viewers are in this shell.
 *
 * The daemon's count includes this reader's own socket once it is attached, and
 * a status line that says "1 viewer attached" while the reader is the only one
 * there would read as somebody else being present. Subtracting is only correct
 * while this socket is actually one of them, which is why the link is an input.
 */
function otherViewers(viewers: number, state: TerminalLinkState): number {
  const total = Number.isFinite(viewers) ? Math.max(0, Math.trunc(viewers)) : 0;
  return state === 'live' ? Math.max(0, total - 1) : total;
}

/**
 * What the reader is told before they type.
 *
 * The agent case is stated even when no second socket is attached: an agent that
 * opened this shell may be driving it through the daemon rather than through a
 * viewer socket, so a viewer count of zero is not evidence that nobody is there.
 * Reporting "nobody else is attached" on that evidence would be the benign
 * reading of an ambiguous fact, which is the failure this codebase keeps hitting.
 */
export function describeCoControl(
  state: TerminalLinkState,
  viewers: number,
  ownership: SurfaceOwnership,
): CoControlStanding {
  const others = otherViewers(viewers, state);
  const attached =
    others === 0
      ? 'no other viewer is attached'
      : others === 1
        ? '1 other viewer is attached'
        : `${others} other viewers are attached`;
  const sharing =
    ownership.by === 'agent'
      ? `An agent opened this shell and may be driving it; ${attached}. You can type at the same time.`
      : ownership.by === 'unrecorded'
        ? `This daemon did not record who opened this shell; ${attached}.`
        : `${attached}.`;
  // Typing depends on the LINK alone. Co-control is concurrent by construction:
  // there is no turn to wait for, so there is nothing here to gate on ownership.
  return { mayType: state === 'live', sharing, link: linkWord(state) };
}
