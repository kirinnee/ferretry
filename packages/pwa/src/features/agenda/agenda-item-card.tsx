/**
 * THE CARD OF AN OPEN AGENDA ITEM — everything the owner reads and answers, in ONE card, top to bottom:
 *
 *   top bar    the item's type, "↓ Not needed" (the ↓ swipe) and the version picker ("v2 of 2 · 3m ago")
 *   situation  PREMISE and CONTEXT — the two fields every item carries — as one soft panel: labels left, points right
 *   question   the one thing asked, said plainly
 *   options    each option's one-word name (or its letter) and what it means, the recommended one said in words
 *   sections   only what the item carries, each folding: why the recommendation, steps, reasoning or more detail
 *              (Markdown with fy-render), decided, still open, impact, links, terms
 *   answers    ONE row of at most three — ← ↑ → — or the item's own form (an input request), or why it cannot be
 *              answered here (parked or resolved)
 *
 * Terms are dotted-underlined where the premise, the context and the options use them (`agenda-terms.tsx`). Picking
 * an earlier version redraws the card as it read then, read-only, with the way back to the latest. No left accent
 * bars, no hint lines, no menus.
 */

import type { AgendaItem, AgendaTerm } from '@ferretry/protocol';
import { Check } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { optionAction } from '../../lib/agenda-answers.ts';
import { agendaCardHead } from '../../lib/agenda-card-head.ts';
import { cardModel } from '../../lib/agenda-card-model.ts';
import { cardRow } from '../../lib/agenda-card-row.ts';
import { DISMISS_ACTION, type InboxAction, questionAnswersAction } from '../../lib/agenda-inbox.ts';
import { cardLettered, itemOptions, letteredOptions } from '../../lib/agenda-options.ts';
import { itemAtVersion, revisionStamp, shortAgo, versionCount } from '../../lib/agenda-revisions.ts';
import { AgendaLinkRow, PointForm, Question } from './agenda-brief.tsx';
import { AgendaConfigChange } from './agenda-config-change.tsx';
import { AgendaDelivery } from './agenda-delivery.tsx';
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
  /** The form an `input` item is answered with (`InputCardHost`): drawn in the answer row's place. */
  readonly inputForm?: ReactNode;
}

/** The option a question's recommendation names, or '' when it names none. */
const recommendedPick = (question: NonNullable<AgendaItem['questions']>[number]): string => {
  const pick = question.recommended?.trim() ?? '';
  return question.options?.some(option => option.label === pick) === true ? pick : '';
};

/** The detail without its premise: the daemon also writes a confirmed change into it for older apps. */
const forConfirmation = (item: AgendaItem): AgendaItem => {
  if (item.confirms === undefined) return item;
  const { premise: _premise, ...rest } = item;
  return rest;
};

function Fold({
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
    <details className="fy-card__fold" data-agenda-section={name} open={open}>
      <summary className="fy-card__fold-title">
        <span className="fy-card__label">{title}</span>
      </summary>
      <div className="fy-card__fold-body">{children}</div>
    </details>
  );
}

