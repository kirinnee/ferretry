/**
 * THE INBOX — everything every ferret on every paired machine is waiting on the reader for, grouped by FERRET.
 *
 * - THREE SECTIONS, in the order to look: "Stopped on you" (a ferret idle until you answer), "Needs you"
 *   (items on your turn), then "With ferrets" (items on the ferret's turn — nothing for you to do, so it is
 *   COLLAPSED until asked for). A ferret's group says who it is and where once, then lists its items and,
 *   below them, its plain notifications (a line, a time, Clear). The badge counts items on your turn and the
 *   notifications you have not cleared.
 * - A TAP OPENS THE CHAT AT THE ITEM: every row is a real link to that ferret's conversation with the item's
 *   full card (`?attention=<id>`), so there is no second card pane to keep in step with the chat. A tapped
 *   notification opens the chat and clears itself. There is no right-hand pane and no list rail: the list is
 *   the page, one calm column.
 * - A PHONE ALSO GETS "Answer quickly": the items on your turn as the swipe deck, one answer per card, into
 *   the same undo window. A wide screen walks the rows with j/k (or ↑/↓); Enter opens the one focused.
 * - FILTERS: Open / Resolved, a machine filter (once there is more than one machine), Find, and — from
 *   `/inbox?from=warden` — a "From Warden" chip that keeps only what the Warden raised, with a way to clear it.
 *
 * The page renders off the shell's `AttentionInbox` alone, so it render-tests with a fake one; reading a
 * ferret's last messages and ticking a step are the host's (`readRecent`, `onProgress`).
 */

import { attentionCardAnswers, DISCUSS_LABEL } from '@ferretry/protocol';
import { ArrowLeft, ArrowRight, CheckCheck, ChevronRight, Search, SkipForward, X, Zap } from 'lucide-react';
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Spinner } from '../../components/spinner.tsx';

import type { AttentionInbox } from '../../hooks/use-attention-inbox.ts';
import { agendaAuthor, agendaStatus } from '../../lib/agenda-status.ts';
import { CLEAR_ACTION, canDiscussNow, kindWord } from '../../lib/attention-answers.ts';
import {
  actionSentence,
  attentionConversationPath,
  type FailedAttentionAction,
  type InboxAction,
  type InboxCard,
  type InboxResolved,
  RESOLVED_READ_LIMIT,
} from '../../lib/attention-inbox.ts';
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
  nextSelection,
  QUEUE_END,
  skipSelection,
  stepSelection,
} from '../../lib/attention-inbox-list.ts';
import type { DaemonId } from '../../lib/daemon-connection.ts';
import { daemonAttentionPath, daemonSessionPath } from '../../lib/pages/routes.ts';
import type { RecentMessage } from '../../lib/recent-messages.ts';
import { AttentionCountBadge } from '../../shell/app-bar.tsx';
import { RouteLink } from '../../shell/route-link.tsx';
import { sessionsBarNames } from '../../shell/sessions-bar-model.ts';
import { AgendaStatusPill } from './agenda-status-pill.tsx';
import { attentionAge, attentionReference } from './attention-board.tsx';
import { AttentionCard, type AttentionCardOrigin } from './attention-card.tsx';
import { AttentionRecentMessages } from './attention-recent-messages.tsx';
import { ResolvedRow } from './attention-resolved.tsx';
import { AttentionSwipeDeck } from './attention-swipe-deck.tsx';
import { AttentionUndoToast } from './attention-undo-toast.tsx';

/**
 * Where a card came from: the FERRET that asked (its callsign, else the row's title), what it is working
 * on when that differs, and its machine — linked to the conversation at the item.
 */
export const inboxCardOrigin = (card: InboxCard, onNavigate: (to: string) => void): AttentionCardOrigin => {
  const names = sessionsBarNames(card.view);
  return {
    ferret: names.ferret ?? names.title,
    ...(names.ferret === null ? {} : { task: names.title }),
    machine: card.machineName,
    href: attentionConversationPath(card.daemonId, card.view.config.id, card.item.id),
    onNavigate,
  };
};

