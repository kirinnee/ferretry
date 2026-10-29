import {
  type AttentionItem,
  type AttentionResponse,
  type AttentionSnapshot,
  attentionTitle,
  type ResolvedAttentionItem,
  type SessionAttentionSummary,
} from '@ferretry/protocol';

/**
 * HOW AN AGENDA ITEM AND ITS FERRET'S CONVERSATION MEET (docs/agenda.md).
 *
 * An item is raised by a ferret and answered by the owner on the board; the answer reaches the ferret as an
 * ordinary message that names the item it answers — `[answer to !A3 «ask»] <answer>` — so the ferret never
 * has to poll its board. The owner may also TALK about an item in the conversation by referencing it (`!A3`,
 * the reference grammar's item form, docs/reference-standard.md): the message reaches the ferret as
 * `[re !A3 «title»] <text>`, resolves NOTHING, and makes the item the ferret's turn. A plain message that
 * references nothing is delivered exactly as typed: the ferret learns of its items when something happens to
 * one, and reads its board on demand (`agenda ls`).
 *
 * Pure: every decision here is a function of the board and the words; the composition root does the
 * reading, the sending and the resolving.
 */

/**
 * `!A3`, bounded exactly as the reference grammar bounds it (`packages/pwa/src/lib/references.ts`,
 * docs/reference-standard.md): after the start or a space/opening bracket/quote, and before the end,
 * a space, closing punctuation or a colon. Case-sensitive — `!a3` is prose.
 */
