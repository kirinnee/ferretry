/**
 * THE INBOX — everything every ferret on every paired machine is waiting on the reader for, grouped by FERRET.
 *
 * - THREE SECTIONS, in the order to look: "Stopped on you" (a ferret idle until you answer), "Needs you"
 *   (items on your turn), then "With ferrets" (items on the ferret's turn — nothing for you to do, so it is
 *   COLLAPSED until asked for). A ferret's group says who it is and where once, then lists its items and,
 *   below them, its plain notifications (a line, a time, Clear). The badge counts items on your turn and the
 *   notifications you have not cleared.
 * - WHO AND WHAT: a ferret's group says its callsign, what it works on (the task's name and its card, `&F12`) and
 *   its machine — never the callsign alone — and so does the open item.
 * - A TAP OPENS THE ITEM HERE, as the SAME full item view the chat shows (`AgendaItemView`: Markdown, options,
 *   quick replies, terms, history), with that ferret's REAL composer under it ({@link AgendaInboxPageProps.renderComposer}):
 *   what is typed goes to the ferret's chat about the item (`!A5 …`, the chat's own path) and a quick reply carries
 *   it as its note. Every row is still a real link to the conversation at the item (`?attention=<id>`), so a
 *   modified click opens the chat, and the open item has "Open chat". A tapped notification opens the chat and
 *   clears itself.
 * - THE OPEN ITEMS ARE A DECK, on a phone and a wide screen alike: SWIPE (or press) in the direction of an answer —
 *   the card's own row, in the options list's order: ← the first, ↑ the second, → the third — and ↓ is Skip,
 *   as everywhere: the next item, nothing sent, the skipped item stays open. "Not needed" is its own button, never a swipe. On touch the card's top bar and answer row swipe on their own,
 *   exactly as in the chat; the item's head and the who-and-what line are the deck's. A swipe goes into the same
 *   undo window as a tap; reduced motion drops the fly-off. NO TEACHING TEXT: no banner naming an answer mid-drag and, on a phone,
 *   no hint line (a wide screen's run has ONE quiet line of its keys under the card, asked for by the owner); the one thing drawn is "Skip" on the ground a card pulled down uncovers (`SwipeReveal`,
 *   where any later down-gesture goes). "Answer quickly" runs the deck from the top on a phone and a wide screen alike. On a wide screen the run is
 *   centred at a readable width, takes ← → ↓ (answer, answer, Skip) and j/k (move) from anywhere that is not a field or
 *   a menu, Esc closes it, a mouse drag swipes, and finishing says "All done". In the list, j/k (or ↑/↓) walk the rows
 *   and Enter opens one.
 * - FILTERS: Open / Snoozed (n) / Replied (n) / Resolved — a snoozed or replied item is parked: off the open list and the
 *   badge until it wakes, is unsnoozed, or the ferret re-opens it — a machine filter (once there is more than one machine), Find, and — from
 *   `/inbox?from=warden` — a "From Warden" chip that keeps only what the Warden raised, with a way to clear it.
 *
 * The page renders off the shell's `AgendaInbox` alone, so it render-tests with a fake one; reading what was said
 * about an open item (its History) is the host's (`readConversation`).
 */

