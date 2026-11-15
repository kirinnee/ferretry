import type { Question } from '../../../contract/index.ts';
import type { StructuredQuestionAnswer } from '../../seams/protocol.ts';

/** What a question the owner left blank is answered: every question is optional, so the form still goes in one go. */
const SKIPPED_ANSWER = 'skipped';

/** What the owner's answer on the Agenda said, as the Agenda recorded it: a form's values by field id, or plain words. */
export interface AgendaAnswerSaid {
  readonly values?: Readonly<Record<string, string>> | undefined;
  readonly text?: string | undefined;
}

export type AgendaAnswerMapping =
  | { readonly ok: true; readonly answers: readonly StructuredQuestionAnswer[] }
  | { readonly ok: false; readonly reason: string };

type Asked = Pick<Question, 'options' | 'multiple'>;

/** The questions one tool call asked, in order: the first, then each of `more`. */
const askedOf = (question: Question): readonly Asked[] => [question, ...(question.more ?? [])];

/**
 * The pick-many field's value is its labels joined with ", " (the Agenda records one text per field). Read it back
 * against the labels the question offers, longest first, so a label that itself holds ", " is not cut in two. Anything
 * the options do not account for entirely is the owner's own words.
 */
function pickedLabels(value: string, offered: readonly string[]): readonly string[] | undefined {
  const known = [...offered].sort((a, b) => b.length - a.length);
  const picked: string[] = [];
  let rest = value;
  while (rest !== '') {
    const label = known.find(each => rest === each || rest.startsWith(`${each}, `));
    if (label === undefined) return undefined;
    picked.push(label);
    rest = rest === label ? '' : rest.slice(label.length + 2);
  }
  return picked.length > 0 && new Set(picked).size === picked.length ? picked : undefined;
}

/** One question's answer from the words the owner gave it: an offered option is a selection, anything else is typed. */
function answerFor(asked: Asked, said: string): StructuredQuestionAnswer {
  const words = said.trim();
  if (words === '') return { kind: 'other', text: SKIPPED_ANSWER };
  const offered = asked.options.map(option => option.label);
  if (asked.multiple) {
    const labels = pickedLabels(words, offered);
    if (labels !== undefined) return { kind: 'selection', labels: [...labels] };
  } else if (offered.includes(words)) return { kind: 'selection', labels: [words] };
  return { kind: 'other', text: words };
}

/**
 * A plain numbered reply — `1. EU`, then `3. yes` on a later line — as one answer per question, in order (v4's
 * `plainNumberedAnswers`): a number starts an answer that runs until the next, and a question with no number is
 * skipped. `undefined` unless the reply STARTS with a number and every number rises and stays within the questions:
 * nothing is guessed from prose.
 */
function numberedAnswers(text: string, count: number): readonly string[] | undefined {
  const found = new Map<number, string[]>();
  let current: string[] | undefined;
  let last = 0;
  for (const line of text.split('\n')) {
    // A number counts only with a space or the line's end after it: "1.5 GB" is prose, not answer 1.
    const head = /^\s*(\d+)[.)](?:\s+(.*))?$/u.exec(line);
    const number = head === null ? Number.NaN : Number(head[1]);
    if (head !== null) {
      if (number <= last || number > count) return undefined;
      last = number;
      current = [head[2] ?? ''];
      found.set(number, current);
    } else if (current === undefined) {
      if (line.trim() !== '') return undefined;
    } else current.push(line);
  }
  if (found.size === 0) return undefined;
  return Array.from({ length: count }, (_, index) => (found.get(index + 1) ?? []).join('\n').trim());
}

/**
 * The owner's answer on the Agenda, as the answers the question's own form is driven with (v4's
 * `harnessQuestionAnswers`). A form card names its fields `1`, `2`, … in the order the questions were asked, so field
 * N is exactly question N; a card that could not be a form (a reply) carries plain words, which answer a single
 * question directly and several questions only when they are numbered. Never a guess: what cannot be mapped is refused
 * with the reason, and the card stays open.
 */
export function agendaAnswers(question: Question, said: AgendaAnswerSaid): AgendaAnswerMapping {
  const asked = askedOf(question);
  const { values } = said;
  if (values !== undefined) {
    const unknown = Object.keys(values).find(id => !asked.some((_, index) => id === String(index + 1)));
    if (unknown !== undefined)
      return { ok: false, reason: `the answer names a field (${unknown}) the question does not have` };
    return { ok: true, answers: asked.map((each, index) => answerFor(each, values[String(index + 1)] ?? '')) };
  }
  const text = said.text?.trim() ?? '';
  const [only] = asked;
  if (only !== undefined && asked.length === 1) return { ok: true, answers: [answerFor(only, text)] };
  const parts = numberedAnswers(text, asked.length);
  if (parts === undefined)
    return {
      ok: false,
      reason: `the reply does not number its answers to the ${asked.length} questions (1. …, 2. …)`,
    };
  return { ok: true, answers: asked.map((each, index) => answerFor(each, parts[index] ?? '')) };
}
