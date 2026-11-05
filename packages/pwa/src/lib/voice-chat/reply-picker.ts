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
 * "The turn" is what came after the person's last message that started it. A row from before that point
 * is never picked, so a turn with no text cannot fall back to the previous turn's last reply.
 */

/** The part of a transcript row this module reads: `TranscriptEntry` satisfies it as it is. */
export interface PickerRow {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
  readonly at?: number;
  readonly sent?: unknown;
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

/** The harness clock can sit behind the browser's; a row this much before the turn start still belongs to it. */
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

/** The rows of the turn that began at `startedAt` (ms; null when unknown), oldest first. */
const rowsOfTurn = (rows: readonly PickerRow[], given: number | null): readonly PickerRow[] => {
  const startedAt = given !== null && Number.isFinite(given) ? given : null;
  // The turn begins after the last message the PERSON put to the agent that is not later than the turn
  // itself. Another ferret's message (a `peer`) can arrive in the middle of a turn without ending it.
  let boundary = -1;
  rows.forEach((row, index) => {
    if (row.kind !== 'user' || row.peer !== undefined) return;
    const at = row.at;
    if (startedAt === null || at === undefined || at <= startedAt + CLOCK_SLACK_MS) boundary = index;
  });
  return rows.slice(boundary + 1).filter(row => {
    if (startedAt === null || row.at === undefined) return true;
    return row.at >= startedAt - CLOCK_SLACK_MS;
  });
};

/** The words of a turn that ended with `your-turn`. */
export const pickReply = (
  rows: readonly PickerRow[],
  startedAt: number | null,
  whatToRead: WhatToRead = 'last',
): ReplyPick => {
  const texts = rowsOfTurn(Array.isArray(rows) ? rows : [], startedAt).filter(isAssistantWords);
  const last = texts.at(-1);
  if (last === undefined) return { key: SILENT_TURN_KEY, markdown: NO_MESSAGE_WORDS, reason: 'no-message' };
  if (whatToRead === 'every') {
    return { key: last.id, markdown: texts.map(row => row.text.trim()).join('\n\n'), reason: 'reply' };
  }
  return { key: last.id, markdown: last.text, reason: 'reply' };
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
