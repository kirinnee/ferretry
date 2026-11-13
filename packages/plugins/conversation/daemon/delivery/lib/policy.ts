import {
  type PeerEnvelopeSender,
  type PeerMessageKind,
  type PeerMessageLabel,
  peerEnvelopePreamble,
  queuedMessageInstruction,
  turnFileInstruction,
} from '../../seams/protocol.ts';
import { STRUCTURED_ANSWER_RELEASED_AGENDA_KIND } from '../../questions/lib/answer-ledger.ts';
import type { SessionSendSettings } from './settings.ts';
import {
  IDLE_SEND_STATUSES,
  type SendPaneObservation,
  type SendRecord,
  SendRefused,
  type SendTarget,
  SendUnavailable,
  TERMINAL_SEND_STATUSES,
} from './types.ts';

/**
 * The pure decisions a send makes, with no clock, no pane and no filesystem of their own.
 *
 * Everything a send does to a terminal follows from two observations — the session's own record and
 * one frame of its pane — and both arrive here as values. That is what makes the rule this slice
 * exists to keep testable: a message is NEVER typed into a pane nothing is monitoring.
 */

/**
 * Refusals that hold whatever the pane shows, evaluated before a frame is even captured.
 *
 * Each is a session whose composer is not addressable, and each is a real way to type into the wrong
 * thing:
 *
 *   * `kill_failed` — a stop that was never confirmed. Something may still be attached to that pane,
 *     and it is not this session's agent.
 *   * A QUARANTINED harness is sitting in a native modal the daemon could not identify. Keystrokes
 *     there are answers to a question nobody read.
 *   * An UNANSWERED STRUCTURED QUESTION is a form, not a composer. Typing prose into it selects
 *     whichever option the keys happen to land on.
 */
export function authorizeSend(target: SendTarget, attachmentIds: readonly string[]): void {
  if (target.status === 'kill_failed')
    throw new SendUnavailable(
      `the previous terminal shutdown for ${target.id} was not confirmed; stop it successfully before sending`,
    );
  if (target.needsHumanKind !== undefined && target.needsHumanKind !== STRUCTURED_ANSWER_RELEASED_AGENDA_KIND)
    throw new SendUnavailable(
      `session ${target.id} is quarantined awaiting a person (${target.needsHumanKind}); clear it before sending`,
    );
  if (target.pendingQuestion !== undefined)
    throw new SendUnavailable(
      `session ${target.id} is holding an unanswered structured question ` +
        `(${target.pendingQuestion.toolUseId}); answer or abandon it before sending prose`,
    );
  // An attachment id is a durable, daemon-keyed reference, not a value this policy
  // must refuse: the send route copies each one out and names its path in the
  // message (`attachments/delivery.ts`), refusing there if one is not this session's.
  void attachmentIds;
}

/** How a send must treat the session it found. */
export type SendRouting =
  /** No live, supervised agent to type into. The message becomes a revive's first turn. */
  | 'revive'
  /** A live agent mid-turn. The message rides the harness's own queue to the turn boundary. */
  | 'busy'
  /** A live agent at a prompt. The message becomes a tracked turn. */
  | 'idle';

/**
 * Where a message goes, given the record and one frame.
 *
 * A TERMINAL session's surviving pane is not somewhere to type, and that is the branch that matters:
 * nothing monitors it — it outlived a daemon restart or a reconciled completion — so a message typed
 * there is lost silently, which is the worst outcome a send has.
 *
 * `busy` is the LAST answer, reached only when nothing says otherwise. A status that is idle by its
 * own account, a document that says the composer is ready, or a pane that looks ready are each enough
 * to take the tracked path — because mistaking an idle prompt for a busy one submits the message as
 * an untracked ghost turn, while mistaking busy for idle merely waits for a prompt that does not come,
 * and the send is refused before its first key (`SendNotReady`).
 *
 * ONE STATUS IS NOT TAKEN AT ITS WORD AGAINST THE PANE: `waiting` (&B153). A declared wait is set by the
 * agent from INSIDE its turn, so the record says waiting while the pane is still visibly at work — ryu's
 * record read `waiting` with `promptReady: false` through eleven stalls. A pane that shows work under it is
 * busy, and the message rides the harness's own queue; one that shows neither work nor a prompt is still
 * taken as idle, because the ghost turn is the worse of the two mistakes.
 */
