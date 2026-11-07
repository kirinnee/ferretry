/**
 * THE AGENDA'S CHAT FORMS: the one writer and the one reader of every message that names an agenda item.
 *
 * An agenda item and its ferret's conversation meet in ordinary chat messages (docs/agenda.md). The daemon
 * words them — the owner's answer from the board, a request for more information, a wish to talk an item
 * through, and the owner's own chat message that references items — and the app reads them back to draw
 * each as a compact card instead of its raw text. Both sides use THIS module, so the words the daemon writes
 * and the shape the app reads cannot drift apart (docs/standards/fact-ownership).
 *
 * Every form opens with a bracketed heading: a kind, then each item it is about as the reference grammar's
 * item token and its quoted ask or title (docs/reference-standard.md, "Agenda message headings"):
 *
 * ```text
 * [answer to !A3 «ask»] <answer>[ · note: <note>]
 * [done !A3 «ask»] The owner marked this done.
 * [dismissed !A3 «ask»] Not needed: <note>
 * [needs more info !A3 «ask»] <note>
 * [discuss !A3 «title»] The owner wants to talk this through before answering: <note>. Reply in chat …
 * [re !A5 «title», !A7 «title»] <the owner's words>
 * ```
 *
 * A burst of board answers is delivered as one message: each form, in the order given, a blank line apart.
 *
 * DEGRADE DIRECTION. A message the reader does not recognise in full is not an agenda message, and is
 * drawn as the words it is: the failure mode is raw text (what every message was before), never the
 * owner's words cut short or attributed to the wrong item.
 */

/** What a form says about the items it names. */
export type AgendaMessageKind = 'answer' | 'done' | 'dismissed' | 'needs-info' | 'discuss' | 're';

/** The words each kind's heading opens with. */
const OPENERS: Readonly<Record<AgendaMessageKind, string>> = {
  answer: 'answer to',
  done: 'done',
  dismissed: 'dismissed',
  'needs-info': 'needs more info',
  discuss: 'discuss',
  re: 're',
};

/** One item a heading names: its id (`A3`, without the `!`) and the ask or title quoted beside it. */
export interface AgendaMessageItem {
  readonly id: string;
  readonly quote: string;
}

/** One form, read. */
export interface AgendaMessagePart {
  readonly kind: AgendaMessageKind;
  /** Every item the heading names, in its order. Only `re` names more than one. */
  readonly items: readonly AgendaMessageItem[];
  /**
   * What the owner said, as the card shows it: the answer, the note, or their chat message. Empty when they
   * said nothing of their own — a discussion asked for without a note.
   */
  readonly text: string;
  /** The note the owner added under an answer, when there is one. */
  readonly note?: string;
  /** The form exactly as it was written. */
  readonly raw: string;
}

/** A message made of agenda forms only — one, or a batch. */
export interface AgendaMessage {
  readonly parts: readonly AgendaMessagePart[];
}

/** The longest ask quoted back to the ferret; the board holds the rest. */
export const AGENDA_QUOTE_CHARS = 120;

/** An ask or title as a heading quotes it: whole, or cut to {@link AGENDA_QUOTE_CHARS} and marked as cut. */
export const agendaQuote = (text: string): string =>
  text.length > AGENDA_QUOTE_CHARS ? `${text.slice(0, AGENDA_QUOTE_CHARS)}…` : text;

/** The separator between an answer and the owner's note under it. */
const NOTE_SEPARATOR = ' · note: ';

/** What a form says when the owner gave no words of their own. */
const DONE_BODY = 'The owner marked this done.';
const DISMISSED_NO_REASON = 'Not needed — the owner dismissed this without a reason.';
const DISMISSED_LEAD = 'Not needed: ';
const NEEDS_INFO_NO_NOTE = 'The owner needs more information.';

