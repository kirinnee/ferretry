/**
 * THE STRUCTURED PART OF AN ATTENTION ITEM, as collapsible sections: Context · Terms · Questions ·
 * Recommendation · Impact · Links, each only when the item has it. Every surface draws the same ones
 * (the inbox card, the in-ferret sheet and the board page), so a reader learns one layout.
 *
 * Collapsed by default EXCEPT the first question: the reader sees what they are being asked without
 * opening anything. Native `<details>` — keyboard and screen-reader friendly, no state to lose.
 *
 * An item with SEVERAL questions and an open-question ask is answered one answer per question: each
 * question gets its own picker here, and the answers leave together (`composeQuestionAnswers`).
 */

import type { AttentionItem, AttentionLink, AttentionQuestion } from '@ferretry/protocol';
import { Check, ChevronRight, ExternalLink } from 'lucide-react';
import { type ReactNode, useId } from 'react';

type AttentionProse = (text: string) => ReactNode;

const POINT = /^\s*[-*•]\s+(\S.*)$/u;

/** The points of a text written as bullets (every non-blank line one), or `null` when it is prose. */
export function bulletPoints(text: string): readonly string[] | null {
  const lines = text.split(/\r?\n/u).filter(line => line.trim() !== '');
  const points = lines.map(line => POINT.exec(line)?.[1]?.trim());
  return lines.length > 0 && points.every(point => point !== undefined) ? (points as string[]) : null;
}

/** Plain text drawn in point form: a bullet list when it is written as bullets, a paragraph otherwise. */
export function PointForm({ text, className = '' }: { readonly text: string; readonly className?: string }) {
  const points = bulletPoints(text);
  if (points === null) return <p className={`${className} m-0 whitespace-pre-wrap break-words`.trim()}>{text}</p>;
  return (
    <ul className={`fy-attn-points ${className}`.trim()}>
      {points.map((point, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: points repeat; their order is their identity
        <li key={index}>{point}</li>
      ))}
    </ul>
  );
}

/** The picks a several-question item collects before "Send answers". */
interface QuestionAnswers {
  readonly answers: readonly string[];
  readonly onAnswer: (index: number, answer: string) => void;
  readonly disabled: boolean;
}

/** The word the badge on a recommended option says; a badge, so the pick never rests on colour alone. */
const RECOMMENDED_WORD = 'Recommended';

export function RecommendedBadge() {
  return (
    <span className="fy-attn-recommended" data-attention-recommended="">
      <Check aria-hidden="true" size={11} />
      {RECOMMENDED_WORD}
    </span>
  );
}

function Section({
  name,
  title,
  open = false,
  children,
}: {
  readonly name: string;
  readonly title: string;
  readonly open?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <details className="fy-attn-sec" data-attention-section={name} open={open}>
      <summary className="fy-attn-sec__title">
        <ChevronRight aria-hidden="true" className="fy-attn-sec__chevron" size={14} />
        {title}
      </summary>
      <div className="fy-attn-sec__body">{children}</div>
    </details>
  );
}

