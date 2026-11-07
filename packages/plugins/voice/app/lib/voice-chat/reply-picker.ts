/**
 * WHICH WORDS OF A FINISHED TURN GET READ ALOUD. Pure and total: rows in, one pick out, never a throw.
 *
 * The page already holds the conversation as rows (history and live records, plus the send ledger, merged
 * by `session-screens.ts`). This reads them and decides, for a turn that has just ended:
 *
 *   - `your-turn`: ONLY the LAST `chat.assistant.text` of the turn ("Last message of the turn", the
 *     default) — or every one of them, when the person chose "Every message". A turn that wrote no text
 *     says "Done. No message." so a silent turn is not mistaken for a broken one.
 *   - `needs-input`: the question, and its options when it is a choice. It is only ever READ: this module
 *     has no way to answer, and nothing in voice chat accepts an answer by voice.
 *
 * What is never read: the person's own messages, messages from other ferrets (a `peer`), agenda and
 * system rows, notices, thinking and tool calls (they are not `assistant` rows at all), a message this
 * ferret SENT to another one, and Pack commands. Only the agent's own words to the person.
 *
 * "The turn" is what came after the person's last message. A row from before that point is never picked, so a
 * turn with no text cannot fall back to the previous turn's last reply. `pickLatestReply` is that and nothing
 * more (the reply to a send); `pickReply` can also cut a turn by its dated start or by rows already held
 * (a turn only watched, and the live reader).
 */

/** The part of a transcript row this module reads: `TranscriptEntry` satisfies it as it is. */
export interface PickerRow {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
  readonly at?: number;
  readonly sent?: unknown;
  /** The delivered send a person's row IS (the transcript's own join to the daemon's ledger): the exact proof of whose row it is. */
  readonly send?: { readonly sendId: string } | undefined;
  readonly pack?: unknown;
  readonly peer?: unknown;
}

export type WhatToRead = 'last' | 'every';

export interface ReplyPick {
  /**
   * The row to show captions on (the last text of the turn), or a made-up key for words that have no
   * row (a silent turn, a question) so nothing is mistaken for a real message.
   */
  readonly key: string;
  /** What to say, as markdown for `speakableSegments`. Never empty. */
  readonly markdown: string;
  readonly reason: 'reply' | 'no-message' | 'question';
}

export const NO_MESSAGE_WORDS = 'Done. No message.';
export const QUESTION_ON_SCREEN_WORDS = 'The ferret needs your answer. It is on screen.';

/** The harness clock can sit behind the browser's: a row this much before the turn start still belongs to it, and one that began the turn may be this much after it. */
const CLOCK_SLACK_MS = 5_000;

/** The key of a reading that has no message row. */
export const SILENT_TURN_KEY = 'auto-read:no-message';
export const QUESTION_KEY = 'auto-read:question';

const isAssistantWords = (row: PickerRow): boolean =>
  row.kind === 'assistant' &&
  row.sent === undefined &&
  row.pack === undefined &&
  row.peer === undefined &&
  typeof row.text === 'string' &&
  row.text.trim() !== '';
/**
 * Where a turn began. A turn that began with a SEND from this page names the rows the page already held
 * when the person pressed send (`knownIds`): the turn starts at the first row of the person's that is not
 * among them, however the two clocks disagree and whatever they send next. Any other turn is dated
 * (`startedAt`, ms; null when unknown).
 */
export interface TurnStart {
  readonly startedAt: number | null;
  readonly knownIds?: readonly string[] | undefined;
}

const isPersonsRow = (row: PickerRow): boolean => row.kind === 'user' && row.peer === undefined;

/** The index of the row that begins the turn (-1: the whole conversation is the turn). */
const boundaryOf = (rows: readonly PickerRow[], start: TurnStart, startedAt: number | null): number => {
  if (start.knownIds !== undefined) {
    const known = new Set(start.knownIds);
    const initiating = rows.findIndex(row => isPersonsRow(row) && !known.has(row.id));
    // The send's own row has not shown yet: the turn begins after everything the page already held.
    return initiating !== -1 ? initiating : rows.findLastIndex(row => known.has(row.id));
  }
  // The turn begins at the last message the PERSON put to the agent that is not later than the turn
  // itself, so a follow-up sent after the start never moves it. Another ferret's message (a `peer`) can
  // arrive in the middle of a turn without ending it.
  let boundary = -1;
  rows.forEach((row, index) => {
    if (isPersonsRow(row) && (startedAt === null || row.at === undefined || row.at <= startedAt)) boundary = index;
  });
  if (startedAt === null) return boundary;
  // CLOCK SKEW, separately: the row that began the turn can be dated a little AFTER the turn's start when
  // the harness clock runs ahead. It counts only if it is the first of the person's rows dated after the
  // start, within the slack, and the agent has not answered before it: a follow-up never qualifies.
  const later = rows.findIndex(row => isPersonsRow(row) && row.at !== undefined && row.at > startedAt);
  const lateAt = rows[later]?.at;
  const answered = rows
    .slice(boundary + 1, Math.max(later, 0))
    .some(row => isAssistantWords(row) && (row.at === undefined || row.at > startedAt));
  return later > boundary && lateAt !== undefined && lateAt <= startedAt + CLOCK_SLACK_MS && !answered
    ? later
    : boundary;
};

