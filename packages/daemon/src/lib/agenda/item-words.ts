import type { AgendaConversationEntry, AgendaItem, AgendaResponse, ResolvedAgendaItem } from '@ferretry/protocol';
import type { AgendaActor } from './state-machine.ts';

/**
 * WHAT IS SAID ON AN ITEM (docs/agenda.md § The conversation): the pure helpers that keep `AgendaItem.conversation` —
 * every word the owner and the ferret say about it, oldest first, whole. The transitions write it, the read-time
 * migration seeds it from an item's history, and a merge interleaves two.
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

const WORKING = /^working: ([\s\S]+)$/u;

/**
 * THE MIGRATION'S SEED: the conversation an item from before it was stored already holds, read from what it kept —
 * the notes of its history (the owner's requests and replies, the ferret's `surface` why and `rest` line), the owner's
 * answer note, the ferret's answer to their question, and the note it was closed with. Nothing that was kept is dropped.
 * A history entry past the history bound is gone already, and cannot come back; an answer to the owner's question has
 * no time of its own, so it takes the ferret's last update (or when the item began waiting).
 *
 * Pure and total: an item with no words seeds nothing.
 */
export function seedConversation(item: AgendaItem | ResolvedAgendaItem): AgendaConversationEntry[] {
  const seeded: (AgendaConversationEntry | undefined)[] = [];
  const answeredAt = item.ownerAnswer?.at;
  let lastUpdate: string | undefined;
  for (const entry of item.history ?? []) {
    switch (entry.kind) {
      case 'needs-info':
        seeded.push(wordsOf(entry.at, 'owner', 'needs-info', entry.note));
        break;
      case 'discuss':
        seeded.push(wordsOf(entry.at, 'owner', 'discuss', entry.note));
        break;
      case 'replied':
        for (const text of responseWords(entry.response, entry.note)) {
          seeded.push(
            wordsOf(
              entry.at,
              'owner',
              entry.response !== undefined || entry.at === answeredAt ? 'answer' : 'reply',
              text,
            ),
          );
        }
        break;
      case 'surfaced':
        seeded.push(wordsOf(entry.at, 'ferret', 'surface', entry.note));
        break;
      case 'updated':
        lastUpdate = entry.at;
        seeded.push(wordsOf(entry.at, 'ferret', 'rest', WORKING.exec(entry.note ?? '')?.[1]));
        break;
      case 'gate-answered':
        break;
    }
  }
  const owner = item.ownerAnswer;
  for (const text of responseWords(owner?.response, owner?.note)) {
    if (owner !== undefined && !seeded.some(entry => entry?.at === owner.at && entry.text === text)) {
      seeded.push(wordsOf(owner.at, 'owner', 'answer', text));
    }
  }
  seeded.push(wordsOf(lastUpdate ?? answeredAt ?? item.waitingSince, 'ferret', 'question-answer', item.questionAnswer));
  if ('resolvedAt' in item && typeof item.resolvedAt === 'string') {
    for (const text of responseWords(item.response, item.response === undefined ? undefined : item.resolutionNote)) {
      if (!seeded.some(entry => entry?.at === item.resolvedAt && entry.text === text)) {
        seeded.push(
          wordsOf(
            item.resolvedAt,
            item.resolvedBy === 'human' ? 'owner' : item.resolvedBy === 'agent' ? 'ferret' : 'daemon',
            'answer',
            text,
          ),
        );
      }
    }
    seeded.push(
      wordsOf(
        item.resolvedAt,
        item.resolvedBy === 'human' ? 'owner' : item.resolvedBy === 'agent' ? 'ferret' : 'daemon',
        item.response === undefined ? 'close' : 'answer',
        item.response === undefined ? item.resolutionNote : undefined,
      ),
    );
  }
  return seeded.filter((entry): entry is AgendaConversationEntry => entry !== undefined).sort(byTime);
}