/** The refusal a card carries, if its last answer did not land. */
const failureFor = (failed: readonly FailedAttentionAction[], key: string): string | null =>
  failed.find(failure => failure.key === key)?.message ?? null;

/** The words a page head uses for how many are waiting. */
export const waitingWords = (count: number): string => (count === 0 ? 'Nothing waiting' : `${count} waiting on you`);

/** A row's age, short: "7h", "now". */
const shortAge = (waitingSince: string, now: number | undefined): string =>
  attentionAge(waitingSince, now).replace(/^waiting /u, '');

interface CardHostProps {
  readonly inbox: AttentionInbox;
  readonly onNavigate: (to: string) => void;
  readonly now: number | undefined;
  readonly readRecent?: ((card: InboxCard) => Promise<readonly RecentMessage[]>) | undefined;
  readonly onProgress?: ((card: InboxCard, step: number, done: boolean) => Promise<void>) | undefined;
  readonly recentOpen?: boolean | undefined;
}

/** One card, answering into the undo window. */
const renderInboxCard = (
  { inbox, onNavigate, now, readRecent, onProgress, recentOpen }: CardHostProps,
  card: InboxCard,
  act: (action: InboxAction) => void,
  swipeHints: boolean,
  onSkip?: () => void,
) => {
  const origin = inboxCardOrigin(card, onNavigate);
  return (
    <AttentionCard
      error={failureFor(inbox.deferredState.failed, card.key)}
      item={card.item}
      key={card.key}
      {...(onSkip === undefined ? {} : { onSkip })}
      onAct={act}
      origin={origin}
      swipeHints={swipeHints}
      {...(now === undefined ? {} : { now })}
      {...(onProgress === undefined
        ? {}
        : { onProgress: (step: number, done: boolean) => onProgress(card, step, done) })}
      {...(readRecent === undefined
        ? {}
        : {
            detailEnd: (
              <AttentionRecentMessages
                ferret={origin.ferret}
                initiallyOpen={recentOpen ?? false}
                key={card.key}
                read={() => readRecent(card)}
                {...(now === undefined ? {} : { now })}
              />
            ),
          })}
    />
  );
};

/**
 * Past the last item: the ones the reader skipped are still open. Said once, with the way back to them —
 * never a silent jump to the top of the list. "Later" leaves them where they are: the reader is caught up
 * for now, and the skipped cards wait in the inbox.
 */
function QueueEnd({ remaining, onReview }: { readonly remaining: number; readonly onReview: () => void }) {
  const [later, setLater] = useState(false);
  if (later)
    return (
      <div className="fy-attn-end" data-attention-queue-end="later">
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
    <div className="fy-attn-end" data-attention-queue-end="">
      <span aria-hidden="true" className="fy-attn-inbox__empty-mark">
        <SkipForward size={24} />
      </span>
      <h2 className="fy-attn-end__title">You skipped {remaining} — review them now?</h2>
      <div className="fy-attn-end__actions">
        <button className="kt-btn" data-attention-review="" data-variant="primary" onClick={onReview} type="button">
          Review skipped
          <ArrowRight aria-hidden="true" size={14} />
        </button>
        <button className="kt-btn" data-attention-later="" onClick={() => setLater(true)} type="button">
          Later
        </button>
      </div>
    </div>
  );
}

/** Refusals whose card is no longer on the deck: said once, until the reader dismisses them. */
function OrphanedFailures({ inbox }: { readonly inbox: AttentionInbox }) {
  const onDeck = new Set(inbox.cards.map(card => card.key));
  const orphans = inbox.deferredState.failed.filter(failure => !onDeck.has(failure.key));
  if (orphans.length === 0) return null;
  return (
    <ul className="fy-attn-inbox__failures" data-attention-failures="">
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
    <div className="fy-attn-inbox__empty" data-attention-empty="">
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
    <p className="fy-attn-inbox__reading" data-attention-reading="" role="status">
      <Spinner size={16} />
      {words}
    </p>
  );
}

