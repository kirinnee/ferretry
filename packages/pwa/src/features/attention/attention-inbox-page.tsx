/**
 * THE ATTENTION PAGE — everything every ferret on every paired machine is waiting on the reader for,
 * newest needing you first.
 *
 * - ONE COMPACT HEADER ROW: the title and count, a quiet "Updating" mark while boards are read, Open /
 *   Resolved, a machine filter (once there is more than one machine) and Find.
 * - A DENSE LIST GROUPED BY CONVERSATION: each group's header says the conversation once ("diene-migrate
 *   · Johnnie · 10") and folds; each row is headed by its ITEM — its title, else the start of its ask —
 *   never by the conversation's name, with the ask on one line and the kind, reference and age under it.
 * - A WIDER SCREEN puts the selected item's CARD beside the list, the whole pane tall: its detail scrolls
 *   inside it, its answer bar stays pinned at the bottom, and a "Last messages from <ferret>" fold shows
 *   what the ferret said last. ↑/↓ (and j/k) move the selection; answering an item selects the next one.
 * - A PHONE gets the same list, and a tapped row opens its card full screen as the swipe deck — the
 *   items after it next in line, so each answer deals the next card.
 *
 * The page renders off the shell's `AttentionInbox` alone, so it render-tests with a fake one; reading a
 * ferret's last messages and ticking a step are the host's (`readRecent`, `onProgress`).
 */

import { attentionCardAnswers, DISCUSS_LABEL } from '@ferretry/protocol';
import { ArrowLeft, ArrowRight, CheckCheck, ChevronRight, MessagesSquare, Search, X } from 'lucide-react';
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Spinner } from '../../components/spinner.tsx';
import type { AttentionInbox } from '../../hooks/use-attention-inbox.ts';
import { canDiscussNow, kindWord } from '../../lib/attention-answers.ts';
import {
  actionSentence,
  attentionConversationPath,
  type FailedAttentionAction,
  type InboxAction,
  type InboxCard,
  type InboxResolved,
  isInDiscussion,
  RESOLVED_READ_LIMIT,
  waitingSentence,
} from '../../lib/attention-inbox.ts';
import {
  filterInboxCards,
  filterInboxResolved,
  type InboxGroup,
  type InboxListFilter,
  inboxGroups,
  inboxMachines,
  inboxRowAsk,
  inboxRowTitle,
  nextSelection,
  stepSelection,
} from '../../lib/attention-inbox-list.ts';
import type { DaemonId } from '../../lib/daemon-connection.ts';
import { daemonAttentionPath } from '../../lib/pages/routes.ts';
import type { RecentMessage } from '../../lib/recent-messages.ts';
import { AttentionCountBadge } from '../../shell/app-bar.tsx';
import { RouteLink } from '../../shell/route-link.tsx';
import { sessionsBarNames } from '../../shell/sessions-bar-model.ts';
import { attentionAge, attentionKindMeta, attentionReference } from './attention-board.tsx';
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
) => {
  const origin = inboxCardOrigin(card, onNavigate);
  return (
    <AttentionCard
      error={failureFor(inbox.deferredState.failed, card.key)}
      item={card.item}
      key={card.key}
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

/** Find or the machine filter left nothing: say so, and offer the way back. */
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
  /** A phone gets the list, then a tapped item's card full screen; a wider screen gets list and card side by side. */
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
  /** Starts the selected card's "Last messages" fold open (a harness). */
  readonly recentOpen?: boolean;
  /** On a phone, the item whose card starts open (a harness); the list otherwise. */
  readonly initialOpen?: string;
}

/** One row of the list: the item's title and age, its ask on one line, and its kind and reference. */
function Row({
  card,
  selected,
  now,
  onSelect,
  rowRef,
}: {
  readonly card: InboxCard;
  readonly selected: boolean;
  readonly now: number | undefined;
  readonly onSelect: (key: string) => void;
  readonly rowRef: (element: HTMLButtonElement | null) => void;
}) {
  const kind = attentionKindMeta(card.item);
  const KindIcon = kind.icon;
  const ask = inboxRowAsk(card.item);
  return (
    <button
      aria-current={selected || undefined}
      className="fy-attn-row kt-attn"
      data-attention-row={card.key}
      data-kind={kind.tone}
      data-selected={selected || undefined}
      onClick={() => onSelect(card.key)}
      ref={rowRef}
      type="button"
    >
      <span className="fy-attn-row__top">
        <span className="fy-attn-row__title" data-attention-row-title="">
          {inboxRowTitle(card.item)}
        </span>
        <span className="fy-attn-row__age">{shortAge(card.item.waitingSince, now)}</span>
      </span>
      {ask === null ? null : <span className="fy-attn-row__summary">{ask}</span>}
      <span className="fy-attn-row__meta">
        <KindIcon aria-hidden="true" className="fy-attn-row__kind" size={11} />
        <span>{kindWord(card.item)}</span>
        <span aria-hidden="true">·</span>
        <span>{attentionReference(card.item.id)}</span>
        {isInDiscussion(card.item) ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="fy-attn-row__state" data-attention-row-discussion="">
              <MessagesSquare aria-hidden="true" size={11} />
              {waitingSentence(card.item)}
            </span>
          </>
        ) : null}
      </span>
    </button>
  );
}

