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
  inputContextLines,
  plainLabel,
  singleAgendaQuestion,
} from '@ferretry/protocol';
import { Check } from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { kindWord, optionAction } from '../../lib/agenda-answers.ts';
import { agendaCardHead } from '../../lib/agenda-card-head.ts';
import { cardModel } from '../../lib/agenda-card-model.ts';
import { readTab, writeTab } from '../../lib/agenda-fold.ts';
import { useFormPicks } from '../../lib/agenda-form-state.ts';
import type { HistoryEvent } from '../../lib/agenda-history.ts';
import { type InboxAction, type SwipeMap, swipeMap } from '../../lib/agenda-inbox.ts';
import {
  type ItemCardAsk,
  itemAskPlan,
  itemCardAsks,
  itemStage,
  PART_TITLES,
  planAskWord,
  type ReferenceRow,
  referenceRows,
  stateChip,
} from '../../lib/agenda-item-sections.ts';
import type { LineageTitles } from '../../lib/agenda-merge.ts';
import { cardLettered, itemOptions, letteredOptions } from '../../lib/agenda-options.ts';
import { itemAtVersion, versionCount } from '../../lib/agenda-revisions.ts';
import { openTab, sectionTab, viewTabs } from '../../lib/agenda-tab-view.ts';
import { attachedGateHeading, attachedGateReference, toGateAction } from '../../lib/gate-items.ts';
import { HowToTest } from '../board/detail/board-detail-sections.tsx';
import { AgendaActivityLog } from './agenda-activity-log.tsx';
import { AgendaLinkRow, PointForm } from './agenda-brief.tsx';
import { CardAskAnswer } from './agenda-card-ask-answer.tsx';
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
  /**
   * The host draws the box under the item and takes what is typed there as the answer to the item's one card ask (the
   * Inbox's, `typedCardAsk`). Only then is that ask Good-only; everywhere else it keeps its own buttons.
   */
  readonly typedAnswer?: boolean;
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
  /** The cards a machine notice is about (`AgendaCardsHost`): ONE form, a pick per card and one Send, which is the answer. */
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

/** The longest title that reads whole in the sticky row (two lines on a phone, one on a desktop): longer, the block keeps the ask. */
const TITLE_READS_WHOLE = 90;

/** Two lines that say the same thing: the same words once case and spacing are set aside. */
const sameWords = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The detail without its premise: the daemon also writes a confirmed change into it for older apps. */
const forConfirmation = (item: AgendaItem): AgendaItem => {
  if (item.confirms === undefined) return item;
  const { premise: _premise, ...rest } = item;
  return rest;
};

/** One written part of a card's status: its key, the label it is drawn under, and its Markdown. */
export interface StatusPart {
  readonly key: string;
  readonly label: string;
  readonly text: string;
}

/**
 * PREMISE and CONTEXT as two tinted blocks: each label above its points. A board card draws the same two, with its
 * STATUS (the card's current state: Now / Done so far / Next, each Markdown, the empty ones left out) as a calm block
 * above them; an agenda card never has one.
 */
