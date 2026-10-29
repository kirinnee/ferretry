/**
 * THE ATTENTION INBOX — everything every ferret on every paired machine is waiting on the reader for,
 * newest needing you first.
 *
 * - A WIDER SCREEN gets two panes: the open items on the left (conversation, summary, ferret · machine,
 *   age) and, on the right, the REAL chat of the selected item, with the item pinned above its composer
 *   (the same block the chat page draws). Answering happens there, through the chat.
 * - A PHONE gets the swipe deck: the newest card on top, drawn whole — every detail, its answers left · up ·
 *   right and the reply — so it can be answered without opening anything else.
 *
 * A small OPEN / RESOLVED filter sits under the heading. Resolved history lives only here and behind a
 * chat's header menu — never as a line under every conversation.
 *
 * The page renders off the shell's `AttentionInbox` alone, so it render-tests with a fake one; the chat
 * pane is supplied by the host as `renderChat`.
 */

import { attentionCardAnswers, DISCUSS_LABEL } from '@ferretry/protocol';
import { ArrowRight, CheckCheck, MessagesSquare, X } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { Spinner } from '../../components/spinner.tsx';
import type { AttentionInbox } from '../../hooks/use-attention-inbox.ts';
import { canDiscussNow } from '../../lib/attention-answers.ts';
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
import type { DaemonId } from '../../lib/daemon-connection.ts';
import { daemonAttentionPath } from '../../lib/pages/routes.ts';
import { AttentionCountBadge } from '../../shell/app-bar.tsx';
import { RouteLink } from '../../shell/route-link.tsx';
import { sessionsBarNames } from '../../shell/sessions-bar-model.ts';
import { attentionAge, attentionReference } from './attention-board.tsx';
import { AttentionCard, type AttentionCardOrigin } from './attention-card.tsx';
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

interface CardHostProps {
  readonly inbox: AttentionInbox;
  readonly onNavigate: (to: string) => void;
  readonly now: number | undefined;
}

