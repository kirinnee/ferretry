/**
 * THE CARD OF AN OPEN AGENDA ITEM — everything the owner reads and answers, in the spec's eight parts, top to bottom
 * (`agenda-item-sections.ts` owns the order; the view's sticky row above holds the title):
 *
 *   1 head          the STATE chip ("Needs you", "Resting · waiting on Zoe") and the STAGE chip ("Question", "Test"),
 *                   small, on one line; then the DESCRIPTION (the item's summary, whole). The version picker, Changes,
 *                   Merge with… and Not needed are the view's ⋯ menu's; this draws what they open (the ↓ swipe skips)
 *   2 premise       PREMISE and CONTEXT — the two fields every item carries — as two tinted blocks
 *   3 detail        the context explained from zero (`detail`), FOLDED
 *   4 references    ONE TABLE of every term and every link (PR, card, file, page), each with a plain meaning; links
 *                   are drawn by the one reference renderer — FOLDED
 *   5 needs         "WHAT I NEED FROM YOU" (`agenda-need.tsx`): exactly the ask, by the card's shape, then why the
 *                   recommendation, the steps, the impact, EVERY CARD ASK with its own buttons, and the answer row;
 *                   marked out while the item needs the owner. When the ferret answered the owner's question, one line
 *                   "Answered: see Where we are now" opens the main tab and brings it into view
 *   6 tabs          THE LIVE DOCUMENT AS TABS (`agenda-tabs.tsx`, &F923): "Where we are now" first and open — the
 *                   answer to the owner's question, decided so far, still open, then the ferret's own Markdown —
 *                   then "The full picture" (a review's Reasoning) and the ferret's own tabs. The open tab is
 *                   remembered per item on this device
 *   7 conversation  the owner's and the ferret's words, oldest first, each whole (`agenda-item-history.tsx`): the log,
 *                   FOLDED
 *   8 activity      the grey "updated / moved / snoozed" lines, FOLDED (`agenda-activity-log.tsx`)
 *
 * A part the item does not carry is not drawn. Nothing is cut short: a long report, reply or edit line is drawn whole.
 * Terms are dotted-underlined where the premise, the context and the options use them (`agenda-terms.tsx`). Picking
 * an earlier version redraws the card as it read then, read-only, with the way back to the latest. A one-row answer
 * docks at the foot of the open item (`answerDock`) so it stays in reach; a card ask's buttons stay in the item.
 */

import {
  AGENDA_SHAPE_LEADS,
  type AgendaCardAnswer,
  type AgendaItem,
  plainLabel,
  singleAgendaQuestion,
} from '@ferretry/core-asks/contract';
import { inputContextLines } from '../../lib/input-context.ts';
import { Check } from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { optionAction } from '../../lib/agenda-answers.ts';
import { agendaCardHead } from '../../lib/agenda-card-head.ts';
import { cardModel } from '../../lib/agenda-card-model.ts';
import { readTab, writeTab } from '../../lib/agenda-fold.ts';
import { useFormPicks } from '../../lib/agenda-form-state.ts';
import type { HistoryEvent } from '../../lib/agenda-history.ts';
import { type InboxAction, swipeMap } from '../../lib/agenda-inbox.ts';
import {
  type ItemCardAsk,
  itemCardAsks,
  itemStage,
  PART_TITLES,
  type ReferenceRow,
  referenceRows,
  STAGE_WORDS,
  stateChip,
} from '../../lib/agenda-item-sections.ts';
import type { LineageTitles } from '../../lib/agenda-merge.ts';
import { cardLettered, itemOptions, letteredOptions } from '../../lib/agenda-options.ts';
import { itemAtVersion, versionCount } from '../../lib/agenda-revisions.ts';
import { openTab, sectionTab, viewTabs } from '../../lib/agenda-tab-view.ts';
import { attachedGateLead, toGateAction, gateOf } from '../../lib/gate-items.ts';
import { type ReplyApproval, replyApproval } from '../../lib/reply-approval.ts';
import { AgendaActivityLog } from './agenda-activity-log.tsx';
import { AgendaLinkRow, PointForm } from './agenda-brief.tsx';
import { AgendaConfigChange } from './agenda-config-change.tsx';
import { AgendaDelivery } from './agenda-delivery.tsx';
import { AgendaFold } from './agenda-fold.tsx';
import { AgendaFormFields } from './agenda-form-fields.tsx';
import { AgendaItemHistory } from './agenda-item-history.tsx';
import { AgendaLineage } from './agenda-merge-control.tsx';
import { AgendaNeed, WantedAnswers, wantedAnswers } from './agenda-need.tsx';
import { AgendaQuickReplies } from './agenda-quick-replies.tsx';
import { AgendaBody, AgendaSteps } from './agenda-steps.tsx';
import { AgendaTabs, Section } from './agenda-tabs.tsx';
import { markTerms, TermLayer } from './agenda-terms.tsx';
import { agendaTypeMeta } from './agenda-type.tsx';
import { VersionDiffPanel } from './agenda-version-diff.tsx';
import { HowToTest } from './how-to-test.tsx';
import { useChangedTabs } from './use-changed-tabs.ts';
import type { DoneCloseView } from './use-done-close-flow.ts';
import { useDownSwipe } from './use-down-swipe.ts';
import type { AgendaMergeView, AgendaVersionsView } from './use-item-lifecycle.ts';

