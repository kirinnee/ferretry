import { messageWithAttachments, parseHandoffPointer, readHandoffDocument } from '@ferretry/protocol';
import { type HandoffDocuments, withoutHarnessBlocks } from '../../imports/conversation-text.ts';

/**
 * What a user record says once the harness's and Ferretry's own wrapping is taken off it.
 *
 * Two kinds of wrapping ride inside user records and were never typed by anybody:
 *
 *   * THE HARNESS'S. Reminder blocks, Codex's AGENTS.md and environment blocks, Claude's slash-command
 *     echoes — the same closed blocks the conversation list strips ({@link withoutHarnessBlocks}).
 *     The target harness injects its own on every turn, so carrying the source's would make the
 *     agent read two contradictory environments.
 *   * FERRETRY'S DELIVERY. A message too long to type reaches the CLI as one pointer line ("Read the
 *     file …/turns/turn-007.md now…"). The pointer is replaced by the document it names when the
 *     caller could read it, because the document IS the message; an unread pointer is kept as it is,
 *     since the file is still on disk inside a folder the target agent may read.
 *
 * A delivery's attachment list is KEPT: it is the person's own reference to the files they sent.
 */

/** kteam's turn-one document: a contract first, then the task under this heading. */
const ASSIGNED_TASK_MARKER = '\n# Assigned task\n\n';

/** Whole messages a CLI writes as the user that say nothing about the conversation. */
const NOISE = new Set(['[Request interrupted by user]', '[Request interrupted by user for tool use]']);

/** The message a hand-off document carries, with its attachment list, without the turn-one contract. */
function documentMessage(document: string): string {
  const task = document.indexOf(ASSIGNED_TASK_MARKER);
  const body = task === -1 ? document : document.slice(task + ASSIGNED_TASK_MARKER.length);
  const read = readHandoffDocument(body);
  return messageWithAttachments(read.message, read.files);
}

/** The person's words in one user text, or `undefined` when nothing in it was said by anybody. */
export function userText(text: string, documents: HandoffDocuments): string | undefined {
  const pointer = parseHandoffPointer(text);
  const document = pointer === null ? undefined : documents.get(pointer.path);
  const message = withoutHarnessBlocks(document === undefined ? text : documentMessage(document));
  return message === '' || NOISE.has(message) ? undefined : message;
}

/** Ferretry's two pointer sentences, wherever they sit inside a transcript's raw records. */
const POINTER_PATHS = /Read the (?:file|queued message file at) (\/[^\s"\\]+?\.md)(?= now| completely now)/gu;

/** The hand-off documents a transcript's pointers name, for the caller to read before converting. */
export function handoffPointerPaths(text: string): readonly string[] {
  return [...new Set([...text.matchAll(POINTER_PATHS)].map(match => match[1] as string))];
}
