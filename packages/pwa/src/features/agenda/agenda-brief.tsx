/**
 * THE STRUCTURED PART OF AN AGENDA ITEM, as sections in ONE fixed order, each only when the item has it:
 * Premise · Context · the questions · Decided so far · Still open · Options · Impact ·
 * Terms · Steps · More detail · Links. Every surface draws the same ones (the inbox card, the in-ferret sheet
 * and the board page), so a reader learns one layout.
 *
 * PREMISE AND CONTEXT ARE TWO THINGS. The premise is the situation the item comes out of — what is going
 * on, in point form, so a cold reader starts there. The context is the facts around it. They have their own
 * headings so they are never read as one block — no tinted boxes, no stripes: a bold sentence-case heading
 * in the ink colour, and room.
 *
 * Two layouts. The CARD's is open: every section is drawn in full under its heading, because a card
 * stands alone and nothing on it hides behind a click (only a long "More detail" is previewed). The
 * recommendation is NOT a section there: the answer bar tags the recommended option and says why under the
 * buttons. The BOARD's is collapsible: native `<details>`, closed except the first question.
 *
 * An item with SEVERAL questions is answered in ONE reply, its answers numbered: the questions are listed, never given
 * option buttons (docs/agenda.md, "What I need from you").
 */

import type {
  AgendaItem,
  AgendaLink,
  AgendaQuestion,
  AgendaRecommendation,
  AgendaRevisableField as RevisionField,
} from '@ferretry/protocol';
import { agendaCardKind, recommendedAgendaOption } from '@ferretry/protocol';
import { Check, ChevronRight, ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';
import { ChatProse } from '../../components/chat-prose.tsx';
import { itemOptions, type LetteredOption, letteredOptions, needsOptionsSection } from '../../lib/agenda-options.ts';
import { bulletPoints, type RevisionHighlight } from '../../lib/agenda-revisions.ts';
import { plainLabel } from '../../lib/plain-label.ts';

type AgendaProse = (text: string) => ReactNode;

export { bulletPoints };

/** The chat's one Markdown renderer: a brief drawn without a host's own (the board, the history) reads like the chat. */
const markdownProse: AgendaProse = text => <ChatProse text={text} />;

/**
 * Text drawn in point form: a bullet list when it is written as bullets, a paragraph otherwise. Every paragraph and
 * every bullet is Markdown, drawn by the same renderer as the chat (`code`, **bold**, links, fy-render blocks).
 */
export function PointForm({
  text,
  className = '',
  fresh,
  renderProse = markdownProse,
}: {
  readonly text: string;
  readonly className?: string;
  /** Points the last edit added or reworded: drawn highlighted, and said "new" in words. */
  readonly fresh?: ReadonlySet<string> | undefined;
  readonly renderProse?: AgendaProse;
}) {
  const points = bulletPoints(text);
  if (points === null) return <div className={`${className} min-w-0 break-words`.trim()}>{renderProse(text)}</div>;
  return (
    <ul className={`fy-attn-points ${className}`.trim()}>
      {points.map((point, index) => {
        const isNew = fresh?.has(point.trim()) === true;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: points repeat; their order is their identity
          <li data-agenda-changed={isNew ? 'new' : undefined} key={index}>
            {isNew ? <NewMarker word="new" /> : null}
            {renderProse(point)}
          </li>
        );
      })}
    </ul>
  );
}

/** The small word that says a line is new or changed, so the highlight never rests on colour alone. */
function NewMarker({ word }: { readonly word: 'new' | 'changed' }) {
  return <span className="fy-attn-new">{word}</span>;
}

/** The one plain line under a card's heading, and what is left of the context once it is said. */
export interface CardLede {
  readonly line: string | null;
  /** What the Context section still draws: the context less its lead point, or `null` when nothing is left. */
  readonly context: string | null;
}

/**
 * A ferret that wrote its own picks into the context ("My picks: A delete · B accept") is suggesting answers, not
 * saying why the item matters: that context is headed "Suggested answers", so a pick never reads as a reason.
 */
const SUGGESTED_PICKS = /^\s*(?:[-*•]\s*)?my picks?\b/iu;

export const contextHeading = (context: string): string => {
  if (SUGGESTED_PICKS.test(context)) return 'Suggested answers';
  return 'Context';
};

/**
 * "Why it matters" as ONE plain line under the heading: the item's own `why` when it adds something, else
 * the first point of its context (the first bullet, or the first paragraph) — which the section then does
 * not say again.
 */