export function Situation({
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
 * ONE CARD ASK, drawn as the ITEM'S OWN ASK inside "What I need from you" (docs/agenda.md § One model): its verb as the
 * heading ("Try it", "Approve"), ONE plain reference line naming the card ("For &F12 Badge colour"), how to try it, and
 * its answers — the gate's buttons, or (`typed`) Good alone with the words typed below as the other answer. It is never
 * headed "Card …" and never says "your answer for the card": to the owner it is simply what this item asks.
 */
function CardAskBlock({
  ask,
  busy,
  onAct,
  renderProse,
  map = {},
  swipeable = false,
  onSkip,
  typed = false,
  error = null,
}: {
  readonly ask: ItemCardAsk;
  readonly busy: boolean;
  /** Why the last answer did not land: said beside the one ask, whichever of the item's rows waits behind it. */
  readonly error?: string | null;
  readonly onAct: (action: InboxAction) => void;
  readonly renderProse: Prose;
  /** The swipes this ask answers, when it is the item's only answer (the arrows are drawn and swiped). */
  readonly map?: SwipeMap;
  readonly swipeable?: boolean;
  readonly onSkip?: (() => void) | undefined;
  /** The host's box under the item takes the typed words as this ask's other answer: Good is the one button. */
  readonly typed?: boolean;
}) {
  const own = Object.keys(map).length > 0;
  const steps = ask.howToTest === null || ask.howToTest.trim() === '' ? null : ask.howToTest;
  return (
    <div className="fy-card__gate-row" data-agenda-attached-gate={ask.gate.cardId} data-agenda-card-ask={ask.key}>
      {/* The verb and the one reference line share a row when they fit: one line of the block, not two. */}
      <div className="fy-card__ask-head">
        <h5 className="fy-card__label fy-card__card-ask-title" data-agenda-card-ask-title="">
          {attachedGateHeading(ask.gate)}
        </h5>
        <div className="fy-card__gate-lead" data-agenda-card-ask-ref="">
          {renderProse(attachedGateReference(ask.gate))}
        </div>
      </div>
      {typed ? (
        <>
          <CardAskAnswer ask={ask} busy={busy} onAct={onAct} renderProse={renderProse} />
          {error === null ? null : (
            <p className="fy-qr__error m-0" data-agenda-card-ask-error="" role="alert">
              Not sent: {error}
            </p>
          )}
        </>
      ) : (
        <>
          {steps === null ? null : (
            // The steps follow the ask's own heading ("Try it"): a second "How to test" label would only say it again.
            <div className="fy-card__need-part" data-agenda-card-ask-test="">
              <HowToTest renderProse={renderProse} text={steps} />
            </div>
          )}
          <AgendaQuickReplies
            busy={busy}
            error={error}
            map={map}
            model={cardModel(ask.view)}
            onAct={action => onAct(toGateAction(action, ask.gate))}
            swipeable={own && swipeable}
            tapOnly={!own}
            {...(own && onSkip !== undefined ? { onSkip } : {})}
          />
        </>
      )}
    </div>
  );
}

/**
 * A card ask that waits for the item's own answer: the item has a row of its own, and one answer row is all an item
 * shows. One plain line names it; its buttons come once the item's own ask is answered.
 */
function CardAskLater({ ask, renderProse }: { readonly ask: ItemCardAsk; readonly renderProse: Prose }) {
  return (
    <div className="fy-card__card-ask-later" data-agenda-card-ask-later={ask.key}>
      {renderProse(
        `Next: ${attachedGateHeading(ask.gate).toLowerCase()}, ${attachedGateReference(ask.gate).replace(/^For /u, 'for ')}.`,
      )}
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
  typedAnswer = false,
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
  const tabs = viewTabs(item, model.notice || item.gate !== undefined);
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
  const cardHead = agendaCardHead(item);
  const headDescription = cardsForm === undefined ? cardHead.description : null;
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
  const gated = item.gate !== undefined;
  const pull = useDownSwipe(() => onSkip?.(), swipeable && onSkip !== undefined);

  // ONE answer row (docs/agenda.md § One model): the first card ask the item carries is asked first, as the item's own,
  // inside "What I need from you"; the item's own buttons wait behind it (`ownRowHeld`). Only the latest version is
  // answerable, so an earlier one draws none.
  const cardAsks = latest && settled === undefined ? itemCardAsks(item, howToTestFor) : [];
  const plan = itemAskPlan(item, cardAsks, { typedHost: typedAnswer });

  // A choice (one question): its options are listed with what each means, and answered on the row. Any other shape
  // offers none, whatever options an item raised before the rule still carries.
  const shape = model.shape;
  const choosing = (shape === 'choice' || shape === 'yesno') && !plan.ownAnswered;
  const options = choosing ? itemOptions(item) : [];
  const lettered = item.gate === undefined && cardLettered(options);
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
        pickHere: answerable && !plan.ownRowHeld && !onRow.has(option.label.trim().toLowerCase()),
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
  // A FINISHED item (resolved or done) is a record: it shows how it ended once (the chip, or the host's settled line) and
  // asks nothing, so there is no "What I need from you" box on it.
  // (A notice reads "done" to the protocol while it is still open and answered by its form: that is not finished.)
  const finished = (current as { readonly resolvedAt?: string }).resolvedAt !== undefined;
  // The item's question is said ONCE: when the "What I need from you" block leads with it, the head does not repeat it,
  // and when the title above already IS the question (the sticky row, always on screen) the block does not say it again.
  // The sticky row always shows the CURRENT item's title, so an older version is judged against that, not its own.
  const shownTitle = agendaCardHead(current).title;
  const questionLineShown =
    !finished &&
    askLine !== '' &&
    !(askLine.length <= TITLE_READS_WHOLE && sameWords(shownTitle, askLine)) &&
    plan.ownLine &&
    cardsForm === undefined &&
    !(gated && body !== null) &&
    shape !== 'answers' &&
    shape !== 'input' &&
    shape !== 'form';
  const description =
    headDescription !== null && questionLineShown && sameWords(headDescription, askLine) ? null : headDescription;
  const questionAnswer = item.questionAnswer?.trim() ? item.questionAnswer : null;
  const detail = read.detail?.trim() ? read.detail : null;
  const steps = item.steps ?? [];
  // What the segment already says is not said again below it: an approval's effect, a review's links (they stay under
  // "What to review", beside the buttons, so the table does not list them twice), a to-do's steps.
  const effectInNeed = shape === 'approval' && item.impact !== undefined && !plan.ownAnswered;
  const linksInNeed = shape === 'review' && item.links !== undefined && !plan.ownAnswered;
  const references = referenceRows(linksInNeed ? { terms: item.terms } : item);
  const stepsInNeed = shape === 'todo';
  const requestChanges =
    answerable && onRequestChanges !== undefined && model.requestChanges !== undefined
      ? { answer: model.requestChanges, onTap: () => onRequestChanges(model.requestChanges as AgendaCardAnswer) }
      : undefined;
  const askBlocks =
    plan.asks.length === 0 && plan.later.length === 0 ? null : (
      <div className="fy-card__card-asks" data-agenda-card-asks={plan.asks.length} data-bare="">
        {plan.asks.map(ask => (
          <CardAskBlock
            ask={ask}
            busy={busy}
            key={ask.key}
            onAct={onAct}
            renderProse={renderProse}
            typed={plan.typed === ask}
            error={error}
            {...(plan.swipes === undefined ? {} : { map: plan.swipes, swipeable })}
            {...(plan.swipes !== undefined && onSkip !== undefined ? { onSkip } : {})}
          />
        ))}
        {plan.later.map(ask => (
          <CardAskLater ask={ask} key={ask.key} renderProse={renderProse} />
        ))}
      </div>
    );
  const replies = (
    <AgendaQuickReplies
      busy={busy}
      // While a card ask is the item's answer, its error is said beside it and the item offers no Done-closes of its
      // own: that would be a second answer row (&B165).
      error={plan.asks.length > 0 ? null : error}
      map={swipeMap(item)}
      model={model}
      onAct={onAct}
      swipeable={swipeable}
      {...(onSkip === undefined ? {} : { onSkip })}
      {...(doneClose === undefined || plan.asks.length > 0 ? {} : { doneClose })}
      {...(item.waitingOn === 'ferret' && !model.notice ? { waitingOn: ferret } : {})}
      {...(requestChanges === undefined ? {} : { requestChanges })}
    />
  );
  // Only a row of buttons docks; a card answered in words has none, and its note or error stays in the card. An item
  // whose card asks are its answer has their buttons inside "What I need from you", so nothing docks over them.
  const docked =
    answerDock != null &&
    latest &&
    settled === undefined &&
    !isInput &&
    planForm === undefined &&
    cardsForm === undefined &&
    plan.asks.length === 0 &&
    (model.notice || model.answers.length > 0 || requestChanges !== undefined);
  const state = stateChip(current, ferret, now);
  const stage = itemStage(current);
  // The chip says the same word the Inbox's list row does, for every kind: a card to try is a Test (`itemAskWord`), anything
  // else its kind's word (`kindWord`: Decision, Question, …), so the list and the open item never disagree.
  const askWord = planAskWord(plan);

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
            {/* A finished item says how it ended once: its settled line when the host draws one, else this chip. */}
            {finished && settled !== undefined ? null : (
              <span className="fy-card__state" data-agenda-state={state.state}>
                {state.label}
              </span>
            )}
            {/* A standalone card gate says its stage in its own meta line (Test, Plan to approve): said once. A finished
                item's stage is not said at all: it is the state, and the state is said once. */}
            {gated || finished ? null : (
              <span
                className="fy-card__type"
                data-agenda-stage={stage}
                data-agenda-type={meta.kind}
                data-tone={meta.tone}
              >
                {askWord ?? kindWord(item)}
              </span>
            )}
            {latest ? null : (
              <span className="fy-card__shown" data-agenda-shown-version="">
                Showing v{shown}
              </span>
            )}
          </span>
        </div>
        {
          // A card ask that is the item's whole ask says the ask itself (Try it, the card, the steps): the generated "Try it: …"
          // line under the title would say it a second time.
          gated ||
          plan.typed !== undefined ||
          (plan.asks.length > 0 && !plan.ownLine) ||
          description === null ? null : (
            <div className="fy-card__desc" data-agenda-description="">
              {renderProse(description)}
            </div>
          )
        }
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
        {/* A notice about cards is answered by its one form: its premise ("these cards have no ferret") only says its title again. */}
        {gated || cardsForm !== undefined || (premise === null && context === null) ? null : (
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
          {...(answerable && !finished && state.state === 'needs-you' ? { 'data-agenda-needs-you': '' } : {})}
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
          {inputDrawn || finished ? null : (
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
              {...((answerable && cardsForm !== undefined) || plan.asks.length > 0 ? { lead: '' } : {})}
            >
              {questionLineShown ? (
                <div className="fy-card__question" data-agenda-question-line="">
                  {renderProse(mark(askLine))}
                </div>
              ) : null}
              {model.notice && body !== null ? <AgendaBody renderProse={renderProse} text={body} /> : null}
              {cardsForm}
              {plan.ownRowHeld && !plan.ownAnswered && plan.asks[0] !== undefined ? (
                <p className="fy-card__card-ask-later" data-agenda-own-row-held="">
                  First answer the {attachedGateHeading(plan.asks[0].gate) === 'Try it' ? 'try-it' : 'approval'} below;
                  the buttons for this come back once it is answered.
                </p>
              ) : null}
              {askBlocks}
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
              {shape === 'form' && !plan.ownAnswered ? (
                <AgendaFormFields
                  disabled={busy || !answerable}
                  fields={formFields}
                  formKey={formKey ?? null}
                  instruction={answerable ? AGENDA_SHAPE_LEADS.form : null}
                  picks={formPicks}
                  renderProse={renderProse}
                />
              ) : null}
              {shape === 'answers' && !plan.ownAnswered ? (
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
              {parkedNote}
              {/* A notice's cards form is its answer (its Send answers Got it): no second row under it. */}
              {cardsForm !== undefined ? (
                error === null ? null : (
                  <p className="fy-qr__error m-0" role="alert">
                    Not sent: {error}
                  </p>
                )
              ) : plan.ownRowHeld ? null : docked ? (
                createPortal(replies, answerDock)
              ) : (
                replies
              )}
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
