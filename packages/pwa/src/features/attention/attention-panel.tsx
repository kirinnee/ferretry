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
 * resolved one is reachable behind "Resolved (N)".
 */

import type { AttentionId, AttentionItem, AttentionSnapshot, ResolvedAttentionItem } from '@ferretry/protocol';
import { Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, LoaderCircle } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChatProse } from '../../components/chat-prose.tsx';
import type { DaemonAttentionClient } from '../../lib/attention-client.ts';
import { actionSentence, type InboxAction } from '../../lib/attention-inbox.ts';
import type { AttentionLoadStatus } from '../../lib/attention-store.ts';
import { cn } from '../../lib/class-names.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';
import { browserClipboardWriter } from '../onboarding/copy-button.tsx';
import { attentionReference, describeResponse, resolutionBadge } from './attention-board.tsx';
import { AttentionCard } from './attention-card.tsx';

/** The three answers the panel sends, and nothing else of the client. */
export type AttentionActionClient = Pick<
  DaemonAttentionClient,
  'dismiss' | 'respond' | 'resolve' | 'needsInfo' | 'progress'
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
  readonly chip?: AttentionAnswerChip;
  /** Drawn in the block while the machine holds answers ("Sending in 8 s… / Send now"). */
  readonly repliesSlot?: ReactNode;
  readonly now?: number;
}

const copyWriter = browserClipboardWriter();

const NO_ITEMS: readonly AttentionItem[] = [];
const NO_RESOLVED: readonly ResolvedAttentionItem[] = [];

interface CardState {
  readonly busy: boolean;
  readonly error: string | null;
}

const failure = (reason: unknown): string =>
  reason instanceof Error ? reason.message : 'The machine did not accept this answer.';

/** The DOM id one item is drawn under, so a link can scroll to it. */
export const attentionPanelItemId = (panelId: string, id: AttentionId): string => `${panelId}-item-${id}`;

/** Newest resolution first: the one just made is the one the reader is looking for. */
const byNewestResolution = (left: ResolvedAttentionItem, right: ResolvedAttentionItem): number =>
  Date.parse(right.resolvedAt) - Date.parse(left.resolvedAt);

