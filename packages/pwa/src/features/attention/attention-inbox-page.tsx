/**
 * THE ATTENTION INBOX — a first-class place, not a buried page: everything every ferret on every paired
 * machine is waiting on the reader for, newest needing you first, as the ONE card (`AttentionCard`).
 *
 * The same cards, two shapes:
 *
 * - A PHONE gets the swipe deck (`AttentionSwipeDeck`): one card on top, swiped right / left / up for
 *   option 1 / 2 / 3, its buttons doing exactly the same.
 * - A WIDER SCREEN gets them all at once, as a grid, each focusable and answered with ← → ↑ as well as
 *   its buttons — the swipe's keyboard twin, said in each card's sr-only hint.
 *
 * EVERY ANSWER IS UNDOABLE, however it was given (swipe, arrow, option, reply, Done, Dismiss): it goes
 * to `inbox.deferred.schedule`, the card leaves at once, and the undo toast holds it for the window —
 * nothing reaches the machine before the window closes. The machine, not this page, then tells the
 * ferret ("[answer to !A3 «ask»] …"): the inbox never writes its own chat message.
 *
 * AN ANSWER THE MACHINE REFUSED COMES BACK on its card with the reason (`deferredState.failed`), and
 * answering again clears it. One whose card has gone in the meantime (the ferret resolved it, the
 * machine was unpaired) is said once, above the deck, until dismissed.
 *
 * It renders off the shell's `AttentionInbox` alone, so it render-tests with a fake one.
 */

import { ArrowRight, CheckCheck, X } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef } from 'react';
import { Spinner } from '../../components/spinner.tsx';
import type { AttentionInbox } from '../../hooks/use-attention-inbox.ts';
import {
  actionSentence,
  attentionConversationPath,
  type FailedAttentionAction,
  type InboxAction,
  type InboxCard,
} from '../../lib/attention-inbox.ts';
import type { DaemonId } from '../../lib/daemon-connection.ts';
import { daemonAttentionPath } from '../../lib/pages/routes.ts';
import { AttentionCountBadge } from '../../shell/app-bar.tsx';
import { RouteLink } from '../../shell/route-link.tsx';
import { sessionsBarNames } from '../../shell/sessions-bar-model.ts';
import { AttentionCard, type AttentionCardOrigin } from './attention-card.tsx';
import { AttentionCardFrame, AttentionSwipeDeck } from './attention-swipe-deck.tsx';
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
  /** A phone deals the swipe deck; anything wider, the grid. */
  readonly phone: boolean;
  /** The clock card ages read; the browser's otherwise. */
  readonly now?: number;
  /** The clock the undo countdown reads; the browser's otherwise. */
  readonly clock?: () => number;
  /** Forces reduced motion on or off; the reader's preference otherwise. */
  readonly reducedMotion?: boolean;
  /** Above the cards: the shell's "notifications are off for <machine>" banner, which draws nothing when none is. */
  readonly banner?: ReactNode;
}

export function AttentionInboxPage({
  inbox,
  onNavigate,
  phone,
  now,
  clock,
  reducedMotion,
  banner,
}: AttentionInboxPageProps) {
  const headingId = useId();
  const host: CardHostProps = { inbox, onNavigate, now };
  const schedule = (card: InboxCard, action: InboxAction): void => inbox.deferred.schedule(card, action);
  // An answered card leaves the grid; when focus was in the grid, the card now in its place takes it.
  const grid = useRef<HTMLUListElement | null>(null);
  const refocusAt = useRef<number | null>(null);
  const scheduleFromGrid = (card: InboxCard, index: number, action: InboxAction): void => {
    if (grid.current?.contains(document.activeElement) === true) refocusAt.current = index;
    schedule(card, action);
  };
  useEffect(() => {
    const at = refocusAt.current;
    if (at === null || inbox.cards.length === 0) return;
    refocusAt.current = null;
    const frames = grid.current?.querySelectorAll<HTMLElement>('[data-attention-frame]');
    frames?.[Math.min(at, frames.length - 1)]?.focus();
  }, [inbox.cards]);
  const count = inbox.reading && inbox.cards.length === 0 ? inbox.total : inbox.cards.length;
  const empty = inbox.cards.length === 0;
  return (
    <main aria-labelledby={headingId} className="fy-attn-inbox" data-attention-inbox={phone ? 'deck' : 'grid'}>
      <header className="fy-attn-inbox__head">
        <h1 className="fy-attn-inbox__title" id={headingId}>
          Attention
          <AttentionCountBadge count={count} />
        </h1>
        <p className="fy-attn-inbox__sub">
          {waitingWords(count)}
          {empty ? '' : ' · newest first, across every machine'}
        </p>
        {phone || empty ? null : (
          <p className="fy-attn-inbox__keys" aria-hidden="true">
            Focus a card, then <kbd>→</kbd> <kbd>←</kbd> <kbd>↑</kbd> answer it
          </p>
        )}
      </header>
      {banner}
      <OrphanedFailures inbox={inbox} />
      {empty ? (
        inbox.reading ? (
          <InboxReading />
        ) : (
          <InboxEmpty />
        )
      ) : phone ? (
        <>
          <AttentionSwipeDeck
            cards={inbox.cards}
            onAct={schedule}
            renderCard={(card, act) => renderInboxCard(host, card, act, true)}
            {...(reducedMotion === undefined ? {} : { reducedMotion })}
          />
          <p className="fy-attn-inbox__hint">
            {inbox.cards.length > 1 ? `${inbox.cards.length - 1} more after this one · ` : ''}
            Swipe, or use the buttons
          </p>
        </>
      ) : (
        <ul className="fy-attn-inbox__grid" aria-label="Waiting on you" ref={grid}>
          {inbox.cards.map((card, index) => (
            <li key={card.key}>
              <AttentionCardFrame card={card} onAct={action => scheduleFromGrid(card, index, action)}>
                {renderInboxCard(host, card, action => scheduleFromGrid(card, index, action), false)}
              </AttentionCardFrame>
            </li>
          ))}
        </ul>
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
