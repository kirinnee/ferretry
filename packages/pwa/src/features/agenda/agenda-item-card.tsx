/**
 * THE CARD OF AN OPEN AGENDA ITEM — everything the owner reads and answers, in ONE card, top to bottom:
 *
 *   top bar    the item's type, "↓ Not needed" (the ↓ swipe) and the version picker ("v2 of 2 · 3m ago")
 *   situation  PREMISE and CONTEXT — the two fields every item carries — as two tinted blocks, each label above its points
 *   need       "WHAT I NEED FROM YOU" (`agenda-need.tsx`): exactly the ask, by the card's shape — the ask itself first
 *              (the question, or what is approved, done or read), then each option with what it means; the steps to
 *              tick; what an approval does; what to review; or the numbered answers a reply gives — and the one plain
 *              instruction last ("Pick one option.")
 *   sections   only what the item carries, each open, none folding: why the recommendation, reasoning or more detail
 *              (Markdown with fy-render), decided, still open, impact, links, terms
 *   answers    ONE row of at most three — ← ↑ → — or the item's own form (an input request), or why it cannot be
 *              answered here (parked or resolved)
 *
 * Terms are dotted-underlined where the premise, the context and the options use them (`agenda-terms.tsx`). Picking
 * an earlier version redraws the card as it read then, read-only, with the way back to the latest. No left accent
 * bars, no hint lines, no menus.
 */

import { type AgendaCardAnswer, type AgendaItem, type AgendaTerm, singleAgendaQuestion } from '@ferretry/protocol';
import { Check } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { createPortal } from 'react-dom';
import { optionAction } from '../../lib/agenda-answers.ts';
import { cardModel } from '../../lib/agenda-card-model.ts';
import { useFormPicks } from '../../lib/agenda-form-state.ts';
import { DISMISS_ACTION, type InboxAction, swipeMap } from '../../lib/agenda-inbox.ts';
import { cardLettered, itemOptions, letteredOptions } from '../../lib/agenda-options.ts';
import { itemAtVersion, revisionStamp, shortAgo, versionCount } from '../../lib/agenda-revisions.ts';
import { plainLabel } from '../../lib/plain-label.ts';
import { AgendaLinkRow, PointForm } from './agenda-brief.tsx';
import { AgendaConfigChange } from './agenda-config-change.tsx';
import { AgendaDelivery } from './agenda-delivery.tsx';
import { AgendaFormFields } from './agenda-form-fields.tsx';
import { AgendaNeed, WantedAnswers, wantedAnswers } from './agenda-need.tsx';
import { AgendaQuickReplies } from './agenda-quick-replies.tsx';
import { AgendaBody, AgendaSteps } from './agenda-steps.tsx';
import { markTerms, TermLayer } from './agenda-terms.tsx';
import { agendaTypeMeta } from './agenda-type.tsx';
import type { DoneCloseView } from './use-done-close-flow.ts';
import { useDownSwipe } from './use-down-swipe.ts';

type Prose = (text: string) => ReactNode;

export interface AgendaItemCardProps {
  readonly item: AgendaItem;
  readonly ferret: string;
  readonly now: number;
  readonly busy: boolean;
  readonly error: string | null;
  readonly swipeable: boolean;
  readonly renderProse: Prose;
  readonly onAct: (action: InboxAction) => void;
  readonly onProgress?: ((step: number, done: boolean) => Promise<void>) | undefined;
  readonly doneClose?: DoneCloseView | undefined;
  /** Why it cannot be answered here (parked, resolved): drawn in the answer row's place, and Not needed is gone. */
  readonly settled?: ReactNode;
  /** Where a replied question stands: drawn above its answer row, which stays live (the reply is not its answer). */
  readonly parkedNote?: ReactNode;
  /** The form an `input` item is answered with (`InputCardHost`): drawn in the answer row's place. */
  readonly inputForm?: ReactNode;
  /** A ferret's paste plan (`CopyPlanHost`): drawn in the answer row's place, its Allow and Decline are the answer. */
  readonly planForm?: ReactNode;
  /**
   * A review's Request changes: the host sends the composer's words as the change asked for, or puts the owner in
   * the composer when it is empty. Absent: the card says to type the changes there instead.
   */
  readonly onRequestChanges?: ((answer: AgendaCardAnswer) => void) | undefined;
  /**
   * Where a one-row answer (choice, approval, to-do, notice, review) is drawn instead of at the card's foot: the open
   * item's sticky dock, so the buttons stay in reach while a long card scrolls. Absent: the row ends the card.
   */
  readonly answerDock?: HTMLElement | null | undefined;
  /**
   * Names the picks of a form card whose fields are answered here, because a composer sends them (the Inbox). Absent: a
   * form's fields are drawn to read, and the owner is told to fill them in in the Inbox.
   */
  readonly formKey?: string | undefined;
}