export function routeSend(target: SendTarget, pane: SendPaneObservation): SendRouting {
  if (TERMINAL_SEND_STATUSES.has(target.status) || !pane.alive || pane.dead) return 'revive';
  // A compaction the pane shows is busy under ANY stored status: `awaiting_user` and `interrupted` are states a person
  // starts `/compact` from, so the idle-status fallback below must never carry a send into that composer (&B188).
  if (pane.compacting === true) return 'busy';
  // A RECORDED ready composer is the older word: it counts only while the pane shows no work, so a compaction
  // that began after the record was written is never typed into (&B188).
  if (pane.promptReady || (target.promptReady === true && !pane.activeWork)) return 'idle';
  if (target.status === 'waiting' && pane.activeWork) return 'busy';
  if (IDLE_SEND_STATUSES.has(target.status)) return 'idle';
  return 'busy';
}

/**
 * Whether anything typed into this pane now would land behind a running turn — the routing says busy,
 * or the frame itself shows work under a status or document that says otherwise.
 */
export function paneMidTurn(target: SendTarget, pane: SendPaneObservation): boolean {
  return pane.activeWork || routeSend(target, pane) === 'busy';
}

/**
 * Whether this send has already been typed into a mid-turn pane: its first transport rode the
 * harness's queue, or a re-attempt was typed behind a running turn.
 *
 * THE HARD GUARD. A queue is the one place a typed message can sit unseen — the daemon proves it held
 * only by recognising the harness's rendering of it, and a rendering it did not recognise is how one
 * message became four copies in Claude Code's queue. So a send is typed into a mid-turn pane at most
 * ONCE unless a person forces another; the daemon instead waits for the turn boundary, where the
 * harness either submits what it held (and the transcript proves it) or holds nothing.
 *
 * A send whose busy-pane transport refused before its first key (`untyped`) was typed nowhere, so it
 * has no copy for the guard to protect.
 */
export function typedIntoBusyPane(record: Pick<SendRecord, 'path' | 'busyTyped' | 'untyped'>): boolean {
  if (record.untyped === true) return false;
  return record.busyTyped === true || record.path === 'native-inline' || record.path === 'native-file';
}

/**
 * The banner prepended to a message one FERRET sent another.
 *
 * A ferret reads only the message TEXT, so attribution has to live inside it. Without this every
 * peer message reads as the owner speaking — and a ferret that cannot tell a peer from its owner
 * cannot judge whether to comply, push back, or escalate.
 *
 * The wording is the protocol's (`peerEnvelopePreamble`), because the app parses it back out of the
 * transcript to show the message as coming FROM the sender; this only says who the sender is and what
 * kind of message it is (`peerMessageKind`).
 */
export function peerPreamble(
  sender: Pick<SendTarget, 'id' | 'teammate'>,
  kind: PeerMessageKind,
  clientName: string,
  label?: PeerMessageLabel,
): string {
  return peerEnvelopePreamble({ ...peerSender(sender, kind, label), clientName });
}

/** Who a ferret's message is from, as the banner writers take it. */
export function peerSender(
  sender: Pick<SendTarget, 'id' | 'teammate'>,
  kind: PeerMessageKind,
  label?: PeerMessageLabel,
): Omit<PeerEnvelopeSender, 'clientName'> {
  return {
    name: sender.teammate ?? sender.id,
    sessionId: sender.id,
    kind,
    ...(label === undefined ? {} : { label }),
  };
}

/**
 * What one ferret's message to another is: the ANSWER the recipient is parked on (`reply`), a
 * question its sender is parked on (`question`), or a note (`message`).
 *
 * A reply wins over a question: a ferret answering a question with one of its own is still, first, the
 * answer the recipient was waiting for.
 */
export function peerMessageKind(
  recipient: Pick<SendTarget, 'waiting'> | undefined,
  senderId: string,
  replyExpected: boolean,
): PeerMessageKind {
  if (recipient?.waiting?.peer === senderId) return 'reply';
  return replyExpected ? 'question' : 'message';
}

/** The last C0 code point, and DEL. Everything at or below the first, plus the second, is a control. */
const LAST_CONTROL_CODE = 0x1f;
const DELETE_CODE = 0x7f;
const NEWLINE_CODE = 0x0a;

/**
 * Whether the text carries a character a TUI composer will not take verbatim. A newline is a control
 * character too; `allowNewline` is for a payload that travels as a bracketed paste, where it is text.
 *
 * A scan rather than a regular expression on purpose: a control-character CLASS is a lint error the
 * repository is right to raise — it is nearly always a mistake — and writing one here would mean
 * suppressing that rule for a check three lines of arithmetic express exactly.
 */
function hasControlCharacters(text: string, allowNewline: boolean): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (allowNewline && code === NEWLINE_CODE) continue;
    if (code <= LAST_CONTROL_CODE || code === DELETE_CODE) return true;
  }
  return false;
}

