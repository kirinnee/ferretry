/**
 * THE PINNED ITEM: the item this ferret raised, shown as a visible BLOCK above the conversation's own
 * composer — the same component on a phone and on a desktop, never a strip and never a popover.
 *
 * It holds the summary in full, the options as real buttons (the recommended one marked), a "Details"
 * toggle for context / terms / impact, and Done / Dismiss in a ⋯ menu. There is no reply field: the reply
 * IS the conversation's composer, and the "Send as answer to !A4?" chip says whether the next message is
 * offered as the answer. Several open items sit behind a compact pager, and a tick-down for answers the
 * machine is holding (`repliesSlot`) is shown where the item was.
 *
 * AN OPTION OR A DONE HERE GOES AT ONCE, through the session's one attention client — no undo window.
 * The reader pressed a labelled button on this ferret's own conversation, and the outcome lands in the
 * resolved list a moment later. Each card carries its own busy state and its own refusal.
 *
 * A LINK POINTS AT ONE ITEM. `?attention=A3`, a notification and a proved `!A3` all arrive as a `focus`
 * request: the block shows THAT item and rings it. Nothing opens by itself. An id the board does not hold
 * is said out loud ("!A3 is no longer open") rather than silently replaced by a different decision, and a
 * resolved one is opened in the resolved list (`onOpenResolved`).
 *
 * NOTHING OPEN, NOTHING DRAWN. The panel is the most important thing on the page while something waits on
 * the reader and must take no room while nothing does: no "all clear" line, and no resolved history under
 * every chat — that lives behind the header menu's "N resolved" (`attention-resolved.tsx`).
 */

import type { AttentionId, AttentionItem, AttentionSnapshot } from '@ferretry/protocol';
import { ArrowRight, ChevronLeft, ChevronRight, CircleAlert, LoaderCircle } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { ChatProse } from '../../components/chat-prose.tsx';
import type { DaemonAttentionClient } from '../../lib/attention-client.ts';
import { actionSentence, type InboxAction } from '../../lib/attention-inbox.ts';
import { nextSelection, QUEUE_END } from '../../lib/attention-inbox-list.ts';
import type { AttentionLoadStatus } from '../../lib/attention-store.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';
import { browserClipboardWriter } from '../onboarding/copy-button.tsx';
import { attentionReference } from './attention-board.tsx';
import { AttentionCard } from './attention-card.tsx';
import { useAttentionCollapse } from './attention-collapse.ts';
import { AttentionCollapseButton, AttentionCollapsedLine } from './attention-collapsed-line.tsx';
import { attentionPanelItemId } from './attention-resolved.tsx';

export { attentionPanelItemId };

/** The three answers the panel sends, and nothing else of the client. */
export type AttentionActionClient = Pick<
  DaemonAttentionClient,
  'dismiss' | 'respond' | 'resolve' | 'needsInfo' | 'discuss' | 'progress'
>;

/**
 * A request to show the panel — at one item, or (`target: null`) at its top. `seq` makes a repeated
 * request a new one: pressing the same `!A3` twice scrolls back to it twice.
 */
export interface AttentionPanelFocus {
  readonly target: AttentionId | null;
  readonly seq: number;
}

/** Where an id sits on a board: answerable, on the record, absent, or not known until the board is read. */
export type AttentionLocation = 'open' | 'resolved' | 'unknown' | 'pending';

export const locateAttention = (snapshot: AttentionSnapshot | null, id: AttentionId): AttentionLocation => {
  if (snapshot === null) return 'pending';
  if (snapshot.items.some(item => item.id === id)) return 'open';
  if (snapshot.resolved.some(item => item.id === id)) return 'resolved';
  return 'unknown';
};

/**
 * Every id in this session's Attention LEDGER — open and resolved. This is what proves a `!A3`: an
 * answered item is still on the record, so a reference to it in older chat stays a link and opens the
 * resolved entry instead of decaying into prose the moment it is answered.
 */
export const attentionLedgerIds = (snapshot: AttentionSnapshot | null): readonly AttentionId[] =>
  snapshot === null ? [] : [...snapshot.items.map(item => item.id), ...snapshot.resolved.map(item => item.id)];

