import { z } from 'zod';
import { QueueAuthorSchema } from './session-queue.ts';

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

/** What surrounds the path in a queued-message pointer, typed into a BUSY pane. */
const QUEUED_POINTER_HEAD = 'Read the queued message file at ';
const QUEUED_POINTER_TAIL = ' completely now, then follow every instruction inside it.';

/** What is typed into a ready pane so the agent picks up the turn written to `turnFile`. */
export function turnFileInstruction(turnFile: string): string {
  return `${TURN_POINTER_HEAD}${turnFile}${TURN_POINTER_TAIL}`;
}

/** What is typed into a BUSY pane when the message was too long to type and went to `payloadFile`. */
export function queuedMessageInstruction(payloadFile: string): string {
  return `${QUEUED_POINTER_HEAD}${payloadFile}${QUEUED_POINTER_TAIL}`;
}

/**
 * The name of one hand-off document inside a session: `turn-008` for a turn, `queued-<send id>` for a
 * message queued behind a busy turn. It is the document's own file stem, and the whole of what the
 * read route accepts — a closed grammar, so no caller can name a path.
 */
export const SessionHandoffNameSchema = z
  .string()
  .regex(/^(?:turn-\d{1,9}|queued-[\w-]{1,128})$/u, 'not a hand-off document name');
export type SessionHandoffName = z.infer<typeof SessionHandoffNameSchema>;

/** A pointer read back out of a transcript. */
export type HandoffPointer =
  | { readonly kind: 'turn'; readonly name: SessionHandoffName; readonly turn: number; readonly path: string }
  | { readonly kind: 'queued'; readonly name: SessionHandoffName; readonly sendId: string; readonly path: string };

const SEP = '[\\\\/]';
const TURN_FILE = new RegExp(`${SEP}turns${SEP}(turn-(\\d{1,9}))\\.md$`, 'u');
const QUEUED_FILE = new RegExp(`${SEP}channel${SEP}(queued-([\\w-]{1,128}))\\.md$`, 'u');

/** The path between a fixed head and tail, when `text` is exactly that sentence. */
const between = (text: string, head: string, tail: string): string | null =>
  text.startsWith(head) && text.endsWith(tail) && text.length > head.length + tail.length
    ? text.slice(head.length, text.length - tail.length)
    : null;

/**
 * The hand-off a user record IS, or `null` when it is anything else.
 *
 * The path is home-, user- and platform-agnostic: only its `…/turns/turn-NNN.md` or
 * `…/channel/queued-<id>.md` tail is read, because the state home is relocatable. The fixed sentence
 * around it, matched whole, is what keeps a person's prose from ever matching.
 */
export function parseHandoffPointer(text: string): HandoffPointer | null {
  const trimmed = text.trim();
  const turnPath = between(trimmed, TURN_POINTER_HEAD, TURN_POINTER_TAIL);
  const turn = turnPath === null ? null : TURN_FILE.exec(turnPath);
  if (turnPath !== null && turn !== null)
    return { kind: 'turn', name: turn[1] as string, turn: Number(turn[2]), path: turnPath };
  const queuedPath = between(trimmed, QUEUED_POINTER_HEAD, QUEUED_POINTER_TAIL);
  const queued = queuedPath === null ? null : QUEUED_FILE.exec(queuedPath);
  if (queuedPath !== null && queued !== null)
    return { kind: 'queued', name: queued[1] as string, sendId: queued[2] as string, path: queuedPath };
  return null;
}

/** How the turn-one document opens, above the task it assigns. */
const ASSIGNED_TASK_HEADING = '# Assigned task\n\n';

/** The turn-one document an agent reads. */
export function assignedTaskDocument(prompt: string): string {
  return `${ASSIGNED_TASK_HEADING}${prompt}\n`;
}

/** One file as the agent is told about it: the path of its delivered copy and its type. */
export interface DeliveredAttachment {
  readonly path: string;
  readonly mime: string;
}

/** The line that introduces the delivered files, after a blank line below the person's message. */
const ATTACHED_FILES = '\n\nAttached files — open them from these paths:\n';
const ATTACHED_LINE = /^- (.+) \(([^()\s]+)\)$/u;

/** The person's message, followed by the files the agent should open. */
export function messageWithAttachments(message: string, files: readonly DeliveredAttachment[]): string {
  if (files.length === 0) return message;
  const lines = files.map(file => `- ${file.path} (${file.mime})`);
  return `${message}${ATTACHED_FILES}${lines.join('\n')}`;
}

/**
 * Splits a delivered message into the person's words and the files named under it.
 *
 * Only a list in the LAST position, every line of which has the written shape, is taken off; anything
 * else leaves the text whole and names no files.
 */
export function parseMessageAttachments(text: string): {
  readonly message: string;
  readonly files: readonly DeliveredAttachment[];
} {
  const at = text.lastIndexOf(ATTACHED_FILES);
  if (at === -1) return { message: text, files: [] };
  const lines = text
    .slice(at + ATTACHED_FILES.length)
    .replace(/\n+$/u, '')
    .split('\n');
  const files: DeliveredAttachment[] = [];
  for (const line of lines) {
    const match = ATTACHED_LINE.exec(line);
    if (match === null) return { message: text, files: [] };
    files.push({ path: match[1] as string, mime: match[2] as string });
  }
  return { message: text.slice(0, at), files };
}

/**
 * The person's message, read back out of a hand-off document.
 *
 * `reminder` is the trailing protocol note a revived turn carries (the daemon's own setting), taken off
 * when the document ends with it. The turn-one heading and the attachment list are taken off by their
 * written shapes above.
 */
export function readHandoffDocument(
  document: string,
  reminder?: string,
): { readonly message: string; readonly files: readonly DeliveredAttachment[] } {
  let body = document.replace(/\n$/u, '');
  const note = reminder?.trim();
  if (note !== undefined && note !== '' && body.endsWith(`\n\n${note}`))
    body = body.slice(0, body.length - note.length - 2);
  if (body.startsWith(ASSIGNED_TASK_HEADING)) body = body.slice(ASSIGNED_TASK_HEADING.length);
  return parseMessageAttachments(body);
}

/** One attached file of a hand-off, as the app is shown it. */
export const SessionHandoffAttachmentSchema = z.strictObject({
  /** Present only when the file is one of THIS session's stored attachments, and so can be fetched. */
  attachmentId: z.string().min(1).optional(),
  filename: z.string().min(1),
  mime: z.string().min(1),
});
export type SessionHandoffAttachment = z.infer<typeof SessionHandoffAttachmentSchema>;

/** `GET /v1/sessions/:sessionId/handoffs/:name` — what the person actually sent in that hand-off. */
export const SessionHandoffSchema = z.strictObject({
  name: SessionHandoffNameSchema,
  message: z.string(),
  attachments: z.array(SessionHandoffAttachmentSchema),
  /**
   * Who the turn is from, when Ferretry wrote it — a Warden resume, a restart's notice — so the app shows a
   * sender chip rather than drawing Ferretry's words as the owner's. Never text in the message.
   */
  by: QueueAuthorSchema.optional(),
});
export type SessionHandoff = z.infer<typeof SessionHandoffSchema>;
