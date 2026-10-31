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
 *   the card's own row: ← left, ↑ the middle (the recommended), → right — and ↓ to SKIP to the next without
 *   answering; the item stays open. On touch the item's head and quick-reply row swipe on their own, exactly as in
 *   the chat; the who-and-what line is the deck's. A swipe goes into the same undo window as a tap; reduced motion
 *   drops the fly-off. NO TEACHING TEXT: no hint line, no banner naming the answer mid-drag, no key caption. A phone
 *   also gets "Answer quickly", the deck from the top; a wide screen walks the rows with j/k (or ↑/↓) and Enter
 *   opens one.
 * - FILTERS: Open / Snoozed (n) / Replied (n) / Resolved — a snoozed or replied item is parked: off the open list and the
 *   badge until it wakes, is unsnoozed, or the ferret re-opens it — a machine filter (once there is more than one machine), Find, and — from
 *   `/inbox?from=warden` — a "From Warden" chip that keeps only what the Warden raised, with a way to clear it.
 *
 * The page renders off the shell's `AgendaInbox` alone, so it render-tests with a fake one; reading what was said
 * about an open item (its History) is the host's (`readConversation`).
 */

import { ArrowLeft, ArrowRight, CheckCheck, ChevronRight, Search, SkipForward, X, Zap } from 'lucide-react';
import { Fragment, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChatProse } from '../../components/chat-prose.tsx';
import { Spinner } from '../../components/spinner.tsx';

import type { AgendaInbox } from '../../hooks/use-agenda-inbox.ts';
import { CLEAR_ACTION, kindWord } from '../../lib/agenda-answers.ts';
import type { ClearPort } from '../../lib/agenda-clear-agents.ts';
import { itemHistory } from '../../lib/agenda-history.ts';
import {
  actionSentence,
  agendaConversationPath,
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
import { withComposerNote } from '../../lib/agenda-reply.ts';
import { agendaAuthor, agendaStatus } from '../../lib/agenda-status.ts';
import type { ModeFilter } from '../../lib/controls.ts';
import type { DaemonId } from '../../lib/daemon-connection.ts';
import { daemonSessionScope } from '../../lib/daemon-scope.ts';
import { escapeCloses } from '../../lib/escape-closes.ts';
import { laneEditDestination } from '../../lib/lane-proposal-link.ts';
import { daemonAgendaPath, daemonSessionPath } from '../../lib/pages/routes.ts';
import { composerQuoteTarget } from '../../lib/quote.ts';
import type { TranscriptEntry } from '../../lib/session-screens.ts';
import { AgendaCountBadge } from '../../shell/app-bar.tsx';
import { RouteLink } from '../../shell/route-link.tsx';
import { sessionsBarNames } from '../../shell/sessions-bar-model.ts';
import { PageThemeSwitch } from '../../shell/theme-toggle.tsx';
import { browserClipboardWriter } from '../onboarding/copy-button.tsx';
import { agendaAge, agendaReference } from './agenda-board.tsx';
import { AgendaCard, type AgendaCardOrigin } from './agenda-card.tsx';
import { AgendaItemView } from './agenda-item-view.tsx';
import { ResolvedRow } from './agenda-resolved.tsx';
import { AgendaStatusPill } from './agenda-status-pill.tsx';
import { AgendaSwipeDeck } from './agenda-swipe-deck.tsx';
import { AgendaUndoToast } from './agenda-undo-toast.tsx';
import { ClearAgentsControl } from './clear-agents.tsx';

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
  <AgendaCard
    error={failureFor(inbox.deferredState.failed, card.key)}
    item={card.item}
    key={card.key}
    onAct={act}
    onSnooze={until => act(snoozeAction(until))}
    origin={inboxCardOrigin(card, onNavigate)}
    swipeHints={false}
    {...(now === undefined ? {} : { now })}
  />
);

/** The conversation an item belongs to, as the composer registers itself under it. */
const scopeOf = (card: InboxCard) => daemonSessionScope({ daemonId: card.daemonId }, card.view.config.id);

/**
 * Answers the open item: what is typed in its ferret's composer rides as the answer's note (the chat's own rule,
 * `withComposerNote`), and the composer is emptied once it is spent.
 */