export const cardLede = (item: Pick<AgendaItem, 'context'>, why: string | null): CardLede => {
  const context = item.context?.trim() ? item.context : null;
  if (why !== null) return { line: why, context };
  if (context === null) return { line: null, context: null };
  const points = bulletPoints(context);
  if (points !== null) {
    const [first = '', ...rest] = points;
    return { line: first, context: rest.length === 0 ? null : rest.map(point => `- ${point}`).join('\n') };
  }
  const [first = '', ...rest] = context.split(/\n\s*\n/u);
  const left = rest.join('\n\n').trim();
  return { line: first.trim(), context: left === '' ? null : left };
};

/** The word the badge on a recommended option says; a badge, so the pick never rests on colour alone. */
const RECOMMENDED_WORD = 'Recommended';

function RecommendedBadge() {
  return (
    <span className="fy-attn-recommended" data-agenda-recommended="">
      <Check aria-hidden="true" size={11} />
      {RECOMMENDED_WORD}
    </span>
  );
}

/**
 * What the ask is called on this card: a note says what happened, a to-do is something to do, and only a
 * card that asks something calls it a question.
 */
const askHeading = (item: Pick<AgendaItem, 'kind' | 'ask'>, several: boolean): string => {
  if (several) return 'The questions';
  const kind = agendaCardKind(item);
  return kind === 'info' ? 'What happened' : kind === 'task' ? 'To do' : 'The question';
};

function Section({
  name,
  title,
  fold,
  open = false,
  changed = false,
  children,
}: {
  readonly name: string;
  /** The last edit changed this whole section: it is highlighted and says "changed" in words. */
  readonly changed?: boolean;
  readonly title: string;
  /** Collapsible (`<details>`) rather than always drawn open. */
  readonly fold: boolean;
  readonly open?: boolean;
  readonly children: ReactNode;
}) {
  if (!fold) {
    return (
      <div
        className={`fy-attn-sec fy-attn-sec--open fy-attn-sec--${name}`}
        data-agenda-changed={changed ? 'changed' : undefined}
        data-agenda-section={name}
      >
        <h4 className="fy-attn-sec__heading">
          {title}
          {changed ? <NewMarker word="changed" /> : null}
        </h4>
        <div className="fy-attn-sec__body">{children}</div>
      </div>
    );
  }
  return (
    <details
      className="fy-attn-sec"
      data-agenda-changed={changed ? 'changed' : undefined}
      data-agenda-section={name}
      open={open}
    >
      <summary className="fy-attn-sec__title">
        <ChevronRight aria-hidden="true" className="fy-attn-sec__chevron" size={14} />
        {title}
        {changed ? <NewMarker word="changed" /> : null}
      </summary>
      <div className="fy-attn-sec__body">{children}</div>
    </details>
  );
}

