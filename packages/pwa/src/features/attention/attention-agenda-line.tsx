/**
 * THE AGENDA'S PARTS IN A FERRET'S CHAT, all siblings of the composer so its own box never moves:
 *
 * - the ONE LINE above it — "● Agenda · 5 need you · 2 with Johnnie ▴" — with what is on its way ("Sending…")
 *   on its right;
 * - the DRAWER the line opens upward, bounded and scrolling on its own, one row per item;
 * - the removable "re: <title> ✕" CHIPS of the items the next message is about;
 * - the DOCKED PANEL a wide screen can keep beside the chat instead of the drawer.
 */

import type { AttentionId, AttentionItem } from '@ferretry/protocol';
import { ChevronUp, LoaderCircle, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { agendaSegments, type AgendaCounts } from '../../lib/agenda-chat.ts';
import type { InboxAction } from '../../lib/attention-answers.ts';
import { AttentionAgendaRow } from './attention-agenda-row.tsx';
import { attentionHeading } from './attention-delivery.tsx';

export interface AgendaSending {
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
}: AttentionAgendaLineProps) {
  const hasStatus = repliesSlot !== undefined || sending.count > 0;
  if (counts === undefined && !hasStatus) return null;
  const segments = counts === undefined ? [] : agendaSegments(counts, ferret);
  const urgent = counts !== undefined && counts.needYou > 0;
  const state = counts === undefined ? 'sending' : hasStatus ? 'both' : 'agenda';
  const summary = (
    <>
      <span aria-hidden="true" className="fy-agenda-line__dot" data-urgent={urgent || undefined} />
      <span className="fy-agenda-line__words">
        <strong className="fy-agenda-line__name">Agenda</strong>
        {segments.map(segment => (
          <span className="fy-agenda-line__segment" key={segment}>
            {segment}
          </span>
        ))}
      </span>
    </>
  );
  return (
    <div
      className="fy-agenda-line"
      data-composer-status={state}
      {...(counts === undefined ? {} : { 'data-agenda-line': '' })}
    >
      {counts === undefined ? (
        <span className="fy-agenda-line__fill" />
      ) : docked ? (
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
      {repliesSlot !== undefined ? (
        <div className="fy-agenda-line__status">{repliesSlot}</div>
      ) : sending.count === 0 ? null : (
        <span
          className="fy-agenda-line__status fy-agenda-sending"
          data-attention-sending-line=""
          role="status"
          title={sending.headings.length === 0 ? undefined : sending.headings.join(', ')}
        >
          <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" size={14} />
          {sending.count === 1 ? 'Sending…' : `Sending ${sending.count}…`}
        </span>
      )}
    </div>
  );
}

export interface AgendaRowsProps {
  readonly items: readonly AttentionItem[];
  readonly ferret: string;
  readonly now?: number;
  readonly busy: ReadonlySet<AttentionId>;
  readonly referenced: readonly AttentionId[];
  readonly onAct: (item: AttentionItem, action: InboxAction) => void;
  readonly onAddReply: (item: AttentionItem) => void;
  readonly onOpen: (item: AttentionItem) => void;
}

function AgendaRows({ items, ferret, now, busy, referenced, onAct, onAddReply, onOpen }: AgendaRowsProps) {
  return (
    <ul className="fy-agenda-rows">
      {items.map(item => (
        <li className="fy-agenda-rows__item" key={item.id}>
          <AttentionAgendaRow
            busy={busy.has(item.id)}
            ferret={ferret}
            item={item}
            onAct={action => onAct(item, action)}
            onAddReply={() => onAddReply(item)}
            onOpen={() => onOpen(item)}
            referenced={referenced.includes(item.id)}
            {...(now === undefined ? {} : { now })}
          />
        </li>
      ))}
    </ul>
  );
}

export interface AttentionAgendaDrawerProps extends AgendaRowsProps {
  readonly id: string;
}

/** Opens upward from the line, between the chat and the composer; bounded, with its own scroll. */
export function AttentionAgendaDrawer({ id, ...rows }: AttentionAgendaDrawerProps) {
  return (
    <section aria-label={`${rows.ferret}’s agenda`} className="fy-agenda-drawer" data-agenda-drawer="" id={id}>
      <AgendaRows {...rows} />
    </section>
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
      {rows.items.length === 0 ? (
        <p className="fy-agenda-panel__empty">Nothing on the agenda.</p>
      ) : (
        <AgendaRows {...rows} />
      )}
    </aside>
  );
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
        <li className="fy-agenda-chip" data-agenda-chip={item.id} key={item.id}>
          <span className="fy-agenda-chip__lead">re:</span>
          <span className="fy-agenda-chip__title">{attentionHeading(item)}</span>
          <button
            aria-label={`Stop replying about ${attentionHeading(item)}`}
            className="fy-agenda-chip__clear"
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