const answerWithDraft = (host: Pick<CardHostProps, 'inbox' | 'onNavigate'>, card: InboxCard, action: InboxAction) => {
  const composer = composerQuoteTarget(scopeOf(card));
  const sent = withComposerNote(action, composer?.draft() ?? '');
  answerCard(host, card, sent);
  if (sent !== action) composer?.replaceDraft('');
};

const copyWriter = browserClipboardWriter();

/**
 * Who asked and about what, over the open item — the ferret, what it works on, its card and its machine, never the
 * callsign alone — and the way to its chat. It is also a place a swipe can start.
 */
function InboxWhoLine({ card, onNavigate }: { readonly card: InboxCard; readonly onNavigate: (to: string) => void }) {
  const who = inboxWho(card);
  const dot = (
    <span aria-hidden="true" className="fy-inbox-who__dot">
      ·
    </span>
  );
  return (
    <div className="fy-inbox-who" data-inbox-who="">
      {/* WHO and WHAT first, together: the task is what the owner reads, so it is never cut to make room. */}
      <span className="fy-inbox-who__main" data-inbox-who-main="">
        <span className="fy-inbox-who__ferret" data-inbox-who-ferret="">
          {who.ferret}
        </span>
        {who.task === null ? null : (
          <>
            {dot}
            <span className="fy-inbox-who__task" data-inbox-who-task="">
              {who.task}
            </span>
          </>
        )}
      </span>
      {/* WHERE: the card and the machine, which move to a second line before the task gives up a letter. */}
      <span className="fy-inbox-who__meta">
        {who.card === null ? null : (
          <>
            <span className="fy-inbox-who__card" data-inbox-who-card="">
              {who.card}
            </span>
            {dot}
          </>
        )}
        <span className="fy-inbox-who__machine">{who.machine}</span>
      </span>
      <RouteLink
        className="fy-inbox-who__chat"
        data-inbox-open-chat=""
        onNavigate={onNavigate}
        to={agendaConversationPath(card.daemonId, card.view.config.id, card.item.id)}
      >
        Open chat
        <ChevronRight aria-hidden="true" size={13} />
      </RouteLink>
    </div>
  );
}

