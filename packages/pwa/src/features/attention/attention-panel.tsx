/**
 * THE ATTENTION PANEL: the items this ferret raised, over its own conversation — QUIET by default.
 *
 * Folded it is ONE slim strip under the tabs, at most 48px: "Needs you · <summary>" and a chevron (with
 * a count when several wait). That is the only "needs you" indicator in the conversation. Tapped, it
 * opens the structured card in a bottom SHEET on a phone and a POPOVER under the strip on a desktop;
 * several open items sit behind a compact pager. Esc, the close button and (on a phone) the scrim
 * dismiss it, focus is held inside while it is open and returns to the strip, and nothing animates
 * under `prefers-reduced-motion`. The resolved items stay reachable inside the sheet, folded behind
 * "Resolved (N)" with the record of who cleared each and how.
 *
 * AN ANSWER HERE GOES AT ONCE, through the session's one attention client — no undo window. The inbox
 * holds an answer back because a swipe on a deck is easy to make by accident; here the reader opened
 * this ferret's own sheet and pressed a labelled button, and the outcome lands in front of them in the
 * resolved list a moment later, which is where a mistake is seen and answered. Each card carries its
 * own busy state and its own refusal, so one slow answer never freezes the others.
 *
 * THE PWA NEVER SENDS A CHAT MESSAGE FOR AN ANSWER. The daemon hands the ferret
 * "[answer to !A3 «ask»] …" itself; a second message from here would say it twice.
 *
 * A LINK POINTS AT ONE ITEM. `?attention=A3`, a notification and a proved `!A3` in the transcript all
 * arrive as a `focus` request: the sheet opens AT that item (unfolding the resolved list when the item
 * is there), scrolls it into view and rings it. An id the board does not hold is said out loud
 * ("!A3 is no longer open") rather than silently replaced by a different decision.
 */

import type { AttentionId, AttentionItem, AttentionSnapshot, ResolvedAttentionItem } from '@ferretry/protocol';
import { Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, LoaderCircle, X } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Markdown } from '../../components/markdown.tsx';
import { useReferenceSurface } from '../../components/reference-surface.tsx';
import type { DaemonAttentionClient } from '../../lib/attention-client.ts';
import { actionSentence, badgeText, type InboxAction } from '../../lib/attention-inbox.ts';
import type { AttentionLoadStatus } from '../../lib/attention-store.ts';
import { cn } from '../../lib/class-names.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../../lib/daemon-scope.ts';
import { attentionReference, describeResponse, resolutionBadge } from './attention-board.tsx';
import { AttentionCard } from './attention-card.tsx';

/** The three answers the panel sends, and nothing else of the client. */
export type AttentionActionClient = Pick<DaemonAttentionClient, 'dismiss' | 'respond' | 'resolve'>;

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
  if (action.kind === 'respond') await client.respond(connection, scope, id, action.response);
  else if (action.kind === 'dismiss') await client.dismiss(connection, scope, id, action.note);
  else await client.resolve(connection, scope, id, action.note);
};

export interface AttentionPanelProps {
  /** The panel's DOM id — the one the header's count names in `aria-controls`. */
  readonly id: string;
  readonly connection: DaemonConnection;
  readonly scope: DaemonSessionScope;
  readonly client: AttentionActionClient;
  readonly snapshot: AttentionSnapshot | null;
  readonly status: AttentionLoadStatus;
  readonly expanded: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
  /** The latest request to be shown somewhere in the panel; `null` while nothing was asked. */
  readonly focus?: AttentionPanelFocus | null;
  readonly now?: number;
}

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

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

