/**
 * THE AGENDA'S PARTS IN A FERRET'S CHAT, all siblings of the composer so its own box never moves:
 *
 * - the ONE ROW above it: what is running ("Pondering… 11s") on its left, and on its right what is on its way
 *   ("Sending…") and the agenda PILL — "● Agenda · 5 need you · 2 with Johnnie ▴", "Agenda · 7" when the row is
 *   narrow. The row never wraps, and has no left half when nothing is running;
 * - the DRAWER the pill opens: a raised sheet above the chat, over a scrim, with its own header and scroll, one
 *   row (one button) per item;
 * - the removable "re: <title> ✕" CHIPS of the items the next message is about;
 * - the DOCKED PANEL a wide screen can keep beside the chat instead of the drawer.
 */

import type { AttentionId, AttentionItem } from '@ferretry/protocol';
import { ChevronUp, LoaderCircle, X } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { type AgendaCounts, agendaSegments } from '../../lib/agenda-chat.ts';
import { AttentionAgendaRow } from './attention-agenda-row.tsx';
import { attentionHeading } from './attention-delivery.tsx';

interface AgendaSending {
  readonly count: number;
  /** What is on its way, for the tooltip. */
  readonly headings: readonly string[];
}

export interface AttentionAgendaLineProps {
  readonly ferret: string;
  /** Absent: the agenda is off or empty, and the line says only what is sending. */
  readonly counts?: AgendaCounts;
  readonly open: boolean;
  /** The drawer's DOM id, for `aria-controls`. */
  readonly controls: string;
  /** Docked: the agenda is beside the chat, so the line is a plain summary. */
  readonly docked: boolean;
  readonly onToggle: () => void;
  readonly sending: AgendaSending;
  /** Drawn on the right instead of "Sending…" while the machine holds answers ("Sending in 8 s… Send now"). */
  readonly repliesSlot?: ReactNode;
  /** What is running, drawn on the row's left ("Pondering… 11s"). Absent: nothing runs and the pill stands alone. */
  readonly live?: ReactNode;
}

export function AttentionAgendaLine({
  ferret,
  counts,
  open,
  controls,
  docked,
  onToggle,
  sending,
  repliesSlot,
  live,
}: AttentionAgendaLineProps) {
  const hasStatus = repliesSlot !== undefined || sending.count > 0;
  if (counts === undefined && !hasStatus) return null;
  const segments = counts === undefined ? [] : agendaSegments(counts, ferret);
  const urgent = counts !== undefined && counts.needYou > 0;
  const state = counts === undefined ? 'sending' : hasStatus ? 'both' : 'agenda';
  const summary = (
    <>
      <span aria-hidden="true" className="fy-agenda-line__dot" data-urgent={urgent || undefined} />
      {counts === undefined ? null : (
        <span className="fy-agenda-line__short" data-agenda-line-short="">
          Agenda · {counts.needYou + counts.withFerret}
        </span>
      )}
      <span className="fy-agenda-line__words">
        <strong className="fy-agenda-line__name">Agenda</strong>
        {segments.map(segment => (
          <span className="fy-agenda-line__segment" key={segment.words}>
            {segment.count === null ? null : (
              <>
                <strong className="fy-agenda-line__n">{segment.count}</strong>{' '}
              </>
            )}
            {segment.words}
          </span>
        ))}
      </span>
    </>
  );
  return (
    <div
      className="fy-agenda-line"
      data-composer-status={state}
      data-shared={live ? '' : undefined}
      {...(counts === undefined ? {} : { 'data-agenda-line': '' })}
    >
      <AgendaLineLive live={live} />
      <AgendaLineStatus repliesSlot={repliesSlot} sending={sending} />
      {counts === undefined ? null : docked ? (
        <p className="fy-agenda-line__main" data-agenda-line-summary="">
          {summary}
        </p>
      ) : (
        <button
          aria-controls={controls}
          aria-expanded={open}
          className="fy-agenda-line__main"
          data-agenda-line-toggle=""
          onClick={onToggle}
          type="button"
        >
          {summary}
          <ChevronUp aria-hidden="true" className="fy-agenda-line__chevron" data-open={open || undefined} size={14} />
        </button>
      )}
    </div>
  );
}

/** What is running, on the row's left; nothing at all (no empty box) when nothing runs. */
function AgendaLineLive({ live }: { readonly live: ReactNode | undefined }) {
  if (!live) return null;
  return (
    <div className="fy-agenda-line__live" data-agenda-live="">
      {live}
    </div>
  );
}

/** The line's right end: the held-replies notice when there is one, else what is on its way, else nothing. */
function AgendaLineStatus({
  repliesSlot,
  sending,
}: {
  readonly repliesSlot: ReactNode | undefined;
  readonly sending: AgendaSending;
}) {
  if (repliesSlot !== undefined) return <div className="fy-agenda-line__status">{repliesSlot}</div>;
  if (sending.count === 0) return null;
  return (
    <span
      className="fy-agenda-line__status fy-agenda-sending"
      data-attention-sending-line=""
      role="status"
      title={sending.headings.length === 0 ? undefined : sending.headings.join(', ')}
    >
      <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" size={14} />
      {sending.count === 1 ? 'Sending…' : `Sending ${sending.count}…`}
    </span>
  );
}

interface AgendaRowsProps {
  readonly items: readonly AttentionItem[];
  readonly ferret: string;
  readonly now?: number;
  readonly onOpen: (item: AttentionItem) => void;
}

