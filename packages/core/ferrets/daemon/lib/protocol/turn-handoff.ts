import { FERRET_CHANNEL_FOLDER } from '../../../contract/sessions-root.ts';

/**
 * How the daemon hands an agent a message through a FILE, and how the app reads that hand-off back.
 *
 * WHY A FILE. A long, multi-line or attached message typed into a terminal composer gets mangled —
 * quoting, paste handling and line breaks each turn one message into several — so the daemon writes the
 * message to a document in the session's own directory and types one short line that points at it. The
 * agent's transcript therefore records THAT line as what "the user" said, and an app that showed it
 * verbatim drew a bubble reading "Read the file …/turn-008.md now, then carefully follow every
 * instruction inside it" where the person's own words belong — which reads exactly like an injected
 * instruction.
 *
 * ONE OWNER FOR BOTH ENDS, for the reason `agent-messages.ts` gives: the daemon writes these sentences
 * and the app recognises them, the two live in packages that may not import one another, and a pointer
 * the daemon rewords while the app still matches the old wording would silently put the raw instruction
 * back in the person's bubble. So every sentence and document shape is written once, here, beside the
 * parser that reads it.
 *
 * THE PARSERS DEGRADE ONE WAY. A pointer is recognised only as the WHOLE message, so a person who quotes
 * one inside their own sentence keeps their sentence; and a document whose attachment list does not have
 * exactly the shape written below is returned as text rather than half-stripped.
 */

/** What follows the path in a turn pointer. */
const TURN_POINTER_TAIL =
  ' now, then carefully follow every instruction inside it. This is your complete task for this turn.';
const TURN_POINTER_HEAD = 'Read the file ';

/** What is typed into a ready pane so the agent picks up the turn written to `turnFile`. */
export function turnFileInstruction(turnFile: string): string {
  return `${TURN_POINTER_HEAD}${turnFile}${TURN_POINTER_TAIL}`;
}

/** How the turn-one document opens, above the task it assigns. */
const ASSIGNED_TASK_HEADING = '# Assigned task\n\n';

/** The turn-one document an agent reads. */
export function assignedTaskDocument(prompt: string): string {
  return `${ASSIGNED_TASK_HEADING}${prompt}\n`;
}

/** What surrounds the path in a queued-message pointer, typed into a BUSY pane (today's protocol, word for word). */
const QUEUED_POINTER_HEAD = 'Read the queued message file at ';
const QUEUED_POINTER_TAIL = ' completely now, then follow every instruction inside it.';

/** What is typed into a BUSY pane when the message was too long to type and went to `payloadFile`. */
export function queuedMessageInstruction(payloadFile: string): string {
  return `${QUEUED_POINTER_HEAD}${payloadFile}${QUEUED_POINTER_TAIL}`;
}

/**
 * The longest message typed INLINE into a busy pane's own queue (today's `nativeQueueInlineMaxChars`). A longer one is
 * written to a file in the ferret's own `channel/` folder and the queue is handed the one-line pointer instead: a long
 * paste into a working harness's composer is the one the queue proof least often recognises.
 */
const NATIVE_QUEUE_INLINE_MAX_CHARS = 1_000;

/** Whether a native-queue ride must go through a file rather than the composer (today's `isFileBackedQueue`). */
export function isFileBackedQueue(payload: string): boolean {
  return payload.length > NATIVE_QUEUE_INLINE_MAX_CHARS;
}

/**
 * A send id that may name a queued-message file: inside the protocol's closed grammar (`queued-[\w-]{1,128}`), and in
 * LOWER case only. On a filesystem that ignores case (macOS by default) two ids that differ only by case would name one
 * file, so the later send would overwrite the earlier one still waiting in the queue; an id with a capital takes a fresh
 * (lower-case) id instead, which only loses the link from the file to its send's row. Send ids are lower case in practice.
 */
const QUEUED_NAME = /^[a-z0-9_-]{1,128}$/u;

/**
 * The queued-message file for `sendId`, relative to the ferret's own session folder: `channel/queued-<send id>.md`, the
 * name the app reads back out of the pointer (`turn-handoff.ts`). An id outside the grammar names no file.
 */
export function queuedPayloadFile(sendId: string): string | undefined {
  return QUEUED_NAME.test(sendId) ? `${FERRET_CHANNEL_FOLDER}/queued-${sendId}.md` : undefined;
}