/** What a discussion says before the owner's note, and what it says after it. */
const DISCUSS_LEAD = 'The owner wants to talk this through before answering: ';
const DISCUSS_NO_NOTE = 'no note';
const discussTail = (binary: string, id: string): string =>
  `. Reply in chat to clear it up; then update the item (\`${binary} agenda edit ${id}\`) or close it if the premise was wrong (\`${binary} agenda done ${id}\`).`;

const named = (item: AgendaMessageItem): string => `!${item.id} «${agendaQuote(item.quote)}»`;

const heading = (kind: AgendaMessageKind, items: readonly AgendaMessageItem[]): string =>
  `[${OPENERS[kind]} ${items.map(named).join(', ')}]`;

/** The owner's answer to an item: the answer, and their note under it unless it only repeats the answer. */
export function agendaAnswerMessage(item: AgendaMessageItem, answer: string, note = ''): string {
  return `${heading('answer', [item])} ${answer}${note === '' || note === answer ? '' : `${NOTE_SEPARATOR}${note}`}`;
}

/** The owner marked an item done with no note. A done WITH a note is an answer: `Done · note: …`. */
export function agendaDoneMessage(item: AgendaMessageItem): string {
  return `${heading('done', [item])} ${DONE_BODY}`;
}

/** The owner dismissed an item, with their reason when they gave one. */
export function agendaDismissedMessage(item: AgendaMessageItem, note = ''): string {
  return `${heading('dismissed', [item])} ${note === '' ? DISMISSED_NO_REASON : `${DISMISSED_LEAD}${note}`}`;
}

/** The owner needs more information on an item before they can answer it. */
export function agendaNeedsInfoMessage(item: AgendaMessageItem, note = ''): string {
  return `${heading('needs-info', [item])} ${note === '' ? NEEDS_INFO_NO_NOTE : note}`;
}

/** The owner wants to talk an item through before answering it; `binary` names the CLI the ferret is told to run. */
export function agendaDiscussMessage(item: AgendaMessageItem, note: string, binary: string): string {
  return `${heading('discuss', [item])} ${DISCUSS_LEAD}${note === '' ? DISCUSS_NO_NOTE : note}${discussTail(binary, item.id)}`;
}

/** The owner's own chat message, naming the items it is about. */
export function agendaReMessage(items: readonly AgendaMessageItem[], message: string): string {
  return `${heading('re', items)} ${message}`;
}

/**
 * `!A3`, bounded exactly as the reference grammar bounds it (`packages/pwa/src/lib/references.ts`,
 * docs/reference-standard.md): after the start or a space/opening bracket/quote, and before the end,
 * a space, closing punctuation or a colon. Case-sensitive — `!a3` is prose.
 */