type Prose = (text: string) => ReactNode;

export interface AgendaItemCardProps {
  readonly item: AgendaItem;
  readonly ferret: string;
  readonly now: number;
  readonly busy: boolean;
  readonly error: string | null;
  readonly swipeable: boolean;
  readonly renderProse: Prose;
  /** The ↓ swipe: Skip (the host moves to the next item, changing nothing), or absent where there is no next item. */
  readonly onSkip?: (() => void) | undefined;
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
  /** The cards a machine notice is about (`AgendaCardsHost`): each with its own Open, Start and Close. Got it stays the answer. */
  readonly cardsForm?: ReactNode;
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
  /** What was said about the item, and its edits (`itemHistory`): its conversation and its activity log. */
  readonly history?: readonly HistoryEvent[] | undefined;
  /** Names the item on this device (its machine, conversation and id), so its folded parts are remembered per item. */
  readonly itemKey?: string | undefined;
  /** A card's How to test, read from the board the app holds: what a card ask shows under its heading. Absent: none. */
  readonly howToTestFor?: ((cardId: string) => string | null | undefined) | undefined;
  /** The versions the machine keeps for the item: the Changes panel reads them. Absent: no diff. */
  readonly versions?: AgendaVersionsView | undefined;
  /** "Merge with…" on an open plain conversation. Absent: no merge panel, though lineage lines still show. */
  readonly merge?: AgendaMergeView | undefined;
  /**
   * The version the head's ⋯ menu shows (`agenda-item-menu.tsx`), and the way back to the latest: the view owns the
   * picker, so the card only draws what was picked. Absent or past the newest: the latest version.
   */
  readonly shown?: number | undefined;
  readonly onShowVersion?: ((version: number) => void) | undefined;
  /** Changes, opened from the ⋯ menu: the diff panel under the head (`diffId` is what the menu's button controls). */
  readonly diffOpen?: boolean | undefined;
  readonly diffId?: string | undefined;
  /** Merge with…, opened from the ⋯ menu: the merge panel under the head, closed by its own Cancel or a sent merge. */
  readonly mergeOpen?: boolean | undefined;
  readonly onMergeClose?: (() => void) | undefined;
  /** The titles of the agendas this one was merged into or split from, where the board holds them. */
  readonly lineageTitles?: LineageTitles | undefined;
}

/** The detail without its premise: the daemon also writes a confirmed change into it for older apps. */
const forConfirmation = (item: AgendaItem): AgendaItem => {
  if (item.confirms === undefined) return item;
  const { premise: _premise, ...rest } = item;
  return rest;
};

/** One written part of a card's status: its key, the label it is drawn under, and its Markdown. */
interface StatusPart {
  readonly key: string;
  readonly label: string;
  readonly text: string;
}

/**
 * PREMISE and CONTEXT as two tinted blocks: each label above its points. A board card draws the same two, with its
 * STATUS (the card's current state: Now / Done so far / Next, each Markdown, the empty ones left out) as a calm block
 * above them; an agenda card never has one.
 */