function AgendaRows({ items, ferret, now, onOpen }: AgendaRowsProps) {
  return (
    <ul className="fy-agenda-rows">
      {items.map(item => (
        <li className="fy-agenda-rows__item" key={item.id}>
          <AttentionAgendaRow
            ferret={ferret}
            item={item}
            onOpen={() => onOpen(item)}
            {...(now === undefined ? {} : { now })}
          />
        </li>
      ))}
    </ul>
  );
}

export interface AttentionAgendaDrawerProps extends AgendaRowsProps {
  readonly id: string;
  readonly counts: AgendaCounts;
  readonly onClose: () => void;
}

/** Whether a scroller has more below what it shows, so a fade can say so. */
const useMoreBelow = () => {
  const ref = useRef<HTMLDivElement | null>(null);
  const [more, setMore] = useState(false);
  const measure = useCallback(() => {
    const box = ref.current;
    if (box !== null) setMore(box.scrollHeight - box.scrollTop - box.clientHeight > 2);
  }, []);
  useEffect(() => {
    measure();
    const box = ref.current;
    if (box === null || typeof ResizeObserver === 'undefined') return undefined;
    const watch = new ResizeObserver(measure);
    watch.observe(box);
    if (box.firstElementChild !== null) watch.observe(box.firstElementChild);
    return () => watch.disconnect();
  }, [measure]);
  return { ref, more, measure };
};

/** "Agenda · 3 need you", or "Agenda · Nothing needs you" when it is all with the ferret. */
const drawerHeading = (counts: AgendaCounts): string =>
  counts.needYou > 0 ? `${counts.needYou} need you` : 'Nothing needs you';

/**
 * A RAISED SHEET over the chat, opening upward from the pill: the theme's surface, border, radius and shadow, a
 * header ("Agenda · 3 need you" and a close ×) and rows in a scroller of its own, so a long agenda never
 * grows past the screen. It floats above the line and the composer — neither moves.
 */
export function AttentionAgendaDrawer({ id, counts, onClose, ...rows }: AttentionAgendaDrawerProps) {
  const { ref, more, measure } = useMoreBelow();
  return (
    <div className="fy-agenda-layer">
      <section
        aria-label={`${rows.ferret}’s agenda`}
        className="fy-agenda-drawer"
        data-agenda-drawer=""
        id={id}
        onKeyDown={event => {
          if (event.key !== 'Escape') return;
          event.stopPropagation();
          onClose();
        }}
      >
        <header className="fy-agenda-drawer__head">
          <h2 className="fy-agenda-drawer__title">
            Agenda
            <span className="fy-agenda-drawer__count" data-urgent={counts.needYou > 0 || undefined}>
              {drawerHeading(counts)}
            </span>
          </h2>
          <button
            aria-label="Close the agenda"
            className="fy-agenda-drawer__close"
            data-agenda-drawer-close=""
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" size={18} />
          </button>
        </header>
        <div className="fy-agenda-drawer__list" data-more={more || undefined} onScroll={measure} ref={ref}>
          <AgendaRows {...rows} />
        </div>
      </section>
    </div>
  );
}

export interface AttentionAgendaPanelProps extends AgendaRowsProps {
  readonly onClose: () => void;
}

/** The agenda docked beside the chat on a wide screen: the same rows, in a column of their own. */
export function AttentionAgendaPanel({ onClose, ...rows }: AttentionAgendaPanelProps) {
  return (
    <aside aria-label={`${rows.ferret}’s agenda`} className="fy-agenda-panel" data-agenda-panel="">
      <header className="fy-agenda-panel__head">
        <h2 className="fy-agenda-panel__title">Agenda</h2>
        <button
          aria-label="Undock the agenda"
          className="fy-agenda-panel__close"
          data-agenda-panel-close=""
          onClick={onClose}
          type="button"
        >
          <X aria-hidden="true" size={16} />
        </button>
      </header>
      <AgendaPanelBody {...rows} />
    </aside>
  );
}

/** The docked panel's rows, or a plain line when there are none. */
function AgendaPanelBody(rows: AgendaRowsProps) {
  if (rows.items.length === 0) return <p className="fy-agenda-panel__empty">Nothing on the agenda.</p>;
  return <AgendaRows {...rows} />;
}

export interface AttentionReferenceChipsProps {
  readonly items: readonly AttentionItem[];
  readonly onRemove: (id: AttentionId) => void;
}

/** "re: <title> ✕" for each item the next message is about. Nothing drawn when there are none. */
export function AttentionReferenceChips({ items, onRemove }: AttentionReferenceChipsProps) {
  if (items.length === 0) return null;
  return (
    <ul aria-label="This message is about" className="fy-agenda-chips" data-agenda-chips="">
      {items.map(item => (
        <li className="fy-agenda-ref" data-agenda-chip={item.id} key={item.id}>
          <span className="fy-agenda-ref__lead">re:</span>
          <span className="fy-agenda-ref__title">{attentionHeading(item)}</span>
          <button
            aria-label={`Stop replying about ${attentionHeading(item)}`}
            className="fy-agenda-ref__clear"
            data-agenda-chip-clear={item.id}
            onClick={() => onRemove(item.id)}
            type="button"
          >
            <X aria-hidden="true" size={14} />
          </button>
        </li>
      ))}
    </ul>
  );
}