/** The detail without its premise: the daemon also writes a confirmed change into it for older apps. */
const forConfirmation = (item: AgendaItem): AgendaItem => {
  if (item.confirms === undefined) return item;
  const { premise: _premise, ...rest } = item;
  return rest;
};

/** One titled section of the card. Always drawn open: the owner reads everything at once, nothing folds. */
function Section({
  name,
  title,
  children,
}: {
  readonly name: string;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="fy-card__section" data-agenda-section={name}>
      <h4 className="fy-card__label fy-card__section-title">{title}</h4>
      <div className="fy-card__section-body">{children}</div>
    </section>
  );
}

/** PREMISE and CONTEXT as two tinted blocks: each label above its points. A board card draws the same two. */
export function Situation({
  premise,
  context,
  renderProse,
}: {
  readonly premise: string | null;
  readonly context: string | null;
  readonly renderProse: Prose;
}) {
  if (premise === null && context === null) return null;
  return (
    <section aria-label="Situation" className="fy-card__situation" data-agenda-situation="">
      {premise === null ? null : (
        <div className="fy-card__sit-row" data-agenda-section="premise">
          <h4 className="fy-card__label fy-card__sit-label">Premise</h4>
          <PointForm className="fy-card__points" renderProse={renderProse} text={premise} />
        </div>
      )}
      {context === null ? null : (
        <div className="fy-card__sit-row" data-agenda-section="context">
          <h4 className="fy-card__label fy-card__sit-label">Context</h4>
          <PointForm className="fy-card__points" renderProse={renderProse} text={context} />
        </div>
      )}
    </section>
  );
}

interface ListedOption {
  readonly label: string;
  /** What the list and the button call it: the option's one word, or its letter. */
  readonly name: string;
  /** What it means: its explanation, led by its full label when the name is a letter. */
  readonly meaning: string | null;
  readonly recommended: boolean;
  /** Not on the answer row (past the three): its name is the button that picks it. */
  readonly pickHere: boolean;
}