/** Find, the machine filter or the Warden chip left nothing: say so, and offer the way back. */
function NothingMatches({ onClear }: { readonly onClear: () => void }) {
  return (
    <div className="fy-attn-inbox__none" data-attention-no-match="">
      <span>Nothing matches.</span>
      <button className="fy-attn-inbox__clear" onClick={onClear} type="button">
        Show everything
      </button>
    </div>
  );
}

export type InboxFilter = 'open' | 'resolved';

/** Open / Resolved: two toggle buttons, the chosen one pressed. */
function InboxFilterBar({
  filter,
  onChange,
}: {
  readonly filter: InboxFilter;
  readonly onChange: (next: InboxFilter) => void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a pair of toggle buttons, not a form fieldset
    <div aria-label="Show" className="fy-attn-inbox__filter" data-attention-filter="" role="group">
      {(['open', 'resolved'] as const).map(entry => (
        <button
          aria-pressed={filter === entry}
          className="fy-attn-inbox__filter-button"
          data-attention-filter-option={entry}
          key={entry}
          onClick={() => onChange(entry)}
          type="button"
        >
          {entry === 'open' ? 'Open' : 'Resolved'}
        </button>
      ))}
    </div>
  );
}

/** "From Warden ✕": the filter `/inbox?from=warden` set, and the one press that lifts it. */
function SourceChip({ onClear }: { readonly onClear: () => void }) {
  return (
    <button
      className="fy-attn-inbox__chip"
      data-attention-from-chip="warden"
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
  readonly inbox: AttentionInbox;
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
      <p className="fy-attn-inbox__none" data-attention-resolved-empty="">
        Nothing resolved in your {RESOLVED_READ_LIMIT} most recent conversations.
      </p>
    );
  return (
    <div className="fy-attn-inbox__resolved" data-attention-resolved-pane="">
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

const resolvedOrigin = (row: InboxResolved, onNavigate: (to: string) => void) => {
  const names = sessionsBarNames(row.view);
  return {
    ferret: names.ferret ?? names.title,
    machine: row.machineName,
    href: attentionConversationPath(row.daemonId, row.view.config.id, row.record.id),
    onNavigate,
  };
};

export interface AttentionInboxPageProps {
  readonly inbox: AttentionInbox;
  readonly onNavigate: (to: string) => void;
  /** A phone gets "Answer quickly" (the swipe deck); a wider screen walks the rows with j/k. */
  readonly phone: boolean;
  /** The clock card ages read; the browser's otherwise. */
  readonly now?: number;
  /** The clock the undo countdown reads; the browser's otherwise. */
  readonly clock?: () => number;
  /** Under the header: the shell's "notifications are off for <machine>" banner, which draws nothing when none is. */
  readonly banner?: ReactNode;
  /** Reads the last few things the card's ferret said. Absent: the card has no "Last messages" fold. */
  readonly readRecent?: (card: InboxCard) => Promise<readonly RecentMessage[]>;
  /** Ticks or unticks a step of a to-do on its machine. Absent: the steps are read-only. */
  readonly onProgress?: (card: InboxCard, step: number, done: boolean) => Promise<void>;
  /** Forces the phone deck's reduced motion on or off; the reader's preference otherwise. */
  readonly reducedMotion?: boolean;
  /** Starts the deck card's "Last messages" fold open (a harness). */
  readonly recentOpen?: boolean;
  /** On a phone, the item whose deck card starts open (a harness); the list otherwise. */
  readonly initialOpen?: string;
  /** Only what this source raised (`/inbox?from=warden`); everything otherwise. */
  readonly from?: InboxSource | null;
  /** Lifts the source filter: the host drops `?from=` from the address. */
  readonly onClearFrom?: () => void;
  /** Starts the "With ferrets" section open (a harness). */
  readonly withFerretsOpen?: boolean;
}

/** Everything a row needs besides the card itself. */
interface RowEnv {
  readonly inbox: AttentionInbox;
  readonly now: number | undefined;
  readonly onNavigate: (to: string) => void;
  readonly selectedKey: string | null;
  readonly rowRef: (key: string) => (element: HTMLAnchorElement | null) => void;
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
  const { now, onNavigate, selectedKey, rowRef } = env;
  const ask = inboxRowAsk(card.item);
  const status = agendaStatus(card.item, group.ferret, now);
  const author = agendaAuthor(card.item, group.ferret);
  return (
    <li>
      <RouteLink
        aria-current={selectedKey === card.key || undefined}
        className="fy-inbox-row"
        data-attention-row={card.key}
        data-dimmed={status?.dimmed || undefined}
        data-selected={selectedKey === card.key || undefined}
        onNavigate={onNavigate}
        ref={rowRef(card.key)}
        to={attentionConversationPath(card.daemonId, card.view.config.id, card.item.id)}
      >
        <span className="fy-inbox-row__top">
          <span className="fy-inbox-row__title" data-attention-row-title="">
            {inboxRowTitle(card.item)}
          </span>
          <span className="fy-inbox-row__age">{shortAge(card.item.waitingSince, now)}</span>
        </span>
        {ask === null ? null : <span className="fy-inbox-row__ask">{ask}</span>}
        <span className="fy-inbox-row__meta">
          {status === null || status.tone === 'needs-you' ? null : <AgendaStatusPill status={status} />}
          <span>{kindWord(card.item)}</span>
          <span aria-hidden="true">·</span>
          <span>{attentionReference(card.item.id)}</span>
          {author === group.ferret ? null : (
            <>
              <span aria-hidden="true">·</span>
              <span data-attention-row-author="">From {author}</span>
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
    <li className="fy-inbox-notice" data-attention-notice={card.key}>
      <RouteLink
        aria-current={selectedKey === card.key || undefined}
        className="fy-inbox-notice__link"
        data-attention-row={card.key}
        data-selected={selectedKey === card.key || undefined}
        onNavigate={to => {
          clear();
          onNavigate(to);
        }}
        ref={rowRef(card.key)}
        to={attentionConversationPath(card.daemonId, card.view.config.id, card.item.id)}
      >
        <span className="fy-inbox-notice__summary">{inboxRowTitle(card.item)}</span>
        <span className="fy-inbox-row__age">{shortAge(card.item.waitingSince, now)}</span>
      </RouteLink>
      <button
        aria-label={`Clear: ${inboxRowTitle(card.item)}`}
        className="fy-inbox-notice__clear"
        data-attention-clear={card.key}
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
    <li className="fy-inbox-group" data-attention-group={group.key}>
      <RouteLink
        className="fy-inbox-group__head"
        data-attention-group-link=""
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
          data-attention-section-toggle={id}
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
    <section className="fy-inbox-section" data-attention-section={id}>
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

const ARROW = { left: '←', up: '↑', right: '→' } as const;

/**
 * What each swipe does on the card on top, in the order the answer bar lays them out — "Swipe ← No · →
 * Yes · ↓ Discuss". Read off that card's own answers, so the hint can never promise a swipe the card does
 * not take; ↓ Discuss closes it wherever a ferret can be talked to, even on a card with no answers.
 */
export const swipeHintFor = (card: InboxCard | undefined): string => {
  if (card === undefined) return '';
  const swipes = [
    ...attentionCardAnswers(card.item).map(answer => `${ARROW[answer.direction]} ${answer.label}`),
    ...(canDiscussNow(card.item) ? [`↓ ${DISCUSS_LABEL}`] : []),
  ];
  const [only] = swipes;
  if (only === undefined) return 'Reply in words, or open the chat';
  return attentionCardAnswers(card.item).length === 0
    ? `Reply in words, or open the chat · ${only}`
    : `Swipe ${swipes.join(' · ')}`;
};

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
        data-attention-find=""
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

export function AttentionInboxPage({
  inbox,
  onNavigate,
  phone,
  now,
  clock,
  banner,
  readRecent,
  onProgress,
  reducedMotion,
  recentOpen,
  initialOpen,
  from = null,
  onClearFrom,
  withFerretsOpen = false,
}: AttentionInboxPageProps) {
  const headingId = useId();
  const [cursor, setCursor] = useState<string | null>(null);
  const [deckAt, setDeckAt] = useState<string | null>(initialOpen ?? null);
  const [deckOpen, setDeckOpen] = useState<boolean>(initialOpen !== undefined);
  const [filter, setFilter] = useState<InboxFilter>('open');
  const [machine, setMachine] = useState<DaemonId | null>(null);
  const [query, setQuery] = useState('');
  const [withFerretsShown, setWithFerretsShown] = useState(withFerretsOpen);
  const rowRefs = useRef(new Map<string, HTMLAnchorElement>()).current;
  const focusRow = useRef(false);

  const machines = useMemo(
    () => inboxMachines([...inbox.cards, ...inbox.withFerret], inbox.resolved),
    [inbox.cards, inbox.withFerret, inbox.resolved],
  );
  const machineFilter = machines.some(entry => entry.daemonId === machine) ? machine : null;
  const listFilter: InboxListFilter = { machine: machineFilter, query, from };
  const visible = filterInboxCards(inbox.cards, listFilter);
  const withFerret = filterInboxCards(inbox.withFerret, listFilter);
  const sections = useMemo(() => inboxSections(visible, withFerret), [visible, withFerret]);
  const filtered = machineFilter !== null || query !== '' || from !== null;

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
    if (next === 'resolved') inbox.loadResolved();
  };
  const clearFilters = (): void => {
    setQuery('');
    setMachine(null);
    if (from !== null) onClearFrom?.();
  };

  // j/k and ↑/↓ walk the rows on a wider screen, unless the reader is typing.
  const keyState = useRef({ navigable, selectedKey });
  keyState.current = { navigable, selectedKey };
  const keysLive = !phone && filter === 'open';
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
  const updating = filter === 'open' ? inbox.reading && !empty : inbox.resolvedReading && inbox.resolved.length > 0;
  const host: CardHostProps = { inbox, onNavigate, now, readRecent, onProgress, recentOpen };
  const atEnd = deckPlace === QUEUE_END;
  const skip = (): void => setDeckAt(skipSelection(order, deckPlace));
  const review = (): void => setDeckAt(order[0] ?? null);
  const startDeck = (): void => {
    setDeckAt(order[0] ?? null);
    setDeckOpen(true);
  };
  const cardOpen = phone && deckOpen && filter === 'open' && (deckSelected !== undefined || atEnd);

  const env: RowEnv = {
    inbox,
    now,
    onNavigate,
    selectedKey,
    rowRef: key => element => {
      if (element === null) rowRefs.delete(key);
      else rowRefs.set(key, element);
    },
  };

  const header = (
    <header className="fy-attn-inbox__head">
      <h1 className="fy-attn-inbox__title" id={headingId}>
        Inbox
        <AttentionCountBadge count={count} />
      </h1>
      {updating ? (
        <span className="fy-attn-inbox__updating" data-attention-updating="" role="status">
          <Spinner size={12} />
          <span className="fy-attn-inbox__updating-text">Updating</span>
        </span>
      ) : null}
      <InboxFilterBar filter={filter} onChange={choose} />
      <div className="fy-attn-inbox__tools">
        {from === 'warden' && onClearFrom !== undefined ? <SourceChip onClear={onClearFrom} /> : null}
        {machines.length > 1 ? (
          <select
            aria-label="Machine"
            className="fy-attn-inbox__machine"
            data-attention-machine=""
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
      <div className="fy-inbox-body" data-attention-lists="">
        {phone && order.length > 0 ? (
          <button className="kt-btn fy-inbox-quick" data-attention-quick="" onClick={startDeck} type="button">
            <Zap aria-hidden="true" size={15} />
            Answer quickly
            <span className="fy-inbox-quick__count">{order.length}</span>
          </button>
        ) : null}
        {nothingForYou && !filtered ? (
          <p className="fy-inbox-calm" data-attention-empty="">
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
        {phone ? null : (
          <p className="fy-attn-inbox__hint" data-attention-keys="">
            j / k to move · Enter to open
          </p>
        )}
      </div>
    );

  if (cardOpen) {
    // The phone's quick answers: the card the reader started at on top, the ones AFTER it next in line —
    // never the ones before it, so the queue only moves forward; past the last, the skipped ones are offered.
    const deck = deckSelected === undefined ? [] : deckCards.slice(Math.max(0, deckCards.indexOf(deckSelected)));
    return (
      <main aria-labelledby={headingId} className="fy-attn-inbox" data-attention-inbox="card">
        <header className="fy-attn-inbox__cardbar">
          <button
            className="fy-attn-inbox__back"
            data-attention-back=""
            onClick={() => setDeckOpen(false)}
            type="button"
          >
            <ArrowLeft aria-hidden="true" size={16} />
            <span id={headingId}>Inbox</span>
            <AttentionCountBadge count={count} />
          </button>
          {updating ? (
            <span className="fy-attn-inbox__updating" data-attention-updating="" role="status">
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
          <div className="fy-attn-inbox__deck" data-attention-deck-host="">
            <AttentionSwipeDeck
              cards={deck}
              onAct={(card, action) => inbox.deferred.schedule(card, action)}
              {...(reducedMotion === undefined ? {} : { reducedMotion })}
              renderCard={(card, act) =>
                renderInboxCard(host, card, act, true, card.key === deckPlace ? skip : undefined)
              }
            />
            <p className="fy-attn-inbox__hint">
              {deck.length > 1 ? `${deck.length - 1} more after this one · ` : ''}
              {swipeHintFor(deck[0])}
            </p>
          </div>
        )}
        <AttentionUndoToast inbox={inbox} {...(clock === undefined ? {} : { clock })} />
      </main>
    );
  }

  return (
    <main aria-labelledby={headingId} className="fy-attn-inbox" data-attention-inbox={phone ? 'list' : 'panes'}>
      {header}
      {banner}
      <OrphanedFailures inbox={inbox} />
      {filter === 'resolved' ? (
        <InboxResolvedList
          inbox={inbox}
          onClear={clearFilters}
          onNavigate={onNavigate}
          rows={filterInboxResolved(inbox.resolved, listFilter)}
        />
      ) : (
        openBody
      )}
      <AttentionUndoToast inbox={inbox} {...(clock === undefined ? {} : { clock })} />
    </main>
  );
}

/** How many cards the Sessions page's Needs-you deck shows. */
const NEEDS_YOU_CARDS = 3;

export interface AttentionNeedsYouProps {
  readonly inbox: AttentionInbox;
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
export function AttentionNeedsYou({ inbox, daemonId, onNavigate, now, clock }: AttentionNeedsYouProps) {
  const headingId = useId();
  const toast = <AttentionUndoToast inbox={inbox} {...(clock === undefined ? {} : { clock })} />;
  if (inbox.cards.length === 0) return toast;
  const host: CardHostProps = { inbox, onNavigate, now };
  const shown = inbox.cards.slice(0, NEEDS_YOU_CARDS);
  return (
    <section aria-labelledby={headingId} className="fy-attn-needs" data-attention-needs-you="">
      <header className="fy-attn-needs__head">
        <h2 className="fy-attn-needs__title" id={headingId}>
          Needs you
          <AttentionCountBadge count={inbox.cards.length} />
        </h2>
        <RouteLink
          className="fy-attn-needs__all"
          data-attention-see-all=""
          onNavigate={onNavigate}
          to={daemonAttentionPath(daemonId)}
        >
          See all {inbox.cards.length}
          <ArrowRight aria-hidden="true" size={13} />
        </RouteLink>
      </header>
      <ul className="fy-attn-needs__cards" data-count={shown.length}>
        {shown.map(card => (
          <li key={card.key}>{renderInboxCard(host, card, action => inbox.deferred.schedule(card, action), false)}</li>
        ))}
      </ul>
      {toast}
    </section>
  );
}