/** The open item the block shows: the chosen one while it is open, else the first. */
export const shownAttentionItem = (
  snapshot: AttentionSnapshot | null,
  selectedId: AttentionId | null,
): AttentionItem | undefined => snapshot?.items.find(entry => entry.id === selectedId) ?? snapshot?.items[0];

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
  chip,
  repliesSlot,
  now,
}: AttentionPanelProps) {
  const renderProse = useCallback((text: string): ReactNode => <ChatProse copyable={copyWriter} text={text} />, []);
  const items = snapshot?.items ?? NO_ITEMS;
  const resolvedItems = snapshot?.resolved ?? NO_RESOLVED;
  const resolved = useMemo(() => [...resolvedItems].sort(byNewestResolution), [resolvedItems]);
  const [cards, setCards] = useState<ReadonlyMap<AttentionId, CardState>>(new Map());
  const [announcement, setAnnouncement] = useState('');
  const [resolvedOpen, setResolvedOpen] = useState(false);
  const target = focus?.target ?? null;
  const location = target === null ? null : locateAttention(snapshot, target);
  const selected = shownAttentionItem(snapshot, selectedId);
  const selectedIndex = selected === undefined ? -1 : items.indexOf(selected);

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
  // read, and — for a resolved item — after its list has unfolded.
  const handled = useRef<number | null>(null);
  useEffect(() => {
    if (focus === null || handled.current === focus.seq || focus.target === null) return;
    const where = locateAttention(snapshot, focus.target);
    if (where === 'pending') return;
    if (where === 'open' && selected?.id !== focus.target) {
      onSelect(focus.target);
      return;
    }
    if (where === 'resolved' && !resolvedOpen) {
      setResolvedOpen(true);
      return;
    }
    handled.current = focus.seq;
    if (typeof document === 'undefined') return;
    const item = document.getElementById(attentionPanelItemId(id, focus.target));
    item?.scrollIntoView?.({ block: 'nearest' });
    item?.focus({ preventScroll: true });
  }, [focus, snapshot, resolvedOpen, id, selected?.id, onSelect]);

  const loading = snapshot === null && (status === 'idle' || status === 'loading');
  const unavailable = snapshot === null && status === 'error';
  const state = selected === undefined ? undefined : cards.get(selected.id);
  const quiet = selected === undefined && resolved.length === 0 && !loading && !unavailable && target === null;
  if (quiet) return null;
  return (
    <section aria-label="Needs you" className="fy-attn-panel" data-attention-panel="" id={id}>
      <p aria-live="polite" className="sr-only" role="status">
        {announcement}
      </p>
      {target !== null && location === 'unknown' ? (
        <p className="fy-attn-panel__note" data-attention-missing={target} role="status">
          <CircleAlert aria-hidden="true" size={14} />
          {attentionReference(target)} is no longer open.
        </p>
      ) : null}
      {snapshot !== null && snapshot.parseErrors > 0 ? (
        <p className="fy-attn-panel__note" data-tone="err" role="alert">
          <CircleAlert aria-hidden="true" size={14} />
          The machine reported {snapshot.parseErrors} damaged Attention records; repair them before trusting this list.
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
      ) : selected === undefined ? (
        <p className="fy-attn-panel__note" data-attention-clear="">
          <Check aria-hidden="true" size={14} />
          Nothing needs you right now.
        </p>
      ) : (
        <div className="fy-attn-panel__item" id={attentionPanelItemId(id, selected.id)} key={selected.id} tabIndex={-1}>
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
      {resolved.length === 0 ? null : (
        <div className="fy-attn-panel__resolved">
          <button
            aria-controls={`${id}-resolved`}
            aria-expanded={resolvedOpen}
            className="fy-attn-panel__fold"
            data-attention-resolved={resolved.length}
            onClick={() => setResolvedOpen(open => !open)}
            type="button"
          >
            <ChevronDown aria-hidden="true" className="fy-attn-panel__chevron" size={14} />
            Resolved ({resolved.length})
          </button>
          {resolvedOpen ? (
            <ul className="fy-attn-panel__records" id={`${id}-resolved`}>
              {resolved.map(record => (
                <ResolvedRow
                  highlighted={target === record.id}
                  id={attentionPanelItemId(id, record.id)}
                  key={`${record.id}:${record.resolvedAt}`}
                  record={record}
                />
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </section>
  );
}

/** One resolved item: what it asked, who cleared it and how — the same badge the audit ledger uses. */
function ResolvedRow({
  record,
  id,
  highlighted,
}: {
  readonly record: ResolvedAttentionItem;
  readonly id: string;
  readonly highlighted: boolean;
}) {
  const badge = resolutionBadge(record);
  const BadgeIcon = badge.icon;
  return (
    <li
      className="fy-attn-panel__record"
      data-attention-record={record.id}
      data-highlighted={highlighted || undefined}
      id={id}
      tabIndex={-1}
    >
      <p className="fy-attn-panel__record-subject">{record.subject}</p>
      <p className="fy-attn-panel__record-meta">
        <span
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider',
            badge.className,
          )}
        >
          <BadgeIcon aria-hidden="true" size={11} />
          {badge.label}
        </span>
        <span className="mono">{attentionReference(record.id)}</span>
        {highlighted ? <span className="fy-attn-card__pointer">linked</span> : null}
        <span>{new Date(record.resolvedAt).toLocaleString()}</span>
      </p>
      {record.response ? <p className="fy-attn-panel__record-answer">{describeResponse(record.response)}</p> : null}
      {record.resolutionNote ? <p className="fy-attn-panel__record-note">{record.resolutionNote}</p> : null}
    </li>
  );
}