const REFERENCE_TARGET = /^(?:[#!][A-Za-z]?\d+|@\S+|[%][a-z]+:\S+|&\S+|[$/][A-Za-z][\w-]*)$/u;
const PATH_TARGET = /^(?:\.{0,2}\/|~\/)\S+$/u;

/** One link: a URL opens outside, a reference or a file goes through the reference surface. */
function AttentionLinkRow({
  link,
  renderProse,
}: {
  readonly link: AttentionLink;
  readonly renderProse: AttentionProse;
}) {
  const target = link.target.trim();
  const label = link.label?.trim() || target;
  if (/^https?:\/\//iu.test(target)) {
    return (
      <a className="fy-attn-link" href={target} rel="noreferrer noopener" target="_blank">
        <ExternalLink aria-hidden="true" size={12} />
        <span>{label}</span>
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    );
  }
  const reference = PATH_TARGET.test(target) ? `@${target}` : REFERENCE_TARGET.test(target) ? target : null;
  return (
    <span className="fy-attn-link fy-attn-link--ref">
      {link.label?.trim() ? <span className="text-muted">{label}</span> : null}
      {reference === null ? <span className="mono">{target}</span> : renderProse(reference)}
    </span>
  );
}

function QuestionPicker({
  question,
  index,
  picker,
}: {
  readonly question: AttentionQuestion;
  readonly index: number;
  readonly picker: QuestionAnswers;
}) {
  const textId = useId();
  const answer = picker.answers[index] ?? '';
  const recommended = question.recommended?.trim();
  const selected = question.options?.some(option => option.label === answer) ?? false;
  return (
    <div className="fy-attn-q__picker">
      {question.options === undefined ? null : (
        <fieldset aria-label={`Options for question ${index + 1}`} className="fy-attn-q__options">
          {question.options.map(option => (
            <button
              aria-pressed={answer === option.label}
              className="kt-attn-option fy-attn-q__option"
              data-attention-pick={option.label}
              disabled={picker.disabled}
              key={option.label}
              onClick={() => picker.onAnswer(index, answer === option.label ? '' : option.label)}
              type="button"
            >
              <span className="kt-attn-option__body">
                <span className="kt-attn-option__label">{option.label}</span>
                {option.description === undefined ? null : (
                  <span className="kt-attn-option__hint">{option.description}</span>
                )}
              </span>
              {recommended === option.label ? <RecommendedBadge /> : null}
            </button>
          ))}
        </fieldset>
      )}
      <label className="sr-only" htmlFor={textId}>
        {`Your own answer to question ${index + 1}`}
      </label>
      <input
        className="kt-input fy-attn-q__text"
        disabled={picker.disabled}
        id={textId}
        onChange={event => picker.onAnswer(index, event.target.value)}
        placeholder={question.options === undefined ? 'Your answer…' : 'Or write your own…'}
        type="text"
        value={selected ? '' : answer}
      />
    </div>
  );
}

function Question({
  question,
  index,
  numbered,
  picker,
  showWhy,
}: {
  readonly question: AttentionQuestion;
  readonly index: number;
  readonly numbered: boolean;
  readonly picker: QuestionAnswers | undefined;
  /** Show the recommendation's reason here; the option buttons live elsewhere for a single question. */
  readonly showWhy: boolean;
}) {
  const recommended = question.recommended?.trim();
  return (
    <>
      <p className="fy-attn-q__ask">
        {numbered ? <span className="fy-attn-q__n">{index + 1}.</span> : null} {question.question}
      </p>
      {picker === undefined ? null : <QuestionPicker index={index} picker={picker} question={question} />}
      {recommended === undefined || !showWhy ? null : (
        <p className="fy-attn-q__why">
          <strong>{question.options === undefined ? 'Suggested' : RECOMMENDED_WORD}:</strong> {recommended}
          {question.why === undefined ? null : <> — {question.why}</>}
        </p>
      )}
    </>
  );
}

export interface AttentionBriefProps {
  readonly item: AttentionItem;
  readonly renderProse: AttentionProse;
  /** Present only when the item is answered one answer per question. */
  readonly picker?: QuestionAnswers;
}

/** The brief's sections, in order. `null` for an item with none, so an old item stays minimal. */
export function AttentionBriefSections({ item, renderProse, picker }: AttentionBriefProps) {
  const context = item.context?.trim() ? item.context : null;
  const questions = item.questions ?? [];
  const several = questions.length > 1;
  return (
    <div className="fy-attn-secs">
      {context === null ? null : (
        <Section name="context" title="Context">
          <div className="fy-attn-prose">{renderProse(context)}</div>
        </Section>
      )}
      {item.terms === undefined ? null : (
        <Section name="terms" title={`Terms (${item.terms.length})`}>
          <dl className="fy-attn-terms">
            {item.terms.map(entry => (
              <div className="fy-attn-terms__row" key={entry.term}>
                <dt>{entry.term}</dt>
                <dd>{entry.meaning}</dd>
              </div>
            ))}
          </dl>
        </Section>
      )}
      {questions.length === 0 ? null : (
        <Section name="questions" open title={several ? `Questions (${questions.length})` : 'Question'}>
          <ol className="fy-attn-q" data-several={several || undefined}>
            {questions.map((question, index) =>
              index === 0 || !several ? (
                <li className="fy-attn-q__item" data-attention-question={index} key={question.question}>
                  <Question
                    index={index}
                    numbered={several}
                    picker={picker}
                    question={question}
                    showWhy={picker !== undefined || !several}
                  />
                </li>
              ) : (
                <li className="fy-attn-q__item" data-attention-question={index} key={question.question}>
                  <details className="fy-attn-sec fy-attn-sec--nested">
                    <summary className="fy-attn-sec__title">
                      <ChevronRight aria-hidden="true" className="fy-attn-sec__chevron" size={14} />
                      {`${index + 1}. ${question.question}`}
                      {(picker?.answers[index] ?? '') === '' ? null : (
                        <Check aria-label="answered" className="fy-attn-q__done" size={12} />
                      )}
                    </summary>
                    <div className="fy-attn-sec__body">
                      <Question
                        index={index}
                        numbered={false}
                        picker={picker}
                        question={question}
                        showWhy={picker !== undefined}
                      />
                    </div>
                  </details>
                </li>
              ),
            )}
          </ol>
        </Section>
      )}
      {item.recommendation === undefined ? null : (
        <Section name="recommendation" title="Recommendation">
          <p className="fy-attn-prose">
            <strong>{item.recommendation.decision}</strong>
            {item.recommendation.why === undefined ? null : <> — {item.recommendation.why}</>}
          </p>
        </Section>
      )}
      {item.impact === undefined && item.urgency === undefined ? null : (
        <Section name="impact" title="Impact">
          {item.impact === undefined ? null : <PointForm className="fy-attn-prose" text={item.impact} />}
          {item.urgency === undefined ? null : (
            <p className="fy-attn-prose">
              <strong>Urgency:</strong> {item.urgency}
            </p>
          )}
        </Section>
      )}
      {item.links === undefined ? null : (
        <Section name="links" title={`Links (${item.links.length})`}>
          <ul className="fy-attn-links">
            {item.links.map(link => (
              <li key={`${link.label ?? ''}\u0000${link.target}`}>
                <AttentionLinkRow link={link} renderProse={renderProse} />
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