/** The rows of the turn, oldest first. */
const rowsOfTurn = (rows: readonly PickerRow[], start: TurnStart): readonly PickerRow[] => {
  const startedAt = start.startedAt !== null && Number.isFinite(start.startedAt) ? start.startedAt : null;
  const after = rows.slice(boundaryOf(rows, start, startedAt) + 1);
  // A send names its own boundary, so the clocks are not consulted for it.
  if (start.knownIds !== undefined || startedAt === null) return after;
  return after.filter(row => row.at === undefined || row.at >= startedAt - CLOCK_SLACK_MS);
};

/** The words to say for the assistant texts of a turn (oldest first), or that there were none. */
const replyOf = (texts: readonly PickerRow[], whatToRead: WhatToRead): ReplyPick => {
  const last = texts.at(-1);
  if (last === undefined) return { key: SILENT_TURN_KEY, markdown: NO_MESSAGE_WORDS, reason: 'no-message' };
  if (whatToRead === 'every') {
    return { key: last.id, markdown: texts.map(row => row.text.trim()).join('\n\n'), reason: 'reply' };
  }
  return { key: last.id, markdown: last.text, reason: 'reply' };
};

/** The words of a turn that ended with `your-turn`, cut by the turn's dated start (or by the rows held when a send was pressed). */
export const pickReply = (
  rows: readonly PickerRow[],
  from: TurnStart | number | null,
  whatToRead: WhatToRead = 'last',
): ReplyPick => {
  const start: TurnStart = typeof from === 'object' && from !== null ? from : { startedAt: from };
  return replyOf(rowsOfTurn(Array.isArray(rows) ? rows : [], start).filter(isAssistantWords), whatToRead);
};

/**
 * The words of the turn that has just ended, with nothing inferred: the assistant text AFTER THE LAST ROW
 * THE PERSON PUT TO THE AGENT that is present now (the whole conversation when there is none). A turn that
 * wrote no text after that row says "Done. No message." — it never falls back to an earlier turn's words.
 */
export const pickLatestReply = (rows: readonly PickerRow[], whatToRead: WhatToRead = 'last'): ReplyPick => {
  const held = Array.isArray(rows) ? rows : [];
  return replyOf(held.slice(held.findLastIndex(isPersonsRow) + 1).filter(isAssistantWords), whatToRead);
};

/** What the daemon's ledger says about a send from this page: enough to recognise the send's own row in the transcript. */
export interface SendEvidence {
  readonly sendId: string;
  /** The message as sent (the ledger's `message`); absent when the ledger entry is not at hand. */
  readonly message?: string | undefined;
  /** When the daemon accepted it (ms, the daemon's clock); null when unreadable. */
  readonly acceptedAt: number | null;
}

const normalized = (value: string): string => value.normalize('NFC').trim().replace(/\s+/gu, ' ');

/**
 * Is this row of the person's the send's own? By identity when the transcript joined it to the ledger
 * (`row.send`): exactly that send, and no other. A row not joined yet counts only when its words are the
 * send's message and it is dated no earlier than the daemon accepted the send (the harness records it after
 * the daemon accepted it, on the daemon's own machine: no slack, because a missed match only costs a wait
 * while a false one reads the wrong reply), so an older row with the same words is never mistaken for it.
 */
const isOwnRow = (row: PickerRow, send: SendEvidence): boolean => {
  if (!isPersonsRow(row)) return false;
  if (row.send !== undefined) return row.send.sendId === send.sendId;
  const message = typeof send.message === 'string' ? normalized(send.message) : '';
  return (
    message !== '' &&
    send.acceptedAt !== null &&
    row.at !== undefined &&
    row.at >= send.acceptedAt &&
    normalized(row.text) === message
  );
};

