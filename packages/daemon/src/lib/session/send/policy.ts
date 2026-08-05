import type { SessionSendSettings } from './settings.ts';
import {
  IDLE_SEND_STATUSES,
  type SendPaneObservation,
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
  if (target.needsHumanKind !== undefined)
    throw new SendUnavailable(
      `session ${target.id} is quarantined awaiting a person (${target.needsHumanKind}); clear it before sending`,
    );
  if (target.pendingQuestion !== undefined)
    throw new SendUnavailable(
      `session ${target.id} is holding an unanswered structured question ` +
        `(${target.pendingQuestion.toolUseId}); answer or abandon it before sending prose`,
    );
  // Per-session upload/download routes are mounted. Agent-side injection remains
  // an explicit migration gap, but an attachment id is now a durable, daemon-keyed
  // reference rather than a value this policy must blanket-refuse.
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
 * an untracked ghost turn, while mistaking busy for idle merely queues it behind the current one.
 */
export function routeSend(target: SendTarget, pane: SendPaneObservation): SendRouting {
  if (TERMINAL_SEND_STATUSES.has(target.status) || !pane.alive || pane.dead) return 'revive';
  if (IDLE_SEND_STATUSES.has(target.status) || target.promptReady === true || pane.promptReady) return 'idle';
  return 'busy';
}

/**
 * The banner prepended to a message one SESSION sent to another.
 *
 * A teammate reads only the message TEXT, so attribution has to live inside it. Without this every
 * peer message reads as the human lead speaking — and a teammate that cannot tell a peer from its
 * lead cannot judge whether to comply, push back, or escalate.
 *
 * The reply instruction appears only when the sender is actually parked on one, so a fire-and-forget
 * note never nags its receiver into answering.
 */
export function peerPreamble(
  sender: Pick<SendTarget, 'id' | 'teammate'>,
  replyExpected: boolean,
  clientName: string,
): string {
  const from = sender.teammate ?? sender.id;
  const lines = [`[peer message from teammate ${from} (session ${sender.id}) — not from the human lead]`];
  if (replyExpected)
    lines.push(
      `${from} is PARKED waiting for your reply and cannot continue until it arrives. ` +
        `Answer with: ${clientName} send ${from} "<your reply>"`,
    );
  else
    lines.push(
      `No reply is required; ${from} has carried on. Reply with \`${clientName} send ${from} "…"\` if useful.`,
    );
  return `${lines.join('\n')}\n\n`;
}

/** The last C0 code point, and DEL. Everything at or below the first, plus the second, is a control. */
const LAST_CONTROL_CODE = 0x1f;
const DELETE_CODE = 0x7f;

/**
 * Whether the text carries a character a TUI composer will not take verbatim.
 *
 * A scan rather than a regular expression on purpose: a control-character CLASS is a lint error the
 * repository is right to raise — it is nearly always a mistake — and writing one here would mean
 * suppressing that rule for a check three lines of arithmetic express exactly.
 */
function hasControlCharacters(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
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
  return !hasControlCharacters(trimmed);
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

/** What is typed into a pane so the agent picks up a tracked turn. */
export function turnInstruction(turnFile: string): string {
  return `Read the file ${turnFile} now, then carefully follow every instruction inside it. This is your complete task for this turn.`;
}

/** What is typed into a BUSY pane when the payload was too long to type. */
export function queuedPayloadInstruction(payloadFile: string): string {
  return `Read the queued message file at ${payloadFile} completely now, then follow every instruction inside it.`;
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

/** The harness whose TUI treats the stop key as harmless at an idle prompt. */
const STOP_KEY_SAFE_WHEN_IDLE = 'claude';

/**
 * Whether an interrupt may actually press the stop key.
 *
 * IT IS SUPPRESSED WHEN NOTHING IS RUNNING, and that is a safety rule rather than an optimisation:
 * the stop key at an idle Codex prompt is one of the ways that TUI QUITS, so an interrupt sent to a
 * session the daemon merely believed was working would kill the agent it was asked to pause.
 *
 * The exception is an interactive Claude pane, where the stop key is exactly what the human at the
 * keyboard would press: it clears a half-typed composer or closes a menu, which is what "stop" means
 * to the person pressing it. Refusing to send it there made the control feel dead whenever the
 * daemon's view of the pane lagged by a tick.
 *
 * Either way the daemon still records the interrupt — the state edge is what the operator asked for,
 * and it does not depend on a keystroke that would have done nothing.
 */
export function shouldPressStopKey(target: SendTarget, pane: SendPaneObservation): boolean {
  if (pane.activeWork) return true;
  return target.mode === 'interactive' && target.harness === STOP_KEY_SAFE_WHEN_IDLE;
}

/** Whether this send is the reply the recipient's declared wait was parked on. */
export function endsPeerWait(recipient: SendTarget, senderId: string): boolean {
  return recipient.waiting?.peer === senderId;
}
