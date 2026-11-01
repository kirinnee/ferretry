/**
 * "WHAT I NEED FROM YOU" — the one segment of an open card that holds exactly the ask, so the owner always knows
 * what to do. It sits directly under the premise and context, before every optional section, and reads by the
 * card's shape (`agendaShape`; the words are the protocol's, `AGENDA_SHAPE_LEADS`):
 *
 *   choice / yes-no   the question, then each option with what it means (the answer row holds the buttons)
 *   approval          what is being approved, then its effect
 *   review            what to review, then its links
 *   reply             the question; the reply box below is the answer
 *   answers           a numbered list of each answer wanted, all given in one reply — never option buttons
 *   todo              what is to be done, then the steps, numbered, each ticked; then Mark as done
 *   info              the message; then Got it
 *
 * The first line is always the ask itself — the one question, else the item's one-line ask — even where the header
 * above says it too, so the segment reads whole on its own (several questions are their numbered list instead).
 * The last line is always the plain instruction: "Pick one option.", "Reply with your answers below, numbered."
 * The segment draws no buttons of its own beyond an old choice's extra options: the answer row under the card is
 * the one place an answer is given, so a button never appears twice.
 */

import { AGENDA_NEED_HEADING, AGENDA_SHAPE_LEADS, type AgendaQuestion, type AgendaShape } from '@ferretry/protocol';
import type { ReactNode } from 'react';
import { plainLabel } from '../../lib/plain-label.ts';

type Prose = (text: string) => ReactNode;

/** One answer the owner is asked for, as the numbered list says it: the question, and any choices it once had. */
export interface WantedAnswer {
  readonly question: string;
  /** An item raised before the rule may still carry options on one of several questions: said as words, never buttons. */
  readonly choices: readonly string[];
  /** What the ferret would answer, when it said. */
  readonly suggested?: string;
}

/** The answers a several-question (or mixed) card wants, in order; steps to follow add one asking that they were. */
export const wantedAnswers = (questions: readonly AgendaQuestion[], hasSteps: boolean): readonly WantedAnswer[] => [
  ...questions.map(each => ({
    question: each.question,
    choices: (each.options ?? []).map(option => plainLabel(option.label)),
    ...(each.recommended === undefined ? {} : { suggested: each.recommended }),
  })),
  ...(hasSteps ? [{ question: 'Have you done the steps below?', choices: [] }] : []),
];

/** The numbered list of answers wanted: one reply answers them all, by number. */
export function WantedAnswers({
  answers,
  renderProse,
}: {
  readonly answers: readonly WantedAnswer[];
  readonly renderProse: Prose;
}) {
  return (
    <ol className="fy-card__wanted" data-agenda-wanted="">
      {answers.map((answer, index) => (
        <li data-agenda-wanted-answer={index} key={`${String(index)}:${answer.question}`}>
          <span aria-hidden="true" className="fy-card__wanted-n">
            {index + 1}.
          </span>
          <div className="fy-card__wanted-body">
            {renderProse(answer.question)}
            {answer.choices.length === 0 ? null : (
              <p className="fy-card__wanted-choices" data-agenda-wanted-choices="">
                {answer.choices.join(' / ')}
              </p>
            )}
            {answer.suggested === undefined ? null : (
              <p className="fy-card__wanted-choices" data-agenda-wanted-suggested="">
                Suggested: {answer.suggested}
              </p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** The segment itself: its heading, what the card asks (its children), and the one plain instruction. */
export function AgendaNeed({
  shape,
  lead,
  heading = AGENDA_NEED_HEADING,
  children,
}: {
  readonly shape: AgendaShape;
  /** The instruction line; the shape's own when absent, none when empty (an item that cannot be answered here). */
  readonly lead?: string;
  /** The segment's heading when it is not "What I need from you" (a gate item's is its How to test). */
  readonly heading?: string;
  readonly children?: ReactNode;
}) {
  return (
    <section aria-label={heading} className="fy-card__need" data-agenda-need={shape}>
      <h4 className="fy-card__label fy-card__need-title">{heading}</h4>
      {children}
      {lead === '' ? null : (
        <p className="fy-card__need-lead" data-agenda-need-lead="">
          {lead ?? AGENDA_SHAPE_LEADS[shape]}
        </p>
      )}
    </section>
  );
}