/**
 * The reply to ONE send from this page, or null while there is no evidence it is in the rows: the words are
 * the assistant text after THE SEND'S OWN ROW (and before the next row of the person's), so nothing from
 * before the send — the previous turn's answer, a transcript that has not caught up — can be picked. Null
 * says "wait for the transcript"; a send whose row is there but whose turn wrote no text says "Done. No
 * message.".
 */
export const pickReplyToSend = (
  rows: readonly PickerRow[],
  send: SendEvidence,
  whatToRead: WhatToRead = 'last',
): ReplyPick | null => {
  const held = Array.isArray(rows) ? rows : [];
  const own = held.findLastIndex(row => isOwnRow(row, send));
  if (own === -1) return null;
  const after = held.slice(own + 1);
  const next = after.findIndex(isPersonsRow);
  return replyOf((next === -1 ? after : after.slice(0, next)).filter(isAssistantWords), whatToRead);
};

/** The question a `needs-input` turn is waiting on: the shape of the daemon's `pendingQuestion`. */
export interface QuestionLike {
  readonly questions?: readonly {
    readonly question?: string;
    readonly options?: readonly { readonly label?: string }[];
    readonly multiSelect?: boolean;
  }[];
}

const ORDINALS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];
const MAX_OPTIONS_READ = 8;

const sentence = (text: string): string => {
  const trimmed = text.trim();
  return /[.!?…]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
};

/** The words of a turn that ended with `needs-input`. With nothing readable it just says where to look. */
export const pickQuestion = (question: QuestionLike | null | undefined): ReplyPick => {
  const asked = Array.isArray(question?.questions) ? (question?.questions ?? []) : [];
  const lines: string[] = [];
  for (const item of asked) {
    const text = typeof item?.question === 'string' ? item.question.trim() : '';
    if (text === '') continue;
    lines.push(sentence(text));
    const options: readonly { readonly label?: string }[] = Array.isArray(item.options) ? item.options : [];
    const labels = options
      .map(option => (typeof option?.label === 'string' ? option.label.trim() : ''))
      .filter(label => label !== '');
    if (labels.length === 0) continue;
    const read = labels.slice(0, MAX_OPTIONS_READ).map((label, index) => `${ORDINALS[index] ?? index + 1}, ${label}`);
    const more = labels.length > MAX_OPTIONS_READ ? ` And ${labels.length - MAX_OPTIONS_READ} more on screen.` : '';
    lines.push(`${item.multiSelect === true ? 'You can pick more than one. ' : ''}Options: ${read.join('; ')}.${more}`);
  }
  if (lines.length === 0) return { key: QUESTION_KEY, markdown: QUESTION_ON_SCREEN_WORDS, reason: 'question' };
  return { key: QUESTION_KEY, markdown: `The ferret asks. ${lines.join(' ')}`, reason: 'question' };
};

/**
 * Everything the page can show as "the ferret needs you" — one of four shapes, any of which can park a
 * `needs-input` turn. Each is carried as plain data; none of them is a way to answer.
 */
export interface NeedsInputSources {
  /** The question the agent asked (`pendingQuestion`). */
  readonly question?: QuestionLike | null | undefined;
  /** The tool-permission prompt its pane is parked on. */
  readonly permissionRequest?:
    | {
        readonly tool?: string;
        readonly question?: string;
        readonly options?: readonly { readonly label?: string }[];
      }
    | null
    | undefined;
  /** The harness's own dialog (hooks to review, a sign-in). */
  readonly harnessDialog?:
    | { readonly title?: string; readonly options?: readonly { readonly label?: string }[] }
    | null
    | undefined;
  /** The daemon's one-line reason, when it has nothing richer. */
  readonly turnPrompt?: string | null | undefined;
}

const hasText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

/**
 * The most specific prompt there is, as read-only question data for {@link pickQuestion}: a permission
 * prompt first, then the harness's dialog (they share one pane, so never both), then the agent's own
 * question, then the daemon's one-line reason. Null when there is nothing to read.
 */
export const needsInputOf = (sources: NeedsInputSources): QuestionLike | null => {
  const { permissionRequest: permission, harnessDialog: dialog } = sources;
  if (hasText(permission?.question)) {
    const tool = hasText(permission.tool) ? `${permission.tool.trim()}: ` : '';
    return { questions: [{ question: `${tool}${permission.question}`, options: permission.options ?? [] }] };
  }
  if (hasText(dialog?.title)) return { questions: [{ question: dialog.title, options: dialog.options ?? [] }] };
  if (sources.question !== null && sources.question !== undefined) return sources.question;
  if (hasText(sources.turnPrompt)) return { questions: [{ question: sources.turnPrompt }] };
  return null;
};
