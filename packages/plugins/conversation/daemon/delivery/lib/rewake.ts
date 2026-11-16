import { ferretryNotice, parseCombinedDelivery, parseFerretryNotice, parsePeerEnvelope } from '../../seams/protocol.ts';

/**
 * HANDING A MESSAGE TO AN IDLE CLAUDE CODE AGENT WITHOUT TYPING IT.
 *
 * Claude Code runs a `Stop` hook with `asyncRewake` in the background after every turn; when that listener exits 2 its stderr
 * wakes the IDLE session and the agent acts on the text (measured on 2.1.317). Ferretry's listener (the harness plugin's
 * fixed layer) watches the ferret's rewake inbox, so a message LEFT THERE reaches the agent with no key pressed, no composer
 * read and no draft in the way.
 *
 * WHAT THE HARNESS MAKES OF IT is what decides who may go this way. The transcript records the text as a `user` entry inside
 * `<task-notification>… Stop hook feedback …</task-notification>` and a system reminder, and the model is told the text is
 * a system notification and NOT a message from the user. So:
 *
 *   * an AGENT's message and a DAEMON notice may go this way — they are not the owner, and their banner says so;
 *   * the OWNER's words NEVER do. They stay typed, as real user input. The most the daemon does for a stuck owner message is
 *     a NOTICE that one is waiting ({@link OWNER_NUDGE_TEXT}), with none of the owner's words in it;
 *   * the Warden's composer acts never do either: they exist to repair the composer, which this path does not touch.
 *
 * Everything here is pure: the I/O is Ferrets' `FerretRewake` inbox, the clock and the ledger are the callers'.
 */

/** A listener whose heartbeat is newer than this is waiting to hand a message over. It touches its heartbeat every second. */
export const REWAKE_ARMED_WITHIN_MS = 5_000;

/**
 * The notice left for an agent that sits on a stuck owner message. It carries NO owner words — only that one is waiting — and
 * asks the agent to end its turn, because an idle harness redraws nothing by itself and a composer the reader could not place
 * is read afresh once the screen has moved. The tracker's next retype (every few seconds) then types the owner's message.
 */
export const OWNER_NUDGE_TEXT = ferretryNotice(
  '[delivery] A message from the owner is waiting to be typed into your input box. Finish briefly and end your turn.',
);

/** The send id the nudge for `sendId` is left under: one per owner send. */
export function ownerNudgeSendId(sendId: string): string {
  return `owner-waiting:${sendId}`;
}

/** Who is sending, as far as the choice of road is concerned. */
export interface RewakeSpeaker {
  /** Ferrets' harness family of the receiving ferret. */
  readonly harness: string | undefined;
  /** Another ferret is the sender. */
  readonly agent: boolean;
  /** Ferretry itself is the sender: a failure notice, or Agenda's turn-end check. */
  readonly notice: boolean;
  /** The Warden is the sender. */
  readonly warden: boolean;
  /** The sender asked for the turn to be stopped first (`--now`), which needs the keyboard. */
  readonly now: boolean;
}

/**
 * Whether this send may be handed over by the hook instead of typed. A person's send, a Warden act and a send-now never may;
 * only a Claude ferret has the listener.
 */
export function mayGoByHook(speaker: RewakeSpeaker): boolean {
  if (speaker.harness !== 'claude' || speaker.warden || speaker.now) return false;
  return speaker.agent || speaker.notice;
}

/**
 * The exact text the agent would have been typed, for the inbox. A ferret's message already opens with its banner, and a
 * combined delivery with its header; a daemon notice that opens with neither is given Ferretry's tag, which is how the chat
 * tells it from anything else a Stop hook says.
 */
export function inboxText(typed: string): string {
  const known =
    parsePeerEnvelope(typed) !== null || parseCombinedDelivery(typed) !== null || parseFerretryNotice(typed) !== null;
  return known ? typed : ferretryNotice(typed);
}