const ATTENTION_REFERENCE = /(?:^|[\s([{"'`<>=—–])!(A[1-9][0-9]*)(?=$|[\s)\]}"'`,;!?<>:.=—–])/gu;

/** The longest ask quoted back to the ferret; the board holds the rest. */
const ASK_QUOTE_CHARS = 120;

const quoted = (ask: string): string => (ask.length > ASK_QUOTE_CHARS ? `${ask.slice(0, ASK_QUOTE_CHARS)}…` : ask);

const named = (item: Pick<AttentionItem, 'id' | 'subject'>): string => `!${item.id} «${quoted(item.subject)}»`;

const namedByTitle = (item: AttentionItem): string => `!${item.id} «${quoted(attentionTitle(item))}»`;

/** The open items a message references, in board order, each once. */
export function referencedAttention(message: string, items: readonly AttentionItem[]): readonly AttentionItem[] {
  const ids = new Set([...message.matchAll(ATTENTION_REFERENCE)].map(match => match[1]));
  return items.filter(item => ids.has(item.id));
}

/** The owner's answer in words: the choice they made, or what they wrote. */
export function responseWords(response: AttentionResponse): string {
  switch (response.kind) {
    case 'permission':
      return response.decision === 'approve' ? 'Approved.' : 'Rejected.';
    case 'multiple-choice':
      return response.choice;
    case 'answer-review':
      return response.verdict === 'good' ? 'Your answer is good.' : `Please clarify: ${response.clarification}`;
    case 'open-question':
      return response.answer;
    case 'other':
      return `Other answer (none of the options): ${response.answer}`;
  }
}

/**
 * The message a ferret receives when the owner closed one of ITS items on the board.
 *
 * EVERY CLOSING IS TOLD, the bare ones included. A ferret that asked and is told nothing waits on an
 * item the owner has already settled: the board resolved, the panel cleared, and the ferret's own chat
 * never said so (the live defect this replaced kept a bare done or dismiss silent, to spare a finished
 * ferret one turn). An answer carries the owner's words; a done or a dismiss says which it was, with
 * the owner's note when there is one. An answer the owner worded themselves (`Always allow — <reply>`, a
 * "Skip") reaches the ferret as the note under the answer's own effect, so what was decided and what was
 * said are both read.
 */
export function boardReplyMessage(item: ResolvedAttentionItem): string {
  const note = item.resolutionNote?.trim() ?? '';
  if (item.response !== undefined) {
    const words = responseWords(item.response);
    return `[answer to ${named(item)}] ${words}${note === '' || note === words ? '' : ` · note: ${note}`}`;
  }
  if (item.disposition === 'dismissed')
    return `[dismissed ${named(item)}] ${note === '' ? 'Not needed — the owner dismissed this without a reason.' : `Not needed: ${note}`}`;
  return note === ''
    ? `[done ${named(item)}] The owner marked this done.`
    : `[answer to ${named(item)}] Done · note: ${note}`;
}

/**
 * The message a ferret receives when the owner asks it for more information on one of ITS items. The item
 * stays open: the ferret answers by expanding it (`agenda edit`), not by closing it.
 */
export function needsInfoMessage(item: AttentionItem): string {
  const note = item.history?.findLast(entry => entry.kind === 'needs-info')?.note?.trim() ?? '';
  return `[needs more info ${named(item)}] ${note === '' ? 'The owner needs more information.' : note}`;
}

/**
 * The message a ferret receives when the owner, looking at a SURFACED item, wants to talk it through before answering —
 * they do not follow it, or its premise is wrong. The item stays open: the ferret answers in chat, then
 * updates the item (`agenda edit`) or closes it when the premise was wrong (`agenda done`).
 */
export function discussMessage(item: AttentionItem, binary: string): string {
  const note = item.history?.findLast(entry => entry.kind === 'discuss')?.note?.trim() ?? '';
  const heading = `!${item.id} «${quoted(attentionTitle(item))}»`;
  return `[discuss ${heading}] The owner wants to talk this through before answering: ${note === '' ? 'no note' : note}. Reply in chat to clear it up; then update the item (\`${binary} agenda edit ${item.id}\`) or close it if the premise was wrong (\`${binary} agenda done ${item.id}\`).`;
}

/** What a person's chat message becomes once the open board is taken into account. */
export interface ConversationTurn {
  /** The words the ferret receives. */
  readonly message: string;
  /** The open items the message names; the composition root makes each the ferret's turn once it is accepted. */
  readonly referenced: readonly AttentionItem[];
}

/**
 * A person's message to a ferret, read against that ferret's open items.
 *
 * - It references open items (`!A5`, typed or from the app's "re:" chips; several): it is delivered as
 *   `[re !A5 «title», !A7 «title»] <text>`, NOTHING resolves — a chat message is never an answer — and each item
 *   becomes the FERRET's turn until it edits the item or surfaces it.
 * - It references none: delivered exactly as typed, however many items are open.
 */
export function conversationTurn(message: string, open: readonly AttentionItem[]): ConversationTurn {
  const referenced = referencedAttention(message, open).filter(item => item.notice !== true);
  return {
    message: referenced.length === 0 ? message : `[re ${referenced.map(namedByTitle).join(', ')}] ${message}`,
    referenced,
  };
}

/** An item on the FERRET's turn because the owner wrote about it or asked to talk it through (not for more information). */
export function inDiscussion(item: Pick<AttentionItem, 'waitingOn' | 'waitingFor'>): boolean {
  return item.waitingOn !== undefined && item.waitingFor === 'discussion';
}

/**
 * The session list's view of a board: how many items are open, how many of those are the ferret's turn,
 * which is oldest, and when the newest was raised — or `undefined` when nothing is open.
 *
 * A NOTICE (`fy notify`) is read, not answered, so it is no part of the agenda's counts. `first` is the
 * oldest item that is the owner's turn, falling back to the oldest open one when every open item is the
 * ferret's: a row opens to what waits on the owner. `discussing` counts the ferret's turns apart, which keeps
 * them out of the needs-you count while every device still re-reads the board when one starts or ends.
 */
export function sessionAttentionSummary(snapshot: AttentionSnapshot): SessionAttentionSummary | undefined {
  const items = snapshot.items.filter(item => item.notice !== true);
  const [oldest] = items;
  if (oldest === undefined) return undefined;
  const first = items.find(item => !inDiscussion(item)) ?? oldest;
  const latestAt = items.reduce(
    (latest, item) => (item.waitingSince.localeCompare(latest) > 0 ? item.waitingSince : latest),
    oldest.waitingSince,
  );
  const discussing = items.filter(inDiscussion).length;
  return {
    open: items.length,
    first: first.id,
    ask: first.subject,
    latestAt,
    ...(discussing === 0 ? {} : { discussing }),
  };
}