const REFERENCE_TARGET = /^(?:[#!][A-Za-z]?\d+|@\S+|[%][a-z]+:\S+|&\S+|[$/][A-Za-z][\w-]*)$/u;
const PATH_TARGET = /^(?:\.{0,2}\/|~\/)\S+$/u;

/** One link: a URL opens outside, a reference or a file goes through the reference surface. */
export function AgendaLinkRow({ link, renderProse }: { readonly link: AgendaLink; readonly renderProse: AgendaProse }) {
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

/** "A — Keep both", then what it means (Markdown), the recommended one marked. */
function OptionsList({
  options,
  renderProse,
}: {
  readonly options: readonly LetteredOption[];
  readonly renderProse: AgendaProse;
}) {
  return (
    <ul className="fy-attn-options">
      {options.map(option => (
        <li className="fy-attn-options__row" data-agenda-option-detail={option.label} key={option.label}>
          <span className="fy-attn-options__head">
            <strong>
              {option.letter} — {plainLabel(option.label, option.letter)}
            </strong>
            {option.recommended ? <RecommendedBadge /> : null}
          </span>
          {option.detail === undefined ? null : (
            <div className="fy-attn-options__what">{renderProse(option.detail)}</div>
          )}
        </li>
      ))}
    </ul>
  );
}

/** The line under a question: why the pick, or the pick itself when it has no button to be tagged on. */
function QuestionReason({
  question,
  showWhy,
  renderProse,
}: {
  readonly question: AgendaQuestion;
  readonly showWhy: boolean;
  readonly renderProse: AgendaProse;
}) {
  const recommended = question.recommended?.trim();
  if (recommended === undefined || !showWhy) return null;
  const onButton = question.options?.some(option => option.label === recommended) === true;
  if (onButton) {
    if (question.why === undefined) return null;
    return (
      <div className="fy-attn-q__why" data-agenda-question-why="">
        {renderProse(question.why)}
      </div>
    );
  }
  return (
    <div className="fy-attn-q__why" data-agenda-question-why="">
      <strong>Suggested:</strong> {recommended}
      {question.why === undefined ? null : <> — {question.why}</>}
    </div>
  );
}

function Question({
  question,
  index,
  numbered,
  showWhy,
  showAsk = true,
  renderProse,
}: {
  readonly question: AgendaQuestion;
  readonly index: number;
  readonly numbered: boolean;
  /** Show the recommendation's reason here; the option buttons live elsewhere for a single question. */
  readonly showWhy: boolean;
  /** False where the question's text is already drawn (a folded row's summary): it is said once. */
  readonly showAsk?: boolean;
  readonly renderProse: AgendaProse;
}) {
  return (
    <>
      {showAsk ? (
        <div className="fy-attn-q__ask" data-numbered={numbered || undefined}>
          {numbered ? <span className="fy-attn-q__n">{index + 1}.</span> : null}
          <div className="min-w-0">{renderProse(question.question)}</div>
        </div>
      ) : null}
      <QuestionReason question={question} renderProse={renderProse} showWhy={showWhy} />
    </>
  );
}

/**
 * THE TOP OF AN OPEN BODY: what is going on (the premise) and why now (the context), ONE tinted block in a soft
 * surface of the theme's accent — a cold reader starts here. It is drawn instead of the two plain sections the
 * folded layouts keep, never beside them.
 */
function Situation({
  premise,
  context,
  highlight,
  renderProse,
}: {
  readonly premise: string | null;
  readonly context: string | null;
  readonly highlight: RevisionHighlight | undefined;
  readonly renderProse: AgendaProse;
}) {
  const changed = (...fields: readonly RevisionField[]): boolean =>
    fields.some(field => highlight?.fields.has(field) === true);
  return (
    <section aria-label="Situation" className="fy-attn-situation" data-agenda-situation="">
      {premise === null ? null : (
        <div
          className="fy-attn-situation__part"
          data-agenda-changed={changed('premise') ? 'changed' : undefined}
          data-agenda-section="premise"
        >
          <h4 className="fy-attn-situation__heading">
            Premise
            {changed('premise') ? <NewMarker word="changed" /> : null}
          </h4>
          <PointForm
            className="fy-attn-prose"
            fresh={highlight?.points.premise}
            renderProse={renderProse}
            text={premise}
          />
        </div>
      )}
      {context === null ? null : (
        <div
          className="fy-attn-situation__part"
          data-agenda-changed={changed('context', 'why') ? 'changed' : undefined}
          data-agenda-section="context"
        >
          <h4 className="fy-attn-situation__heading">
            {SUGGESTED_PICKS.test(context) ? 'Suggested answers' : 'Context'}
            {changed('context', 'why') ? <NewMarker word="changed" /> : null}
          </h4>
          <PointForm
            className="fy-attn-prose"
            fresh={highlight?.points.context}
            renderProse={renderProse}
            text={context}
          />
        </div>
      )}
    </section>
  );
}

export interface AgendaBriefProps {
  readonly item: AgendaItem;
  readonly renderProse: AgendaProse;
  /**
   * Sections fold behind a `<summary>` (the board). `false` draws every section open under a bold heading
   * (the card). Default: collapsible.
   */
  readonly collapsible?: boolean;
  /** Collapsible only: every section starts open. */
  readonly expanded?: boolean;
  /**
   * The card already draws the ask: a LONE question would only say it again in other words, so its section
   * is left out. Several questions still draw.
   */
  readonly askShown?: boolean;
  /** The ask itself, drawn first — when it is not already the card's heading. */
  readonly ask?: string;
  /**
   * What the ask is headed with. Absent: the item's own word (a note says what happened, a to-do is something
   * to do). `null`: no heading — the ask is the first line of the body, as a card that asks reads it.
   */
  readonly askLabel?: string | null;
  /**
   * What to draw as the recommendation. The folded layout defaults to the item's own; the open layout draws it
   * only when handed one, because the card's answer bar says it under the options.
   */
  readonly recommendation?: AgendaRecommendation | undefined;
  /** The steps checklist, drawn under "Steps". */
  readonly steps?: ReactNode;
  /** The body, drawn under "More detail" — the one section that may start folded. */
  readonly detail?: ReactNode;
  /**
   * Which half to draw. `card`: only what the minimal card needs (the ask when it is not the heading, the
   * recommendation handed in). `detail`: everything else — what the item knows beyond
   * its question. Default `all`: the board's folded brief.
   */
  readonly part?: 'all' | 'card' | 'detail';
  /** What the last edit changed: its new points and changed sections are marked. */
  readonly highlight?: RevisionHighlight;
}

/** The brief's sections, in order. Nothing for an item with none, so an old item stays minimal. */
export function AgendaBriefSections({
  item,
  renderProse,
  collapsible = true,
  expanded = false,
  askShown = false,
  ask,
  askLabel,
  recommendation: given,
  steps,
  detail,
  part = 'all',
  highlight,
}: AgendaBriefProps) {
  const fold = collapsible;
  const open = expanded || !collapsible;
  const asCard = part === 'card';
  const asDetail = part === 'detail';
  const premise = !asCard && item.premise?.trim() ? item.premise : null;
  const decided = !asCard && item.decided?.trim() ? item.decided : null;
  const context = !asCard && item.context?.trim() ? item.context : null;
  const stillOpen = !asCard && item.stillOpen?.trim() ? item.stillOpen : null;
  const changedWhole = (...fields: readonly RevisionField[]): boolean =>
    fields.some(field => highlight?.fields.has(field) === true);
  const all = item.questions ?? [];
  const several = all.length > 1;
  const questions = asDetail || (askShown && !several) || asCard ? [] : all;
  const pick = recommendedAgendaOption(item);
  const lettered = asCard || several ? [] : letteredOptions(itemOptions(item), item.optionDetails, pick);
  const options = needsOptionsSection(lettered) ? lettered : [];
  const termsLine = asCard ? null : (item.terms ?? null);
  // The board folds the item's own recommendation. A card's answer bar says it under the options, so a card
  // draws a section only when it is handed one — the per-question card, whose bar has no options to tag.
  const recommendation = asDetail ? undefined : (given ?? (fold ? item.recommendation : undefined));
  // A recommendation that names a listed option is marked on that option and its reason said right under the list.
  const reasonUnderOptions =
    recommendation !== undefined &&
    options.some(option => option.label.trim().toLowerCase() === recommendation.decision.trim().toLowerCase());
  const heading = askLabel === undefined ? askHeading(item, several) : askLabel;
  // Open and not the card: the premise and the context are ONE block on top, and the type orders what follows.
  const situated = !fold && !asCard && (premise !== null || context !== null);
  const kind = agendaCardKind(item);
  const typed = !fold && !asCard;
  const stepsBlock =
    asCard || steps === undefined ? null : (
      <Section fold={fold} name="steps" open={open} title="Steps">
        {steps}
      </Section>
    );
  const detailBlock =
    asCard || detail === undefined ? null : (
      <Section fold={fold} name="more" open={open} title={typed && kind === 'review' ? 'Reasoning' : 'More detail'}>
        {detail}
      </Section>
    );
  // A to-do leads with its steps, a review with its reasoning: what the reader acts on comes before the background.
  const early = typed && kind === 'task' ? stepsBlock : typed && kind === 'review' ? detailBlock : null;
  // The open layout asks first: what is being asked is the item, what is going on is its background.
  const questionsBlock =
    asDetail || ((ask === undefined || heading === null) && questions.length === 0) ? null : (
      <Section fold={fold} name="questions" open title={heading ?? askHeading(item, several)}>
        {ask === undefined || heading === null ? null : (
          <div className="fy-attn-card__ask" data-agenda-ask="">
            {renderProse(ask)}
          </div>
        )}
        {questions.length === 0 ? null : (
          <ol className="fy-attn-q" data-several={several || undefined}>
            {questions.map((question, index) =>
              !fold || index === 0 || !several ? (
                <li className="fy-attn-q__item" data-agenda-question={index} key={question.question}>
                  <Question index={index} numbered={several} question={question} renderProse={renderProse} showWhy />
                </li>
              ) : (
                <li className="fy-attn-q__item" data-agenda-question={index} key={question.question}>
                  <details className="fy-attn-sec fy-attn-sec--nested" open={open}>
                    <summary className="fy-attn-sec__title">
                      <ChevronRight aria-hidden="true" className="fy-attn-sec__chevron" size={14} />
                      {`${index + 1}. ${question.question}`}
                    </summary>
                    <div className="fy-attn-sec__body">
                      <Question
                        index={index}
                        numbered={false}
                        question={question}
                        renderProse={renderProse}
                        showAsk={false}
                        showWhy={false}
                      />
                    </div>
                  </details>
                </li>
              ),
            )}
          </ol>
        )}
      </Section>
    );
  return (
    <div className="fy-attn-secs" data-layout={fold ? 'fold' : 'open'}>
      {asDetail || ask === undefined || heading !== null ? null : (
        <div className="fy-attn-card__ask" data-agenda-ask="">
          {renderProse(ask)}
        </div>
      )}
      {situated ? (
        <Situation context={context} highlight={highlight} premise={premise} renderProse={renderProse} />
      ) : null}
      {fold ? null : questionsBlock}
      {early}
      {premise === null || situated ? null : (
        <Section changed={changedWhole('premise')} fold={fold} name="premise" open={open} title="Premise">
          <PointForm
            className="fy-attn-prose"
            renderProse={renderProse}
            fresh={highlight?.points.premise}
            text={premise}
          />
        </Section>
      )}
      {context === null || situated ? null : (
        <Section
          changed={changedWhole('context', 'why')}
          fold={fold}
          name="context"
          open={open}
          title={contextHeading(context)}
        >
          <PointForm
            className="fy-attn-prose"
            fresh={highlight?.points.context}
            renderProse={renderProse}
            text={context}
          />
        </Section>
      )}
      {decided === null ? null : (
        <Section
          changed={changedWhole('decided')}
          fold={fold}
          name="decided"
          open={open}
          title={fold ? 'Already decided' : 'Decided so far'}
        >
          <PointForm
            className="fy-attn-prose"
            renderProse={renderProse}
            fresh={highlight?.points.decided}
            text={decided}
          />
        </Section>
      )}
      {stillOpen === null ? null : (
        <Section changed={changedWhole('stillOpen')} fold={fold} name="still-open" open={open} title="Still open">
          <PointForm
            className="fy-attn-prose"
            renderProse={renderProse}
            fresh={highlight?.points.stillOpen}
            text={stillOpen}
          />
        </Section>
      )}
      {fold ? questionsBlock : null}
      {options.length === 0 ? null : (
        <Section changed={changedWhole('optionDetails')} fold={fold} name="options" open={open} title="Options">
          <OptionsList options={options} renderProse={renderProse} />
          {reasonUnderOptions && recommendation?.why !== undefined ? (
            <div className="fy-attn-options__why" data-agenda-recommendation="">
              {renderProse(
                `**Why ${options.find(option => option.recommended)?.letter ?? 'this'}:** ${recommendation.why}`,
              )}
            </div>
          ) : null}
        </Section>
      )}
      {recommendation === undefined || reasonUnderOptions ? null : (
        <Section fold={fold} name="recommendation" open={open} title="Recommendation">
          <p className="fy-attn-card__rec" data-agenda-recommendation="">
            <RecommendedBadge />
            <span>
              <strong>{recommendation.decision}</strong>
              {recommendation.why === undefined ? null : <> — {recommendation.why}</>}
            </span>
          </p>
        </Section>
      )}
      {asCard || (item.impact === undefined && item.urgency === undefined) ? null : (
        <Section
          fold={fold}
          name="impact"
          open={open}
          title={typed && kind === 'permission' ? 'What it allows' : 'Impact'}
        >
          {item.impact === undefined ? null : (
            <PointForm className="fy-attn-prose" renderProse={renderProse} text={item.impact} />
          )}
          {item.urgency === undefined ? null : (
            <p className="fy-attn-prose">
              <strong>Urgency:</strong> {item.urgency}
            </p>
          )}
        </Section>
      )}
      {termsLine === null ? null : (
        <Section fold={fold} name="terms" open={open} title={fold ? `Terms (${termsLine.length})` : 'Terms'}>
          <table className="fy-attn-terms-table" data-agenda-terms="">
            <thead>
              <tr>
                <th scope="col">Term</th>
                <th scope="col">Meaning</th>
              </tr>
            </thead>
            <tbody>
              {termsLine.map(entry => (
                <tr key={entry.term}>
                  <th scope="row">{entry.term}</th>
                  <td>{renderProse(entry.meaning)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
      {early === stepsBlock ? null : stepsBlock}
      {early === detailBlock ? null : detailBlock}
      {asCard || item.links === undefined ? null : (
        <Section fold={fold} name="links" open={open} title={fold ? `Links (${item.links.length})` : 'Links'}>
          <ul className="fy-attn-links">
            {item.links.map(link => (
              <li key={`${link.label ?? ''}\u0000${link.target}`}>
                <AgendaLinkRow link={link} renderProse={renderProse} />
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}