function Situation({
  premise,
  context,
  status = [],
  renderProse,
}: {
  readonly premise: string | null;
  readonly context: string | null;
  readonly status?: readonly StatusPart[];
  readonly renderProse: Prose;
}) {
  if (premise === null && context === null && status.length === 0) return null;
  return (
    <section aria-label="Situation" className="fy-card__situation" data-agenda-situation="">
      {status.length === 0 ? null : (
        <div className="fy-card__sit-row" data-agenda-section="status">
          <h4 className="fy-card__label fy-card__sit-label">Status</h4>
          <div className="fy-card__status">
            {status.map(part => (
              <div className="fy-card__status-part" data-status-part={part.key} key={part.key}>
                <h5 className="fy-card__status-label">{part.label}</h5>
                {renderProse(part.text)}
              </div>
            ))}
          </div>
        </div>
      )}
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
  /** What the list calls it: the option's one word, or its letter (its button always says its label). */
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

/**
 * TERMS AND REFERENCES as ONE table: every term with what it means, then every link, named by its target and meaning
 * its label (empty when it has none: nothing is made up). A link's target is drawn by the one reference renderer
 * (`AgendaLinkRow` → the chat's prose), so `&F12`, `!A3` and a PR read and open exactly as they do in a message.
 */
function ReferencesTable({
  rows,
  renderProse,
}: {
  readonly rows: readonly ReferenceRow[];
  readonly renderProse: Prose;
}) {
  return (
    <table className="fy-card__refs" data-agenda-references="">
      <thead>
        <tr>
          <th scope="col">Term or link</th>
          <th scope="col">What it means</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(row => (
          <tr data-agenda-reference={row.kind} key={row.key}>
            <th className="fy-card__ref-name" scope="row">
              {row.kind === 'term' ? (
                row.term
              ) : (
                <AgendaLinkRow link={{ target: row.link.target }} renderProse={renderProse} />
              )}
            </th>
            <td className="fy-card__ref-meaning">{row.meaning === '' ? null : renderProse(row.meaning)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * ONE CARD ASK inside "What I need from you": its own heading ("Card &F559: your answer for the card"),
 * the card and what it waits on, its How to test when the ask carries one, and ITS buttons (Done / Not good, or OK to
 * build) — tap only, so the arrows and swipes stay the item's own.
 */
function CardAskBlock({
  ask,
  busy,
  onAct,
  renderProse,
  offer = null,
}: {
  readonly ask: ItemCardAsk;
  readonly busy: boolean;
  readonly onAct: (action: InboxAction) => void;
  readonly renderProse: Prose;
  /** The owner's last words already approve this ask (&B155): offered as its answer, one tap, never applied. */
  readonly offer?: ReplyApproval | null;
}) {
  return (
    <div className="fy-card__gate-row" data-agenda-attached-gate={ask.gate.cardId} data-agenda-card-ask={ask.key}>
      <h5 className="fy-card__label fy-card__card-ask-title" data-agenda-card-ask-title="">
        Card &amp;{ask.gate.cardId}: your answer for the card
      </h5>
      <p className="fy-card__gate-lead">{attachedGateLead(ask.gate)}</p>
      {ask.howToTest === null || ask.howToTest.trim() === '' ? null : (
        <div className="fy-card__need-part" data-agenda-card-ask-test="">
          <h5 className="fy-card__label">How to test</h5>
          <HowToTest renderProse={renderProse} text={ask.howToTest} />
        </div>
      )}
      {offer === null ? null : (
        <p className="fy-card__reply-offer" data-agenda-reply-offer="">
          <span>You replied “{offer.reply}”. Use it as your answer for the card?</span>
          <button
            className="kt-btn fy-card__reply-offer-use"
            data-agenda-reply-offer-use={offer.label}
            disabled={busy}
            onClick={() => onAct(toGateAction(optionAction({ label: offer.label }, ''), ask.gate))}
            type="button"
          >
            {offer.label}
          </button>
        </p>
      )}
      <AgendaQuickReplies
        busy={busy}
        error={null}
        map={{}}
        model={cardModel(ask.view)}
        onAct={action => onAct(toGateAction(action, ask.gate))}
        swipeable={false}
        tapOnly
      />
    </div>
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
  onSkip,
  renderProse,
  onAct,
  onProgress,
  doneClose,
  settled,
  parkedNote,
  inputForm,
  planForm,
  cardsForm,
  onRequestChanges,
  answerDock,
  formKey,
  history = [],
  itemKey,
  howToTestFor,
  versions,
  merge,
  lineageTitles,
  shown: picked,
  onShowVersion,
  diffOpen = false,
  diffId,
  mergeOpen = false,
  onMergeClose,
}: AgendaItemCardProps) {
  const count = versionCount(current);
  // Absent follows the latest version, so an edit that lands while the card is open shows at once.
  const shown = Math.min(picked ?? count, count);
  const latest = shown >= count;
  const item = latest ? current : itemAtVersion(current, shown);
  const read = forConfirmation(item);
  const model = cardModel(item);
  const meta = agendaTypeMeta(item);
  const foldKey = itemKey ?? item.id;
  // THE TABS (&F923): the open one is remembered per item on this device; a notice draws its body in its ask, and a card
  // gate's body is its How to test, so for those the full picture is not a tab.
  const [remembered, setRemembered] = useState(() => readTab(foldKey));
  const tabsPart = useRef<HTMLElement | null>(null);
  const tabs = viewTabs(item, model.notice || gateOf(item) !== undefined);
  const openTabId = openTab(tabs, remembered);
  const selectTab = (id: string): void => {
    setRemembered(id);
    writeTab(foldKey, id, id === tabs[0]?.id);
  };
  // Opening a tab from elsewhere on the card ("Answered: see …", a section in Changes) also brings the tabs into view.
  const showTab = (id: string): void => {
    selectTab(id);
    if (typeof tabsPart.current?.scrollIntoView === 'function') tabsPart.current.scrollIntoView({ block: 'start' });
  };
  const changedTabIds = useChangedTabs(current, versions, latest);
  // The head's description: the item's summary under its title, drawn whole (the view's sticky row holds the title).
  // A gate item repeats nothing, and a notice drawn with its cards lists them as rows (its summary is the same lines,
  // for an older app): neither has one.
  const description = cardsForm === undefined ? agendaCardHead(item).description : null;
  // The segment LEADS WITH THE ASK, whatever the header above it says (a form's is its header's, said once): the lone question, else the item's one-line
  // ask — what is being chosen, approved, done or read. Several questions are their own numbered list instead.
  const askLine = singleAgendaQuestion(item)?.question.trim() || item.subject.trim();
  const terms = item.terms ?? [];
  const seen = new Set<number>();
  const mark = (text: string): string => markTerms(text, terms, seen);
  const premise = read.premise?.trim() ? mark(read.premise) : null;
  // A notice with cards lists them as rows with buttons, so its context (the same lines, for an older app) says nothing more.
  const answerable = latest && settled === undefined;
  const isInput = inputForm !== undefined && item.kind === 'input';
  // Only a card that is DRAWN says the agent's prompt itself, under the daemon's facts, so only then does the context keep
  // just the daemon's own lines: a settled record and an older version draw no card, and keep the prompt as written.
  const inputDrawn = isInput && answerable;
  const contextText = inputDrawn ? inputContextLines(read.context) : read.context;
  const context = cardsForm === undefined && contextText?.trim() ? mark(contextText) : null;

  const formFields = item.fields ?? [];
  const formPicks = useFormPicks(formKey ?? item.id, formFields);
  // A gate item is a card to try or approve: its steps are the card's How to test.
  const gated = gateOf(item) !== undefined;
  const pull = useDownSwipe(() => onSkip?.(), swipeable && onSkip !== undefined);

  // A choice (one question): its options are listed with what each means, and answered on the row. Any other shape
  // offers none, whatever options an item raised before the rule still carries.
  const shape = model.shape;
  const choosing = shape === 'choice' || shape === 'yesno';
  const options = choosing ? itemOptions(item) : [];
  const lettered = gateOf(item) === undefined && cardLettered(options);
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
  const showList = !gated && listed.some(option => option.meaning !== null || option.pickHere);

  const questions = item.questions ?? [];
  const recommendation = model.recommendation;
  const recommendedOption = listed.find(option => option.recommended);
  const kind = meta.kind;
  const body = item.body?.trim() ? item.body : null;
  const questionAnswer = item.questionAnswer?.trim() ? item.questionAnswer : null;
  const detail = read.detail?.trim() ? read.detail : null;
  const steps = item.steps ?? [];
  // What the segment already says is not said again below it: an approval's effect, a review's links (they stay under
  // "What to review", beside the buttons, so the table does not list them twice), a to-do's steps.
  const effectInNeed = shape === 'approval' && item.impact !== undefined;
  const linksInNeed = shape === 'review' && item.links !== undefined;
  const references = referenceRows(linksInNeed ? { terms: item.terms } : item);
  const stepsInNeed = shape === 'todo';
  const requestChanges =
    answerable && onRequestChanges !== undefined && model.requestChanges !== undefined
      ? { answer: model.requestChanges, onTap: () => onRequestChanges(model.requestChanges as AgendaCardAnswer) }
      : undefined;
  // Every card ask the item carries is answered HERE, inside the item, with its own buttons: never docked, never a
  // separate item. Only the latest version is answerable, so an earlier one draws none.
  const cardAsks = latest && settled === undefined ? itemCardAsks(item, howToTestFor) : [];
  // The owner already said yes in words ("build", "ok to build!"): offer it as the card ask's answer (&B155).
  const replyOffer = cardAsks.length === 0 ? null : replyApproval(item, history);
  const replies = (
    <AgendaQuickReplies
      busy={busy}
      error={error}
      map={swipeMap(item)}
      model={model}
      onAct={onAct}
      swipeable={swipeable}
      {...(onSkip === undefined ? {} : { onSkip })}
      {...(doneClose === undefined ? {} : { doneClose })}
      {...(item.waitingOn === 'ferret' && !model.notice ? { waitingOn: ferret } : {})}
      {...(requestChanges === undefined ? {} : { requestChanges })}
    />
  );
  // Only a row of buttons docks; a card answered in words has none, and its note or error stays in the card.
  // With card asks the item's own row is not docked: it sits inline under its ask, labelled, so two button sets never
  // share the foot of the view and the card ask's buttons are never covered. An item answered in words (a reply, its
  // questions) has no row to label: it gets no "Your answer for this item" heading over nothing (&B156).
  const ownRow = model.notice || model.answers.length > 0 || requestChanges !== undefined;
  const rowInline = cardAsks.length > 0 && !isInput && planForm === undefined && ownRow;
  const docked =
    answerDock != null &&
    latest &&
    settled === undefined &&
    !isInput &&
    planForm === undefined &&
    cardAsks.length === 0 &&
    (model.notice || model.answers.length > 0 || requestChanges !== undefined);
  const state = stateChip(current, ferret, now);
  const stage = itemStage(current);

  return (
    <article
      aria-label={`${meta.label} card`}
      className="fy-card"
      data-agenda-card-v6={item.id}
      data-agenda-version={shown}
      data-kind={meta.tone}
    >
      {/* 1. HEAD (under the view's one-line title): where it stands and what it is now, as two small chips, then the
          description, whole. The version picker, Changes, Merge with… and Not needed are the head's ⋯ menu's. */}
      <div className="fy-card__head" data-agenda-part="head">
        <div className="fy-card__top" data-agenda-card-top="" {...pull}>
          <span className="fy-card__chips">
            <span className="fy-card__state" data-agenda-state={state.state}>
              {state.label}
            </span>
            {/* A standalone card gate says its stage in its own meta line (Test, Plan to approve): said once. */}
            {gated ? null : (
              <span
                className="fy-card__type"
                data-agenda-stage={stage}
                data-agenda-type={meta.kind}
                data-tone={meta.tone}
              >
                {STAGE_WORDS[stage]}
              </span>
            )}
            {latest ? null : (
              <span className="fy-card__shown" data-agenda-shown-version="">
                Showing v{shown}
              </span>
            )}
          </span>
        </div>
        {gated || description === null ? null : (
          <div className="fy-card__desc" data-agenda-description="">
            {renderProse(description)}
          </div>
        )}
      </div>
      {versions !== undefined && diffOpen && diffId !== undefined ? (
        <VersionDiffPanel
          id={diffId}
          now={now}
          onOpenTab={showTab}
          tabFor={key => sectionTab(key, tabs)}
          versions={versions}
        />
      ) : null}
      {latest ? (
        <AgendaLineage
          item={current}
          merge={merge}
          onMergeClose={onMergeClose ?? (() => undefined)}
          mergeOpen={mergeOpen}
          renderProse={renderProse}
          titles={lineageTitles}
        />
      ) : null}
      {latest ? <AgendaDelivery busy={busy} ferret={ferret} item={item} onAct={onAct} /> : null}
      <TermLayer renderProse={renderProse} terms={terms}>
        {/* 2. PREMISE AND CONTEXT (a held config change first, which stands in for the premise). */}
        {latest ? <AgendaConfigChange item={item} /> : null}
        {gated || (premise === null && context === null) ? null : (
          <div className="fy-card__part" data-agenda-part="premise">
            <Situation context={context} premise={premise} renderProse={renderProse} />
          </div>
        )}
        {/* 3. DETAILED CONTEXT, from zero: folded. */}
        {detail === null ? null : (
          <AgendaFold itemKey={foldKey} part="detail" title={PART_TITLES.detail}>
            <AgendaBody renderProse={renderProse} text={mark(detail)} />
          </AgendaFold>
        )}
        {/* 4. TERMS AND REFERENCES, one table: folded. */}
        {references.length === 0 ? null : (
          <AgendaFold
            itemKey={foldKey}
            meta={`${String(references.length)} ${references.length === 1 ? 'entry' : 'entries'}`}
            part="references"
            title={PART_TITLES.references}
          >
            <ReferencesTable renderProse={renderProse} rows={references} />
          </AgendaFold>
        )}
        {/* 5. WHAT I NEED FROM YOU: the ask, then every card ask with its own buttons, then the answer row. While the item
            needs the owner it is marked out, so the one thing to do is the thing the eye lands on. */}
        <div
          className="fy-card__part"
          data-agenda-part="needs"
          {...(answerable && state.state === 'needs-you' ? { 'data-agenda-needs-you': '' } : {})}
          tabIndex={-1}
        >
          {/* The ferret answered the owner's question: the answer is the main tab's first block, below — said here so it
              is never missed, and one tap opens it. */}
          {questionAnswer === null || tabs[0]?.kind !== 'main' ? null : (
            <p className="fy-card__answered-line" data-agenda-answered-line="">
              <button className="fy-card__answered-link" onClick={() => showTab(tabs[0]?.id ?? '')} type="button">
                Answered: see {tabs[0].name}
              </button>
            </p>
          )}
          {/* An input card's form is its ask: its field says what is wanted, and "Type the value below" said it twice. */}
          {inputDrawn ? null : (
            <AgendaNeed
              shape={shape}
              {...(gated && body !== null ? { heading: 'How to test' } : {})}
              {...(gated ? { lead: '' } : {})}
              {...(!answerable || (shape === 'form' && formKey !== undefined)
                ? // A form filled in here says how to send in its own pinned foot, with the count.
                  { lead: '' }
                : shape === 'form'
                  ? { lead: FORM_ELSEWHERE }
                  : {})}
              {...(answerable && cardsForm !== undefined ? { lead: '' } : {})}
            >
              {askLine === '' ||
              cardsForm !== undefined ||
              (gated && body !== null) ||
              shape === 'answers' ||
              shape === 'input' ||
              shape === 'form' ? null : (
                <div className="fy-card__question" data-agenda-question-line="">
                  {renderProse(mark(askLine))}
                </div>
              )}
              {model.notice && body !== null ? <AgendaBody renderProse={renderProse} text={body} /> : null}
              {cardsForm}
              {gated && body !== null ? <HowToTest renderProse={renderProse} text={body} /> : null}
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
                  instruction={answerable ? AGENDA_SHAPE_LEADS.form : null}
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
          )}
          {rowInline ? (
            <div className="fy-card__item-answer" data-agenda-item-answer="">
              <h5 className="fy-card__label fy-card__item-answer-title">Your answer for this item</h5>
              {parkedNote}
              {replies}
            </div>
          ) : null}
          {recommendation === undefined || recommendation.why === undefined ? null : (
            <Section
              name="recommendation"
              title={`Why I recommend ${recommendedOption?.name ?? recommendation.decision}`}
            >
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
          {cardAsks.length === 0 ? null : (
            <div className="fy-card__card-asks" data-agenda-card-asks={cardAsks.length}>
              {cardAsks.map(ask => (
                <CardAskBlock
                  ask={ask}
                  busy={busy}
                  key={ask.key}
                  offer={replyOffer?.ask === ask.key ? replyOffer : null}
                  onAct={onAct}
                  renderProse={renderProse}
                />
              ))}
            </div>
          )}
          {!latest ? (
            <p className="fy-card__old" data-agenda-old-version="">
              <span>Showing v{shown}.</span>
              <button
                className="kt-btn fy-card__latest"
                data-agenda-latest=""
                onClick={() => onShowVersion?.(count)}
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
          ) : (
            <>
              {rowInline ? null : parkedNote}
              {rowInline ? null : docked ? createPortal(replies, answerDock) : replies}
            </>
          )}
        </div>
        {/* 6. THE TABS: the live document — the main tab first and open, then the full picture and the ferret's own. */}
        <AgendaTabs
          changed={changedTabIds}
          mark={mark}
          onOpen={selectTab}
          open={openTabId}
          partRef={tabsPart}
          renderProse={renderProse}
          tabs={tabs}
        />
      </TermLayer>
      {/* 7. CONVERSATION, oldest first: the log, at the bottom, folded. */}
      <AgendaItemHistory events={history} ferret={ferret} itemKey={foldKey} renderProse={renderProse} />
      {/* 8. ACTIVITY LOG: folded. */}
      <AgendaActivityLog ferret={ferret} item={current} itemKey={foldKey} now={now} />
    </article>
  );
}
