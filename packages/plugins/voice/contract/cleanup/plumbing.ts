/**
 * Recognisers for Ferretry's own plumbing messages, so a dictation cleanup never reads them as something a person
 * said. These are READ-ONLY copies of the three recognisers the conversation transcript uses (the `[ferretry]` notice
 * tag, a turn or queued hand-off pointer, a peer-ferret banner): they match the wording Conversation writes today and
 * only ever strip it from the reference text. When Conversation's contract exports them, this file is replaced by that
 * import.
 */

const NOTICE_TAG = '[ferretry] ';

/** The notice's text without its tag; `null` when the message is not a Ferretry notice. */
export function parseFerretryNotice(text: string): string | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(NOTICE_TAG)) return null;
  const notice = trimmed.slice(NOTICE_TAG.length).trim();
  return notice === '' ? null : notice;
}

const TURN_POINTER_TAIL =
  ' now, then carefully follow every instruction inside it. This is your complete task for this turn.';
const TURN_POINTER_HEAD = 'Read the file ';
const QUEUED_POINTER_HEAD = 'Read the queued message file at ';
const QUEUED_POINTER_TAIL = ' completely now, then follow every instruction inside it.';

const SEP = '[\\\\/]';
const TURN_FILE = new RegExp(`${SEP}turns${SEP}(turn-(\\d{1,9}))\\.md$`, 'u');
const QUEUED_FILE = new RegExp(`${SEP}channel${SEP}(queued-([\\w-]{1,128}))\\.md$`, 'u');

const between = (text: string, head: string, tail: string): string | null =>
  text.startsWith(head) && text.endsWith(tail) && text.length > head.length + tail.length
    ? text.slice(head.length, text.length - tail.length)
    : null;

/** A hand-off pointer, recognised only as the WHOLE message. */
export function parseHandoffPointer(text: string): { readonly kind: 'turn' | 'queued'; readonly path: string } | null {
  const trimmed = text.trim();
  const turnPath = between(trimmed, TURN_POINTER_HEAD, TURN_POINTER_TAIL);
  if (turnPath !== null && TURN_FILE.test(turnPath)) return { kind: 'turn', path: turnPath };
  const queuedPath = between(trimmed, QUEUED_POINTER_HEAD, QUEUED_POINTER_TAIL);
  if (queuedPath !== null && QUEUED_FILE.test(queuedPath)) return { kind: 'queued', path: queuedPath };
  return null;
}

/** The one-line banner a peer ferret's message opens with. */
const PEER_BANNER =
  /^\[(?:(\d+)\/(\d+) · )?(message|question|reply)(?: · (blocker|action|fyi))? from ferret ([^\s(\]]+)([^\]]*)\] ((?:To reply: |[^\n]+ is waiting for your answer\. Reply with: )[^\n]*)\n/u;

/** Splits a peer message into the message itself; `null` when it carries no banner. */
export function parsePeerEnvelope(text: string): { readonly body: string } | null {
  const oneLine = PEER_BANNER.exec(text);
  if (oneLine !== null) return { body: text.slice(oneLine[0].length) };
  return null;
}
