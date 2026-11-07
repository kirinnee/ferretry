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
 *   a menu, Esc closes it, a finger still swipes (a mouse never does), and finishing says "All done". In the list, j/k (or ↑/↓) walk the rows
 *   and Enter opens one.
 * - ONE TOOLBAR ROW, on a phone and a wide screen alike, in ONE centred column that every block aligns to: the
 *   "Inbox n" title, Show ▾ (Open / Snoozed (n) / Replied (n) / Resolved — a snoozed or replied item is parked: off the
 *   open list and the badge until it wakes, is unsnoozed, or the ferret re-opens it), who ▾ (All / Interactive / Agents),
 *   machine ▾ (once there is more than one machine), Find behind a search icon that expands, and — from
 *   `/inbox?from=warden` — a "From Warden" chip that keeps only what the Warden raised, with a way to clear it. On a
 *   wide screen "Answer quickly n" is a compact primary button at the row's right end; on a phone it sits in the body.
 *   The theme switch is not on this row at all: Settings has it, and a phone's top bar carries its own.
 *
 * The page renders off the shell's `AgendaInbox` alone, so it render-tests with a fake one; reading what was said
 * about an open item (its History) is the host's (`readConversation`).
 */

import { type AgendaId, type AgendaItem, agendaAnswerText, isMachineAgendaId } from '../../wire/index.ts';
import {
  AlarmClockOff,
  ArrowLeft,
  ArrowRight,
  CheckCheck,
  ChevronRight,
  CloudOff,
  Laptop,
  Server,
  SkipForward,
  Undo2,
  Users,
  X,
  Zap,
} from 'lucide-react';
import {
  Fragment,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { DaemonTaskReferences, shellClock } from '../../shell.ts';
import { Spinner } from '../../shell.ts';
import type { AgendaInbox } from '../../hooks/use-agenda-inbox.ts';
import { useDoneClose } from '../../hooks/use-done-close.ts';
import { CLEAR_ACTION, kindWord, swipeTargets } from '../../lib/agenda-answers.ts';
import { answerRowLayout, cardModel } from '../../lib/agenda-card-model.ts';
import type { ClearPort } from '../../lib/agenda-clear-agents.ts';
import { storedHistory } from '../../lib/agenda-conversation.ts';
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
import { findRows, isFinding } from '../../lib/agenda-inbox-find.ts';
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
import { agendaAuthor, agendaStatus } from '../../lib/agenda-status.ts';
import { itemCardKind } from '../../shell.ts';
import type { ModeFilter } from '../../shell.ts';
import type { DaemonConnection, DaemonId } from '../../shell.ts';
import { daemonSessionScope } from '../../shell.ts';
import { escapeCloses } from '../../shell.ts';
import {
  choiceLabel,
  type GateItem,
  gateAnswerAction,
  gateAsksWords,
  gateWhySubject,
  gateWordsFor,
  isGateItem,
  firstOpenGate,
} from '../../lib/gate-items.ts';
import { laneEditDestination } from '../../shell.ts';
import { daemonAgendaPath, daemonSessionPath } from '../../shell.ts';
import { composerQuoteTarget } from '../../shell.ts';
import type { TranscriptEntry } from '../../shell.ts';
import { AgendaCountBadge } from '../../shell.ts';
import { RouteLink } from '../../shell.ts';
import { sessionsBarNames } from '../../shell.ts';
import { BoardSendBack, type SendBack, type SendBackPorts, useSendBackFiles } from '../../shell.ts';
import { InputCardHost } from '../../shell.ts';
import { PhoneApprovalHost } from '../../shell.ts';
import { TwoFactorSeedHost } from '../../shell.ts';
import { browserClipboardWriter, CopyButton } from '../../shell.ts';
import { useAnsweredSuggestionSweep } from '../../shell.ts';
import { CopyPlanHost } from '../../shell.ts';
import { SignInRuleSuggestionHost } from '../../shell.ts';
import { TaskPlanHost } from '../../shell.ts';
import { agendaAge, agendaReference } from './agenda-board.tsx';
import { AgendaCard, type AgendaCardOrigin } from './agenda-card.tsx';
import { AgendaCardsHost } from './agenda-cards-host.tsx';
import { AgendaItemView } from './agenda-item-view.tsx';
import { agendaProse } from './agenda-prose.tsx';
import { ResolvedRow } from './agenda-resolved.tsx';
import { ResolvedItemView } from './resolved-item-view.tsx';
import { AgendaStatusPill } from './agenda-status-pill.tsx';
import { AgendaSwipeDeck } from './agenda-swipe-deck.tsx';
import { ownsKeys } from './agenda-swipe-gesture.ts';
import { AgendaUndoToast } from './agenda-undo-toast.tsx';
import { CardKindChip } from './card-kind-chip.tsx';
import { CardMetaLine, hasWords, joinMeta } from './card-meta-line.tsx';
import { ClearAgentsControl } from './clear-agents.tsx';
import { FilterMenu, FindToggle } from './inbox-filter-menu.tsx';
import { InboxFindResults } from './inbox-find-results.tsx';
import { useItemLifecycle } from './use-item-lifecycle.ts';

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

/**
 * Whether the owner may snooze this card: the machine must take snoozes, and a ferret's rule suggestion never does (the
 * ferret reads its own board, so a snooze would tell it the owner looked: C2).
 */
const snoozable = (card: InboxCard): boolean => card.item.signInRuleSuggestion === undefined;

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
      {...(card.item.signInRuleSuggestion === undefined
        ? { onSnooze: (until: string) => act(snoozeAction(until)) }
        : {})}
      origin={inboxCardOrigin(card, onNavigate)}
      swipeHints={false}
      {...inputFormFor(inbox, card, onNavigate)}
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
  onNavigate: (to: string) => void,
): { readonly inputForm?: ReactNode; readonly planForm?: ReactNode; readonly cardsForm?: ReactNode } => {
  const connection = inbox.connectionFor(card.daemonId);
  if (connection !== undefined && card.item.cards !== undefined)
    return { cardsForm: <AgendaCardsHost cards={card.item.cards} connection={connection} onNavigate={onNavigate} /> };
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
      planForm: (
        <SignInRuleSuggestionHost
          agentName={inboxWho(card).ferret}
          connection={connection}
          item={card.item}
          sessionId={card.view.config.id}
          {...(card.view.config.projectId === undefined ? {} : { projectId: card.view.config.projectId })}
        />
      ),
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

/**
 * The card's own composer, as it registers itself: its ferret's conversation and THIS item's draft slot. The chat
 * box registers under the conversation alone, so a quote or a quick reply here never reads or empties the chat's
 * words, nor another card's.
 */
const scopeOf = (card: InboxCard) => daemonSessionScope({ daemonId: card.daemonId }, card.view.config.id, card.item.id);

/**
 * Answers the open item: what is typed in the item's own composer rides as the answer's note (the chat's own rule,
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
      chat={
        isMachineAgendaId(card.view.config.id)
          ? undefined
          : {
              to: agendaConversationPath(card.daemonId, card.view.config.id, card.item.id),
              onNavigate,
              hooks: { 'data-inbox-open-chat': '' },
            }
      }
      hooks={{ 'data-inbox-who': '' }}
    >
      {joinMeta(
        <span className="fy-meta-line__ferret" data-inbox-who-ferret="">
          {who.ferret}
        </span>,
        hasWords(who.task) ? <span data-inbox-who-task="">{who.task}</span> : null,
        hasWords(who.card) ? (
          <span className="fy-meta-line__card" data-inbox-who-card="">
            {who.card}
          </span>
        ) : null,
        hasWords(who.machine) ? <span>{who.machine}</span> : null,
      )}
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
  askTap,
}: {
  readonly host: CardHostProps;
  readonly card: InboxCard;
  readonly act: (action: InboxAction) => void;
  readonly skip: () => void;
  readonly place: OpenItemPlace;
  readonly canSnooze: boolean;
  /** A tapped notification opened it: it opens at its ask, and each tap is a new number. */
  readonly askTap?: number;
}) {
  const conversation = useItemConversation(card, readConversation);
  const entries = conversation.entries;
  const connection = inbox.connectionFor(card.daemonId);
  const lifecycle = useItemLifecycle({
    connection,
    scope: scopeOf(card),
    client: inbox.agendaClient,
    item: card.item,
    board: inbox.boardOf?.(card.daemonId, card.view.config.id) ?? NO_BOARD,
    records: inbox.recordsOf?.(card.daemonId, card.view.config.id) ?? NO_BOARD,
  });
  const history = useMemo(
    () =>
      lifecycle.conversation === null
        ? itemHistory(card.item, entries)
        : storedHistory(card.item, lifecycle.conversation, lifecycle.conversationGap),
    [card.item, entries, lifecycle.conversation, lifecycle.conversationGap],
  );
  // A step's tick goes to the machine the card came from, through the one agenda client (as in the chat). Without a
  // client or a paired connection the list stays read-only, never a box that looks live and does nothing.
  const progress = inbox.agendaClient;
  const onProgress =
    progress === undefined || connection === undefined
      ? undefined
      : (step: number, done: boolean): Promise<void> =>
          progress.progress(connection, daemonSessionScope(connection, card.view.config.id), card.item.id, step, done);
  const machineFerrets = isMachineAgendaId(card.view.config.id) ? ferretsOf(card.item.context) : [];
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
        {machineFerrets.length === 0 ? null : <MachineNotes ferrets={machineFerrets} item={card.item} />}
        <AgendaItemView
          busy={false}
          closeLabel="Back to the Inbox"
          daemonId={card.daemonId}
          error={failureFor(inbox.deferredState.failed, card.key) ?? conversation.error}
          ferret={inboxWho(card).ferret}
          formKey={card.key}
          history={history}
          itemKey={card.key}
          {...(lifecycle.versions === undefined ? {} : { versions: lifecycle.versions })}
          {...(lifecycle.merge === undefined ? {} : { merge: lifecycle.merge })}
          {...(lifecycle.lineageTitles === undefined ? {} : { lineageTitles: lifecycle.lineageTitles })}
          {...(askTap === undefined ? {} : { startAt: 'ask' as const, startTap: askTap })}
          howToTestFor={cardId => inbox.howToTestFor?.(card.daemonId, cardId)}
          tools={<CardTools act={act} dismissable={card.item.signInRuleSuggestion === undefined} skip={skip} />}
          item={machineFerrets.length === 0 ? card.item : withoutMachineRepeats(card.item)}
          onAct={act}
          onClose={place.onClose}
          onNext={skip}
          {...(onProgress === undefined ? {} : { onProgress })}
          {...(canSnooze ? { onSnooze: (until: string) => act(snoozeAction(until)) } : {})}
          position={{ index: place.index, total: place.total }}
          quoteScope={scopeOf(card)}
          {...inputFormFor(inbox, card, onNavigate)}
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

/**
 * The ferrets a machine notice lists: a `name (id): reason and action` line each, and an optional `$ command` line
 * under it that the owner can run. A line of any other shape is not one.
 */
const FERRET_LINE = /^(.+) \(([^()\s]+)\): (.*)$/;
const COMMAND_LINE = /^\$ (.+)$/;

interface MachineFerret {
  readonly name: string;
  readonly id: string;
  readonly said: string;
  readonly command?: string;
}

const ferretsOf = (context: string | null | undefined): readonly MachineFerret[] => {
  const ferrets: MachineFerret[] = [];
  for (const line of (context ?? '').split('\n')) {
    const match = FERRET_LINE.exec(line);
    if (match !== null) {
      ferrets.push({ name: match[1] ?? '', id: match[2] ?? '', said: match[3] ?? '' });
      continue;
    }
    const command = COMMAND_LINE.exec(line)?.[1];
    const last = ferrets.pop();
    if (last !== undefined) ferrets.push(command === undefined ? last : { ...last, command });
  }
  return ferrets;
};

/** The item without the text `MachineNotes` already says, so each fact appears once. */
function withoutMachineRepeats(item: InboxCard['item']): InboxCard['item'] {
  const { context: _context, body: _body, premise: _premise, ...rest } = item;
  return { ...rest, why: '' };
}

/** A machine notice's open view: why it was raised, then each ferret with its reason, its action and its command. */
function MachineNotes({
  item,
  ferrets,
}: {
  readonly item: InboxCard['item'];
  readonly ferrets: readonly MachineFerret[];
}) {
  return (
    <div className="fy-inbox-machine-notes" data-inbox-machine-notes="">
      <p data-inbox-machine-why="">{item.why}</p>
      <ul className="fy-inbox-machine-notes__moves" data-inbox-machine-moves="">
        {ferrets.map(ferret => (
          <li data-inbox-machine-move={ferret.id} key={ferret.id}>
            <span className="fy-inbox-machine-notes__ferret">{ferret.name}</span>
            <span className="fy-inbox-machine-notes__said" data-inbox-machine-said="">
              {ferret.said}
            </span>
            {ferret.command === undefined ? null : (
              <div className="fy-inbox-machine-notes__command">
                <code data-inbox-machine-command="">{ferret.command}</code>
                <CopyButton
                  label={`Copy the move command for ${ferret.name}`}
                  text={ferret.command}
                  write={copyWriter}
                />
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
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
      {joinMeta(
        hasWords(gate.projectName) ? <span data-inbox-gate-project="">{gate.projectName}</span> : null,
        <span className="fy-meta-line__ferret" data-inbox-who-ferret="">
          {inboxWho(card).ferret}
        </span>,
      )}
    </CardMetaLine>
  );
}

/** The compass's quiet moves as plain buttons, so nothing depends on a gesture: Skip and Not needed. Snooze is the head's clock. */
function CardTools({
  act,
  skip,
  dismissable = true,
}: {
  readonly act: (action: InboxAction) => void;
  readonly skip: () => void;
  /** A ferret's rule suggestion has no Not needed: its card's own Dismiss says no (the agenda refuses a close). */
  readonly dismissable?: boolean;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring its border and min-width into a flex row of buttons
    <div aria-label="Put this card aside" className="fy-inbox-tools" data-inbox-card-tools="" role="group">
      <button className="kt-btn kt-btn--sm" data-inbox-tool="skip" onClick={skip} type="button">
        Skip
      </button>
      {dismissable ? (
        <button
          className="kt-btn kt-btn--sm"
          data-inbox-tool="not-needed"
          onClick={() => act(DISMISS_ACTION)}
          type="button"
        >
          Not needed
        </button>
      ) : null}
    </div>
  );
}

/** The words "Not good" waits for, asked where the answer row was; the refusal, if any, shows beside its buttons. */
function GateWhy({
  card,
  daemon,
  error,
  optional,
  subject,
  ports,
  onSend,
  onCancel,
}: {
  readonly card: InboxCard;
  /** What the answer is about, as the heading names it: the card being tried (`gateWhySubject`). */
  readonly subject: string;
  /** The card's machine; a machine that has gone has nowhere to send the answer, so no box is drawn for it. */
  readonly daemon: DaemonConnection | undefined;
  readonly error: string | null;
  readonly optional: boolean;
  /** What the machine needs to take files with the answer; absent, the box is words alone. */
  readonly ports: SendBackPorts | undefined;
  readonly onSend: (sent: SendBack, sessionId: string | null) => void;
  readonly onCancel: () => void;
}) {
  // The files ride the answer to the item's own session; the daemon carries them to the card's ferret.
  const answerPorts = useMemo(
    () =>
      ports?.answerFiles === undefined
        ? undefined
        : { sendBackFiles: ports.answerFiles, uploadAttachment: ports.uploadAttachment },
    [ports?.answerFiles, ports?.uploadAttachment],
  );
  const files = useSendBackFiles(answerPorts, daemon, card.view.config.id);
  if (daemon === undefined) return null;
  return (
    <div className="fy-inbox-gate-why" data-inbox-gate-why={card.key}>
      <BoardSendBack
        busy={false}
        error={error}
        // "Not yet" leaves the card where it is: there is no ferret to show a picture to.
        files={optional ? null : files}
        heading={optional ? `Not yet: anything to add about ${subject}?` : `Not good: what went wrong with ${subject}?`}
        submitLabel={optional ? 'Not yet' : 'Send back'}
        wordsOptional={optional}
        placeholder={optional ? 'Optional: add a note' : 'What went wrong?'}
        onCancel={onCancel}
        onSubmit={sent => {
          onSend(sent, files?.sessionId ?? null);
          return null;
        }}
        target={{ daemon, sessionId: card.view.config.id }}
      />
    </div>
  );
}

const NO_ENTRIES: readonly TranscriptEntry[] = [];
const NO_BOARD: readonly AgendaItem[] = [];

/** What was said about the card's item, with read failures shown by the item's normal error state. */
function useItemConversation(
  card: InboxCard,
  read: ((card: InboxCard) => Promise<readonly TranscriptEntry[]>) | undefined,
): { readonly entries: readonly TranscriptEntry[]; readonly error: string | null } {
  const [loaded, setLoaded] = useState<{
    readonly key: string;
    readonly entries: readonly TranscriptEntry[];
    readonly error: string | null;
  }>({
    key: '',
    entries: NO_ENTRIES,
    error: null,
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
        if (live) setLoaded({ key, entries, error: null });
      },
      (reason: unknown) => {
        if (live)
          setLoaded({ key, entries: NO_ENTRIES, error: reason instanceof Error ? reason.message : String(reason) });
      },
    );
    return () => {
      live = false;
    };
  }, [key, reads]);
  return loaded.key === key ? loaded : { entries: NO_ENTRIES, error: null };
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

const KIND_WORDS: Readonly<Record<ModeFilter, string>> = { all: 'All', interactive: 'Interactive', auto: 'Agents' };
const KIND_CHOICES = (Object.keys(KIND_WORDS) as ModeFilter[]).map(value => ({ value, label: KIND_WORDS[value] }));
const FILTER_CHOICES = ['open', 'snoozed', 'replied', 'resolved'] as const;

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
  onOpenMachine,
}: {
  readonly inbox: AgendaInbox;
  readonly rows: readonly InboxResolved[];
  readonly onNavigate: (to: string) => void;
  readonly onClear: () => void;
  readonly onOpenMachine: (row: InboxResolved) => void;
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
            {...(isMachineAgendaId(row.view.config.id) ? { onOpen: () => onOpenMachine(row) } : {})}
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
        aria-label={`${filter === 'snoozed' ? 'Unsnooze' : 'Back to my list'}: ${inboxRowTitle(card.item)}`}
        className="kt-btn kt-btn--sm fy-parked-row__back"
        data-agenda-unsnooze={filter}
        title={filter === 'snoozed' ? 'Unsnooze' : 'Back to my list'}
        onClick={() => inbox.deferred.schedule(card, UNSNOOZE_ACTION)}
        type="button"
      >
        {filter === 'snoozed' ? <AlarmClockOff aria-hidden="true" size={18} /> : <Undo2 aria-hidden="true" size={18} />}
      </button>
    </li>
  );
}

/** The Snoozed and Replied filters: what is parked, each with the way back to the owner's list. */
function InboxParkedList({
  inbox,
  filter,
  rows,
  now,
  onNavigate,
  onClear,
}: {
  readonly inbox: AgendaInbox;
  readonly filter: ParkedReason;
  readonly rows: readonly InboxCard[];
  readonly now: number | undefined;
  readonly onNavigate: (to: string) => void;
  readonly onClear: () => void;
}) {
  if (rows.length === 0)
    return inbox.parked.length > 0 ? (
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
      </ul>
      {inbox.parkedWhole ? (
        inbox.resolvedReading ? (
          <p className="fy-attn-inbox__hint">Reading more…</p>
        ) : null
      ) : (
        <p className="fy-attn-inbox__hint" data-agenda-parked-window="">
          From your {RESOLVED_READ_LIMIT} most recent conversations
          {inbox.resolvedReading ? ' · reading more…' : ''}
        </p>
      )}
    </div>
  );
}

const resolvedOrigin = (row: InboxResolved, onNavigate: (to: string) => void) => {
  const names = sessionsBarNames(row.root ?? row.view);
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
  /** A phone finishes a run back at the list; a wider screen keys it (a finger still swipes) and ends on "All done". */
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
  /** Uploads files with the unified ask answer, through the item's own conversation. */
  readonly answerPorts?: SendBackPorts;
  /**
   * An item was opened here (it is the deck's top card): its alerts come down on this device and the owner's others
   * (docs/notifications.md § When an alert is cleared). Called once each time a different item opens. Absent: nothing.
   */
  readonly onItemOpened?: (card: InboxCard) => void;
}

/** How long a tapped notification's item may take to appear among the open ones before its chat opens instead. */
const OPEN_WAIT_MS = 5_000;

/** How soon after the last input on this page a card coming up on top still counts as the owner opening it. */
const ATTENDED_MS = 60_000;

/** What counts as someone at the page: a press, a key, a tap, or the page coming back into view. */
const ATTENDED_INPUTS = ['pointerdown', 'keydown', 'click', 'touchstart', 'visibilitychange'] as const;

/** Everything a row needs besides the card itself. */
interface RowEnv {
  readonly inbox: AgendaInbox;
  readonly now: number | undefined;
  readonly onNavigate: (to: string) => void;
  readonly selectedKey: string | null;
  readonly rowRef: (key: string) => (element: HTMLAnchorElement | null) => void;
  /** Opens an item here, as the deck's top card. */
  readonly onOpen: (key: string) => void;
  /** More than one machine is paired: the Machine group then says which machine it is. */
  readonly severalMachines: boolean;
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
  const head = (
    <>
      {group.machine ? (
        <Server aria-hidden="true" className="fy-inbox-group__icon" data-agenda-group-icon="" size={16} />
      ) : null}
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
      {group.via === null ? null : (
        <span className="fy-inbox-group__via" data-agenda-group-via="">
          via {group.via}
        </span>
      )}
    </>
  );
  return (
    <li className="fy-inbox-group" data-agenda-group={group.key}>
      {group.machine ? (
        // The machine agenda has no chat: its header names the machine's own notices and goes nowhere.
        <div className="fy-inbox-group__head" data-agenda-group-machine="">
          {head}
        </div>
      ) : (
        <RouteLink
          className="fy-inbox-group__head"
          data-agenda-group-link=""
          onNavigate={env.onNavigate}
          to={daemonSessionPath(group.daemonId, group.view.config.id)}
        >
          {head}
        </RouteLink>
      )}
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

/**
 * The arrows an agenda card answers by, in its buttons' own words (`agendaAnswerText`), then Skip. Each is cut for the
 * row the open card draws (`answerRowLayout`): the deck's open item always has a composer, so a review's Request
 * changes is on it, and "Done · closes" is on it when the item offers one (`doneClose`).
 */
export const agendaRunKeys = (card: InboxCard, doneClose = false): readonly RunKey[] => {
  const targets = swipeTargets(card.item);
  const { slots } = answerRowLayout(cardModel(card.item), { requestChanges: true, doneClose });
  return [
    ...(targets.left === undefined ? [] : [{ key: '←', word: agendaAnswerText(targets.left.label, slots) }]),
    ...(targets.up === undefined ? [] : [{ key: '↑', word: agendaAnswerText(targets.up.label, slots) }]),
    ...(targets.right === undefined ? [] : [{ key: '→', word: agendaAnswerText(targets.right.label, slots) }]),
    ...RUN_MOVES,
  ];
};

/** The run's keys for the open agenda card, counting its "Done · closes" as its row does. */
function AgendaRunKeysHint({ card }: { readonly card: InboxCard }) {
  const doneClose = useDoneClose(card.daemonId, card.item) !== undefined;
  return <RunKeysHint keys={agendaRunKeys(card, doneClose)} />;
}

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

/**
 * Remembers that the focus was in the composer when its card left: the composer is removed with the card, and a
 * removed node leaves the focus on the page body. Rendered once per card, so it unmounts with that card's composer.
 */
function FocusHandoff({
  root,
  flag,
}: {
  readonly root: RefObject<HTMLElement | null>;
  readonly flag: MutableRefObject<boolean>;
}) {
  useLayoutEffect(
    () => () => {
      const element = root.current;
      if (element?.contains(document.activeElement)) flag.current = true;
    },
    [root, flag],
  );
  return null;
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
  answerPorts,
  onItemOpened,
}: AgendaInboxPageProps) {
  const headingId = useId();
  const [resolvedMachine, setResolvedMachine] = useState<InboxResolved | null>(null);
  const resolvedConnection = resolvedMachine === null ? undefined : inbox.connectionFor(resolvedMachine.daemonId);
  useAnsweredSuggestionSweep(inbox.cards, inbox.connectionFor);
  const [cursor, setCursor] = useState<string | null>(null);
  const [deckAt, setDeckAt] = useState<string | null>(initialOpen ?? null);
  // The card a tapped notification opened: it opens at its ask (a Needs-you push lands on what to do).
  const [askAt, setAskAt] = useState<{ readonly key: string; readonly tap: number } | null>(null);
  const askTaps = useRef(0);
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
  const finding = isFinding(query);
  const listFilter: InboxListFilter = { machine: machineFilter, query, from, mode: kind };
  const visible = filterInboxCards(inbox.cards, listFilter);
  const withFerret = filterInboxCards(inbox.withFerret, listFilter);
  const sections = useMemo(() => inboxSections(visible, withFerret), [visible, withFerret]);
  const filtered = machineFilter !== null || query !== '' || from !== null || kind !== 'all';
  const snoozed = parkedBy(inbox.parked, 'snoozed');
  const replied = parkedBy(inbox.parked, 'replied');
  // A count is the length of what is listed under it: the rows the machine, who and Find filters keep.
  const snoozedShown = filterInboxCards(snoozed, listFilter);
  const repliedShown = filterInboxCards(replied, listFilter);
  const parkedCounts = { snoozed: snoozedShown.length, replied: repliedShown.length };

  // The deck deals what waits on the owner, in the order the page lists it: the agenda items and their card asks.
  const deckCards = groupCards([...sections.stopped, ...sections.needsYou]);
  const order = deckCards.map(card => card.key);
  const runOrder = order;
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

  // Words typed make Find look in every tab, and the snoozed, replied and resolved ones come from the resolved read.
  const loadResolved = inbox.loadResolved;
  useEffect(() => {
    if (finding) loadResolved();
  }, [finding, loadResolved]);
  const findResults = finding
    ? findRows(
        {
          cards: inbox.cards,
          withFerret: inbox.withFerret,
          parked: inbox.parked,
          resolved: inbox.resolved,
        },
        listFilter,
        now ?? shellClock.nowMs(),
      )
    : [];
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
  const keysLive = resolvedMachine === null && !phone && filter === 'open' && !deckOpen && !finding;
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
  const empty = inbox.cards.length === 0 && inbox.withFerret.length === 0;
  const nothingForYou = inbox.cards.length === 0 && inbox.unavailable.length === 0;
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
  const openRecord =
    open === null || !isMachineAgendaId(open.sessionId)
      ? undefined
      : inbox.resolved.find(
          row => row.daemonId === open.daemonId && row.view.config.id === open.sessionId && row.record.id === open.id,
        );
  // biome-ignore lint/correctness/useExhaustiveDependencies: `openAt` and the host callback are re-made every render; the target and what it resolves to are the inputs
  useEffect(() => {
    // The request is gone from the address once it was honoured: a later tap for the same item is a new one.
    if (wantedKey === null) openedFor.current = null;
    if (wantedKey === null || openedFor.current === wantedKey) return;
    if (openRecord !== undefined) {
      openedFor.current = wantedKey;
      setResolvedMachine(openRecord);
      onOpenSettled?.(true);
      return;
    }
    if (openCardKey !== undefined) {
      openedFor.current = wantedKey;
      setFilter('open');
      askTaps.current += 1;
      setAskAt({ key: openCardKey, tap: askTaps.current });
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
    return shellClock.after(giveUp, OPEN_WAIT_MS);
  }, [wantedKey, openCardKey, openRecord, openSettled, inbox.reading]);

  // Paging away or closing the deck leaves the item the tap was for: opening one from the list starts at its top.
  const askedKey = askAt?.key;
  useEffect(() => {
    if (askedKey !== undefined && (!deckOpen || deckPlace !== askedKey)) setAskAt(null);
  }, [askedKey, deckOpen, deckPlace]);

  // A reply moves the deck on by itself (the card leaves, `nextSelection` deals the one after it). Undo brings the card
  // back and the deck opens it, so the owner sees the words it restored.
  const revealKey = inbox.repliedState.entries.find(entry => entry.reveal)?.key;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key to reveal and the order it may now be listed in are the inputs
  useEffect(() => {
    if (revealKey === undefined) return;
    if (deckCards.some(card => card.key === revealKey)) {
      setFilter('open');
      setAllDone(false);
      openAt(revealKey);
    }
    inbox.replied.revealed(revealKey);
  }, [revealKey, orderKey]);
  // The composer that sent a reply goes away with its card; the keyboard keeps its place on the next card's frame.
  const composerRoot = useRef<HTMLDivElement | null>(null);
  const composerHandoff = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the card on top changing is the only trigger
  useEffect(() => {
    if (!composerHandoff.current) return;
    composerHandoff.current = false;
    document.querySelector<HTMLElement>('.fy-attn-deck__top [data-agenda-frame]')?.focus();
  }, [deckPlace]);

  // An open item is the deck's top card, on a phone and a wide screen alike.
  const cardOpen = deckOpen && filter === 'open' && (deckSelected !== undefined || atEnd);
  // Opening an item is the owner seeing it: its alerts come down here and on their other devices. Only while someone is
  // at this page (review round 9): a deck that moved on by itself on a screen nobody is at — its card was answered
  // elsewhere — or a hidden tab is not an open, or it would take the next card's alert off the phone in the owner's
  // hand. The card on top is told when it comes up within `ATTENDED_MS` of an input on a visible page (coming to the
  // page counts), or else at the next one.
  const openedCard = cardOpen ? deckSelected : undefined;
  const opened = useRef({ card: openedCard, tell: onItemOpened });
  opened.current = { card: openedCard, tell: onItemOpened };
  const readClock = clock ?? shellClock.nowMs;
  const lastInput = useRef(readClock());
  const toldKey = useRef<string | null>(null);
  const tellOpened = useRef((): void => undefined);
  tellOpened.current = () => {
    const { card, tell } = opened.current;
    if (card === undefined || toldKey.current === card.key) return;
    if (document.visibilityState === 'hidden' || readClock() - lastInput.current > ATTENDED_MS) return;
    toldKey.current = card.key;
    tell?.(card);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: a different item on top is the only trigger; the card object and the host callback are re-made every render
  useEffect(() => {
    if (openedCard === undefined) toldKey.current = null;
    tellOpened.current();
  }, [openedCard?.key]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the clock is read through `readClock` each time
  useEffect(() => {
    const input = (): void => {
      if (document.visibilityState === 'hidden') return;
      lastInput.current = readClock();
      tellOpened.current();
    };
    for (const type of ATTENDED_INPUTS) document.addEventListener(type, input, true);
    return () => {
      for (const type of ATTENDED_INPUTS) document.removeEventListener(type, input, true);
    };
  }, []);

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
  };
  const runKeysLive = resolvedMachine === null && !phone && (cardOpen || allDone);
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
    severalMachines: machines.length > 1,
    rowRef: key => element => {
      if (element === null) rowRefs.delete(key);
      else rowRefs.set(key, element);
    },
  };

  const quick =
    runOrder.length === 0 ? null : (
      <button
        className={phone ? 'kt-btn fy-inbox-quick' : 'kt-btn fy-inbox-quick fy-inbox-quick--toolbar'}
        data-agenda-quick=""
        {...(phone ? {} : { 'data-variant': 'primary' })}
        onClick={startDeck}
        type="button"
      >
        <Zap aria-hidden="true" size={15} />
        Answer quickly
        <span className="fy-inbox-quick__count">{runOrder.length}</span>
      </button>
    );

  // ONE TOOLBAR ROW on every width: title and count, the status menu, who, machine and Find; on a wide screen
  // "Answer quickly" ends the row (the phone's is the first line of its list), and theme is not on this row (Settings has it; a phone's top bar carries its own).
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
      <FilterMenu
        choiceHook="data-agenda-filter-option"
        choices={FILTER_CHOICES.map(entry => ({ value: entry, label: filterWords(entry, parkedCounts) }))}
        hook="data-agenda-filter"
        name="Show"
        onChange={choose}
        value={filter}
      />
      <div className="fy-attn-inbox__tools">
        {from === 'warden' && onClearFrom !== undefined ? <SourceChip onClear={onClearFrom} /> : null}
        <FilterMenu
          choiceHook="data-agenda-kind-option"
          choices={KIND_CHOICES}
          hook="data-agenda-kind"
          icon={<Users aria-hidden="true" size={14} />}
          name="Ferrets"
          onChange={setKind}
          value={kind}
        />
        {machines.length > 1 ? (
          <FilterMenu
            choiceHook="data-agenda-machine-option"
            choices={[
              { value: '', label: phone ? 'All' : 'All machines' },
              ...machines.map(entry => ({ value: entry.daemonId as string, label: entry.name })),
            ]}
            hook="data-agenda-machine"
            icon={<Laptop aria-hidden="true" size={14} />}
            name="Machine"
            onChange={next => setMachine(next === '' ? null : (next as DaemonId))}
            value={machineFilter ?? ''}
          />
        ) : null}
        <FindToggle onChange={setQuery} query={query} />
      </div>
      {phone || filter !== 'open' ? null : quick}
    </header>
  );

  const nothingShown = sections.stopped.length + sections.needsYou.length + sections.withFerrets.length === 0;
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
        {phone ? quick : null}
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

  if (resolvedMachine !== null && resolvedConnection !== undefined) {
    return (
      <main aria-label="Inbox" className="fy-attn-inbox" data-agenda-inbox="card">
        <DaemonTaskReferences connection={resolvedConnection} onNavigate={onNavigate}>
          <ResolvedItemView
            row={resolvedMachine}
            connection={resolvedConnection}
            onClose={() => setResolvedMachine(null)}
          />
        </DaemonTaskReferences>
        <AgendaUndoToast inbox={inbox} {...(clock === undefined ? {} : { clock })} />
      </main>
    );
  }

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
    // The toast takes a row of its own between the card and the composer (never over the input, Send or the keys hint);
    // wherever the deck foot is not drawn (the end of the run, a card) it floats at the bottom as before.
    const toastInFoot = !atEnd;
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
        ) : (
          <div className="fy-attn-inbox__deck fy-attn-inbox__deck--open" data-agenda-deck-host="">
            <AgendaSwipeDeck
              cards={deck}
              canSnooze={card => snoozable(card)}
              onAct={(card, action) => answerWithDraft(host, card, action)}
              onDismiss={card => answerCard(host, card, DISMISS_ACTION)}
              onHold={(card, action) => {
                if (!gateAsksWords(card.item, action)) return false;
                setGateWhy({ key: card.key, action });
                return true;
              }}
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
                    key={card.key}
                    {...(askAt?.key === card.key ? { askTap: askAt.tap } : {})}
                    canSnooze={snoozable(card)}
                    card={card}
                    host={host}
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
              <AgendaUndoToast inbox={inbox} inline {...(clock === undefined ? {} : { clock })} />
              {deck[0] !== undefined && gateWhy?.key === deck[0].key ? (
                <GateWhy
                  ports={answerPorts}
                  card={deck[0]}
                  daemon={inbox.connectionFor(deck[0].daemonId)}
                  optional={gateWordsFor(deck[0].item, gateWhy.action) === 'optional'}
                  subject={gateWhySubject(deck[0].item, gateWhy.action)}
                  error={failureFor(inbox.deferredState.failed, deck[0].key)}
                  onCancel={() => setGateWhy(null)}
                  onSend={(sent, from) => {
                    const label = choiceLabel(gateWhy.action);
                    if (label === null || deck[0] === undefined) return;
                    answerCard(
                      host,
                      deck[0],
                      gateAnswerAction(
                        label,
                        sent.reason,
                        gateWhy.action.kind === 'respond' && gateWhy.action.gate === true
                          ? (gateWhy.action.cardAsk ?? firstOpenGate(deck[0].item) ?? true)
                          : false,
                        from === null || sent.attachmentIds.length === 0
                          ? undefined
                          : { from, ids: [...sent.attachmentIds] },
                      ),
                    );
                    setGateWhy(null);
                  }}
                />
              ) : deck[0] === undefined ||
                renderComposer === undefined ||
                isMachineAgendaId(deck[0].view.config.id) ||
                isGateItem(deck[0].item) ||
                // A ferret's rule suggestion takes no words: anything the owner writes there, the ferret reads (C2).
                deck[0].item.signInRuleSuggestion !== undefined ? null : (
                // biome-ignore lint/a11y/noStaticElementInteractions: the keydown only routes an unclaimed Esc in the composer back to the Inbox list
                <div
                  className="fy-inbox-composer"
                  data-inbox-composer={deck[0].key}
                  onKeyDown={escapeCloses(() => setDeckOpen(false))}
                  ref={composerRoot}
                >
                  <FocusHandoff key={deck[0].key} flag={composerHandoff} root={composerRoot} />
                  {renderComposer(
                    deck[0],
                    deck[0].item.kind === 'form' ? () => answerForm(host, deck[0] as InboxCard) : undefined,
                  )}
                </div>
              )}
              {phone || deck[0] === undefined ? null : <AgendaRunKeysHint card={deck[0]} />}
            </div>
          </div>
        )}
        {toastInFoot ? null : <AgendaUndoToast inbox={inbox} {...(clock === undefined ? {} : { clock })} />}
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
      {finding ? (
        <InboxFindResults
          onClear={clearFilters}
          onNavigate={onNavigate}
          onOpen={key => {
            setFilter('open');
            openAt(key);
          }}
          reading={inbox.reading || inbox.resolvedReading}
          rows={findResults}
        />
      ) : filter === 'snoozed' || filter === 'replied' ? (
        <InboxParkedList
          filter={filter}
          inbox={inbox}
          now={now}
          onClear={clearFilters}
          onNavigate={onNavigate}
          rows={filter === 'snoozed' ? snoozedShown : repliedShown}
        />
      ) : filter === 'resolved' ? (
        <InboxResolvedList
          inbox={inbox}
          onClear={clearFilters}
          onNavigate={onNavigate}
          rows={filterInboxResolved(inbox.resolved, listFilter)}
          onOpenMachine={setResolvedMachine}
        />
      ) : (
        openBody
      )}
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