/**
 * Whether a payload is safe to type verbatim into an idle composer.
 *
 * Single line after trimming, under the caller's ceiling, and free of control characters — each
 * exclusion is a way a TUI's quoting or paste handling turns one message into several. Everything
 * else takes the turn-file indirection, which is one line whatever the payload contains.
 *
 * A ceiling of zero disables the verbatim path entirely, which is how an operator opts a session out.
 */
export function isDirectPayload(payload: string, limit: number): boolean {
  if (limit <= 0) return false;
  const trimmed = payload.trim();
  if (trimmed === '' || trimmed.length > limit) return false;
  if (trimmed.includes('\n')) return false;
  return !hasControlCharacters(trimmed, false);
}

/**
 * Whether a MULTI-LINE payload may be typed into an idle composer as one bracketed paste.
 *
 * The same exclusions as `isDirectPayload` except the newline: a paste is one event the composer takes
 * whole (it may collapse it to a `[Pasted text #1 +N lines]` chip, which the landing proof accepts), so
 * a newline cannot submit half of it. A tab or any other control character is still refused — those are
 * what a TUI's paste handling rewrites — and the payload takes the turn file instead.
 */
export function isDirectPaste(payload: string, limit: number): boolean {
  if (limit <= 0) return false;
  const trimmed = payload.trim();
  if (trimmed === '' || trimmed.length > limit) return false;
  return !hasControlCharacters(trimmed, true);
}

/**
 * The verbatim ceiling for one session: its own configuration, or the deployment default.
 *
 * An INTERACTIVE session has no ceiling worth consulting — a human typing in a chat box answered with
 * "read /home/…/turns/turn-014.md" is not a conversation — so any single-line payload goes direct
 * there. Every other exclusion above still applies.
 */
export function directLimitFor(target: SendTarget, settings: SessionSendSettings): number {
  if (target.mode === 'interactive') return Number.POSITIVE_INFINITY;
  return target.directSendMaxChars ?? settings.directSendMaxChars;
}

/** The harness whose composer is proven to take a bracketed paste of a whole message. */
const PASTE_SAFE_HARNESS = 'claude';

/**
 * Whether an idle send is typed into the composer verbatim rather than handed over as a turn file.
 *
 * A one-line payload goes direct under the session's ceiling (`directLimitFor`). A MULTI-LINE one goes
 * direct only to Claude Code, which takes it as one bracketed paste (the busy path already types
 * multi-line text the same way), and only up to the smaller of the session's ceiling and
 * `directPasteMaxChars`. A session whose ceiling is zero has opted out of both.
 *
 * Codex keeps today's rule — one line only — because no fixture here proves a multi-line paste landing
 * in its composer and being submitted; its fixtures show typed text only.
 */
export function isDirectSend(target: SendTarget, payload: string, settings: SessionSendSettings): boolean {
  if (isDirectPayload(payload, directLimitFor(target, settings))) return true;
  if (target.harness !== PASTE_SAFE_HARNESS) return false;
  return isDirectPaste(payload, Math.min(pasteCeilingFor(target, settings), settings.directPasteMaxChars));
}

/**
 * The ceiling a multi-line paste is held to: the session's own `directSendMaxChars` when it set one,
 * zero included, even on an interactive session (whose single-line rule has no ceiling). Without one,
 * `directLimitFor` decides, so an interactive session stays unbounded here and only
 * `directPasteMaxChars` applies.
 */
function pasteCeilingFor(target: SendTarget, settings: SessionSendSettings): number {
  return target.directSendMaxChars ?? directLimitFor(target, settings);
}

/** What is typed into a pane so the agent picks up a tracked turn. The wording is the protocol's, because the app reads it back out of the transcript (`turn-handoff.ts`). */
export function turnInstruction(turnFile: string): string {
  return turnFileInstruction(turnFile);
}

/** What is typed into a BUSY pane when the payload was too long to type. */
export function queuedPayloadInstruction(payloadFile: string): string {
  return queuedMessageInstruction(payloadFile);
}

/** Whether a native-queue ride must go through a file rather than the composer. */
export function isFileBackedQueue(payload: string, settings: SessionSendSettings): boolean {
  return payload.length > settings.nativeQueueInlineMaxChars;
}

/**
 * The message a send actually carries, refusing an empty one outright.
 *
 * A send with nothing in it is not a cheap no-op: it starts a turn, restarts the turn clock, and buys
 * a model response to a prompt that says nothing.
 */
export function sendPayload(message: string): string {
  const trimmed = message.trim();
  if (trimmed === '') throw new SendRefused('a send requires a message');
  return trimmed;
}

/** Whether this send is the reply the recipient's declared wait was parked on. */
export function endsPeerWait(recipient: SendTarget, senderId: string): boolean {
  return recipient.waiting?.peer === senderId;
}