/** The list: one collapsible header per conversation, its items under it. */
function GroupedList({
  groups,
  selectedKey,
  collapsed,
  onToggle,
  onSelect,
  now,
  showMachine,
  rowRefs,
}: {
  readonly groups: readonly InboxGroup[];
  readonly selectedKey: string | null;
  readonly collapsed: ReadonlySet<string>;
  readonly onToggle: (key: string) => void;
  readonly onSelect: (key: string) => void;
  readonly now: number | undefined;
  readonly showMachine: boolean;
  readonly rowRefs: Map<string, HTMLButtonElement>;
}) {
  return (
    <ul aria-label="Waiting on you" className="fy-attn-inbox__list" data-attention-list="">
      {groups.map(group => {
        const open = !collapsed.has(group.key);
        const rowsId = `attention-group-${encodeURIComponent(group.key)}`;
        return (
          <li className="fy-attn-group" data-attention-group={group.key} key={group.key}>
            <button
              aria-controls={rowsId}
              aria-expanded={open}
              className="fy-attn-group__head"
              data-attention-group-toggle=""
              onClick={() => onToggle(group.key)}
              type="button"
            >
              <ChevronRight
                aria-hidden="true"
                className="fy-attn-group__chevron"
                data-open={open || undefined}
                size={14}
              />
              <span className="fy-attn-group__name">
                <span className="fy-attn-group__title">{group.title}</span>
                {group.ferret === null ? null : <span className="fy-attn-group__ferret"> · {group.ferret}</span>}
                {showMachine ? <span className="fy-attn-group__machine"> · {group.machineName}</span> : null}
              </span>
              <span className="fy-attn-group__count" data-attention-group-count="">
                {group.cards.length}
              </span>
            </button>
            {open ? (
              <ul className="fy-attn-group__rows" id={rowsId}>
                {group.cards.map(card => (
                  <li key={card.key}>
                    <Row
                      card={card}
                      now={now}
                      onSelect={onSelect}
                      rowRef={element => {
                        if (element === null) rowRefs.delete(card.key);
                        else rowRefs.set(card.key, element);
                      }}
                      selected={selectedKey === card.key}
                    />
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
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
  if (target.closest('input, textarea, select, [role="menu"], [role="dialog"], [role="listbox"]') !== null) return true;
  return target.closest('[data-attention-pane]') !== null;
};

/** The header's Find box. */
function FindBox({ query, onChange }: { readonly query: string; readonly onChange: (next: string) => void }) {
  return (
    <label className="fy-attn-inbox__find">
      <Search aria-hidden="true" size={14} />
      <input
        aria-label="Find in Attention"
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
}: AttentionInboxPageProps) {
  const headingId = useId();
  const [chosen, setChosen] = useState<string | null>(initialOpen ?? null);
  const [opened, setOpened] = useState<boolean>(initialOpen !== undefined);
  const [filter, setFilter] = useState<InboxFilter>('open');
  const [machine, setMachine] = useState<DaemonId | null>(null);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const rowRefs = useRef(new Map<string, HTMLButtonElement>()).current;
  const focusRow = useRef(false);

  const machines = useMemo(() => inboxMachines(inbox.cards, inbox.resolved), [inbox.cards, inbox.resolved]);
  const machineFilter = machines.some(entry => entry.daemonId === machine) ? machine : null;
  const listFilter: InboxListFilter = { machine: machineFilter, query };
  const visible = filterInboxCards(inbox.cards, listFilter);
  const groups = inboxGroups(visible);
  const order = groups.flatMap(group => group.cards.map(card => card.key));
  const navigable = groups.flatMap(group => (collapsed.has(group.key) ? [] : group.cards.map(card => card.key)));

  // The selection follows the reader's pick while it is listed, and the item after it once it leaves.
  const lastOrder = useRef<readonly string[]>(order);
  const selectedKey = nextSelection(lastOrder.current, chosen, order);
  const orderKey = order.join('\u0001');
  useEffect(() => {
    lastOrder.current = orderKey === '' ? [] : orderKey.split('\u0001');
    if (selectedKey !== chosen) setChosen(selectedKey);
    if (orderKey === '') setOpened(false);
  }, [orderKey, selectedKey, chosen]);
  const selected = visible.find(card => card.key === selectedKey);

  const choose = (next: InboxFilter): void => {
    setFilter(next);
    if (next === 'resolved') inbox.loadResolved();
  };
  const clearFilters = (): void => {
    setQuery('');
    setMachine(null);
  };
  const toggleGroup = (key: string): void =>
    setCollapsed(current => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const select = (key: string): void => {
    setChosen(key);
    if (phone) setOpened(true);
  };

  // ↑/↓ and j/k walk the open rows on a wider screen, unless the reader is typing or inside the card.
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
      setChosen(next);
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
  const empty = inbox.cards.length === 0;
  const updating = filter === 'open' ? inbox.reading && !empty : inbox.resolvedReading && inbox.resolved.length > 0;
  const host: CardHostProps = { inbox, onNavigate, now, readRecent, onProgress, recentOpen };
  const cardOpen = phone && opened && filter === 'open' && selected !== undefined;

  const header = (
    <header className="fy-attn-inbox__head">
      <h1 className="fy-attn-inbox__title" id={headingId}>
        Attention
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

  const openBody = empty ? (
    inbox.reading ? (
      <InboxReading />
    ) : (
      <InboxEmpty />
    )
  ) : visible.length === 0 ? (
    <NothingMatches onClear={clearFilters} />
  ) : (
    <div className="fy-attn-inbox__body">
      <GroupedList
        collapsed={collapsed}
        groups={groups}
        now={now}
        onSelect={select}
        onToggle={toggleGroup}
        rowRefs={rowRefs}
        selectedKey={phone ? null : selectedKey}
        showMachine={machines.length > 1}
      />
      {phone || selected === undefined ? null : (
        <section
          aria-label={`${inboxRowTitle(selected.item)} — selected item`}
          className="fy-attn-inbox__pane"
          data-attention-pane={selected.key}
        >
          {renderInboxCard(host, selected, action => inbox.deferred.schedule(selected, action), false)}
        </section>
      )}
    </div>
  );

  if (cardOpen) {
    // The phone's full-screen card: the chosen item on top, the ones after it next in line.
    const at = Math.max(0, visible.indexOf(selected));
    const deck = [...visible.slice(at), ...visible.slice(0, at)];
    return (
      <main aria-labelledby={headingId} className="fy-attn-inbox" data-attention-inbox="card">
        <header className="fy-attn-inbox__cardbar">
          <button className="fy-attn-inbox__back" data-attention-back="" onClick={() => setOpened(false)} type="button">
            <ArrowLeft aria-hidden="true" size={16} />
            <span id={headingId}>Attention</span>
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
        <div className="fy-attn-inbox__deck" data-attention-deck-host="">
          <AttentionSwipeDeck
            cards={deck}
            onAct={(card, action) => inbox.deferred.schedule(card, action)}
            {...(reducedMotion === undefined ? {} : { reducedMotion })}
            renderCard={(card, act) => renderInboxCard(host, card, act, true)}
          />
          <p className="fy-attn-inbox__hint">
            {deck.length > 1 ? `${deck.length - 1} more after this one · ` : ''}
            {swipeHintFor(deck[0])}
          </p>
        </div>
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
