/**
 * A FORM CARD'S WORDS: how a filled-in form reads as the numbered answer the ferret receives, and what makes a
 * filled-in form acceptable. The one place those are decided, so the card the owner fills in, the daemon that
 * checks and records it and the CLI that prints it agree (docs/agenda.md, "Forms").
 *
 * The answer reads as numbered lines, one per field in the form's order:
 * `1. Region: EU`, `2. Alerts: Failures, Slow builds`, `3. Restart: Yes`, `4. Notes: <the typed text>`.
 */
import type { AgendaFormAnswer, AgendaFormField } from './agenda.ts';

/** The words a yes-or-no field is answered with. */
const FORM_YES = 'Yes';
const FORM_NO = 'No';

/** What a line says for a field the owner skipped: every field may be left empty (&F922). */
const FORM_UNANSWERED = '(skipped)';

/** The short word a field's line uses: its own `name`, else its question without the closing mark. */
export const formFieldName = (field: Pick<AgendaFormField, 'name' | 'label'>): string =>
  field.name?.trim() ??
  field.label
    .replaceAll(/\s+/gu, ' ')
    .trim()
    .replace(/[?:.!\s]+$/u, '');

/** The value a field is answered with, as a list: a pick-many holds several, every other field one. */
export const formValues = (answer: AgendaFormAnswer | undefined): readonly string[] =>
  answer === undefined ? [] : typeof answer.picked === 'string' ? [answer.picked] : answer.picked;

/** The answer to one field, if the owner gave one. */
export const formAnswerOf = (
  answers: readonly AgendaFormAnswer[],
  field: Pick<AgendaFormField, 'id'>,
): AgendaFormAnswer | undefined => answers.find(answer => answer.id === field.id);

/**
 * The form as the numbered answer: one `N. Name: value` entry per field in order (a field the owner skipped says
 * `(skipped)`), joined by `separator` — a line break for the ferret, ` · ` for a one-line summary.
 */
export const formWords = (
  fields: readonly AgendaFormField[],
  answers: readonly AgendaFormAnswer[],
  separator = '\n',
): string =>
  fields
    .map((field, index) => {
      const values = formValues(formAnswerOf(answers, field));
      return `${index + 1}. ${formFieldName(field)}: ${values.length === 0 ? FORM_UNANSWERED : values.join(', ')}`;
    })
    .join(separator);

/**
 * Everything wrong with answers to a form, each in plain words — empty when they fit: an answer to no field, a
 * field answered twice, a value that is not one of the field's options, or several values for a pick-one. A field
 * left empty is NOT a problem: every field is optional to the owner (&F922); a form answered with only words is sent
 * as a plain reply to its ask (`open-question`) instead.
 */
export const formAnswerProblems = (
  fields: readonly AgendaFormField[],
  answers: readonly AgendaFormAnswer[],
): string[] => {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const answer of answers) {
    const field = fields.find(each => each.id === answer.id);
    if (field === undefined) {
      problems.push(
        `there is no field "${answer.id}" on this form (fields: ${fields.map(each => each.id).join(', ')})`,
      );
      continue;
    }
    if (seen.has(answer.id)) problems.push(`field "${answer.id}" is answered twice`);
    seen.add(answer.id);
    const values = formValues(answer);
    if (field.type === 'text') {
      if (typeof answer.picked !== 'string') problems.push(`field "${field.id}" takes typed text, not a list`);
      continue;
    }
    if (field.type !== 'many' && values.length !== 1) problems.push(`field "${field.id}" takes exactly one answer`);
    const allowed =
      field.type === 'yesno' ? [FORM_NO, FORM_YES] : (field.options ?? []).map(option => option.label.trim());
    for (const value of values) {
      if (!allowed.includes(value.trim())) {
        problems.push(`"${value}" is not an option of field "${field.id}" (${allowed.join(', ')})`);
      }
    }
  }
  return problems;
};