function OptionsList({
  options,
  busy,
  onPick,
  renderProse,
}: {
  readonly options: readonly ListedOption[];
  readonly busy: boolean;
  readonly onPick: (label: string) => void;
  readonly renderProse: Prose;
}) {
  return (
    <ul aria-label="Options" className="fy-card__options" data-agenda-options="">
      {options.map(option => (
        <li data-agenda-option-detail={option.label} key={option.label}>
          {option.pickHere ? (
            <button
              aria-label={`Choose ${plainLabel(option.label)}`}
              className="fy-card__option-name fy-card__option-pick"
              data-agenda-option={option.label}
              disabled={busy}
              onClick={() => onPick(option.label)}
              type="button"
            >
              {option.name}
            </button>
          ) : (
            <span className="fy-card__option-name">{option.name}</span>
          )}
          <span className="fy-card__option-meaning">
            {option.meaning === null ? null : renderProse(option.meaning)}
            {option.recommended ? (
              <span className="fy-card__recommended" data-agenda-recommended="">
                · Recommended
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

function LinksList({
  links,
  renderProse,
}: {
  readonly links: NonNullable<AgendaItem['links']>;
  readonly renderProse: Prose;
}) {
  return (
    <ul className="fy-card__links">
      {links.map(link => (
        <li key={`${link.label ?? ''}\u0000${link.target}`}>
          <AgendaLinkRow link={link} renderProse={renderProse} />
        </li>
      ))}
    </ul>
  );
}

function TermsList({ terms, renderProse }: { readonly terms: readonly AgendaTerm[]; readonly renderProse: Prose }) {
  return (
    <dl className="fy-card__terms" data-agenda-terms="">
      {terms.map(entry => (
        <div className="fy-card__term" key={entry.term}>
          <dt>{entry.term}</dt>
          <dd>{renderProse(entry.meaning)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** "v2 of 2 · 3m ago": a native picker, so it is a keyboard's and a screen reader's as much as a finger's. */
function VersionPicker({
  item,
  shown,
  now,
  onShow,
}: {
  readonly item: AgendaItem;
  readonly shown: number;
  readonly now: number;
  readonly onShow: (version: number) => void;
}) {
  const count = versionCount(item);
  const atOf = (version: number): string =>
    version === 1 ? item.waitingSince : (item.revisions?.[version - 2]?.at ?? item.waitingSince);
  const when = (version: number): string =>
    version === count ? shortAgo(atOf(version), now) : revisionStamp(atOf(version), now);
  return (
    <select
      aria-label="Version"
      className="fy-card__version"
      data-agenda-version-picker=""
      onChange={event => onShow(Number(event.currentTarget.value))}
      value={shown}
    >
      {Array.from({ length: count }, (_, at) => count - at).map(version => (
        <option key={version} value={version}>
          {`v${String(version)} of ${String(count)}${when(version) === '' ? '' : ` · ${when(version)}`}`}
        </option>
      ))}
    </select>
  );
}

const FORM_ELSEWHERE = 'Open this in the Inbox to fill it in, or answer in the reply box, numbered.';

export function AgendaItemCard({
  item: current,
  ferret,
  now,
  busy,
  error,
  swipeable,
  renderProse,
  onAct,
  onProgress,
  doneClose,
  settled,
  parkedNote,
  inputForm,
  planForm,
  onRequestChanges,
  answerDock,
  formKey,
}: AgendaItemCardProps) {
  const count = versionCount(current);
  // `null` follows the latest version, so an edit that lands while the card is open shows at once.
  const [picked, setPicked] = useState<number | null>(null);
  const shown = Math.min(picked ?? count, count);
  const setShown = (version: number): void => setPicked(version >= count ? null : version);
  const latest = shown >= count;
  const item = latest ? current : itemAtVersion(current, shown);
  const read = forConfirmation(item);
  const model = cardModel(item);
  const meta = agendaTypeMeta(item);
  // The segment LEADS WITH THE ASK, whatever the header above it says (a form's is its header's, said once): the lone question, else the item's one-line
  // ask — what is being chosen, approved, done or read. Several questions are their own numbered list instead.
  const askLine = singleAgendaQuestion(item)?.question.trim() || item.subject.trim();
  const terms = item.terms ?? [];
  const seen = new Set<number>();
  const mark = (text: string): string => markTerms(text, terms, seen);
  const premise = read.premise?.trim() ? mark(read.premise) : null;
  const context = read.context?.trim() ? mark(read.context) : null;

  const answerable = latest && settled === undefined;
  const formFields = item.fields ?? [];
  const formPicks = useFormPicks(formKey ?? item.id, formFields);
  const isInput = inputForm !== undefined && item.kind === 'input';
  const canDismiss = answerable && !isInput && model.dismissInMenu && !model.notice;
  const dismiss = (): void => {
    if (!busy) onAct(DISMISS_ACTION);
  };
  const pull = useDownSwipe(dismiss, swipeable && canDismiss);

  // A choice (one question): its options are listed with what each means, and answered on the row. Any other shape
  // offers none, whatever options an item raised before the rule still carries.
  const shape = model.shape;
  const choosing = shape === 'choice' || shape === 'yesno';
  const options = choosing ? itemOptions(item) : [];
  const lettered = cardLettered(options);
  const onRow = new Set(model.answers.map(answer => answer.label.trim().toLowerCase()));
  const listed: readonly ListedOption[] = letteredOptions(options, item.optionDetails, model.recommended).map(
    option => {
      const named = lettered ? option.letter : plainLabel(option.label);
      const meaning = lettered
        ? `**${plainLabel(option.label, option.letter)}**${option.detail === undefined ? '' : ` — ${option.detail}`}`
        : (option.detail ?? null);
      return {
        label: option.label,
        name: named,
        meaning: meaning === null ? null : mark(meaning),
        recommended: option.recommended,
        pickHere: answerable && !onRow.has(option.label.trim().toLowerCase()),
      };
    },
  );
  // A list that would only repeat its buttons ("Yes", "No") is not drawn.
  const showList = listed.some(option => option.meaning !== null || option.pickHere);

  const questions = item.questions ?? [];
  const recommendation = model.recommendation;
  const recommendedOption = listed.find(option => option.recommended);
  const kind = meta.kind;
  const body = item.body?.trim() ? item.body : null;
  const questionAnswer = item.questionAnswer?.trim() ? item.questionAnswer : null;
  const steps = item.steps ?? [];
  // What the segment already says is not said again below it: an approval's effect, a review's links, a to-do's steps.
  const effectInNeed = shape === 'approval' && item.impact !== undefined;
  const linksInNeed = shape === 'review' && item.links !== undefined;
  const stepsInNeed = shape === 'todo';
  const requestChanges =
    answerable && onRequestChanges !== undefined && model.requestChanges !== undefined
      ? { answer: model.requestChanges, onTap: () => onRequestChanges(model.requestChanges as AgendaCardAnswer) }
      : undefined;
  const replies = (
    <AgendaQuickReplies
      busy={busy}
      error={error}
      map={swipeMap(item)}
      model={model}
      onAct={onAct}
      options={options}
      swipeable={swipeable}
      {...(canDismiss ? { onDown: dismiss } : {})}
      {...(doneClose === undefined ? {} : { doneClose })}
      {...(item.waitingOn === 'ferret' && !model.notice ? { waitingOn: ferret } : {})}
      {...(requestChanges === undefined ? {} : { requestChanges })}
    />
  );
  // Only a row of buttons docks; a card answered in words has none, and its note or error stays in the card.
  const docked =
    answerDock != null &&
    latest &&
    settled === undefined &&
    !isInput &&
    planForm === undefined &&
    (model.notice || model.answers.length > 0 || requestChanges !== undefined);

  return (
    <article
      aria-label={`${meta.label} card`}
      className="fy-card"
      data-agenda-card-v6={item.id}
      data-agenda-version={shown}
      data-kind={meta.tone}
    >
      <div className="fy-card__top" data-agenda-card-top="" {...pull}>
        <span className="fy-card__type" data-agenda-type={meta.kind} data-tone={meta.tone}>
          {meta.label}
        </span>
        <span className="fy-card__tools">
          {canDismiss ? (
            <button
              aria-label={swipeable ? 'Not needed, or swipe down' : 'Not needed'}
              className="fy-card__dismiss"
              data-agenda-dismiss=""
              disabled={busy}
              onClick={dismiss}
              type="button"
            >
              <span aria-hidden="true" className="fy-card__arrow">
                ↓
              </span>
              Not needed
            </button>
          ) : null}
          {count > 1 ? <VersionPicker item={current} now={now} onShow={setShown} shown={shown} /> : null}
        </span>
      </div>
      {latest ? <AgendaDelivery busy={busy} ferret={ferret} item={item} onAct={onAct} /> : null}
      {latest ? <AgendaConfigChange item={item} /> : null}
      <TermLayer renderProse={renderProse} terms={terms}>
        <Situation context={context} premise={premise} renderProse={renderProse} />
        {questionAnswer === null ? null : (
          <div className="fy-card__answered" data-agenda-question-answer="">
            <h5 className="fy-card__label">Answer to your question</h5>
            <PointForm renderProse={renderProse} text={mark(questionAnswer)} />
          </div>
        )}
        <AgendaNeed
          shape={shape}
          {...(!answerable ? { lead: '' } : shape === 'form' && formKey === undefined ? { lead: FORM_ELSEWHERE } : {})}
        >
          {askLine === '' || shape === 'answers' || shape === 'input' || shape === 'form' ? null : (
            <div className="fy-card__question" data-agenda-question-line="">
              {renderProse(mark(askLine))}
            </div>
          )}
          {model.notice && body !== null ? <AgendaBody renderProse={renderProse} text={body} /> : null}
          {choosing && showList ? (
            <OptionsList
              busy={busy}
              onPick={label => {
                const option = options.find(entry => entry.label === label);
                if (option !== undefined && !busy) onAct(optionAction(option, ''));
              }}
              options={listed}
              renderProse={renderProse}
            />
          ) : null}
          {effectInNeed && item.impact !== undefined ? (
            <div className="fy-card__need-part" data-agenda-need-effect="">
              <h5 className="fy-card__label">What it does</h5>
              <PointForm renderProse={renderProse} text={mark(item.impact)} />
            </div>
          ) : null}
          {linksInNeed && item.links !== undefined ? (
            <div className="fy-card__need-part" data-agenda-need-review="">
              <h5 className="fy-card__label">What to review</h5>
              <LinksList links={item.links} renderProse={renderProse} />
            </div>
          ) : null}
          {shape === 'form' ? (
            <AgendaFormFields
              disabled={busy || !answerable}
              fields={formFields}
              formKey={formKey ?? null}
              picks={formPicks}
              renderProse={renderProse}
            />
          ) : null}
          {shape === 'answers' ? (
            <WantedAnswers answers={wantedAnswers(questions, steps.length > 0)} renderProse={renderProse} />
          ) : null}
          {stepsInNeed && steps.length > 0 ? (
            <AgendaSteps
              disabled={busy || !answerable}
              done={item.stepsDone ?? []}
              renderProse={renderProse}
              steps={steps}
              {...(onProgress === undefined || !answerable ? {} : { onProgress })}
            />
          ) : null}
        </AgendaNeed>
      </TermLayer>
      {recommendation === undefined || recommendation.why === undefined ? null : (
        <Section name="recommendation" title={`Why I recommend ${recommendedOption?.name ?? recommendation.decision}`}>
          {recommendedOption === undefined ? (
            <p className="fy-card__decision">
              <strong>{recommendation.decision}</strong>
            </p>
          ) : null}
          <PointForm renderProse={renderProse} text={recommendation.why} />
        </Section>
      )}
      {steps.length === 0 || stepsInNeed ? null : (
        <Section name="steps" title="Steps">
          <AgendaSteps
            disabled={busy || !answerable}
            done={item.stepsDone ?? []}
            renderProse={renderProse}
            steps={steps}
            {...(onProgress === undefined || !answerable ? {} : { onProgress })}
          />
        </Section>
      )}
      {body === null || model.notice ? null : (
        <Section
          name={kind === 'review' ? 'reasoning' : 'more'}
          title={kind === 'review' ? 'Reasoning' : 'More detail'}
        >
          <AgendaBody renderProse={renderProse} text={body} />
        </Section>
      )}
      {read.decided?.trim() ? (
        <Section name="decided" title="Decided so far">
          <PointForm renderProse={renderProse} text={read.decided} />
        </Section>
      ) : null}
      {read.stillOpen?.trim() ? (
        <Section name="still-open" title="Still open">
          <PointForm renderProse={renderProse} text={read.stillOpen} />
        </Section>
      ) : null}
      {(item.impact === undefined || effectInNeed) && item.urgency === undefined ? null : (
        <Section name="impact" title={kind === 'permission' ? 'What it allows' : 'Impact'}>
          {item.impact === undefined || effectInNeed ? null : (
            <PointForm renderProse={renderProse} text={item.impact} />
          )}
          {item.urgency === undefined ? null : (
            <p className="fy-card__decision">
              <strong>Urgency:</strong> {item.urgency}
            </p>
          )}
        </Section>
      )}
      {item.links === undefined || linksInNeed ? null : (
        <Section name="links" title="Links">
          <LinksList links={item.links} renderProse={renderProse} />
        </Section>
      )}
      {terms.length === 0 ? null : (
        <Section name="terms" title="Terms">
          <TermsList renderProse={renderProse} terms={terms} />
        </Section>
      )}
      {!latest ? (
        <p className="fy-card__old" data-agenda-old-version="">
          <span>Showing v{shown}.</span>
          <button
            className="kt-btn fy-card__latest"
            data-agenda-latest=""
            onClick={() => setShown(count)}
            type="button"
          >
            <Check aria-hidden="true" size={13} />
            Back to v{count}
          </button>
        </p>
      ) : settled !== undefined ? (
        settled
      ) : isInput ? (
        <div className="fy-card__input" data-agenda-input-form="">
          {inputForm}
        </div>
      ) : planForm !== undefined ? (
        <div className="fy-card__input" data-agenda-plan-form="">
          {planForm}
        </div>
      ) : docked ? null : (
        <>
          {parkedNote}
          {replies}
        </>
      )}
      {docked ? (
        <>
          {parkedNote}
          {createPortal(replies, answerDock)}
        </>
      ) : null}
    </article>
  );
}