/** One card, answering into the undo window. */
const renderInboxCard = (
  { inbox, onNavigate, now }: CardHostProps,
  card: InboxCard,
  act: (action: InboxAction) => void,
  swipeHints: boolean,
) => (
  <AttentionCard
    error={failureFor(inbox.deferredState.failed, card.key)}
    item={card.item}
    onAct={act}
    origin={inboxCardOrigin(card, onNavigate)}
    swipeHints={swipeHints}
    {...(now === undefined ? {} : { now })}
  />
);

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
  onNavigate,
}: {
  readonly inbox: AttentionInbox;
  readonly onNavigate: (to: string) => void;
}) {
  const rows = inbox.resolved;
  if (rows.length === 0)
    return inbox.resolvedReading ? (
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
  /** A phone gets the swipe deck, its top card drawn whole; a wider screen gets the list and the chat. */
  readonly phone: boolean;
  /** The clock card ages read; the browser's otherwise. */
  readonly now?: number;
  /** The clock the undo countdown reads; the browser's otherwise. */
  readonly clock?: () => number;
  /** Above the list: the shell's "notifications are off for <machine>" banner, which draws nothing when none is. */
  readonly banner?: ReactNode;
  /** The right pane: the selected item's real chat, pinned item and all. */
  readonly renderChat?: (card: InboxCard) => ReactNode;
  /** Forces the phone deck's reduced motion on or off; the reader's preference otherwise. */
  readonly reducedMotion?: boolean;
}

/** One row of the wide screen's list: where it came from, what it asks, how long ago. */
function RowFace({
  card,
  selected,
  now,
  onSelect,
  onNavigate,
}: {
  readonly card: InboxCard;
  readonly selected: boolean;
  readonly now: number | undefined;
  readonly onSelect: (key: string) => void;
  readonly onNavigate: (to: string) => void;
}) {
  const origin = inboxCardOrigin(card, onNavigate);
  const title = origin.task ?? origin.ferret;
  const body = (
    <>
      <span className="fy-attn-row__title">{title}</span>
      <span className="fy-attn-row__summary">{card.item.subject}</span>
      <span className="fy-attn-row__meta">
        {origin.task === undefined ? origin.machine : `${origin.ferret} · ${origin.machine}`} ·{' '}
        {attentionReference(card.item.id)} · {attentionAge(card.item.waitingSince, now)}
      </span>
      {isInDiscussion(card.item) ? (
        <span className="fy-attn-row__state" data-attention-row-discussion="">
          <MessagesSquare aria-hidden="true" size={11} />
          {waitingSentence(card.item)}
        </span>
      ) : null}
    </>
  );
  return (
    <button
      aria-current={selected || undefined}
      className="fy-attn-row"
      data-attention-row={card.key}
      data-selected={selected || undefined}
      onClick={() => onSelect(card.key)}
      type="button"
    >
      {body}
    </button>
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

export function AttentionInboxPage({
  inbox,
  onNavigate,
  phone,
  now,
  clock,
  banner,
  renderChat,
  reducedMotion,
}: AttentionInboxPageProps) {
  const headingId = useId();
  const [chosen, setChosen] = useState<string | null>(null);
  const [filter, setFilter] = useState<InboxFilter>('open');
  const choose = (next: InboxFilter): void => {
    setFilter(next);
    if (next === 'resolved') inbox.loadResolved();
  };
  const count = inbox.reading && inbox.cards.length === 0 ? inbox.total : inbox.cards.length;
  const empty = inbox.cards.length === 0;
  const selected = inbox.cards.find(card => card.key === chosen) ?? inbox.cards[0];
  return (
    <main aria-labelledby={headingId} className="fy-attn-inbox" data-attention-inbox={phone ? 'list' : 'panes'}>
      <header className="fy-attn-inbox__head">
        <h1 className="fy-attn-inbox__title" id={headingId}>
          Attention
          <AttentionCountBadge count={count} />
        </h1>
        <p className="fy-attn-inbox__sub">
          {waitingWords(count)}
          {empty ? '' : ' · newest first, across every machine'}
        </p>
      </header>
      {banner}
      <InboxFilterBar filter={filter} onChange={choose} />
      <OrphanedFailures inbox={inbox} />
      {filter === 'resolved' ? (
        <InboxResolvedList inbox={inbox} onNavigate={onNavigate} />
      ) : empty ? (
        inbox.reading ? (
          <InboxReading />
        ) : (
          <InboxEmpty />
        )
      ) : (
        <div className="fy-attn-inbox__body">
          {phone ? (
            <div className="fy-attn-inbox__deck" data-attention-deck-host="">
              <AttentionSwipeDeck
                cards={inbox.cards}
                onAct={(card, action) => inbox.deferred.schedule(card, action)}
                {...(reducedMotion === undefined ? {} : { reducedMotion })}
                renderCard={(card, act) => renderInboxCard({ inbox, onNavigate, now }, card, act, true)}
              />
              <p className="fy-attn-inbox__hint">
                {inbox.cards.length > 1 ? `${inbox.cards.length - 1} more after this one · ` : ''}
                {swipeHintFor(inbox.cards[0])}
              </p>
            </div>
          ) : (
            <ul aria-label="Waiting on you" className="fy-attn-inbox__list">
              {inbox.cards.map(card => (
                <li key={card.key}>
                  <RowFace
                    card={card}
                    now={now}
                    onNavigate={onNavigate}
                    onSelect={setChosen}
                    selected={selected?.key === card.key}
                  />
                </li>
              ))}
            </ul>
          )}
          {phone || selected === undefined || renderChat === undefined ? null : (
            <section aria-label="Conversation" className="fy-attn-inbox__chat" data-attention-chat={selected.key}>
              {renderChat(selected)}
            </section>
          )}
        </div>
      )}
      {inbox.reading && !empty && filter === 'open' ? <InboxReading /> : null}
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