import { type AgendaId, formatTaskRef } from '@ferretry/protocol';
import {
  ArrowLeft,
  ArrowRight,
  CheckCheck,
  ChevronRight,
  CloudOff,
  Laptop,
  SkipForward,
  Users,
  X,
  Zap,
} from 'lucide-react';
import { Fragment, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { DaemonTaskReferences } from '../../components/daemon-task-references.tsx';
import { Spinner } from '../../components/spinner.tsx';
import type { AgendaInbox } from '../../hooks/use-agenda-inbox.ts';
import { CLEAR_ACTION, kindWord, swipeTargets } from '../../lib/agenda-answers.ts';
import { itemCardKind } from '../../lib/card-kind.ts';
import type { ClearPort } from '../../lib/agenda-clear-agents.ts';
import { sendForm } from '../../lib/agenda-form-send.ts';
import { itemHistory } from '../../lib/agenda-history.ts';
import {
  actionSentence,
  agendaConversationPath,
  DISMISS_ACTION,
  type FailedAgendaAction,
  type InboxAction,
  type InboxCard,
  type InboxResolved,
  RESOLVED_READ_LIMIT,
  snoozeAction,
  UNSNOOZE_ACTION,
} from '../../lib/agenda-inbox.ts';
import {
  type FerretGroup,
  filterInboxCards,
  filterInboxResolved,
  groupCards,
  type InboxListFilter,
  type InboxSource,
  inboxMachines,
  inboxRowAsk,
  inboxRowTitle,
  inboxSections,
  inboxWho,
  nextSelection,
  type ParkedReason,
  parkedBy,
  QUEUE_END,
  skipSelection,
  stepSelection,
} from '../../lib/agenda-inbox-list.ts';
import { composerNoteFor, inputDraftDiscarded, withComposerNote } from '../../lib/agenda-reply.ts';
import { agendaAuthor, agendaStatus, clockWords } from '../../lib/agenda-status.ts';
import type { ModeFilter } from '../../lib/controls.ts';
import type { DaemonId } from '../../lib/daemon-connection.ts';
import { daemonSessionScope } from '../../lib/daemon-scope.ts';
import { escapeCloses } from '../../lib/escape-closes.ts';
import {
  choiceLabel,
  type GateItem,
  gateAnswerAction,
  gateAsksWords,
  gateVerb,
  gateWordsFor,
  isGateItem,
} from '../../lib/gate-items.ts';
import { laneEditDestination } from '../../lib/lane-proposal-link.ts';
import { daemonAgendaPath, daemonBoardCardPath, daemonSessionPath } from '../../lib/pages/routes.ts';
import { composerQuoteTarget } from '../../lib/quote.ts';
import type { TranscriptEntry } from '../../lib/session-screens.ts';
import { filterToTest, type ToTestCard } from '../../lib/to-test-inbox.ts';
import { AgendaCountBadge } from '../../shell/app-bar.tsx';
import { RouteLink } from '../../shell/route-link.tsx';
import { sessionsBarNames } from '../../shell/sessions-bar-model.ts';
import { PageThemeSwitch } from '../../shell/theme-toggle.tsx';
import { BoardSendBack } from '../board/board-send-back.tsx';
import { InputCardHost } from '../input-request/input-card-host.tsx';
import { PhoneApprovalHost } from '../input-request/phone-approval-host.tsx';
import { TwoFactorSeedHost } from '../input-request/two-factor-seed-host.tsx';
import { browserClipboardWriter } from '../onboarding/copy-button.tsx';
import { CopyPlanHost } from '../secure-copy/copy-plan-host.tsx';
import { SignInRuleSuggestionHost } from '../secure-copy/sign-in-rule-suggestion-host.tsx';
import { TaskPlanHost } from '../secure-copy/task-plan-host.tsx';
import { agendaAge, agendaReference } from './agenda-board.tsx';
import { AgendaCard, type AgendaCardOrigin } from './agenda-card.tsx';
import { AgendaItemView } from './agenda-item-view.tsx';
import { CardKindChip } from './card-kind-chip.tsx';
import { CardMetaLine, MetaDot } from './card-meta-line.tsx';
import { FilterMenu, FindBox, FindToggle } from './inbox-filter-menu.tsx';
import { agendaProse } from './agenda-prose.tsx';
import { ResolvedRow } from './agenda-resolved.tsx';
import { AgendaStatusPill } from './agenda-status-pill.tsx';
import { AgendaSwipeDeck } from './agenda-swipe-deck.tsx';
import { ownsKeys } from './agenda-swipe-gesture.ts';
import { AgendaUndoToast } from './agenda-undo-toast.tsx';
import { ClearAgentsControl } from './clear-agents.tsx';
import { type ToTestAnswers, type ToTestHost, ToTestList, useToTestAnswers, wordsOf } from './to-test-rows.tsx';
import { ToTestStep } from './to-test-step.tsx';

/**
 * Where a card came from: the FERRET that asked (its callsign, else the row's title), what it is working
 * on when that differs, and its machine — linked to the conversation at the item.
 */
export const inboxCardOrigin = (card: InboxCard, onNavigate: (to: string) => void): AgendaCardOrigin => {
  const names = sessionsBarNames(card.view);
  return {
    ferret: names.ferret ?? names.title,
    ...(names.ferret === null ? {} : { task: names.title }),
    machine: card.machineName,
    href: agendaConversationPath(card.daemonId, card.view.config.id, card.item.id),
    onNavigate,
  };
};

/** The refusal a card carries, if its last answer did not land. */
const failureFor = (failed: readonly FailedAgendaAction[], key: string): string | null =>
  failed.find(failure => failure.key === key)?.message ?? null;

/** The words a page head uses for how many are waiting. */
export const waitingWords = (count: number): string => (count === 0 ? 'Nothing waiting' : `${count} waiting on you`);

/** A row's age, short: "7h", "now". */
const shortAge = (waitingSince: string, now: number | undefined): string =>
  agendaAge(waitingSince, now).replace(/^waiting /u, '');

interface CardHostProps {
  readonly inbox: AgendaInbox;
  readonly onNavigate: (to: string) => void;
  readonly now: number | undefined;
  readonly readConversation?: ((card: InboxCard) => Promise<readonly TranscriptEntry[]>) | undefined;
}

/**
 * Answers a card into the undo window. Edit on a lane-proposal card also opens the lane editor: leaving the page
 * flushes the held answer, so the card is still resolved.
 */
const answerCard = (
  { inbox, onNavigate }: Pick<CardHostProps, 'inbox' | 'onNavigate'>,
  card: InboxCard,
  action: InboxAction,
): void => {
  inbox.deferred.schedule(card, action);
  const editor = laneEditDestination(card.daemonId, card.item, action);
  if (editor !== undefined) onNavigate(editor);
};

/** One compact card (the Sessions page's Needs-you deck), answered with its buttons into the undo window. */
const renderInboxCard = (
  { inbox, onNavigate, now }: CardHostProps,
  card: InboxCard,
  act: (action: InboxAction) => void,
) => (
  <DaemonTaskReferences connection={inbox.connectionFor(card.daemonId)} key={card.key} onNavigate={onNavigate}>
    <AgendaCard
      error={failureFor(inbox.deferredState.failed, card.key)}
      item={card.item}
      key={card.key}
      onAct={act}
      onSnooze={until => act(snoozeAction(until))}
      origin={inboxCardOrigin(card, onNavigate)}
      swipeHints={false}
      {...inputFormFor(inbox, card)}
      {...(now === undefined ? {} : { now })}
    />
  </DaemonTaskReferences>
);

/**
 * The form an `input` card is answered with, the form of a paste plan's card, or nothing for any other kind
 * (or a machine that is not paired here).
 */
const inputFormFor = (
  inbox: AgendaInbox,
  card: InboxCard,
): { readonly inputForm?: ReactNode; readonly planForm?: ReactNode } => {
  const connection = inbox.connectionFor(card.daemonId);
  if (connection !== undefined && card.item.taskPlan !== undefined)
    return {
      planForm: (
        <TaskPlanHost
          agentName={inboxWho(card).ferret}
          connection={connection}
          item={card.item}
          sessionId={card.view.config.id}
        />
      ),
    };
  if (connection !== undefined && card.item.signInRuleSuggestion !== undefined)
    return {
      planForm: <SignInRuleSuggestionHost agentName={inboxWho(card).ferret} connection={connection} item={card.item} />,
    };
  if (connection !== undefined && card.item.copyPlan !== undefined)
    return {
      planForm: (
        <CopyPlanHost
          agentName={inboxWho(card).ferret}
          connection={connection}
          item={card.item}
          sessionId={card.view.config.id}
        />
      ),
    };
  if (connection !== undefined && card.item.phoneApproval !== undefined)
    return {
      planForm: (
        <PhoneApprovalHost
          approvalId={card.item.phoneApproval.id}
          connection={connection}
          sessionId={card.view.config.id}
        />
      ),
    };
  if (connection !== undefined && card.item.twoFactorSeed !== undefined)
    return { planForm: <TwoFactorSeedHost connection={connection} item={card.item} /> };
  return card.item.kind !== 'input' || connection === undefined
    ? {}
    : {
        inputForm: (
          <InputCardHost
            agentName={inboxWho(card).ferret}
            connection={connection}
            item={card.item}
            sessionId={card.view.config.id}
          />
        ),
      };
};

/** The conversation an item belongs to, as the composer registers itself under it. */
const scopeOf = (card: InboxCard) => daemonSessionScope({ daemonId: card.daemonId }, card.view.config.id);

/**
 * Answers the open item: what is typed in its ferret's composer rides as the answer's note (the chat's own rule,
 * `withComposerNote`), and the composer is emptied once it is spent.
 */
const answerWithDraft = (host: Pick<CardHostProps, 'inbox' | 'onNavigate'>, card: InboxCard, action: InboxAction) => {
  const composer = composerQuoteTarget(scopeOf(card));
  const draft = composer?.draft() ?? '';
  const sent = withComposerNote(action, composerNoteFor(card.item, draft));
  answerCard(host, card, sent);
  if (sent !== action || inputDraftDiscarded(card.item, draft)) composer?.replaceDraft('');
};

/**
 * A form item's one Send: the picks on the card and what is typed in the composer go as one answer into the undo
 * window. Throws the sentence the composer shows when Send must wait (empty fields, asked once).
 */
const answerForm = (host: Pick<CardHostProps, 'inbox' | 'onNavigate'>, card: InboxCard): void => {
  const composer = composerQuoteTarget(scopeOf(card));
  sendForm(card.key, card.item, composer?.draft() ?? '', action => answerCard(host, card, action));
  composer?.replaceDraft('');
};

const copyWriter = browserClipboardWriter();

/**
 * Who asked and about what, over the open item — the ferret, what it works on, its card and its machine, never the
 * callsign alone — and the way to its chat. It is also a place a swipe can start.
 */
function InboxWhoLine({ card, onNavigate }: { readonly card: InboxCard; readonly onNavigate: (to: string) => void }) {
  const who = inboxWho(card);
  return (
    <CardMetaLine
      chat={{
        to: agendaConversationPath(card.daemonId, card.view.config.id, card.item.id),
        onNavigate,
        hooks: { 'data-inbox-open-chat': '' },
      }}
      hooks={{ 'data-inbox-who': '' }}
    >
      <CardKindChip kind={itemCardKind(card.item)} />
      <span className="fy-meta-line__ferret" data-inbox-who-ferret="">
        {who.ferret}
      </span>
      {who.task === null ? null : (
        <>
          <MetaDot />
          <span data-inbox-who-task="">{who.task}</span>
        </>
      )}
      {who.card === null ? null : (
        <>
          <MetaDot />
          <span className="fy-meta-line__card" data-inbox-who-card="">
            {who.card}
          </span>
        </>
      )}
      <MetaDot />
      <span>{who.machine}</span>
    </CardMetaLine>
  );
}

/** Where a touch item view swipes on its own: its card's top bar (↓ Skip) and its answer row (← ↑ → ↓). */
const VIEW_GESTURES = '[data-agenda-card-top], [data-agenda-quick-replies]';

interface OpenItemPlace {
  readonly index: number;
  readonly total: number;
  readonly onPrevious?: (() => void) | undefined;
  readonly onClose: () => void;
  /** Touch: the view's own row swipes and says its arrows, exactly as in the chat. */
  readonly swipeable: boolean;
}

/** The open item: who and what, then the SAME full view the chat shows, answering into the undo window. */
function OpenItem({
  host: { inbox, onNavigate, now, readConversation },
  card,
  act,
  skip,
  place,
  canSnooze,
}: {
  readonly host: CardHostProps;
  readonly card: InboxCard;
  readonly act: (action: InboxAction) => void;
  readonly skip: () => void;
  readonly place: OpenItemPlace;
  readonly canSnooze: boolean;
}) {
  const entries = useItemConversation(card, readConversation);
  const history = useMemo(() => itemHistory(card.item, entries), [card.item, entries]);
  return (
    <DaemonTaskReferences connection={inbox.connectionFor(card.daemonId)} key={card.key} onNavigate={onNavigate}>
      <div
        className="fy-inbox-open"
        data-inbox-gate={isGateItem(card.item) ? '' : undefined}
        data-inbox-open={card.key}
        key={card.key}
      >
        {isGateItem(card.item) ? (
          <GateMeta card={card} item={card.item} onNavigate={onNavigate} />
        ) : (
          <InboxWhoLine card={card} onNavigate={onNavigate} />
        )}
        <AgendaItemView
          busy={false}
          closeLabel="Back to the Inbox"
          daemonId={card.daemonId}
          error={failureFor(inbox.deferredState.failed, card.key)}
          ferret={inboxWho(card).ferret}
          formKey={card.key}
          history={history}
          tools={<CardTools act={act} skip={skip} />}
          item={card.item}
          onAct={act}
          onClose={place.onClose}
          onNext={skip}
          {...(canSnooze ? { onSnooze: (until: string) => act(snoozeAction(until)) } : {})}
          position={{ index: place.index, total: place.total }}
          quoteScope={scopeOf(card)}
          {...inputFormFor(inbox, card)}
          renderProse={agendaProse(copyWriter)}
          // The SAME row as the chat: on touch its buttons say their arrows and its head and row swipe (↓ going to
          // "next", the skip); the deck takes a drag that starts on the who-and-what line, and the keys go to the view.
          swipeable={place.swipeable}
          {...(now === undefined ? {} : { now })}
          {...(place.onPrevious === undefined ? {} : { onPrevious: place.onPrevious })}
        />
      </div>
    </DaemonTaskReferences>
  );
}

/** A gate item's one quiet line: what it is (the lane's verb), the project, the ferret, and the way to its chat. */
function GateMeta({
  card,
  item,
  onNavigate,
}: {
  readonly card: InboxCard;
  readonly item: GateItem;
  readonly onNavigate: (to: string) => void;
}) {
  const { gate } = item;
  return (
    <CardMetaLine
      chat={{
        to: agendaConversationPath(card.daemonId, card.view.config.id, card.item.id),
        onNavigate,
        hooks: { 'data-inbox-open-chat': '' },
      }}
      className="fy-meta-line--gate"
      hooks={{ 'data-inbox-gate': gate.cardId, 'data-inbox-who': '' }}
    >
      <CardKindChip kind={itemCardKind(item)} />
      <span className="fy-inbox-gate__stage" data-inbox-gate-stage="">
        {gateVerb(item)}
      </span>
      {gate.projectName === undefined ? null : (
        <>
          <MetaDot />
          <span data-inbox-gate-project="">{gate.projectName}</span>
        </>
      )}
      <MetaDot />
      <span className="fy-meta-line__ferret" data-inbox-who-ferret="">
        {inboxWho(card).ferret}
      </span>
    </CardMetaLine>
  );
}

/** The compass's quiet moves as plain buttons, so nothing depends on a gesture: Skip and Not needed. Snooze is the head's clock. */
function CardTools({ act, skip }: { readonly act: (action: InboxAction) => void; readonly skip: () => void }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring its border and min-width into a flex row of buttons
    <div aria-label="Put this card aside" className="fy-inbox-tools" data-inbox-card-tools="" role="group">
      <button className="kt-btn kt-btn--sm" data-inbox-tool="skip" onClick={skip} type="button">
        Skip
      </button>
      <button
        className="kt-btn kt-btn--sm"
        data-inbox-tool="not-needed"
        onClick={() => act(DISMISS_ACTION)}
        type="button"
      >
        Not needed
      </button>
    </div>
  );
}

