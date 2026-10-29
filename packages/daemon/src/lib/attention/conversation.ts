import {
  type AttentionItem,
  type AttentionResponse,
  type AttentionSnapshot,
  attentionTitle,
  MAX_ATTENTION_DETAIL_LENGTH,
  type ResolvedAttentionItem,
  type SessionAttentionSummary,
} from '@ferretry/protocol';

/**
 * HOW AN ATTENTION ITEM AND ITS FERRET'S CONVERSATION MEET (docs/attention.md).
 *
 * An item is raised by a ferret, answered by the owner, and the answer reaches the ferret as an
 * ordinary message that names the item it answers — `[answer to !A3 «ask»] <answer>` — so the ferret
 * never has to poll its board. The owner may also answer in the conversation itself by referencing
 * the item (`!A3`, the reference grammar's Attention form, docs/reference-standard.md). A plain message
 * that references nothing is delivered exactly as typed and resolves nothing: a footer naming every open
 * item on every message was re-read on every later turn for no gain, so the ferret learns of its items
 * when something happens to one, and reads its board on demand (`attention ls`).
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
    return `[answer to ${named(item)}] ${words}${note === '' || note === words ? '' : `\n\nNote: ${note}`}`;
  }
  if (item.disposition === 'dismissed')
    return `[dismissed ${named(item)}] ${note === '' ? 'The owner dismissed this without an answer.' : note}`;
  return note === ''
    ? `[done ${named(item)}] The owner marked this done.`
    : `[answer to ${named(item)}] Done.\n\nNote: ${note}`;
}

/**
 * The message a ferret receives when the owner asks it for more information on one of ITS items. The item
 * stays open: the ferret answers by expanding it (`attention edit`), not by closing it.
 */
export function needsInfoMessage(item: AttentionItem): string {
  const note = item.history?.findLast(entry => entry.kind === 'needs-info')?.note?.trim() ?? '';
  return `[needs more info ${named(item)}] ${note === '' ? 'The owner needs more information.' : note}`;
}

/**
 * The message a ferret receives when the owner wants to talk one of ITS items through before answering —
 * they do not follow it, or its premise is wrong. The item stays open: the ferret answers in chat, then
 * updates the item (`attention edit`) or closes it when the premise was wrong (`attention done`).
 */
export function discussMessage(item: AttentionItem, binary: string): string {
  const note = item.history?.findLast(entry => entry.kind === 'discuss')?.note?.trim() ?? '';
  const heading = `!${item.id} «${quoted(attentionTitle(item))}»`;
  return `[discuss ${heading}] The owner wants to talk this through before answering: ${note === '' ? 'no note' : note}. Reply in chat to clear it up; then update the item (\`${binary} attention edit ${item.id}\`) or close it if the premise was wrong (\`${binary} attention done ${item.id}\`).`;
}

/** What a person's chat message becomes once the open board is taken into account. */
export interface ConversationTurn {
  /** The words the ferret receives. */
  readonly message: string;
  /** The open items the message answers; the composition root resolves them once it is accepted. */
  readonly answers: readonly AttentionItem[];
}

/**
 * A person's message to a ferret, read against that ferret's open items.
 *
 * - It references open items: it IS the answer to them — prefixed `[answer to !A3 «ask»]` so the
 *   ferret knows what it answers, and they resolve.
 * - It references none: delivered exactly as typed, however many items are open. Nothing is resolved.
 * - An item IN DISCUSSION is never answered by chat: the owner asked to talk it through, and talking about
 *   it (the app's answer chip still names it) is that discussion, delivered as typed. The ferret ends the
 *   discussion by updating or closing the item; the owner answers it on its card.
 */
export function conversationTurn(message: string, open: readonly AttentionItem[]): ConversationTurn {
  const answers = referencedAttention(message, open).filter(item => !inDiscussion(item));
  if (answers.length > 0) return { message: `[answer to ${answers.map(named).join(', ')}] ${message}`, answers };
  return { message, answers };
}

/**
 * How a chat message answers one item on the board, or `undefined` when it can only RESOLVE it (with
 * the message as the note): an open question takes the words as its answer, and a choice takes them
 * only when, once the reference is taken out, they name one of its options exactly. Anything else —
 * no ask, a permission, a review — is never guessed from prose.
 */
export function conversationResponse(item: AttentionItem, message: string): AttentionResponse | undefined {
  // The words without the references that named the item: "!A3 eu-west-1" answers "eu-west-1".
  const answer = message
    .replaceAll(ATTENTION_REFERENCE, match => match.slice(0, match.indexOf('!')))
    .replace(/\s+/gu, ' ')
    .trim();
  if (answer === '' || item.ask === undefined) return undefined;
  if (item.ask.kind === 'open-question')
    return { kind: 'open-question', answer: answer.slice(0, MAX_ATTENTION_DETAIL_LENGTH) };
  if (item.ask.kind !== 'multiple-choice') return undefined;
  const words = answer.toLowerCase();
  const option = item.ask.options.find(candidate => candidate.label.trim().toLowerCase() === words);
  return option === undefined ? undefined : { kind: 'multiple-choice', choice: option.label };
}

/** An item the owner asked to talk through, now waiting on the ferret's reply rather than on the owner. */
export function inDiscussion(item: Pick<AttentionItem, 'waitingOn' | 'waitingFor'>): boolean {
  return item.waitingOn !== undefined && item.waitingFor === 'discussion';
}

/**
 * The session list's view of a board: how many items are open, how many of those are in discussion, which
 * is oldest, and when the newest was raised — or `undefined` when nothing is open.
 *
 * `first` is the oldest item that still needs the owner, falling back to the oldest open one when every open
 * item is in discussion: a row opens to what waits on the owner. Counting the discussions apart is what keeps
 * them out of the needs-you count while every device still re-reads the board when one starts or ends.
 */
export function sessionAttentionSummary(snapshot: AttentionSnapshot): SessionAttentionSummary | undefined {
  const [oldest] = snapshot.items;
  if (oldest === undefined) return undefined;
  const first = snapshot.items.find(item => !inDiscussion(item)) ?? oldest;
  const latestAt = snapshot.items.reduce(
    (latest, item) => (item.waitingSince.localeCompare(latest) > 0 ? item.waitingSince : latest),
    oldest.waitingSince,
  );
  const discussing = snapshot.items.filter(inDiscussion).length;
  return {
    open: snapshot.items.length,
    first: first.id,
    ask: first.subject,
    latestAt,
    ...(discussing === 0 ? {} : { discussing }),
  };
}
