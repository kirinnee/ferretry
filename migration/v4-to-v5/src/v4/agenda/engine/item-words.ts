// VENDORED from v4.291.5 (64fd8cbcc811e2341f1ab18be170d76106a44852) packages/daemon/src/lib/agenda/item-words.ts, verbatim except the @ferretry/protocol import path.
// The converter's own frozen v4 reader: never imported by the product. Do not edit; re-vendor instead.
import type { AgendaConversationEntry, AgendaItem, AgendaResponse, ResolvedAgendaItem } from '../protocol/index.ts';
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

const WORKING = /^working: ([\s\S]+)$/u;

/**
 * THE MIGRATION'S SEED: the conversation an item from before it was stored already holds, read from what it kept —
 * the notes of its history (the owner's requests and replies, the ferret's `surface` why and `rest` line), the owner's
 * answer note, the ferret's answer to their question, and the note it was closed with. Nothing that was kept is dropped.
 * A history entry past the history bound is gone already, and cannot come back; an answer to the owner's question has
 * no time of its own, so it takes the time of the latest edit that changed it, else the ferret's last update (or when
 * the item began waiting).
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
  const answeredBy = item.revisions?.findLast(revision => revision.changed.includes('questionAnswer'))?.at;
  seeded.push(
    wordsOf(
      answeredBy ?? lastUpdate ?? answeredAt ?? item.waitingSince,
      'ferret',
      'question-answer',
      item.questionAnswer,
    ),
  );
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

/** An item as its latest recorded version kept it: when, the bounded item, and the whole thread, tags included. */
export interface RecordedItem {
  readonly at: string;
  readonly item: AgendaItem | ResolvedAgendaItem;
  readonly conversation: readonly AgendaConversationEntry[];
}

/** The version's thread holds words from this word's speaker, so it was kept when the version was recorded. */
const covered = (base: readonly AgendaConversationEntry[], word: AgendaConversationEntry): boolean =>
  base.some(entry => entry.by === word.by);

const sameWords = (left: AgendaConversationEntry, right: AgendaConversationEntry): boolean =>
  left.by === right.by && left.text === right.text;

/**
 * THE THREAD AFTER A ROUND TRIP THROUGH A DAEMON THAT DOES NOT KEEP ONE: the item's latest recorded version holds the
 * whole thread as it stood (verbatim, tagged, in order), and the history `seeded` from what the older daemon kept says
 * what was said since. A seeded word at or before the version is already in it, once the version's thread holds words
 * from its speaker (a version recorded before the item's older words were kept holds none); a later one is added unless it is
 * there (the same chat message, or the same time, speaker and text). The ferret's answer to a question has no time of
 * its own, so it is matched by its text alone and, when new, placed no earlier than the version whenever the version's
 * thread holds any words (the owner's alone included), even if the edit that dated it is gone.
 *
 * Pure and total: nothing the version holds is dropped or changed, and nothing is said twice.
 */
export function resumedConversation(
  recorded: Pick<RecordedItem, 'at' | 'conversation'>,
  seeded: readonly AgendaConversationEntry[],
): AgendaConversationEntry[] {
  const base = recorded.conversation;
  const after = Date.parse(recorded.at);
  const added: AgendaConversationEntry[] = [];
  for (const word of seeded) {
    const message = word.fromChat?.messageId;
    if (message !== undefined && base.some(entry => entry.fromChat?.messageId === message)) continue;
    const answer = word.via === 'question-answer';
    const older = Date.parse(word.at) <= after && covered(base, word);
    if (answer ? base.some(entry => entry.via === word.via && sameWords(entry, word)) : older) continue;
    const placed = answer && base.length > 0 && Date.parse(word.at) < after ? { ...word, at: recorded.at } : word;
    if ([...base, ...added].some(entry => entry.at === placed.at && sameWords(entry, placed))) continue;
    added.push(placed);
  }
  return interleaved(base, added);
}

const LINKS = ['relatedTasks', 'mergedFrom', 'mergedInto', 'splitFrom', 'splitInto'] as const;

/**
 * THE LINKS AN OLDER DAEMON'S WRITE STRIPS: the cards a merge brought in and the merge and split links between items.
 * They are the item's, so one the item lacks comes back from its latest recorded version; one it still holds stays.
 * The same item when it lacks none.
 */
export function relinked<Item extends AgendaItem | ResolvedAgendaItem>(item: Item, recorded: RecordedItem): Item {
  const missing = LINKS.filter(key => item[key] === undefined && recorded.item[key] !== undefined);
  if (missing.length === 0) return item;
  return { ...item, ...Object.fromEntries(missing.map(key => [key, recorded.item[key]])) };
}