/** Where a touch item view swipes on its own: its card's top bar (↓ Not needed) and its answer row (← ↑ → ↓). */
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
}: {
  readonly host: CardHostProps;
  readonly card: InboxCard;
  readonly act: (action: InboxAction) => void;
  readonly skip: () => void;
  readonly place: OpenItemPlace;
}) {
  const entries = useItemConversation(card, readConversation);
  const history = useMemo(() => itemHistory(card.item, entries), [card.item, entries]);
  return (
    <div className="fy-inbox-open" data-inbox-open={card.key} key={card.key}>
      <InboxWhoLine card={card} onNavigate={onNavigate} />
      <AgendaItemView
        busy={false}
        closeLabel="Back to the Inbox"
        daemonId={card.daemonId}
        error={failureFor(inbox.deferredState.failed, card.key)}
        ferret={inboxWho(card).ferret}
        history={history}
        item={card.item}
        onAct={act}
        onClose={place.onClose}
        onNext={skip}
        onSnooze={until => act(snoozeAction(until))}
        position={{ index: place.index, total: place.total }}
        quoteScope={scopeOf(card)}
        renderProse={text => <ChatProse copyable={copyWriter} text={text} />}
        // The SAME row as the chat: on touch its buttons say their arrows and its head and row swipe (↓ going to
        // "next", the skip); the deck takes a drag that starts on the who-and-what line, and the keys go to the view.
        swipeable={place.swipeable}
        {...(now === undefined ? {} : { now })}
        {...(place.onPrevious === undefined ? {} : { onPrevious: place.onPrevious })}
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
      {(['open', 'snoozed', 'replied', 'resolved'] as const).map(entry => (
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
  /** A phone gets "Answer quickly" (the swipe deck); a wider screen walks the rows with j/k. */
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
  /** Starts the "With ferrets" section open (a harness). */
  readonly withFerretsOpen?: boolean;
  /**
   * The open item's ferret's REAL composer, bound to that conversation: what is typed goes to its chat about the
   * item. The host draws it (it holds the clients); absent, the open item has no composer.
   */
  readonly renderComposer?: (card: InboxCard) => ReactNode;
  /** How "Clear all from agent ferrets" reaches the machines. Absent: the Agents filter has no such button. */
  readonly clearPort?: ClearPort;
}

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
}: {
  readonly id: string;
  readonly title: string;
  readonly groups: readonly FerretGroup[];
  readonly env: RowEnv;
  /** Present when the section folds. */
  readonly open?: boolean;
  readonly onToggle?: () => void;
}) {
  const bodyId = useId();
  const count = groups.reduce((total, group) => total + group.items.length + group.notices.length, 0);
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
          {groups.map(group => (
            <GroupView env={env} group={group} key={group.key} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** Whether a key press belongs to something the reader is typing into or operating, not to the list. */
const ownedElsewhere = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.closest('input, textarea, select, [role="menu"], [role="dialog"], [role="listbox"]') !== null;
};

/** The header's Find box. */
function FindBox({ query, onChange }: { readonly query: string; readonly onChange: (next: string) => void }) {
  return (
    <label className="fy-attn-inbox__find">
      <Search aria-hidden="true" size={14} />
      <input
        aria-label="Find in Inbox"
        className="fy-attn-inbox__find-input"
        data-agenda-find=""
        onChange={event => onChange(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Escape' && query !== '') {
            event.preventDefault();
            onChange('');
          }
        }}
        placeholder="Find"
        type="search"
        value={query}
      />
    </label>
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
  from = null,
  onClearFrom,
  withFerretsOpen = false,
  renderComposer,
  clearPort,
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
  const filtered = machineFilter !== null || query !== '' || from !== null || kind !== 'all';
  const snoozed = parkedBy(inbox.parked, 'snoozed');
  const replied = parkedBy(inbox.parked, 'replied');
  const parkedCounts = { snoozed: snoozed.length, replied: replied.length };

  // The deck deals what waits on the owner, in the order the page lists it.
  const deckCards = groupCards([...sections.stopped, ...sections.needsYou]);
  const order = deckCards.map(card => card.key);
  // j/k walk the rows that are showing: the owner's sections, and With ferrets only once it is open.
  const navigable = [...order, ...(withFerretsShown ? groupCards(sections.withFerrets).map(card => card.key) : [])];
  const selectedKey = cursor !== null && navigable.includes(cursor) ? cursor : null;

  // The deck follows the reader's place while it is listed, and the card after it once it leaves.
  const lastOrder = useRef<readonly string[]>(order);
  const deckPlace = nextSelection(lastOrder.current, deckAt, order);
  const orderKey = order.join('\u0001');
  useEffect(() => {
    lastOrder.current = orderKey === '' ? [] : orderKey.split('\u0001');
    if (deckPlace !== deckAt) setDeckAt(deckPlace);
    if (orderKey === '') setDeckOpen(false);
  }, [orderKey, deckPlace, deckAt]);
  const deckSelected = deckCards.find(card => card.key === deckPlace);

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
      if (by === 0 || ownedElsewhere(event.target)) return;
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

  const count = inbox.reading && inbox.cards.length === 0 ? inbox.total : inbox.cards.length;
  const empty = inbox.cards.length === 0 && inbox.withFerret.length === 0;
  const nothingForYou = inbox.cards.length === 0;
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
  const review = (): void => setDeckAt(order[0] ?? null);
  const startDeck = (): void => {
    setDeckAt(order[0] ?? null);
    setDeckOpen(true);
  };
  // An open item is the deck's top card, on a phone and a wide screen alike.
  const cardOpen = deckOpen && filter === 'open' && (deckSelected !== undefined || atEnd);

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
      <h1 className="fy-attn-inbox__title" id={headingId}>
        Inbox
        <AgendaCountBadge count={count} />
      </h1>
      {updating ? (
        <span className="fy-attn-inbox__updating" data-agenda-updating="" role="status">
          <Spinner size={12} />
          <span className="fy-attn-inbox__updating-text">Updating</span>
        </span>
      ) : null}
      <InboxFilterBar counts={parkedCounts} filter={filter} onChange={choose} />
      <div className="fy-attn-inbox__tools">
        {from === 'warden' && onClearFrom !== undefined ? <SourceChip onClear={onClearFrom} /> : null}
        <KindFilterBar kind={kind} onChange={setKind} />
        {machines.length > 1 ? (
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
        ) : null}
        <FindBox onChange={setQuery} query={query} />
        <PageThemeSwitch />
      </div>
    </header>
  );

  const nothingShown = sections.stopped.length + sections.needsYou.length + sections.withFerrets.length === 0;
  const openBody =
    empty && !filtered ? (
      inbox.reading ? (
        <InboxReading />
      ) : (
        <InboxEmpty />
      )
    ) : nothingShown ? (
      <NothingMatches onClear={clearFilters} />
    ) : (
      <div className="fy-inbox-body" data-agenda-lists="">
        {phone && order.length > 0 ? (
          <button className="kt-btn fy-inbox-quick" data-agenda-quick="" onClick={startDeck} type="button">
            <Zap aria-hidden="true" size={15} />
            Answer quickly
            <span className="fy-inbox-quick__count">{order.length}</span>
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

  if (cardOpen) {
    // The phone's quick answers: the card the reader started at on top, the ones AFTER it next in line —
    // never the ones before it, so the queue only moves forward; past the last, the skipped ones are offered.
    const deck = deckSelected === undefined ? [] : deckCards.slice(Math.max(0, deckCards.indexOf(deckSelected)));
    return (
      <main
        aria-labelledby={headingId}
        className="fy-attn-inbox"
        data-agenda-inbox="card"
        data-phone={phone || undefined}
      >
        <header className="fy-attn-inbox__cardbar">
          <button className="fy-attn-inbox__back" data-agenda-back="" onClick={() => setDeckOpen(false)} type="button">
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
        <OrphanedFailures inbox={inbox} />
        {atEnd ? (
          // The end sits where the card did, at its height: the deck's peek gap and hint line are kept.
          <div className="fy-attn-inbox__deck fy-attn-inbox__deck--end">
            <QueueEnd onReview={review} remaining={deckCards.length} />
            <p aria-hidden="true" className="fy-attn-inbox__hint" />
          </div>
        ) : (
          <div className="fy-attn-inbox__deck fy-attn-inbox__deck--open" data-agenda-deck-host="">
            <AgendaSwipeDeck
              cards={deck}
              onAct={(card, action) => answerWithDraft(host, card, action)}
              onSkip={card => setDeckAt(skipSelection(order, card.key))}
              {...(phone ? { ownGesturesIn: VIEW_GESTURES } : {})}
              {...(reducedMotion === undefined ? {} : { reducedMotion })}
              renderCard={(card, act, skipCard) => {
                const index = order.indexOf(card.key);
                const previous = index > 0 ? order[index - 1] : undefined;
                return (
                  <OpenItem
                    act={act}
                    card={card}
                    host={host}
                    key={card.key}
                    place={{
                      index: Math.max(0, index),
                      total: order.length,
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
              {deck[0] === undefined || renderComposer === undefined ? null : (
                // biome-ignore lint/a11y/noStaticElementInteractions: the keydown only routes an unclaimed Esc in the composer back to the Inbox list
                <div
                  className="fy-inbox-composer"
                  data-inbox-composer={deck[0].key}
                  onKeyDown={escapeCloses(() => setDeckOpen(false))}
                >
                  {renderComposer(deck[0])}
                </div>
              )}
            </div>
          </div>
        )}
        <AgendaUndoToast inbox={inbox} {...(clock === undefined ? {} : { clock })} />
      </main>
    );
  }

  return (
    <main aria-labelledby={headingId} className="fy-attn-inbox" data-agenda-inbox={phone ? 'list' : 'panes'}>
      {header}
      {banner}
      <AgentsBulk inbox={inbox} kind={kind} machines={machines} port={clearPort} />
      <OrphanedFailures inbox={inbox} />
      {filter === 'snoozed' || filter === 'replied' ? (
        <InboxParkedList
          filter={filter}
          inbox={inbox}
          now={now}
          onClear={clearFilters}
          onNavigate={onNavigate}
          rows={filterInboxCards(filter === 'snoozed' ? snoozed : replied, listFilter)}
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