/** Sends one answer, as the daemon is asked for it, to this session on this machine. */
export const runPanelAction = async (
  client: AttentionActionClient,
  connection: DaemonConnection,
  scope: DaemonSessionScope,
  id: AttentionId,
  action: InboxAction,
): Promise<void> => {
  if (action.kind === 'respond') await client.respond(connection, scope, id, action.response, action.note);
  else if (action.kind === 'dismiss') await client.dismiss(connection, scope, id, action.note);
  else if (action.kind === 'needs-info') await client.needsInfo(connection, scope, id, action.note);
  else if (action.kind === 'discuss') await client.discuss(connection, scope, id, action.note);
  else await client.resolve(connection, scope, id, action.note);
};

export interface AttentionAnswerChip {
  /** The next composer message is sent as the answer to the shown item. */
  readonly on: boolean;
  readonly onChange: (on: boolean) => void;
}

export interface AttentionPanelProps {
  /** The panel's DOM id — the one the header's count names in `aria-controls`. */
  readonly id: string;
  readonly connection: DaemonConnection;
  readonly scope: DaemonSessionScope;
  readonly client: AttentionActionClient;
  readonly snapshot: AttentionSnapshot | null;
  readonly status: AttentionLoadStatus;
  /** The latest request to be shown at one item; `null` while nothing was asked. */
  readonly focus?: AttentionPanelFocus | null;
  /** The item the block shows, which the chat page also needs to build the answer prefix. */
  readonly selectedId: AttentionId | null;
  readonly onSelect: (id: AttentionId) => void;
  /** A request named a resolved item: open the resolved list at it. The panel itself draws no history. */
  readonly onOpenResolved?: (id: AttentionId) => void;
  readonly chip?: AttentionAnswerChip;
  /** Drawn in the block while the machine holds answers ("Sending in 8 s… / Send now"). */
  readonly repliesSlot?: ReactNode;
  readonly now?: number;
}

const copyWriter = browserClipboardWriter();

const NO_ITEMS: readonly AttentionItem[] = [];

interface CardState {
  readonly busy: boolean;
  readonly error: string | null;
}

const failure = (reason: unknown): string =>
  reason instanceof Error ? reason.message : 'The machine did not accept this answer.';

/**
 * The open item the block shows — and so the item the next message answers: the chosen one, else the first
 * while none is chosen. A chosen item that has left shows nothing until the block moves on to the item
 * after it (or to "You skipped N"), so a message is never offered as the answer to an item the reader did
 * not choose.
 */
export const shownAttentionItem = (
  snapshot: AttentionSnapshot | null,
  selectedId: AttentionId | null,
): AttentionItem | undefined =>
  selectedId === null ? snapshot?.items[0] : snapshot?.items.find(entry => entry.id === selectedId);