/** The words "Not good" waits for, asked where the answer row was; the refusal, if any, shows beside its buttons. */
function GateWhy({
  card,
  error,
  optional,
  onSend,
  onCancel,
}: {
  readonly card: InboxCard;
  readonly error: string | null;
  readonly optional: boolean;
  readonly onSend: (reason: string) => void;
  readonly onCancel: () => void;
}) {
  return (
    <div className="fy-inbox-gate-why" data-inbox-gate-why={card.key}>
      <BoardSendBack
        busy={false}
        error={error}
        files={null}
        heading={
          optional
            ? `Not yet: anything to add about ${card.item.subject ?? card.item.id}?`
            : `Not good: what went wrong with ${card.item.subject ?? card.item.id}?`
        }
        submitLabel={optional ? 'Not yet' : 'Send back'}
        wordsOptional={optional}
        placeholder={optional ? 'Optional: what should the ferret know?' : 'What is not good? The ferret reads this.'}
        onCancel={onCancel}
        onSubmit={sent => onSend(sent.reason)}
      />
    </div>
  );
}

const NO_ENTRIES: readonly TranscriptEntry[] = [];

/** What was said about the card's item in its conversation; nothing until it is read, and nothing when it cannot be. */
function useItemConversation(
  card: InboxCard,
  read: ((card: InboxCard) => Promise<readonly TranscriptEntry[]>) | undefined,
): readonly TranscriptEntry[] {
  const [loaded, setLoaded] = useState<{ readonly key: string; readonly entries: readonly TranscriptEntry[] }>({
    key: '',
    entries: NO_ENTRIES,
  });
  const key = card.key;
  const latest = useRef({ read, card });
  latest.current = { read, card };
  const reads = read !== undefined;
  useEffect(() => {
    if (!reads) return;
    let live = true;
    latest.current.read?.(latest.current.card).then(
      entries => {
        if (live) setLoaded({ key, entries });
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [key, reads]);
  return loaded.key === key ? loaded.entries : NO_ENTRIES;
}

/**
 * Past the last item: the ones the reader skipped are still open. Said once, with the way back to them —
 * never a silent jump to the top of the list. "Later" leaves them where they are: the reader is caught up
 * for now, and the skipped cards wait in the inbox.
 */
function QueueEnd({ remaining, onReview }: { readonly remaining: number; readonly onReview: () => void }) {
  const [later, setLater] = useState(false);
  if (later)
    return (
      <div className="fy-attn-end" data-agenda-queue-end="later">
        <span aria-hidden="true" className="fy-attn-inbox__empty-mark">
          <CheckCheck size={24} />
        </span>
        <h2 className="fy-attn-end__title">All caught up for now</h2>
        <p className="fy-attn-end__text">
          Skipped cards wait in the inbox — {remaining} {remaining === 1 ? 'is' : 'are'} still open.
        </p>
      </div>
    );
  return (
    <div className="fy-attn-end" data-agenda-queue-end="">
      <span aria-hidden="true" className="fy-attn-inbox__empty-mark">
        <SkipForward size={24} />
      </span>
      <h2 className="fy-attn-end__title">You skipped {remaining} — review them now?</h2>
      <div className="fy-attn-end__actions">
        <button className="kt-btn" data-agenda-review="" data-variant="primary" onClick={onReview} type="button">
          Review skipped
          <ArrowRight aria-hidden="true" size={14} />
        </button>
        <button className="kt-btn" data-agenda-later="" onClick={() => setLater(true)} type="button">
          Later
        </button>
      </div>
    </div>
  );
}

/** Refusals whose card is no longer on the deck: said once, until the reader dismisses them. */
function OrphanedFailures({ inbox }: { readonly inbox: AgendaInbox }) {
  const onDeck = new Set(inbox.cards.map(card => card.key));
  const orphans = inbox.deferredState.failed.filter(failure => !onDeck.has(failure.key));
  if (orphans.length === 0) return null;
  return (
    <ul className="fy-attn-inbox__failures" data-agenda-failures="">
      {orphans.map(failure => (
        <li className="fy-attn-inbox__failure" key={failure.key} role="alert">
          <span className="min-w-0 flex-1">
            Not sent — {actionSentence(failure.action, failure.card.item.id)}: {failure.message}
          </span>
          <button
            aria-label={`Dismiss: ${actionSentence(failure.action, failure.card.item.id)} was not sent`}
            className="kt-btn kt-btn--sm"
            data-variant="ghost"
            onClick={() => inbox.deferred.clearFailure(failure.key)}
            type="button"
          >
            <X aria-hidden="true" size={14} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Calm, quietly pleased: nothing is waiting on the reader anywhere. */
/**
 * A machine whose boards could not be read says so on its own line: the Inbox counts its items (every badge does)
 * but cannot list them, and the reader is told why the list is shorter than the count instead of watching a spinner.
 */
function UnreadableMachines({ inbox }: { readonly inbox: AgendaInbox }) {
  if (inbox.unavailable.length === 0) return null;
  return (
    <ul className="fy-attn-inbox__unreadable" data-agenda-unreadable="">
      {inbox.unavailable.map(machine => (
        <li className="fy-attn-inbox__unreadable-row" data-daemon={machine.daemonId} key={machine.daemonId}>
          <CloudOff aria-hidden="true" size={14} />
          <span className="min-w-0 flex-1">
            Couldn’t read {machine.items === 1 ? '1 item' : `${machine.items} items`} on {machine.machineName}
            {machine.why === undefined ? '' : ` — ${machine.why}`}. Trying again.
          </span>
        </li>
      ))}
    </ul>
  );
}

function InboxEmpty() {
  return (
    <div className="fy-attn-inbox__empty" data-agenda-empty="">
      <span aria-hidden="true" className="fy-attn-inbox__empty-mark">
        <CheckCheck size={26} />
      </span>
      <h2 className="m-0 font-display text-title font-semibold text-fg">Nothing needs you</h2>
      <p className="m-0 max-w-[32ch] text-center text-muted">
        When a ferret on any of your machines asks for you, it lands here.
      </p>
    </div>
  );
}

function InboxReading({ words = 'Reading what your ferrets asked…' }: { readonly words?: string }) {
  return (
    <p className="fy-attn-inbox__reading" data-agenda-reading="" role="status">
      <Spinner size={16} />
      {words}
    </p>
  );
}

/** Find, the machine filter or the Warden chip left nothing: say so, and offer the way back. */
function NothingMatches({ onClear }: { readonly onClear: () => void }) {
  return (
    <div className="fy-attn-inbox__none" data-agenda-no-match="">
      <span>Nothing matches.</span>
      <button className="fy-attn-inbox__clear" onClick={onClear} type="button">
        Show everything
      </button>
    </div>
  );
}

export type InboxFilter = 'open' | 'snoozed' | 'replied' | 'resolved';

const FILTER_WORDS: Readonly<Record<InboxFilter, string>> = {
  open: 'Open',
  snoozed: 'Snoozed',
  replied: 'Replied',
  resolved: 'Resolved',
};

/** The words on a filter button: the parked ones say how many they hold. */
const filterWords = (entry: InboxFilter, counts: Readonly<Record<ParkedReason, number>>): string =>
  entry === 'snoozed' || entry === 'replied' ? `${FILTER_WORDS[entry]} (${counts[entry]})` : FILTER_WORDS[entry];

/** Open / Snoozed / Replied / Resolved: toggle buttons, the chosen one pressed. */
function InboxFilterBar({
  filter,
  counts,
  onChange,
}: {
  readonly filter: InboxFilter;
  readonly counts: Readonly<Record<ParkedReason, number>>;
  readonly onChange: (next: InboxFilter) => void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a pair of toggle buttons, not a form fieldset
    <div aria-label="Show" className="fy-attn-inbox__filter" data-agenda-filter="" role="group">
      {FILTER_CHOICES.map(entry => (
        <button
          aria-pressed={filter === entry}
          className="fy-attn-inbox__filter-button"
          data-agenda-filter-option={entry}
          key={entry}
          onClick={() => onChange(entry)}
          type="button"
        >
          {filterWords(entry, counts)}
        </button>
      ))}
    </div>
  );
}

const KIND_WORDS: Readonly<Record<ModeFilter, string>> = { all: 'All', interactive: 'Interactive', auto: 'Agents' };
const KIND_CHOICES = (Object.keys(KIND_WORDS) as ModeFilter[]).map(value => ({ value, label: KIND_WORDS[value] }));
const FILTER_CHOICES = ['open', 'snoozed', 'replied', 'resolved'] as const;

/** All / Interactive / Agents: which kind of ferret raised the items — the sessions bar's own split. */
function KindFilterBar({
  kind,
  onChange,
}: {
  readonly kind: ModeFilter;
  readonly onChange: (next: ModeFilter) => void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of toggle buttons, not a form fieldset
    <div aria-label="Ferrets" className="fy-attn-inbox__filter" data-agenda-kind="" role="group">
      {(['all', 'interactive', 'auto'] as const).map(entry => (
        <button
          aria-pressed={kind === entry}
          className="fy-attn-inbox__filter-button"
          data-agenda-kind-option={entry}
          key={entry}
          onClick={() => onChange(entry)}
          type="button"
        >
          {KIND_WORDS[entry]}
        </button>
      ))}
    </div>
  );
}

/** The bulk dismiss under the Agents filter; nothing under any other, or where the host gave it no way to reach machines. */
function AgentsBulk({
  kind,
  port,
  inbox,
  machines,
}: {
  readonly kind: ModeFilter;
  readonly port: ClearPort | undefined;
  readonly inbox: AgendaInbox;
  readonly machines: readonly { readonly daemonId: DaemonId; readonly name: string }[];
}) {
  if (kind !== 'auto' || port === undefined) return null;
  const targets = machines.flatMap(machine => {
    const connection = inbox.connectionFor(machine.daemonId);
    return connection === undefined ? [] : [{ daemonId: machine.daemonId, name: machine.name, connection }];
  });
  return <ClearAgentsControl port={port} targets={targets} />;
}

/** "From Warden ✕": the filter `/inbox?from=warden` set, and the one press that lifts it. */
function SourceChip({ onClear }: { readonly onClear: () => void }) {
  return (
    <button
      className="fy-attn-inbox__chip"
      data-agenda-from-chip="warden"
      onClick={onClear}
      title="Show everything"
      type="button"
    >
      From Warden
      <X aria-hidden="true" size={13} />
    </button>
  );
}

/** The Resolved filter: every resolved item the inbox has read, newest first, each linked to its chat. */
function InboxResolvedList({
  inbox,
  rows,
  onNavigate,
  onClear,
}: {
  readonly inbox: AgendaInbox;
  readonly rows: readonly InboxResolved[];
  readonly onNavigate: (to: string) => void;
  readonly onClear: () => void;
}) {
  if (rows.length === 0)
    return inbox.resolved.length > 0 ? (
      <NothingMatches onClear={onClear} />
    ) : inbox.resolvedReading ? (
      <InboxReading words="Reading resolved items…" />
    ) : (
      <p className="fy-attn-inbox__none" data-agenda-resolved-empty="">
        Nothing resolved in your {RESOLVED_READ_LIMIT} most recent conversations.
      </p>
    );
  return (
    <div className="fy-attn-inbox__resolved" data-agenda-resolved-pane="">
      <ul aria-label="Resolved" className="fy-attn-panel__records fy-attn-inbox__records">
        {rows.map((row, index) => (
          <ResolvedRow
            id={`inbox-resolved-${index}`}
            key={`${row.key}:${row.record.resolvedAt}`}
            origin={resolvedOrigin(row, onNavigate)}
            record={row.record}
          />
        ))}
      </ul>
      <p className="fy-attn-inbox__hint">
        From your {RESOLVED_READ_LIMIT} most recent conversations
        {inbox.resolvedReading ? ' · reading more…' : ''}
      </p>
    </div>
  );
}

/** One parked row: where it stands, and the one button that brings it back. */
function ParkedRow({
  card,
  filter,
  inbox,
  now,
  onNavigate,
}: {
  readonly card: InboxCard;
  readonly filter: ParkedReason;
  readonly inbox: AgendaInbox;
  readonly now: number | undefined;
  readonly onNavigate: (to: string) => void;
}) {
  const who = inboxWho(card);
  const status = agendaStatus(card.item, who.ferret, now);
  // A replied row's status already names the ferret it waits on.
  const more = filter === 'snoozed' ? [who.ferret, agendaReference(card.item.id)] : [agendaReference(card.item.id)];
  return (
    <li className="fy-parked-row" data-agenda-parked={card.key}>
      <RouteLink
        className="fy-inbox-row fy-parked-row__link"
        onNavigate={onNavigate}
        to={agendaConversationPath(card.daemonId, card.view.config.id, card.item.id)}
      >
        <span className="fy-inbox-row__top">
          <span className="fy-inbox-row__title" data-agenda-row-title="">
            {inboxRowTitle(card.item)}
          </span>
        </span>
        <span className="fy-inbox-row__meta">
          {status === null ? null : <span data-agenda-parked-status="">{status.label}</span>}
          {more.map(text => (
            <Fragment key={text}>
              <span aria-hidden="true">·</span>
              <span>{text}</span>
            </Fragment>
          ))}
        </span>
      </RouteLink>
      <button
        className="kt-btn fy-parked-row__back"
        data-agenda-unsnooze={filter}
        onClick={() => inbox.deferred.schedule(card, UNSNOOZE_ACTION)}
        type="button"
      >
        {filter === 'snoozed' ? 'Unsnooze' : 'Back to my list'}
      </button>
    </li>
  );
}

/** One snoozed card to test: when it wakes, and the button that brings it back now. */
function SnoozedToTestRow({
  row,
  answers,
  now,
  onNavigate,
}: {
  readonly row: ToTestCard;
  readonly answers: ToTestAnswers;
  readonly now: number | undefined;
  readonly onNavigate: (to: string) => void;
}) {
  const wakes = row.snoozedUntil === null ? null : clockWords(row.snoozedUntil, now ?? Date.now());
  const more = [row.taskName, row.card.machine, formatTaskRef({ id: row.card.task.id })].filter(
    (text): text is string => text !== null,
  );
  return (
    <li className="fy-parked-row" data-to-test-snoozed={row.key}>
      <RouteLink
        className="fy-inbox-row fy-parked-row__link"
        onNavigate={onNavigate}
        to={daemonBoardCardPath(row.card.daemonId, row.card.task.id)}
      >
        <span className="fy-inbox-row__top">
          <span className="fy-inbox-row__title" data-to-test-snoozed-title="">
            {row.card.task.title}
          </span>
        </span>
        <span className="fy-inbox-row__meta">
          <span data-to-test-wakes="">{wakes === null ? 'Snoozed' : `Snoozed until ${wakes}`}</span>
          {more.map(text => (
            <Fragment key={text}>
              <span aria-hidden="true">·</span>
              <span>{text}</span>
            </Fragment>
          ))}
        </span>
      </RouteLink>
      <button
        aria-label={`Unsnooze: ${row.card.task.title}`}
        className="kt-btn fy-parked-row__back"
        data-to-test-unsnooze=""
        onClick={() => answers.snooze(row, null)}
        type="button"
      >
        Unsnooze
      </button>
    </li>
  );
}

/** The Snoozed and Replied filters: what is parked, each with the way back to the owner's list. */
function InboxParkedList({
  inbox,
  filter,
  rows,
  toTestRows,
  answers,
  now,
  onNavigate,
  onClear,
}: {
  readonly inbox: AgendaInbox;
  readonly filter: ParkedReason;
  readonly rows: readonly InboxCard[];
  /** The snoozed cards to test (the Snoozed filter only). */
  readonly toTestRows: readonly ToTestCard[];
  readonly answers: ToTestAnswers;
  readonly now: number | undefined;
  readonly onNavigate: (to: string) => void;
  readonly onClear: () => void;
}) {
  if (rows.length === 0 && toTestRows.length === 0)
    return inbox.parked.length > 0 || (filter === 'snoozed' && inbox.toTestSnoozed.length > 0) ? (
      <NothingMatches onClear={onClear} />
    ) : inbox.resolvedReading ? (
      <InboxReading words="Reading agenda items…" />
    ) : (
      <p className="fy-attn-inbox__none" data-agenda-parked-empty={filter}>
        {filter === 'snoozed' ? 'Nothing is snoozed.' : 'Nothing is waiting on a ferret after your reply.'}
      </p>
    );
  return (
    <div className="fy-attn-inbox__resolved" data-agenda-parked-pane={filter}>
      <ul aria-label={FILTER_WORDS[filter]} className="fy-parked-list">
        {rows.map(card => (
          <ParkedRow card={card} filter={filter} inbox={inbox} key={card.key} now={now} onNavigate={onNavigate} />
        ))}
        {toTestRows.map(row => (
          <SnoozedToTestRow answers={answers} key={row.key} now={now} onNavigate={onNavigate} row={row} />
        ))}
      </ul>
      <p className="fy-attn-inbox__hint">
        From your {RESOLVED_READ_LIMIT} most recent conversations
        {inbox.resolvedReading ? ' · reading more…' : ''}
      </p>
    </div>
  );
}

const resolvedOrigin = (row: InboxResolved, onNavigate: (to: string) => void) => {
  const names = sessionsBarNames(row.view);
  return {
    ferret: names.ferret ?? names.title,
    machine: row.machineName,
    href: agendaConversationPath(row.daemonId, row.view.config.id, row.record.id),
    onNavigate,
  };
};

export interface AgendaInboxPageProps {
  readonly inbox: AgendaInbox;
  readonly onNavigate: (to: string) => void;
  /** A phone finishes a run back at the list; a wider screen keys and mouse-drags it and ends on "All done". */
  readonly phone: boolean;
  /** The clock card ages read; the browser's otherwise. */
  readonly now?: number;
  /** The clock the undo countdown reads; the browser's otherwise. */
  readonly clock?: () => number;
  /** Under the header: the shell's "notifications are off for <machine>" banner, which draws nothing when none is. */
  readonly banner?: ReactNode;
  /** Reads what was said about the card's item in its conversation, for the open item's History. Absent: revisions only. */
  readonly readConversation?: (card: InboxCard) => Promise<readonly TranscriptEntry[]>;
  /** Forces the phone deck's reduced motion on or off; the reader's preference otherwise. */
  readonly reducedMotion?: boolean;
  /** On a phone, the item whose deck card starts open (a harness); the list otherwise. */
  readonly initialOpen?: string;
  /** Only what this source raised (`/inbox?from=warden`); everything otherwise. */
  readonly from?: InboxSource | null;
  /** Lifts the source filter: the host drops `?from=` from the address. */
  readonly onClearFrom?: () => void;
  /**
   * An item a notification tap asked for: its card opens as soon as it is among the open ones. `settled` says the
   * machine's conversations have been read, so a missing card means the item is no longer open — and then
   * `onOpenSettled(false)` lets the host send the reader to the conversation instead.
   */
  readonly open?: {
    readonly daemonId: DaemonId;
    readonly sessionId: string;
    readonly id: AgendaId;
    readonly settled: boolean;
  } | null;
  readonly onOpenSettled?: (opened: boolean) => void;
  /** Starts the "With ferrets" section open (a harness). */
  readonly withFerretsOpen?: boolean;
  /**
   * The open item's ferret's REAL composer, bound to that conversation: what is typed goes to its chat about the
   * item. The host draws it (it holds the clients); absent, the open item has no composer.
   */
  readonly renderComposer?: (card: InboxCard, answerForm: (() => void) | undefined) => ReactNode;
  /** How "Clear all from agent ferrets" reaches the machines. Absent: the Agents filter has no such button. */
  readonly clearPort?: ClearPort;
  /** How the "Ready to test" items move their cards (the Board's own verbs). Absent: they list, and refuse to move. */
  readonly toTestHost?: ToTestHost;
}

/** How long a tapped notification's item may take to appear among the open ones before its chat opens instead. */
const OPEN_WAIT_MS = 5_000;

/** Everything a row needs besides the card itself. */
interface RowEnv {
  readonly inbox: AgendaInbox;
  readonly now: number | undefined;
  readonly onNavigate: (to: string) => void;
  readonly selectedKey: string | null;
  readonly rowRef: (key: string) => (element: HTMLAnchorElement | null) => void;
  /** Opens an item here, as the deck's top card. */
  readonly onOpen: (key: string) => void;
}

/** One item: its title and age, its ask on one line, and under it where it stands, its kind and its reference. */
function ItemRow({
  card,
  group,
  env,
}: {
  readonly card: InboxCard;
  readonly group: FerretGroup;
  readonly env: RowEnv;
}) {
  const { now, onOpen, selectedKey, rowRef } = env;
  const ask = inboxRowAsk(card.item);
  // The card this item is about, when it is not the one its ferret is on (the group's head says that one).
  const itemCard = inboxWho(card).card;
  const status = agendaStatus(card.item, group.ferret, now);
  const author = agendaAuthor(card.item, group.ferret);
  return (
    <li>
      <RouteLink
        aria-current={selectedKey === card.key || undefined}
        className="fy-inbox-row"
        data-agenda-row={card.key}
        data-dimmed={status?.dimmed || undefined}
        data-selected={selectedKey === card.key || undefined}
        // A plain click opens the item here; a modified one opens the chat at it (the link's own address).
        onNavigate={() => onOpen(card.key)}
        ref={rowRef(card.key)}
        to={agendaConversationPath(card.daemonId, card.view.config.id, card.item.id)}
      >
        <span className="fy-inbox-row__top">
          <span className="fy-inbox-row__title" data-agenda-row-title="">
            {inboxRowTitle(card.item)}
          </span>
          <span className="fy-inbox-row__age">{shortAge(card.item.waitingSince, now)}</span>
        </span>
        {ask === null ? null : <span className="fy-inbox-row__ask">{ask}</span>}
        <span className="fy-inbox-row__meta">
          {status === null || status.tone === 'needs-you' ? null : <AgendaStatusPill status={status} />}
          <span>{kindWord(card.item)}</span>
          <span aria-hidden="true">·</span>
          <span>{agendaReference(card.item.id)}</span>
          {itemCard === null || itemCard === group.card ? null : (
            <>
              <span aria-hidden="true">·</span>
              <span data-agenda-row-card="">{itemCard}</span>
            </>
          )}
          {author === group.ferret ? null : (
            <>
              <span aria-hidden="true">·</span>
              <span data-agenda-row-author="">From {author}</span>
            </>
          )}
        </span>
      </RouteLink>
    </li>
  );
}

/**
 * One plain notification: a line and a time, nothing to answer. Tapping it opens the chat and clears it;
 * Clear alone clears it where it is. Both go through the undo window, so a slip is one press from undone.
 */
function NoticeRow({ card, env }: { readonly card: InboxCard; readonly env: RowEnv }) {
  const { inbox, now, onNavigate, selectedKey, rowRef } = env;
  const clear = (): void => inbox.deferred.schedule(card, CLEAR_ACTION);
  return (
    <li className="fy-inbox-notice" data-agenda-notice={card.key}>
      <RouteLink
        aria-current={selectedKey === card.key || undefined}
        className="fy-inbox-notice__link"
        data-agenda-row={card.key}
        data-selected={selectedKey === card.key || undefined}
        onNavigate={to => {
          clear();
          onNavigate(to);
        }}
        ref={rowRef(card.key)}
        to={agendaConversationPath(card.daemonId, card.view.config.id, card.item.id)}
      >
        <span className="fy-inbox-notice__summary">{inboxRowTitle(card.item)}</span>
        <span className="fy-inbox-row__age">{shortAge(card.item.waitingSince, now)}</span>
      </RouteLink>
      <button
        aria-label={`Clear: ${inboxRowTitle(card.item)}`}
        className="fy-inbox-notice__clear"
        data-agenda-clear={card.key}
        onClick={clear}
        type="button"
      >
        Clear
      </button>
    </li>
  );
}

/** One ferret: who and where on its header (a link to the chat), its items, then its notifications. */
function GroupView({ group, env }: { readonly group: FerretGroup; readonly env: RowEnv }) {
  return (
    <li className="fy-inbox-group" data-agenda-group={group.key}>
      <RouteLink
        className="fy-inbox-group__head"
        data-agenda-group-link=""
        onNavigate={env.onNavigate}
        to={daemonSessionPath(group.daemonId, group.view.config.id)}
      >
        <span className="fy-inbox-group__ferret">{group.ferret}</span>
        {group.task === null ? null : (
          <>
            <span aria-hidden="true" className="fy-inbox-group__dot">
              ·
            </span>
            <span className="fy-inbox-group__task">{group.task}</span>
          </>
        )}
        {group.card === null ? null : (
          <>
            <span aria-hidden="true" className="fy-inbox-group__dot">
              ·
            </span>
            <span className="fy-inbox-group__card" data-agenda-group-card="">
              {group.card}
            </span>
          </>
        )}
        <span aria-hidden="true" className="fy-inbox-group__dot">
          ·
        </span>
        <span className="fy-inbox-group__machine">{group.machineName}</span>
      </RouteLink>
      <ul aria-label={`${group.ferret}'s items`} className="fy-inbox-group__rows">
        {group.items.map(card => (
          <ItemRow card={card} env={env} group={group} key={card.key} />
        ))}
        {group.notices.map(card => (
          <NoticeRow card={card} env={env} key={card.key} />
        ))}
      </ul>
    </li>
  );
}

/** One section: a sentence-case heading with its count, then its ferrets. A collapsible one folds under its heading. */
function Section({
  id,
  title,
  groups,
  env,
  open,
  onToggle,
  extra = null,
  extraCount = 0,
}: {
  readonly id: string;
  readonly title: string;
  readonly groups: readonly FerretGroup[];
  readonly env: RowEnv;
  /** Rows of another kind that sit in this section, above its ferrets (the cards to test). */
  readonly extra?: ReactNode;
  readonly extraCount?: number;
  /** Present when the section folds. */
  readonly open?: boolean;
  readonly onToggle?: () => void;
}) {
  const bodyId = useId();
  const count = groups.reduce((total, group) => total + group.items.length + group.notices.length, extraCount);
  const shown = open ?? true;
  const heading =
    onToggle === undefined ? (
      <h2 className="fy-inbox-section__title">
        {title}
        <span className="fy-inbox-section__count">{count}</span>
      </h2>
    ) : (
      <h2 className="fy-inbox-section__title">
        <button
          aria-controls={bodyId}
          aria-expanded={shown}
          className="fy-inbox-section__toggle"
          data-agenda-section-toggle={id}
          onClick={onToggle}
          type="button"
        >
          {title}
          <span className="fy-inbox-section__count">{count}</span>
          <ChevronRight
            aria-hidden="true"
            className="fy-attn-group__chevron"
            data-open={shown || undefined}
            size={14}
          />
        </button>
      </h2>
    );
  return (
    <section className="fy-inbox-section" data-agenda-section={id}>
      {heading}
      {shown ? (
        <ul className="fy-inbox-section__groups" id={bodyId}>
          {extra === null ? null : <li className="fy-inbox-section__extra">{extra}</li>}
          {groups.map(group => (
            <GroupView env={env} group={group} key={group.key} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** One key of the desktop run and what it does on the card on top: the quiet line under the card. */
interface RunKey {
  readonly key: string;
  readonly word: string;
}

/** The desktop run's shortcuts, said once under the card: the card's own answers by arrow, then moving and closing. */
function RunKeysHint({ keys }: { readonly keys: readonly RunKey[] }) {
  return (
    <p className="fy-inbox-keys" data-inbox-keys="">
      {keys.map(entry => (
        <span className="fy-inbox-keys__entry" key={entry.key}>
          <kbd className="fy-inbox-keys__key">{entry.key}</kbd> {entry.word}
        </span>
      ))}
    </p>
  );
}

const RUN_MOVES: readonly RunKey[] = [
  { key: '↓', word: 'Skip' },
  { key: 'j k', word: 'Next, previous' },
  { key: 'Esc', word: 'Close' },
];

/** The arrows an agenda card answers by, in the words of its own answers, then Skip. */
const agendaRunKeys = (card: InboxCard): readonly RunKey[] => {
  const targets = swipeTargets(card.item);
  return [
    ...(targets.left === undefined ? [] : [{ key: '←', word: targets.left.label }]),
    ...(targets.up === undefined ? [] : [{ key: '↑', word: targets.up.label }]),
    ...(targets.right === undefined ? [] : [{ key: '→', word: targets.right.label }]),
    ...RUN_MOVES,
  ];
};

/** A task card's two answers by arrow, then Skip. */
const toTestRunKeys = (row: ToTestCard): readonly RunKey[] => {
  const words = wordsOf(row);
  return [{ key: '←', word: words.left }, { key: '→', word: words.right }, ...RUN_MOVES];
};

/** The keys the desktop run answers to at the page: the deck takes the arrows of an agenda card itself. */
const RUN_KEY_NAMES: ReadonlySet<string> = new Set(['Escape', 'j', 'k', 'ArrowLeft', 'ArrowRight', 'ArrowDown']);

/** The end of a run that answered every card: short, and the way back. */
function RunDone({ onBack }: { readonly onBack: () => void }) {
  return (
    <div className="fy-attn-end" data-agenda-run-done="">
      <span aria-hidden="true" className="fy-attn-inbox__empty-mark">
        <CheckCheck size={24} />
      </span>
      <h2 className="fy-attn-end__title">All done</h2>
      <p className="fy-attn-end__text">Nothing else needs you right now.</p>
      <div className="fy-attn-end__actions">
        <button className="kt-btn" data-agenda-run-back="" data-variant="primary" onClick={onBack} type="button">
          Back to Inbox
        </button>
      </div>
    </div>
  );
}

export function AgendaInboxPage({
  inbox,
  onNavigate,
  phone,
  now,
  clock,
  banner,
  readConversation,
  reducedMotion,
  initialOpen,
  open = null,
  onOpenSettled,
  from = null,
  onClearFrom,
  withFerretsOpen = false,
  renderComposer,
  clearPort,
  toTestHost,
}: AgendaInboxPageProps) {
  const headingId = useId();
  const [cursor, setCursor] = useState<string | null>(null);
  const [deckAt, setDeckAt] = useState<string | null>(initialOpen ?? null);
  const [deckOpen, setDeckOpen] = useState<boolean>(initialOpen !== undefined);
  const [filter, setFilter] = useState<InboxFilter>('open');
  const [machine, setMachine] = useState<DaemonId | null>(null);
  const [kind, setKind] = useState<ModeFilter>('all');
  const [query, setQuery] = useState('');
  const [withFerretsShown, setWithFerretsShown] = useState(withFerretsOpen);
  /** A gate answer held for the owner's words: "Not good" is refused without a reason, so it waits for one. */
  const [gateWhy, setGateWhy] = useState<{ readonly key: string; readonly action: InboxAction } | null>(null);
  const rowRefs = useRef(new Map<string, HTMLAnchorElement>()).current;
  const focusRow = useRef(false);

  const machines = useMemo(
    () => inboxMachines([...inbox.cards, ...inbox.withFerret, ...inbox.parked], inbox.resolved),
    [inbox.cards, inbox.withFerret, inbox.parked, inbox.resolved],
  );
  const machineFilter = machines.some(entry => entry.daemonId === machine) ? machine : null;
  const listFilter: InboxListFilter = { machine: machineFilter, query, from, mode: kind };
  const visible = filterInboxCards(inbox.cards, listFilter);
  const withFerret = filterInboxCards(inbox.withFerret, listFilter);
  const sections = useMemo(() => inboxSections(visible, withFerret), [visible, withFerret]);
  const toTestRows = useMemo(
    () => filterToTest(inbox.toTest, { machine: machineFilter, query, agendaOnly: from !== null || kind !== 'all' }),
    [inbox.toTest, machineFilter, query, from, kind],
  );
  const snoozedToTest = useMemo(
    () =>
      filterToTest(inbox.toTestSnoozed, { machine: machineFilter, query, agendaOnly: from !== null || kind !== 'all' }),
    [inbox.toTestSnoozed, machineFilter, query, from, kind],
  );
  const toTestAnswers = useToTestAnswers(toTestHost, phone);
  const filtered = machineFilter !== null || query !== '' || from !== null || kind !== 'all';
  const snoozed = parkedBy(inbox.parked, 'snoozed');
  const replied = parkedBy(inbox.parked, 'replied');
  const parkedCounts = { snoozed: snoozed.length + inbox.toTestSnoozed.length, replied: replied.length };

  // The deck deals what waits on the owner, in the order the page lists it: the agenda items, then the cards to test.
  const deckCards = groupCards([...sections.stopped, ...sections.needsYou]);
  const order = deckCards.map(card => card.key);
  const runOrder = [...order, ...toTestRows.map(row => row.key)];
  // j/k walk the rows that are showing: the owner's sections, and With ferrets only once it is open.
  const navigable = [...order, ...(withFerretsShown ? groupCards(sections.withFerrets).map(card => card.key) : [])];
  const selectedKey = cursor !== null && navigable.includes(cursor) ? cursor : null;

  // The deck follows the reader's place while it is listed, and the card after it once it leaves.
  const lastOrder = useRef<readonly string[]>(runOrder);
  const deckPlace = nextSelection(lastOrder.current, deckAt, runOrder);
  const orderKey = runOrder.join('\u0001');
  useEffect(() => {
    lastOrder.current = orderKey === '' ? [] : orderKey.split('\u0001');
    if (deckPlace !== deckAt) setDeckAt(deckPlace);
    if (orderKey === '') setDeckOpen(false);
  }, [orderKey, deckPlace, deckAt]);
  const deckSelected = deckCards.find(card => card.key === deckPlace);
  const stepRow = toTestRows.find(row => row.key === deckPlace);

  const choose = (next: InboxFilter): void => {
    setFilter(next);
    if (next !== 'open') inbox.loadResolved();
  };
  const clearFilters = (): void => {
    setQuery('');
    setMachine(null);
    setKind('all');
    if (from !== null) onClearFrom?.();
  };

  // j/k and ↑/↓ walk the rows on a wider screen, unless the reader is typing.
  const keyState = useRef({ navigable, selectedKey });
  keyState.current = { navigable, selectedKey };
  const keysLive = !phone && filter === 'open' && !deckOpen;
  useEffect(() => {
    if (!keysLive || typeof window === 'undefined') return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      const by =
        event.key === 'ArrowDown' || event.key === 'j' ? 1 : event.key === 'ArrowUp' || event.key === 'k' ? -1 : 0;
      if (by === 0 || ownsKeys(event.target)) return;
      const next = stepSelection(keyState.current.navigable, keyState.current.selectedKey, by);
      if (next === null) return;
      event.preventDefault();
      focusRow.current = true;
      setCursor(next);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [keysLive]);
  useEffect(() => {
    if (!focusRow.current || selectedKey === null) return;
    focusRow.current = false;
    const row = rowRefs.get(selectedKey);
    row?.focus();
    row?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedKey, rowRefs]);

  // The heading shows the shell's one Inbox count, the number the sidebar, top bar and tab bar show.
  const count = inbox.total;
  const empty = inbox.cards.length === 0 && inbox.withFerret.length === 0 && inbox.toTest.length === 0;
  const nothingForYou = inbox.cards.length === 0 && inbox.toTest.length === 0 && inbox.unavailable.length === 0;
  const updating =
    filter === 'open'
      ? inbox.reading && !empty
      : inbox.resolvedReading && (filter === 'resolved' ? inbox.resolved.length : inbox.parked.length) > 0;
  const host: CardHostProps = { inbox, onNavigate, now, readConversation };
  const atEnd = deckPlace === QUEUE_END;
  const openAt = (key: string): void => {
    setDeckAt(key);
    setDeckOpen(true);
  };
  const review = (): void => setDeckAt(runOrder[0] ?? null);
  const startDeck = (): void => {
    setDeckAt(runOrder[0] ?? null);
    setDeckOpen(true);
  };
  // A desktop run that answered its last card says so, with the way back; a phone returns to its list.
  const [allDone, setAllDone] = useState(false);
  const running = deckOpen && filter === 'open' && runOrder.length > 0;
  const wasRunning = useRef(false);
  const hasRun = runOrder.length > 0;
  useEffect(() => {
    if (running) {
      wasRunning.current = true;
      setAllDone(false);
      return;
    }
    setAllDone(!phone && wasRunning.current && !hasRun);
    wasRunning.current = false;
  }, [running, hasRun, phone]);
  // A tapped notification's item opens as a card once it is among the open ones; a few seconds without it
  // (or a settled read that lacks it) mean it is no longer open, and the host takes the reader to its chat.
  const openedFor = useRef<string | null>(null);
  const wantedKey = open === null ? null : `${open.daemonId}\u0000${open.sessionId}\u0000${open.id}`;
  const openSettled = open?.settled === true;
  const openCard =
    open === null
      ? undefined
      : inbox.cards.find(
          card => card.daemonId === open.daemonId && card.view.config.id === open.sessionId && card.item.id === open.id,
        );
  const openCardKey = openCard?.key;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `openAt` and the host callback are re-made every render; the target and what it resolves to are the inputs
  useEffect(() => {
    if (wantedKey === null || openedFor.current === wantedKey) return;
    if (openCardKey !== undefined) {
      openedFor.current = wantedKey;
      setFilter('open');
      openAt(openCardKey);
      onOpenSettled?.(true);
      return;
    }
    const giveUp = (): void => {
      openedFor.current = wantedKey;
      onOpenSettled?.(false);
    };
    if (openSettled && !inbox.reading) {
      giveUp();
      return;
    }
    const timer = setTimeout(giveUp, OPEN_WAIT_MS);
    return () => clearTimeout(timer);
  }, [wantedKey, openCardKey, openSettled, inbox.reading]);

  // An open item is the deck's top card, on a phone and a wide screen alike.
  const cardOpen = deckOpen && filter === 'open' && (deckSelected !== undefined || stepRow !== undefined || atEnd);

  // The desktop run's keys. ←, ↑, → and ↓ answer or skip an agenda card inside the deck; a task card is answered here.
  // j and k move between cards, Esc closes. Never while the reader is in a field, a menu or a dialog.
  const runKeys = useRef<(event: KeyboardEvent) => void>(() => undefined);
  runKeys.current = event => {
    const at = runOrder.indexOf(deckPlace ?? '');
    if (event.key === 'Escape') {
      setAllDone(false);
      setDeckOpen(false);
    } else if (event.key === 'j' && at >= 0) setDeckAt(skipSelection(runOrder, deckPlace));
    else if (event.key === 'k' && at > 0) setDeckAt(runOrder[at - 1] ?? null);
    else if (stepRow !== undefined && toTestAnswers.answerFor(stepRow.card).pressed === null) {
      if (event.key === 'ArrowLeft') toTestAnswers.notGood(stepRow);
      else if (event.key === 'ArrowRight') toTestAnswers.done(stepRow);
      else if (event.key === 'ArrowDown') setDeckAt(skipSelection(runOrder, stepRow.key));
    }
  };
  const runKeysLive = !phone && (cardOpen || allDone);
  useEffect(() => {
    if (!runKeysLive || typeof window === 'undefined') return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.isComposing || ownsKeys(event.target)) return;
      if (!RUN_KEY_NAMES.has(event.key)) return;
      event.preventDefault();
      runKeys.current(event);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [runKeysLive]);

  const env: RowEnv = {
    inbox,
    now,
    onNavigate,
    selectedKey,
    onOpen: openAt,
    rowRef: key => element => {
      if (element === null) rowRefs.delete(key);
      else rowRefs.set(key, element);
    },
  };

  const header = (
    <header className="fy-attn-inbox__head">
      {/* A phone's top bar already says "Inbox" with the count beside it: the page draws no second title there. */}
      {phone ? null : (
        <h1 className="fy-attn-inbox__title" id={headingId}>
          Inbox
          <AgendaCountBadge count={count} />
        </h1>
      )}
      {updating ? (
        <span className="fy-attn-inbox__updating" data-agenda-updating="" role="status">
          <Spinner size={12} />
          <span className="fy-attn-inbox__updating-text">Updating</span>
        </span>
      ) : null}
      {phone ? (
        <FilterMenu
          choiceHook="data-agenda-filter-option"
          choices={FILTER_CHOICES.map(entry => ({ value: entry, label: filterWords(entry, parkedCounts) }))}
          hook="data-agenda-filter"
          name="Show"
          onChange={choose}
          value={filter}
        />
      ) : (
        <InboxFilterBar counts={parkedCounts} filter={filter} onChange={choose} />
      )}
      <div className="fy-attn-inbox__tools">
        {from === 'warden' && onClearFrom !== undefined ? <SourceChip onClear={onClearFrom} /> : null}
        {phone ? (
          <FilterMenu
            choiceHook="data-agenda-kind-option"
            choices={KIND_CHOICES}
            hook="data-agenda-kind"
            icon={<Users aria-hidden="true" size={14} />}
            name="Ferrets"
            onChange={setKind}
            value={kind}
          />
        ) : (
          <KindFilterBar kind={kind} onChange={setKind} />
        )}
        {machines.length > 1 ? (
          phone ? (
            <FilterMenu
              choiceHook="data-agenda-machine-option"
              choices={[
                { value: '', label: 'All' },
                ...machines.map(entry => ({ value: entry.daemonId as string, label: entry.name })),
              ]}
              hook="data-agenda-machine"
              icon={<Laptop aria-hidden="true" size={14} />}
              name="Machine"
              onChange={next => setMachine(next === '' ? null : (next as DaemonId))}
              value={machineFilter ?? ''}
            />
          ) : (
            <select
              aria-label="Machine"
              className="fy-attn-inbox__machine"
              data-agenda-machine=""
              onChange={event => setMachine(event.target.value === '' ? null : (event.target.value as DaemonId))}
              value={machineFilter ?? ''}
            >
              <option value="">All machines</option>
              {machines.map(entry => (
                <option key={entry.daemonId} value={entry.daemonId}>
                  {entry.name}
                </option>
              ))}
            </select>
          )
        ) : null}
        {phone ? <FindToggle onChange={setQuery} query={query} /> : <FindBox onChange={setQuery} query={query} />}
        <PageThemeSwitch />
      </div>
    </header>
  );

  const nothingShown =
    sections.stopped.length + sections.needsYou.length + sections.withFerrets.length + toTestRows.length === 0;
  const openBody =
    empty && !filtered ? (
      inbox.reading ? (
        <InboxReading />
      ) : inbox.unavailable.length > 0 ? null : (
        <InboxEmpty />
      )
    ) : nothingShown ? (
      <NothingMatches onClear={clearFilters} />
    ) : (
      <div className="fy-inbox-body" data-agenda-lists="">
        {runOrder.length > 0 ? (
          <button className="kt-btn fy-inbox-quick" data-agenda-quick="" onClick={startDeck} type="button">
            <Zap aria-hidden="true" size={15} />
            Answer quickly
            <span className="fy-inbox-quick__count">{runOrder.length}</span>
          </button>
        ) : null}
        {nothingForYou && !filtered ? (
          <p className="fy-inbox-calm" data-agenda-empty="">
            Nothing needs you right now.
          </p>
        ) : null}
        {sections.stopped.length === 0 ? null : (
          <Section env={env} groups={sections.stopped} id="stopped" title="Stopped on you" />
        )}
        {sections.needsYou.length === 0 ? null : (
          <Section env={env} groups={sections.needsYou} id="needs-you" title="Needs you" />
        )}
        {toTestRows.length === 0 ? null : (
          <Section
            env={env}
            extra={<ToTestList answers={toTestAnswers} now={now} onNavigate={onNavigate} rows={toTestRows} />}
            extraCount={toTestRows.length}
            groups={[]}
            id="to-test"
            title="To test"
          />
        )}
        {sections.withFerrets.length === 0 ? null : (
          <Section
            env={env}
            groups={sections.withFerrets}
            id="with-ferrets"
            onToggle={() => setWithFerretsShown(shown => !shown)}
            open={withFerretsShown}
            title="With ferrets"
          />
        )}
      </div>
    );

  if (allDone && filter === 'open') {
    return (
      <main aria-label="Inbox" className="fy-attn-inbox" data-agenda-inbox="card">
        <div className="fy-attn-inbox__deck fy-attn-inbox__deck--end">
          <RunDone onBack={() => setAllDone(false)} />
        </div>
        <AgendaUndoToast inbox={inbox} {...(clock === undefined ? {} : { clock })} />
      </main>
    );
  }

  if (cardOpen) {
    // The phone's quick answers: the card the reader started at on top, the ones AFTER it next in line —
    // never the ones before it, so the queue only moves forward; past the last, the skipped ones are offered.
    const deck = deckSelected === undefined ? [] : deckCards.slice(Math.max(0, deckCards.indexOf(deckSelected)));
    return (
      <main
        {...(phone ? { 'aria-label': 'Inbox' } : { 'aria-labelledby': headingId })}
        className="fy-attn-inbox"
        data-agenda-inbox="card"
        data-phone={phone || undefined}
      >
        {phone ? (
          updating ? (
            // The phone has no back row to carry it; the status only takes room while boards are read.
            <span className="fy-attn-inbox__updating" data-agenda-updating="" role="status">
              <Spinner size={12} />
              <span className="fy-attn-inbox__updating-text">Updating</span>
            </span>
          ) : null
        ) : (
          <header className="fy-attn-inbox__cardbar">
            <button
              className="fy-attn-inbox__back"
              data-agenda-back=""
              onClick={() => setDeckOpen(false)}
              type="button"
            >
              <ArrowLeft aria-hidden="true" size={16} />
              <span id={headingId}>Inbox</span>
              <AgendaCountBadge count={count} />
            </button>
            {updating ? (
              <span className="fy-attn-inbox__updating" data-agenda-updating="" role="status">
                <Spinner size={12} />
                <span className="fy-attn-inbox__updating-text">Updating</span>
              </span>
            ) : null}
          </header>
        )}
        <OrphanedFailures inbox={inbox} />
        {atEnd ? (
          // The end sits where the card did, at its height: the deck's peek gap and hint line are kept.
          <div className="fy-attn-inbox__deck fy-attn-inbox__deck--end">
            <QueueEnd onReview={review} remaining={runOrder.length} />
            <p aria-hidden="true" className="fy-attn-inbox__hint" />
          </div>
        ) : stepRow !== undefined ? (
          <div className="fy-attn-inbox__deck fy-attn-inbox__deck--open" data-agenda-deck-host="">
            <ToTestStep
              answers={toTestAnswers}
              index={runOrder.indexOf(stepRow.key)}
              mouseSwipe={!phone}
              now={now}
              onClose={() => setDeckOpen(false)}
              onNavigate={onNavigate}
              onNext={() => setDeckAt(skipSelection(runOrder, stepRow.key))}
              onPrevious={
                runOrder.indexOf(stepRow.key) > 0
                  ? () => setDeckAt(runOrder[runOrder.indexOf(stepRow.key) - 1] ?? null)
                  : undefined
              }
              row={stepRow}
              total={runOrder.length}
            />
            {phone ? null : <RunKeysHint keys={toTestRunKeys(stepRow)} />}
          </div>
        ) : (
          <div className="fy-attn-inbox__deck fy-attn-inbox__deck--open" data-agenda-deck-host="">
            <AgendaSwipeDeck
              cards={deck}
              canSnooze={card => inbox.canSnooze?.(card.daemonId) ?? true}
              onAct={(card, action) => answerWithDraft(host, card, action)}
              onDismiss={card => answerCard(host, card, DISMISS_ACTION)}
              onHold={(card, action) => {
                if (!gateAsksWords(card.item, action)) return false;
                setGateWhy({ key: card.key, action });
                return true;
              }}
              mouseSwipe={!phone}
              onSkip={card => setDeckAt(skipSelection(runOrder, card.key))}
              runKeys={!phone}
              onSnooze={(card, until) => answerCard(host, card, snoozeAction(until))}
              {...(phone ? { ownGesturesIn: VIEW_GESTURES } : {})}
              {...(reducedMotion === undefined ? {} : { reducedMotion })}
              renderCard={(card, act, skipCard) => {
                const index = order.indexOf(card.key);
                const previous = index > 0 ? order[index - 1] : undefined;
                return (
                  <OpenItem
                    act={act}
                    canSnooze={inbox.canSnooze?.(card.daemonId) ?? true}
                    card={card}
                    host={host}
                    key={card.key}
                    place={{
                      index: Math.max(0, index),
                      total: runOrder.length,
                      onClose: () => setDeckOpen(false),
                      swipeable: phone,
                      ...(previous === undefined ? {} : { onPrevious: () => setDeckAt(previous) }),
                    }}
                    skip={skipCard}
                  />
                );
              }}
            />
            <div className="fy-inbox-deck-foot" data-inbox-deck-foot="">
              {deck[0] !== undefined && gateWhy?.key === deck[0].key ? (
                <GateWhy
                  card={deck[0]}
                  optional={gateWordsFor(deck[0].item, gateWhy.action) === 'optional'}
                  error={failureFor(inbox.deferredState.failed, deck[0].key)}
                  onCancel={() => setGateWhy(null)}
                  onSend={reason => {
                    const label = choiceLabel(gateWhy.action);
                    if (label === null || deck[0] === undefined) return;
                    answerCard(host, deck[0], gateAnswerAction(label, reason));
                    setGateWhy(null);
                  }}
                />
              ) : deck[0] === undefined || renderComposer === undefined || isGateItem(deck[0].item) ? null : (
                // biome-ignore lint/a11y/noStaticElementInteractions: the keydown only routes an unclaimed Esc in the composer back to the Inbox list
                <div
                  className="fy-inbox-composer"
                  data-inbox-composer={deck[0].key}
                  onKeyDown={escapeCloses(() => setDeckOpen(false))}
                >
                  {renderComposer(
                    deck[0],
                    deck[0].item.kind === 'form' ? () => answerForm(host, deck[0] as InboxCard) : undefined,
                  )}
                </div>
              )}
              {phone || deck[0] === undefined ? null : <RunKeysHint keys={agendaRunKeys(deck[0])} />}
            </div>
          </div>
        )}
        {toTestAnswers.composer}
        <AgendaUndoToast inbox={inbox} {...(clock === undefined ? {} : { clock })} />
      </main>
    );
  }

  return (
    <main
      {...(phone ? { 'aria-label': 'Inbox' } : { 'aria-labelledby': headingId })}
      className="fy-attn-inbox"
      data-agenda-inbox={phone ? 'list' : 'panes'}
    >
      {header}
      {banner}
      <AgentsBulk inbox={inbox} kind={kind} machines={machines} port={clearPort} />
      <OrphanedFailures inbox={inbox} />
      {filter === 'open' ? <UnreadableMachines inbox={inbox} /> : null}
      {toTestAnswers.notice === null ? null : (
        <p className="fy-totest__error" data-to-test-notice="" role="alert">
          {toTestAnswers.notice}
        </p>
      )}
      {filter === 'snoozed' || filter === 'replied' ? (
        <InboxParkedList
          answers={toTestAnswers}
          filter={filter}
          inbox={inbox}
          now={now}
          onClear={clearFilters}
          onNavigate={onNavigate}
          rows={filterInboxCards(filter === 'snoozed' ? snoozed : replied, listFilter)}
          toTestRows={filter === 'snoozed' ? snoozedToTest : []}
        />
      ) : filter === 'resolved' ? (
        <InboxResolvedList
          inbox={inbox}
          onClear={clearFilters}
          onNavigate={onNavigate}
          rows={filterInboxResolved(inbox.resolved, listFilter)}
        />
      ) : (
        openBody
      )}
      {toTestAnswers.composer}
      <AgendaUndoToast inbox={inbox} {...(clock === undefined ? {} : { clock })} />
    </main>
  );
}

/** How many cards the Sessions page's Needs-you deck shows. */
const NEEDS_YOU_CARDS = 3;

export interface AgendaNeedsYouProps {
  readonly inbox: AgendaInbox;
  /** The machine whose Sessions page this is: "See all" opens the inbox under it. */
  readonly daemonId: DaemonId;
  readonly onNavigate: (to: string) => void;
  readonly now?: number;
  readonly clock?: () => number;
}

/**
 * The Sessions page's "Needs you" deck: the newest few cards across every machine, answered with their
 * buttons into the same undo window, and "See all N" into the inbox. Nothing open, nothing drawn —
 * except the undo toast, which outlives the last card it took.
 */
export function AgendaNeedsYou({ inbox, daemonId, onNavigate, now, clock }: AgendaNeedsYouProps) {
  const headingId = useId();
  const toast = <AgendaUndoToast inbox={inbox} {...(clock === undefined ? {} : { clock })} />;
  if (inbox.cards.length === 0) return toast;
  const host: CardHostProps = { inbox, onNavigate, now };
  const shown = inbox.cards.slice(0, NEEDS_YOU_CARDS);
  return (
    <section aria-labelledby={headingId} className="fy-attn-needs" data-agenda-needs-you="">
      <header className="fy-attn-needs__head">
        <h2 className="fy-attn-needs__title" id={headingId}>
          Needs you
          <AgendaCountBadge count={inbox.cards.length} />
        </h2>
        <RouteLink
          className="fy-attn-needs__all"
          data-agenda-see-all=""
          onNavigate={onNavigate}
          to={daemonAgendaPath(daemonId)}
        >
          See all {inbox.cards.length}
          <ArrowRight aria-hidden="true" size={13} />
        </RouteLink>
      </header>
      <ul className="fy-attn-needs__cards" data-count={shown.length}>
        {shown.map(card => (
          <li key={card.key}>{renderInboxCard(host, card, action => answerCard(host, card, action))}</li>
        ))}
      </ul>
      {toast}
    </section>
  );
}