export function AttentionPanel({
  id,
  connection,
  scope,
  client,
  snapshot,
  status,
  expanded,
  onExpandedChange,
  focus = null,
  now,
}: AttentionPanelProps) {
  const references = useReferenceSurface();
  const renderProse = useCallback((text: string): ReactNode => <Markdown text={text} {...references} />, [references]);
  const items = snapshot?.items ?? NO_ITEMS;
  const resolvedItems = snapshot?.resolved ?? NO_RESOLVED;
  const resolved = useMemo(() => [...resolvedItems].sort(byNewestResolution), [resolvedItems]);
  const [cards, setCards] = useState<ReadonlyMap<AttentionId, CardState>>(new Map());
  const [announcement, setAnnouncement] = useState('');
  const [resolvedOpen, setResolvedOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<AttentionId | null>(null);
  const strip = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const wasExpanded = useRef(expanded);
  const target = focus?.target ?? null;
  const location = target === null ? null : locateAttention(snapshot, target);
  const selected = items.find(entry => entry.id === selectedId) ?? items[0];
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

  // A REQUEST IS HONOURED ONCE, when it can be: after the sheet is open, after the board that says
  // where the item is has been read, after the pager is on that item, and — for a resolved item —
  // after its list has unfolded, because a folded row has no position to scroll to.
  const handled = useRef<number | null>(null);
  useEffect(() => {
    if (!expanded || focus === null || handled.current === focus.seq) return;
    if (focus.target !== null) {
      const where = locateAttention(snapshot, focus.target);
      if (where === 'pending') return;
      if (where === 'open' && selected?.id !== focus.target) {
        setSelectedId(focus.target);
        return;
      }
      if (where === 'resolved' && !resolvedOpen) {
        setResolvedOpen(true);
        return;
      }
    }
    handled.current = focus.seq;
    if (typeof document === 'undefined') return;
    const item = focus.target === null ? null : document.getElementById(attentionPanelItemId(id, focus.target));
    const element = item ?? document.getElementById(id);
    // No `behavior`: the panel's CSS decides, so prefers-reduced-motion jumps instead of gliding.
    element?.scrollIntoView?.({ block: 'nearest' });
    // The reader came for THIS item: a keyboard or a screen reader lands on it too.
    item?.focus({ preventScroll: true });
  }, [expanded, focus, snapshot, resolvedOpen, id, selected?.id]);

  // FOCUS IS HELD while the sheet is open (landing on it when nothing else claimed it) and RETURNS to
  // the strip when it closes.
  useEffect(() => {
    if (expanded) {
      const inside = sheet.current?.contains(document.activeElement) ?? false;
      if (!inside && focus?.target == null) sheet.current?.focus({ preventScroll: true });
    } else if (wasExpanded.current) {
      strip.current?.focus({ preventScroll: true });
    }
    wasExpanded.current = expanded;
  }, [expanded, focus]);

  const onSheetKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      if (event.defaultPrevented) return;
      event.preventDefault();
      onExpandedChange(false);
      return;
    }
    if (event.key !== 'Tab' || sheet.current === null) return;
    const stops = [...sheet.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      stop => stop.offsetParent !== null || stop === document.activeElement,
    );
    const first = stops[0];
    const last = stops.at(-1);
    if (first === undefined || last === undefined) return;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === sheet.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!expanded && items.length === 0) return null;

  const first = items[0];
  const loading = snapshot === null && (status === 'idle' || status === 'loading');
  const unavailable = snapshot === null && status === 'error';
  const sheetId = `${id}-body`;
  const state = selected === undefined ? undefined : cards.get(selected.id);
  const sheetTitle =
    items.length === 0 ? 'Attention' : items.length === 1 ? 'Needs you' : `Needs you (${items.length})`;
  return (
    <section aria-label="Attention" className="fy-attn-panel" data-expanded={expanded || undefined} id={id}>
      <div className="fy-attn-panel__column">
        <button
          aria-controls={sheetId}
          aria-expanded={expanded}
          aria-haspopup="dialog"
          className="fy-attn-panel__strip"
          data-attention-strip={items.length}
          onClick={() => onExpandedChange(!expanded)}
          ref={strip}
          type="button"
        >
          {items.length === 0 ? (
            <span className="fy-attn-panel__lead">Nothing needs you</span>
          ) : (
            <>
              <span className="fy-attn-panel__lead">Needs you</span>
              {first === undefined ? null : (
                <>
                  <span aria-hidden="true" className="fy-attn-panel__dot">
                    ·
                  </span>
                  <span className="fy-attn-panel__ask">{first.subject}</span>
                </>
              )}
              {items.length > 1 ? (
                <span className="fy-attn-panel__count" data-attention-count={items.length}>
                  <span className="sr-only">{items.length} items: </span>
                  {badgeText(items.length)}
                </span>
              ) : null}
            </>
          )}
          <ChevronDown aria-hidden="true" className="fy-attn-panel__chevron" size={16} />
        </button>
        {/* ONE polite region, always mounted, so an outcome is announced rather than raced. */}
        <p aria-live="polite" className="sr-only" role="status">
          {announcement}
        </p>
        {expanded ? (
          <>
            <div aria-hidden="true" className="fy-attn-sheet__scrim" onClick={() => onExpandedChange(false)} />
            <div
              aria-label="Attention"
              aria-modal="true"
              className="fy-attn-sheet"
              data-attention-panel=""
              id={sheetId}
              onKeyDown={onSheetKeyDown}
              ref={sheet}
              role="dialog"
              tabIndex={-1}
            >
              <div className="fy-attn-sheet__grip" aria-hidden="true" />
              <header className="fy-attn-sheet__head">
                <h2 className="fy-attn-sheet__title">{sheetTitle}</h2>
                {items.length > 1 && selected !== undefined ? (
                  <nav aria-label="Open items" className="fy-attn-pager">
                    <button
                      aria-label="Previous item"
                      className="fy-attn-pager__step"
                      disabled={selectedIndex <= 0}
                      onClick={() => setSelectedId(items[selectedIndex - 1]?.id ?? null)}
                      type="button"
                    >
                      <ChevronLeft aria-hidden="true" size={16} />
                    </button>
                    <span aria-live="polite" className="fy-attn-pager__where" data-attention-pager="">
                      {selectedIndex + 1} of {items.length}
                    </span>
                    <button
                      aria-label="Next item"
                      className="fy-attn-pager__step"
                      disabled={selectedIndex >= items.length - 1}
                      onClick={() => setSelectedId(items[selectedIndex + 1]?.id ?? null)}
                      type="button"
                    >
                      <ChevronRight aria-hidden="true" size={16} />
                    </button>
                  </nav>
                ) : null}
                <button
                  aria-label="Close"
                  className="fy-attn-sheet__close"
                  data-attention-close=""
                  onClick={() => onExpandedChange(false)}
                  type="button"
                >
                  <X aria-hidden="true" size={18} />
                </button>
              </header>
              <div className="fy-attn-panel__body">
                {target !== null && location === 'unknown' ? (
                  <p className="fy-attn-panel__note" data-attention-missing={target} role="status">
                    <CircleAlert aria-hidden="true" size={14} />
                    {attentionReference(target)} is no longer open.
                  </p>
                ) : null}
                {snapshot !== null && snapshot.parseErrors > 0 ? (
                  <p className="fy-attn-panel__note" data-tone="err" role="alert">
                    <CircleAlert aria-hidden="true" size={14} />
                    The machine reported {snapshot.parseErrors} damaged Attention records; repair them before trusting
                    this list.
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
                  <ol aria-label="Open Attention" className="fy-attn-panel__list">
                    <li
                      className="fy-attn-panel__item"
                      id={attentionPanelItemId(id, selected.id)}
                      key={selected.id}
                      tabIndex={-1}
                    >
                      <AttentionCard
                        busy={state?.busy ?? false}
                        error={state?.error ?? null}
                        highlighted={target === selected.id}
                        item={selected}
                        onAct={action => act(selected, action)}
                        renderProse={renderProse}
                        {...(now === undefined ? {} : { now })}
                      />
                    </li>
                  </ol>
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
              </div>
            </div>
          </>
        ) : null}
      </div>
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