const AGENDA_REFERENCE = /(?:^|[\s([{"'`<>=—–])!(A[1-9][0-9]*)(?=$|[\s)\]}"'`,;!?<>:.=—–])/gu;

/** The item ids a message references (`!A3`), each once, in the order first named. */
export const referencedAgendaIds = (message: string): readonly string[] => [
  ...new Set([...message.matchAll(AGENDA_REFERENCE)].map(match => match[1] as string)),
];

/** An open item, as much of it as wording a chat reply about it needs. */
export interface AgendaReplyItem {
  readonly id: string;
  readonly notice?: true | undefined;
}

/**
 * THE OWNER'S CHAT MESSAGE AS THE FERRET RECEIVES IT — the one place it is worded, so what the daemon delivers
 * and what the app shows while it is on its way are the same text. A message naming open items (in `open`'s
 * order, notices left out) is headed `[re !A5 «title»]`; any other message goes exactly as typed.
 */
export function agendaChatReply<T extends AgendaReplyItem>(
  message: string,
  open: readonly T[],
  quote: (item: T) => string,
): { readonly message: string; readonly referenced: readonly T[] } {
  const ids = new Set(referencedAgendaIds(message));
  const referenced = open.filter(item => ids.has(item.id) && item.notice !== true);
  if (referenced.length === 0) return { message, referenced };
  return {
    message: agendaReMessage(
      referenced.map(item => ({ id: item.id, quote: quote(item) })),
      message,
    ),
    referenced,
  };
}

/** Several forms delivered as one message: in the order given, a blank line apart. */
export const agendaBatchMessage = (forms: readonly string[]): string => forms.join('\n\n');

/**
 * A heading at the start of the text. The quote is matched lazily up to the `»` that is followed by the next
 * item or the closing bracket, so an ask that itself holds `»` is still read whole. Ids are bounded exactly as
 * the reference grammar's item token: `A` and a positive number.
 */
const OPENER_WORDS = Object.values(OPENERS)
  .sort((left, right) => right.length - left.length)
  .join('|');
const ITEM = String.raw`!(A[1-9][0-9]*) «([\s\S]*?)»`;
const HEADING = new RegExp(String.raw`^\[(${OPENER_WORDS}) (${ITEM}(?:, ${ITEM})*)\](?: |$)`, 'u');
const HEADING_ITEM = new RegExp(String.raw`${ITEM}(?=, !A[1-9]|$)`, 'gu');
/** Where a batch's next form starts: a blank line, then a heading's opening. */
const NEXT_FORM = new RegExp(String.raw`\n\n(?=\[(?:${OPENER_WORDS}) !A[1-9][0-9]* «)`, 'u');

const KIND_OF: ReadonlyMap<string, AgendaMessageKind> = new Map(
  (Object.entries(OPENERS) as [AgendaMessageKind, string][]).map(([kind, opener]) => [opener, kind]),
);

/**
 * The owner's words in a form's body, as {@link AgendaMessagePart} names them: the stock words a form carries when
 * the owner gave none of their own ("The owner marked this done.") are not theirs, so they read as nothing.
 */
const said = (kind: AgendaMessageKind, body: string): { readonly text: string; readonly note?: string } => {
  if (kind === 'done') return { text: body === DONE_BODY ? '' : body };
  if (kind === 'needs-info') return { text: body === NEEDS_INFO_NO_NOTE ? '' : body };
  if (kind === 'dismissed') {
    if (body === DISMISSED_NO_REASON) return { text: '' };
    return { text: body.startsWith(DISMISSED_LEAD) ? body.slice(DISMISSED_LEAD.length) : body };
  }
  if (kind === 'answer') {
    const at = body.indexOf(NOTE_SEPARATOR);
    return at < 0 ? { text: body } : { text: body.slice(0, at), note: body.slice(at + NOTE_SEPARATOR.length) };
  }
  if (kind === 'discuss' && body.startsWith(DISCUSS_LEAD)) {
    const rest = body.slice(DISCUSS_LEAD.length);
    const end = rest.lastIndexOf('. Reply in chat to clear it up; ');
    const note = end < 0 ? rest : rest.slice(0, end);
    return { text: note === DISCUSS_NO_NOTE ? '' : note };
  }
  return { text: body };
};

/** One form, or `undefined` when the text does not open with a heading. */
const parsePart = (raw: string): AgendaMessagePart | undefined => {
  const match = HEADING.exec(raw);
  if (match === null) return undefined;
  const kind = KIND_OF.get(match[1] as string) as AgendaMessageKind;
  const items = [...(match[2] as string).matchAll(HEADING_ITEM)].map(each => ({
    id: each[1] as string,
    quote: each[2] as string,
  }));
  if (kind !== 're' && items.length !== 1) return undefined;
  return { kind, items, ...said(kind, raw.slice(match[0].length)), raw };
};

/**
 * A message read as agenda forms, or `undefined` when it is anything else. Every form of a batch must read:
 * one that does not means the message is not (only) the daemon's, so none of it is drawn as a card.
 */
export function parseAgendaMessage(text: string): AgendaMessage | undefined {
  const forms = text.trim().split(NEXT_FORM);
  const parts: AgendaMessagePart[] = [];
  for (const form of forms) {
    const part = parsePart(form);
    if (part === undefined) return undefined;
    parts.push(part);
  }
  return { parts };
}
