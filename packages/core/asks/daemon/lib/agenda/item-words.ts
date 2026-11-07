import type { AgendaConversationEntry, AgendaResponse } from '../protocol/agenda.ts';
import type { AgendaActor } from './state-machine.ts';

/**
 * WHAT IS SAID ON AN ITEM (docs/agenda.md § The conversation): the pure helpers that keep `AgendaItem.conversation` —
 * every word the owner and the ferret say about it, oldest first, whole. The transitions write it and a merge
 * interleaves two.
 */

type Speaker = AgendaConversationEntry['by'];
type Via = AgendaConversationEntry['via'];

/** Who an actor is in a conversation: the owner, a ferret (or its lead), or the daemon. */
export const speakerOf = (actor: AgendaActor): Speaker =>
  actor.kind === 'human' ? 'owner' : actor.kind === 'agent' ? 'ferret' : 'daemon';

/** One thing said, or nothing when there are no words; text keeps every source character, including boundary whitespace. */
export function wordsOf(
  at: string,
  by: Speaker,
  via: Via,
  text: string | null | undefined,
  fromChat?: AgendaConversationEntry['fromChat'],
): AgendaConversationEntry | undefined {
  const words = text ?? '';
  if (words.trim() === '') return undefined;
  return {
    at,
    by,
    via,
    text: words,
    ...(fromChat === undefined ? {} : { fromChat }),
  };
}

/** The item's conversation with the entries appended; the fields to spread onto the item (none when nothing was said). */
export function said(
  item: { readonly conversation?: readonly AgendaConversationEntry[] | undefined },
  ...entries: readonly (AgendaConversationEntry | undefined)[]
): { conversation?: AgendaConversationEntry[] } {
  const added = entries.filter((entry): entry is AgendaConversationEntry => entry !== undefined);
  return added.length === 0 ? {} : { conversation: [...(item.conversation ?? []), ...added].sort(byTime) };
}

/** Whether a chat message was already logged on the item (`fy agenda log` is idempotent per message). */
export const loggedFromChat = (
  item: { readonly conversation?: readonly AgendaConversationEntry[] | undefined },
  messageId: string,
): boolean => (item.conversation ?? []).some(entry => entry.fromChat?.messageId === messageId);

const byTime = (left: AgendaConversationEntry, right: AgendaConversationEntry): number =>
  Date.parse(left.at) - Date.parse(right.at);

/** Two conversations as one, interleaved by time; on a tie the first one's entries come first. Nothing is dropped. */
export function interleaved(
  first: readonly AgendaConversationEntry[] | undefined,
  second: readonly AgendaConversationEntry[] | undefined,
): AgendaConversationEntry[] {
  return [...(first ?? []), ...(second ?? [])].sort(byTime);
}

/**
 * Two conversations merged into one: {@link interleaved}, minus the absorbed entries the survivor already holds — the
 * same chat message (one message that names both items is logged on both) or the very same entry. Nothing else is dropped.
 */
export function mergedThreads(
  survivor: readonly AgendaConversationEntry[] | undefined,
  absorbed: readonly AgendaConversationEntry[] | undefined,
): AgendaConversationEntry[] {
  const messages = new Set(
    (survivor ?? []).flatMap(entry => (entry.fromChat === undefined ? [] : [entry.fromChat.messageId])),
  );
  const exact = new Set((survivor ?? []).map(entry => JSON.stringify(entry)));
  return interleaved(
    survivor,
    (absorbed ?? []).filter(
      entry =>
        !(entry.fromChat !== undefined && messages.has(entry.fromChat.messageId)) && !exact.has(JSON.stringify(entry)),
    ),
  );
}

/** The textual parts of an answer, in source order, with an optional distinct note. */
export function responseWords(response: AgendaResponse | undefined, note?: string | null): string[] {
  const words: string[] = [];
  if (response?.kind === 'open-question' || response?.kind === 'other') words.push(response.answer);
  if (response?.kind === 'answer-review' && response.verdict === 'clarify') words.push(response.clarification);
  if (response?.kind === 'form') {
    for (const answer of response.answers) {
      if (typeof answer.picked === 'string') words.push(answer.picked);
    }
  }
  if (note !== undefined && note !== null && note.trim() !== '' && !words.includes(note)) words.push(note);
  return words;
}