export function AttentionPanel({
  id,
  connection,
  scope,
  client,
  snapshot,
  status,
  focus = null,
  selectedId,
  onSelect,
  onOpenResolved,
  chip,
  repliesSlot,
  now,
}: AttentionPanelProps) {
  const renderProse = useCallback((text: string): ReactNode => <ChatProse copyable={copyWriter} text={text} />, []);
  const items = snapshot?.items ?? NO_ITEMS;
  const [cards, setCards] = useState<ReadonlyMap<AttentionId, CardState>>(new Map());
  const [announcement, setAnnouncement] = useState('');
  const target = focus?.target ?? null;
  const location = target === null ? null : locateAttention(snapshot, target);
  const openIds = items.map(entry => entry.id);
  // THE QUEUE ONLY MOVES FORWARD: once the shown item is answered the block shows the one after it, and past
  // the last one it offers the skipped ones — never item 1 again (`nextSelection`).
  const lastIds = useRef<readonly string[]>(openIds);
  const forward = nextSelection(lastIds.current, selectedId, openIds);
  const atEnd = forward === QUEUE_END;
  const selected = atEnd ? undefined : (items.find(entry => entry.id === forward) ?? items[0]);
  const selectedIndex = selected === undefined ? -1 : items.indexOf(selected);
  const openKey = openIds.join('\u0001');
  // The order is remembered only while the selection is SETTLED (none chosen, or the chosen one open): until
  // the page catches up with the move, the departed item must still have a place to move on from.
  const settled = selectedId === null || openIds.includes(selectedId);
  useEffect(() => {
    if (settled) lastIds.current = openKey === '' ? [] : openKey.split('\u0001');
  }, [openKey, settled]);
  // "Later" on the end of the queue: caught up for now, the skipped items left where they are.
  const [later, setLater] = useState(false);
  useEffect(() => {
    if (!atEnd) setLater(false);
  }, [atEnd]);
  const shownId = selected?.id ?? null;
  useEffect(() => {
    if (selectedId !== null && shownId !== null && shownId !== selectedId) onSelect(shownId);
  }, [selectedId, shownId, onSelect]);
  const fold = useAttentionCollapse(scope, openIds, snapshot !== null);
  const folded = fold.collapsed;
  const expandFold = fold.expand;

  const setCard = (itemId: AttentionId, state: CardState | null): void =>
    setCards(current => {
      const next = new Map(current);
      if (state === null) next.delete(itemId);
      else next.set(itemId, state);
      return next;
    });

  const act = (item: AttentionItem, action: InboxAction): void => {
    if (cards.get(item.id)?.busy === true) return;
    setCard(item.id, { busy: true, error: null });
    setAnnouncement('');
    runPanelAction(client, connection, scope, item.id, action).then(
      () => {
        setCard(item.id, null);
        setAnnouncement(actionSentence(action, item.id));
      },
      (reason: unknown) => setCard(item.id, { busy: false, error: failure(reason) }),
    );
  };

  // A REQUEST IS HONOURED ONCE, when it can be: after the board that says where the item is has been
  // read. A resolved item is handed to the page, which opens the resolved list at it.
  const handled = useRef<number | null>(null);
  useEffect(() => {
    if (focus === null || handled.current === focus.seq || focus.target === null) return;
    const where = locateAttention(snapshot, focus.target);
    if (where === 'pending') return;
    if (where === 'open' && folded) return;
    if (where === 'open' && selected?.id !== focus.target) {
      onSelect(focus.target);
      return;
    }
    if (where === 'resolved') {
      handled.current = focus.seq;
      onOpenResolved?.(focus.target);
      return;
    }
    handled.current = focus.seq;
    if (typeof document === 'undefined') return;
    const item = document.getElementById(attentionPanelItemId(id, focus.target));
    item?.scrollIntoView?.({ block: 'nearest' });
    item?.focus({ preventScroll: true });
  }, [focus, snapshot, id, selected?.id, folded, onSelect, onOpenResolved]);

  // A LINK TO AN OPEN ITEM UNFOLDS THE CARD: the reader pressed `!A3`, so the item must be there to show.
  const unfoldedFor = useRef<number | null>(null);
  useEffect(() => {
    if (focus === null || focus.target === null || unfoldedFor.current === focus.seq) return;
    if (locateAttention(snapshot, focus.target) !== 'open') return;
    unfoldedFor.current = focus.seq;
    expandFold();
  }, [focus, snapshot, expandFold]);

  // A folded card is a "not now": the next message is not offered as its answer until it is unfolded.
  const chipChange = chip?.onChange;
  const wasFolded = useRef(false);
  useEffect(() => {
    if (folded === wasFolded.current) return;
    wasFolded.current = folded;
    chipChange?.(!folded);
  }, [folded, chipChange]);

  const loading = snapshot === null && (status === 'idle' || status === 'loading');
  const unavailable = snapshot === null && status === 'error';
  const state = selected === undefined ? undefined : cards.get(selected.id);
  const missing = target !== null && location === 'unknown';
  const quiet = selected === undefined && !atEnd && !loading && !unavailable && !missing;
  // The live region outlives the block: answering the last open item removes the block, and the sentence
  // that says what was sent must still be spoken.
  const live = (
    <p aria-live="polite" className="sr-only" role="status">
      {announcement}
    </p>
  );
  if (quiet) return live;
  return (
    <>
      {live}
      <section
        aria-label="Needs you"
        className="fy-attn-panel"
        data-attention-panel=""
        data-folded={(folded && !loading && !unavailable) || undefined}
        id={id}
      >
        {missing && target !== null ? (
          <p className="fy-attn-panel__note" data-attention-missing={target} role="status">
            <CircleAlert aria-hidden="true" size={14} />
            {attentionReference(target)} is no longer open.
          </p>
        ) : null}
        {snapshot !== null && snapshot.parseErrors > 0 ? (
          <p className="fy-attn-panel__note" data-tone="err" role="alert">
            <CircleAlert aria-hidden="true" size={14} />
            The machine reported {snapshot.parseErrors} damaged Attention records; repair them before trusting this
            list.
          </p>
        ) : null}
        {loading ? (
          <p className="fy-attn-panel__note" role="status">
            <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" size={14} />
            Checking this ferret's Attention…
          </p>
        ) : unavailable ? (
          <p className="fy-attn-panel__note" data-tone="err" role="alert">
            <CircleAlert aria-hidden="true" size={14} />
            Attention cannot be read right now. Reconnect before assuming nothing needs you.
          </p>
        ) : atEnd && later ? (
          <p className="fy-attn-panel__end" data-attention-queue-end="later">
            All caught up for now — skipped cards wait in the inbox.
          </p>
        ) : atEnd ? (
          <div className="fy-attn-panel__end" data-attention-queue-end="">
            <span>You skipped {items.length} — review them now?</span>
            <span className="fy-attn-panel__end-actions">
              <button
                className="kt-btn kt-btn--sm"
                data-attention-review=""
                data-variant="primary"
                onClick={() => {
                  const first = items[0];
                  if (first !== undefined) onSelect(first.id);
                }}
                type="button"
              >
                Review skipped
                <ArrowRight aria-hidden="true" size={13} />
              </button>
              <button
                className="kt-btn kt-btn--sm"
                data-attention-later=""
                onClick={() => setLater(true)}
                type="button"
              >
                Later
              </button>
            </span>
          </div>
        ) : selected === undefined ? null : folded ? (
          <>
            <AttentionCollapsedLine controls={id} item={selected} more={items.length - 1} onExpand={fold.expand} />
            {repliesSlot}
          </>
        ) : (
          <div
            className="fy-attn-panel__item"
            id={attentionPanelItemId(id, selected.id)}
            key={selected.id}
            tabIndex={-1}
          >
            {items.length > 1 ? (
              <nav aria-label="Open items" className="fy-attn-pager">
                <button
                  aria-label="Previous item"
                  className="fy-attn-pager__step"
                  disabled={selectedIndex <= 0}
                  onClick={() => onSelect(items[selectedIndex - 1]?.id ?? selected.id)}
                  type="button"
                >
                  <ChevronLeft aria-hidden="true" size={16} />
                </button>
                <span aria-live="polite" className="fy-attn-pager__where" data-attention-pager="">
                  Needs you · {selectedIndex + 1} of {items.length}
                </span>
                <button
                  aria-label="Next item"
                  className="fy-attn-pager__step"
                  disabled={selectedIndex >= items.length - 1}
                  onClick={() => onSelect(items[selectedIndex + 1]?.id ?? selected.id)}
                  type="button"
                >
                  <ChevronRight aria-hidden="true" size={16} />
                </button>
              </nav>
            ) : null}
            <AttentionCard
              busy={state?.busy ?? false}
              error={state?.error ?? null}
              highlighted={target === selected.id}
              item={selected}
              onAct={action => act(selected, action)}
              onProgress={(step, done) => client.progress(connection, scope, selected.id, step, done)}
              headerSlot={<AttentionCollapseButton controls={id} onCollapse={fold.collapse} />}
              pinned
              renderProse={renderProse}
              {...(now === undefined ? {} : { now })}
            />
            {repliesSlot}
            {chip === undefined ? null : (
              <label className="fy-attn-chip" data-attention-answer-chip="">
                <input checked={chip.on} onChange={event => chip.onChange(event.target.checked)} type="checkbox" />
                Send my next message as the answer to {attentionReference(selected.id)}
              </label>
            )}
          </div>
        )}
      </section>
    </>
  );
}
