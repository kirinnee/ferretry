import {
  type AttentionItem,
  type AttentionResponse,
  type AttentionSnapshot,
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
 * the item (`!A3`, the reference grammar's Attention form, docs/reference-standard.md); a plain
 * message that references nothing never resolves anything, but it tells the ferret which items are
 * still open so it can resolve one itself when the message settled it.
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
 * the owner's note when there is one.
 */
export function boardReplyMessage(item: ResolvedAttentionItem): string {
  const note = item.resolutionNote?.trim() ?? '';
  if (item.response !== undefined) {
    const words = responseWords(item.response);
    return `[answer to ${named(item)}] ${words}${note === '' || note === words ? '' : `\n\nNote: ${note}`}`;
  }
  if (item.disposition === 'dismissed')
    return `[dismissed ${named(item)}] ${note === '' ? 'The owner dismissed this without an answer.' : note}`;
  return note === '' ? `[done ${named(item)}] The owner marked this done.` : `[answer to ${named(item)}] ${note}`;
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
 * - It references none and items are open: delivered as written, with one trailing line naming them,
 *   so the ferret can resolve one itself if the message settled it. Nothing is resolved for it.
 * - Nothing is open: unchanged.
 */
export function conversationTurn(message: string, open: readonly AttentionItem[], binary: string): ConversationTurn {
  const answers = referencedAttention(message, open);
  if (answers.length > 0) return { message: `[answer to ${answers.map(named).join(', ')}] ${message}`, answers };
  if (open.length === 0) return { message, answers };
  return {
    message: `${message}\n\n[open attention: ${open.map(named).join('; ')} — if this message settles one, resolve it with \`${binary} attention done <id>\`]`,
    answers,
  };
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

/**
 * The session list's view of a board: how many items are open, which is oldest, and when the newest
 * was raised — or `undefined` when nothing is open.
 */
export function sessionAttentionSummary(snapshot: AttentionSnapshot): SessionAttentionSummary | undefined {
  const [first] = snapshot.items;
  if (first === undefined) return undefined;
  const latestAt = snapshot.items.reduce(
    (latest, item) => (item.waitingSince.localeCompare(latest) > 0 ? item.waitingSince : latest),
    first.waitingSince,
  );
  return { open: snapshot.items.length, first: first.id, ask: first.subject, latestAt };
}
