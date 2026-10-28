/**
 * THE ATTENTION INBOX — everything every ferret on every paired machine is waiting on the reader for,
 * newest needing you first.
 *
 * - A WIDER SCREEN gets two panes: the open items on the left (conversation, summary, ferret · machine,
 *   age) and, on the right, the REAL chat of the selected item, with the item pinned above its composer
 *   (the same block the chat page draws). Answering happens there, through the chat.
 * - A PHONE gets the list alone; a row opens that ferret's chat at the item.
 *
 * The page renders off the shell's `AttentionInbox` alone, so it render-tests with a fake one; the chat
 * pane is supplied by the host as `renderChat`.
 */

import { ArrowRight, CheckCheck, X } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { Spinner } from '../../components/spinner.tsx';
import type { AttentionInbox } from '../../hooks/use-attention-inbox.ts';
import {
  actionSentence,
  attentionConversationPath,
  type FailedAttentionAction,
  type InboxAction,
  type InboxCard,
  isTask,
  isWaitingOnFerret,
  swipeMap,
} from '../../lib/attention-inbox.ts';
import type { DaemonId } from '../../lib/daemon-connection.ts';
import { daemonAttentionPath } from '../../lib/pages/routes.ts';
import { AttentionCountBadge } from '../../shell/app-bar.tsx';
import { RouteLink } from '../../shell/route-link.tsx';
import { sessionsBarNames } from '../../shell/sessions-bar-model.ts';
import { attentionAge, attentionReference } from './attention-board.tsx';
import { AttentionCard, type AttentionCardOrigin } from './attention-card.tsx';
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

function InboxReading() {
  return (
    <p className="fy-attn-inbox__reading" data-attention-reading="" role="status">
      <Spinner size={16} />
      Reading what your ferrets asked…
    </p>
  );
}

export interface AttentionInboxPageProps {
  readonly inbox: AttentionInbox;
  readonly onNavigate: (to: string) => void;
  /** A phone gets the list alone; a row opens the chat. */
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

/** One row of the list: where it came from, what it asks, how long ago. */
function RowFace({
  card,
  selected,
  now,
  phone,
  onSelect,
  onNavigate,
}: {
  readonly card: InboxCard;
  readonly selected: boolean;
  readonly now: number | undefined;
  readonly phone: boolean;
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
    </>
  );
  return phone ? (
    <RouteLink className="fy-attn-row" data-attention-row={card.key} onNavigate={onNavigate} to={origin.href}>
      {body}
    </RouteLink>
  ) : (
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

/** A phone's swipeable card: the row (a link into the chat) and its two answers as buttons — Done / Dismiss, or on a to-do Done / Need more info. */
function SwipeRow({
  card,
  now,
  onNavigate,
  act,
}: {
  readonly card: InboxCard;
  readonly now: number | undefined;
  readonly onNavigate: (to: string) => void;
  readonly act: (action: InboxAction) => void;
}) {
  const map = swipeMap(card.item);
  const first = map.right;
  const second = map.left;
  const waiting = isTask(card.item) && isWaitingOnFerret(card.item);
  return (
    <div className="fy-attn-swiperow">
      <RowFace card={card} now={now} onNavigate={onNavigate} onSelect={() => undefined} phone selected={false} />
      {waiting ? (
        <p className="fy-attn-swiperow__waiting m-0 text-meta text-muted" data-attention-waiting="" role="status">
          Waiting on {inboxCardOrigin(card, onNavigate).ferret}
        </p>
      ) : null}
      <div className="fy-attn-swiperow__actions">
        {first === undefined ? null : (
          <button className="kt-btn kt-btn--sm" data-attention-done="" onClick={() => act(first)} type="button">
            {first.label}
          </button>
        )}
        {second === undefined ? null : (
          <button
            className="kt-btn kt-btn--sm"
            {...(second.kind === 'dismiss' ? { 'data-attention-dismiss': '' } : { 'data-attention-needs-info': '' })}
            data-variant="ghost"
            onClick={() => act(second)}
            type="button"
          >
            {second.label}
          </button>
        )}
      </div>
    </div>
  );
}

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
      <OrphanedFailures inbox={inbox} />
      {empty ? (
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
                renderCard={(card, act) => <SwipeRow act={act} card={card} now={now} onNavigate={onNavigate} />}
              />
              <p className="fy-attn-inbox__hint">
                {inbox.cards.length > 1 ? `${inbox.cards.length - 1} more after this one · ` : ''}
                {inbox.cards.some(card => isTask(card.item))
                  ? 'Swipe right for Done, left for Need more info'
                  : 'Swipe right for Done, left to dismiss'}
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
                    phone={false}
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
      {inbox.reading && !empty ? <InboxReading /> : null}
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
