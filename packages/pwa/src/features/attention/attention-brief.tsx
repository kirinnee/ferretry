/**
 * THE STRUCTURED PART OF AN ATTENTION ITEM, as sections in ONE fixed order, each only when the item has it:
 * Premise · Context · The question · Already decided · Options · Recommendation · Impact · Terms · Steps ·
 * More detail · Links. Every surface draws the same ones (the inbox card, the in-ferret sheet and the board
 * page), so a reader learns one layout.
 *
 * PREMISE AND CONTEXT ARE TWO THINGS. The premise is the situation the item comes out of — what is going
 * on, in point form, so a cold reader starts there. The context is why it matters now. They have their own
 * headings and their own look so they are never read as one block.
 *
 * Two layouts. The CARD's is open: every section is drawn in full under a small heading, because a card
 * stands alone and nothing on it hides behind a click (only a long "More detail" is previewed). The
 * BOARD's is collapsible: native `<details>`, closed except the first question.
 *
 * An item with SEVERAL questions and an open-question ask is answered one answer per question: each
 * question gets its own picker here, and the answers leave together (`composeQuestionAnswers`).
 */

import type { AttentionItem, AttentionLink, AttentionQuestion, AttentionRecommendation } from '@ferretry/protocol';
import { recommendedAttentionOption } from '@ferretry/protocol';
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

function RecommendedBadge() {
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
  fold,
  open = false,
  children,
}: {
  readonly name: string;
  readonly title: string;
  /** Collapsible (`<details>`) rather than always drawn open. */
  readonly fold: boolean;
  readonly open?: boolean;
  readonly children: ReactNode;
}) {
  if (!fold) {
    return (
      <div className={`fy-attn-sec fy-attn-sec--open fy-attn-sec--${name}`} data-attention-section={name}>
        <h4 className="fy-attn-sec__heading">{title}</h4>
        <div className="fy-attn-sec__body">{children}</div>
      </div>
    );
  }
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
  /**
   * Sections fold behind a `<summary>` (the board). `false` draws every section open under a small heading
   * (the card). Default: collapsible.
   */
  readonly collapsible?: boolean;
  /** Collapsible only: every section starts open. */
  readonly expanded?: boolean;
  /**
   * The card already draws the ask: a LONE question would only say it again in other words, so its section
   * is left out. Several questions, or one answered here (a picker), still draw.
   */
  readonly askShown?: boolean;
  /** The ask itself, drawn at the head of "The question" — when it is not already the card's title. */
  readonly ask?: string;
  /** The item's `why` when it adds something, drawn with the context under "Why it matters now". */
  readonly why?: string | null;
  /** What to draw as the recommendation; defaults to the item's own. A lone question's pick goes here. */
  readonly recommendation?: AttentionRecommendation | undefined;
  /** The steps checklist, drawn under "Steps". */
  readonly steps?: ReactNode;
  /** The body, drawn under "More detail" — the one section that may start folded. */
  readonly detail?: ReactNode;
}

/** The options of a choice, when at least one says what happens if it is picked: the point of listing them. */
const describedOptions = (
  item: AttentionItem,
  several: boolean,
): readonly { readonly label: string; readonly description?: string | undefined }[] => {
  if (several) return [];
  const options = item.ask?.kind === 'multiple-choice' ? item.ask.options : (item.questions?.[0]?.options ?? []);
  return options.some(option => option.description !== undefined) ? options : [];
};

/** The brief's sections, in order. Nothing for an item with none, so an old item stays minimal. */
export function AttentionBriefSections({
  item,
  renderProse,
  picker,
  collapsible = true,
  expanded = false,
  askShown = false,
  ask,
  why = null,
  recommendation = item.recommendation,
  steps,
  detail,
}: AttentionBriefProps) {
  const fold = collapsible;
  const open = expanded || !collapsible;
  const premise = item.premise?.trim() ? item.premise : null;
  const decided = item.decided?.trim() ? item.decided : null;
  const context = item.context?.trim() ? item.context : null;
  const all = item.questions ?? [];
  const several = all.length > 1;
  const questions = askShown && !several && picker === undefined ? [] : all;
  const options = describedOptions(item, several);
  const pick = recommendedAttentionOption(item);
  return (
    <div className="fy-attn-secs" data-layout={fold ? 'fold' : 'open'}>
      {premise === null ? null : (
        <Section fold={fold} name="premise" open={open} title="What's going on">
          <PointForm className="fy-attn-prose" text={premise} />
        </Section>
      )}
      {context === null && why === null ? null : (
        <Section fold={fold} name="context" open={open} title={fold ? 'Context' : 'Why it matters now'}>
          {why === null ? null : (
            <div className="fy-attn-prose" data-attention-why="">
              {renderProse(why)}
            </div>
          )}
          {context === null ? null : <div className="fy-attn-prose">{renderProse(context)}</div>}
        </Section>
      )}
      {ask === undefined && questions.length === 0 ? null : (
        <Section fold={fold} name="questions" open title={several ? 'The questions' : 'The question'}>
          {ask === undefined ? null : (
            <p className="fy-attn-card__ask" data-attention-ask="">
              {ask}
            </p>
          )}
          {questions.length === 0 ? null : (
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
                    <details className="fy-attn-sec fy-attn-sec--nested" open={open}>
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
          )}
        </Section>
      )}
      {decided === null ? null : (
        <Section fold={fold} name="decided" open={open} title="Already decided">
          <PointForm className="fy-attn-prose" text={decided} />
        </Section>
      )}
      {options.length === 0 ? null : (
        <Section fold={fold} name="options" open={open} title="Options">
          <ul className="fy-attn-options">
            {options.map(option => (
              <li className="fy-attn-options__row" data-attention-option-detail={option.label} key={option.label}>
                <span className="fy-attn-options__label">
                  <strong>{option.label}</strong>
                  {pick === option.label.trim() ? <RecommendedBadge /> : null}
                </span>
                {option.description === undefined ? null : (
                  <span className="fy-attn-options__what">{option.description}</span>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {recommendation === undefined ? null : (
        <Section fold={fold} name="recommendation" open={open} title="Recommendation">
          <p className="fy-attn-card__rec" data-attention-recommendation="">
            <RecommendedBadge />
            <span>
              <strong>{recommendation.decision}</strong>
              {recommendation.why === undefined ? null : <> — {recommendation.why}</>}
            </span>
          </p>
        </Section>
      )}
      {item.impact === undefined && item.urgency === undefined ? null : (
        <Section fold={fold} name="impact" open={open} title="Impact">
          {item.impact === undefined ? null : <PointForm className="fy-attn-prose" text={item.impact} />}
          {item.urgency === undefined ? null : (
            <p className="fy-attn-prose">
              <strong>Urgency:</strong> {item.urgency}
            </p>
          )}
        </Section>
      )}
      {item.terms === undefined ? null : (
        <Section fold={fold} name="terms" open={open} title={fold ? `Terms (${item.terms.length})` : 'Terms'}>
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
      {steps === undefined ? null : (
        <Section fold={fold} name="steps" open={open} title="Steps">
          {steps}
        </Section>
      )}
      {detail === undefined ? null : (
        <Section fold={fold} name="more" open={open} title="More detail">
          {detail}
        </Section>
      )}
      {item.links === undefined ? null : (
        <Section fold={fold} name="links" open={open} title={fold ? `Links (${item.links.length})` : 'Links'}>
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
