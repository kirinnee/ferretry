/**
 * "IS THIS ONE DECISION?" — the warning `fy agenda add` gives when an ask looks like two (docs/agenda.md § One channel
 * per topic). Two independent decisions with different backgrounds, or at different speeds, belong in two agendas;
 * two that change each other belong in one. A ferret cannot always tell from the words, so this only WARNS, and says
 * both rules; it never refuses.
 *
 * Pure and total: the controller hands it the composed add, and prints what it returns.
 */

/** What the heuristic reads of a new item: its one-line ask and its questions. */
export interface DecisionShape {
  readonly subject: string;
  readonly questions?: readonly { readonly question: string }[] | undefined;
}

/** Words that say a question is wanted soon. */
const SOON =
  /\b(now|today|tonight|asap|urgent(?:ly)?|immediately|right away|this morning|this afternoon|before (?:the|we|i|you|it|merging|release|deploy)\b|blocking|blocked)\b/iu;

/** Words that say a question can wait. */
const LATER =
  /\b(later|eventually|someday|some day|no rush|whenever|when you can|when you have time|next (?:week|month|quarter|sprint|release)|long[- ]term|in the future|down the line)\b/iu;

/** A question mark that ends a question: followed by a space or the end, so `?q=1` in a link is not one. */
const QUESTION_END = /\?(?=\s|$)/gu;

/** How many separate questions one line asks. */
export const questionCount = (line: string): number => (line.match(QUESTION_END) ?? []).length;

/** The pace a question's words speak of: soon, later, or nothing said. */
export const paceOf = (text: string): 'soon' | 'later' | undefined =>
  SOON.test(text) ? 'soon' : LATER.test(text) ? 'later' : undefined;

/**
 * Why an add looks like two decisions, one reason a line; empty when it looks like one. The signals: the one-line ask
 * itself asks two or more questions, or its questions speak of different paces (one now, one later).
 */
export function twoDecisionSignals(shape: DecisionShape): string[] {
  const signals: string[] = [];
  const asked = questionCount(shape.subject);
  if (asked >= 2) signals.push(`the ask asks ${String(asked)} questions in one line`);
  const paces = new Set((shape.questions ?? []).map(question => paceOf(question.question)));
  if (paces.has('soon') && paces.has('later'))
    signals.push('its questions are wanted at different paces (one soon, one later)');
  return signals;
}

/** The warning itself, or nothing: the signals, then the two rules the ferret decides with. */
export function twoDecisionsWarning(shape: DecisionShape): string | undefined {
  const signals = twoDecisionSignals(shape);
  if (signals.length === 0) return undefined;
  return [
    `This looks like two decisions: ${signals.join('; ')}.`,
    'Two independent decisions with different backgrounds or paces belong in two agendas; if deciding one changes the',
    'other, they share one. If they are independent, raise each where it belongs.',
  ].join('\n');
}