/** PREMISE and CONTEXT as one soft panel: the label on the left, the points on the right. */
function Situation({
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
              aria-label={`Choose ${option.label}`}
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
  inputForm,
}: AgendaItemCardProps) {
  const count = versionCount(current);
  // `null` follows the latest version, so an edit that lands while the card is open shows at once.
  const [picked, setPicked] = useState<number | null>(null);
  const shown = Math.min(picked ?? count, count);
  const setShown = (version: number): void => setPicked(version >= count ? null : version);
  const [picks, setPicks] = useState<readonly string[]>([]);
  const latest = shown >= count;
  const item = latest ? current : itemAtVersion(current, shown);
  const read = forConfirmation(item);
  const model = cardModel(item);
  // The answer row reads in the options list's order, its swipes pointed to match (`cardRow`).
  const row = cardRow(item, model);
  const meta = agendaTypeMeta(item);
  const { question } = agendaCardHead(item);
  const terms = item.terms ?? [];
  const seen = new Set<number>();
  const mark = (text: string): string => markTerms(text, terms, seen);
  const premise = read.premise?.trim() ? mark(read.premise) : null;
  const context = read.context?.trim() ? mark(read.context) : null;

  const answerable = latest && settled === undefined;
  const isInput = inputForm !== undefined && item.kind === 'input';
  const canDismiss = answerable && !isInput && model.dismissInMenu && !model.notice;
  const dismiss = (): void => {
    if (!busy) onAct(DISMISS_ACTION);
  };
  const pull = useDownSwipe(dismiss, swipeable && canDismiss);

  // One question (or a choice ask): its options are listed with what each means, and answered on the row.
  const options = model.perQuestion ? [] : itemOptions(item);
  const lettered = cardLettered(options);
  const onRow = new Set(model.answers.map(answer => answer.label.trim().toLowerCase()));
  const listed: readonly ListedOption[] = letteredOptions(options, item.optionDetails, model.recommended).map(
    option => {
      const named = lettered ? option.letter : option.label;
      const meaning = lettered
        ? `**${option.label}**${option.detail === undefined ? '' : ` — ${option.detail}`}`
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
  const asked = questions.flatMap((entry, index) => (entry.options === undefined ? [] : [{ entry, index }]));
  const agreed = questions.map(recommendedPick);
  const sendable =
    model.perQuestion && asked.length > 0 && asked.every(({ index }) => (picks[index] ?? '').trim() !== '')
      ? questionAnswersAction(questions, picks)
      : null;
  const picker = model.perQuestion
    ? {
        answers: picks,
        disabled: busy || !answerable,
        onAnswer: (index: number, text: string) =>
          setPicks(now => {
            const next = questions.map((_, at) => now[at] ?? '');
            next[index] = text;
            return next;
          }),
      }
    : undefined;

  const recommendation = model.recommendation;
  const recommendedOption = listed.find(option => option.recommended);
  const kind = meta.kind;
  const body = item.body?.trim() ? item.body : null;
  const steps = item.steps ?? [];

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
        {model.notice && body !== null ? <AgendaBody renderProse={renderProse} text={body} /> : null}
        {question === null ? null : (
          <div className="fy-card__question" data-agenda-question-line="">
            {renderProse(mark(question))}
          </div>
        )}
        {showList ? (
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
        {questions.length > 1 ? (
          <ol className="fy-card__questions" data-agenda-questions="">
            {questions.map((entry, index) => (
              <li data-agenda-question={index} key={entry.question}>
                <Question
                  details={item.optionDetails}
                  index={index}
                  numbered
                  picker={picker}
                  question={entry}
                  renderProse={renderProse}
                  showWhy
                />
              </li>
            ))}
          </ol>
        ) : null}
      </TermLayer>
      {recommendation === undefined || model.perQuestion || recommendation.why === undefined ? null : (
        <Fold
          name="recommendation"
          open
          title={`Why I recommend ${recommendedOption?.name ?? recommendation.decision}`}
        >
          {recommendedOption === undefined ? (
            <p className="fy-card__decision">
              <strong>{recommendation.decision}</strong>
            </p>
          ) : null}
          <PointForm renderProse={renderProse} text={recommendation.why} />
        </Fold>
      )}
      {steps.length === 0 ? null : (
        <Fold name="steps" open={kind === 'task'} title="Steps">
          <AgendaSteps
            disabled={busy || !answerable}
            done={item.stepsDone ?? []}
            renderProse={renderProse}
            steps={steps}
            {...(onProgress === undefined || !answerable ? {} : { onProgress })}
          />
        </Fold>
      )}
      {body === null || model.notice ? null : (
        <Fold
          name={kind === 'review' ? 'reasoning' : 'more'}
          open={kind === 'review'}
          title={kind === 'review' ? 'Reasoning' : 'More detail'}
        >
          <AgendaBody renderProse={renderProse} text={body} />
        </Fold>
      )}
      {read.decided?.trim() ? (
        <Fold name="decided" title="Decided so far">
          <PointForm renderProse={renderProse} text={read.decided} />
        </Fold>
      ) : null}
      {read.stillOpen?.trim() ? (
        <Fold name="still-open" title="Still open">
          <PointForm renderProse={renderProse} text={read.stillOpen} />
        </Fold>
      ) : null}
      {item.impact === undefined && item.urgency === undefined ? null : (
        <Fold name="impact" title={kind === 'permission' ? 'What it allows' : 'Impact'}>
          {item.impact === undefined ? null : <PointForm renderProse={renderProse} text={item.impact} />}
          {item.urgency === undefined ? null : (
            <p className="fy-card__decision">
              <strong>Urgency:</strong> {item.urgency}
            </p>
          )}
        </Fold>
      )}
      {item.links === undefined ? null : (
        <Fold name="links" title="Links">
          <ul className="fy-card__links">
            {item.links.map(link => (
              <li key={`${link.label ?? ''}\u0000${link.target}`}>
                <AgendaLinkRow link={link} renderProse={renderProse} />
              </li>
            ))}
          </ul>
        </Fold>
      )}
      {terms.length === 0 ? null : (
        <Fold name="terms" title="Terms">
          <TermsList renderProse={renderProse} terms={terms} />
        </Fold>
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
      ) : (
        <AgendaQuickReplies
          busy={busy}
          error={error}
          map={row.map}
          model={{ ...model, answers: row.answers }}
          onAct={onAct}
          options={options}
          swipeable={swipeable}
          {...(canDismiss ? { onDown: dismiss } : {})}
          {...(doneClose === undefined ? {} : { doneClose })}
          {...(item.waitingOn === 'ferret' && !model.notice ? { waitingOn: ferret } : {})}
          {...(model.perQuestion && asked.length > 0
            ? {
                sending: {
                  ready: sendable !== null,
                  canUseRecommended: asked.every(({ index }) => agreed[index] !== ''),
                  onSend: () => {
                    if (sendable === null || busy) return;
                    onAct(sendable);
                    setPicks([]);
                  },
                  onUseRecommended: () => setPicks(agreed),
                },
              }
            : {})}
        />
      )}
    </article>
  );
}
