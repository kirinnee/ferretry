/**
 * THE RESOLVED RECORDS: what was asked, who cleared it and how — kept out of the chat feed.
 *
 * A conversation shows only what is open. A resolved item is one tap away instead of one line under every chat:
 * Info's agenda list has a Resolved filter whose rows open the item's view read-only (`agenda-settled.tsx`), and the
 * Inbox's "Resolved" filter draws {@link ResolvedRow} across every conversation.
 */

import type { ResolvedAgendaItem } from '@ferretry/protocol';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '../../lib/class-names.ts';
import { RouteLink } from '../../shell/route-link.tsx';
import { agendaReference, describeResponse, resolutionBadge } from './agenda-board.tsx';

/** Newest resolution first: the one just made is the one the reader is looking for. */
export const byNewestResolution = (left: ResolvedAgendaItem, right: ResolvedAgendaItem): number =>
  Date.parse(right.resolvedAt) - Date.parse(left.resolvedAt);

/** When it was cleared, short and in the reader's own time: "Oct 23, 8:54 AM" — no year, no seconds. */
export const resolvedWhen = (instant: string, timeZone?: string): string =>
  new Date(instant).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone === undefined ? {} : { timeZone }),
  });

/**
 * Text held to two lines until the reader asks for the rest. "Show more" appears only when the text
 * really overflows two lines at the width it is drawn at — measured, not guessed from its length — and
 * a record that fits reads exactly as it did.
 */
function ClampedText({ text, className }: { readonly text: string; readonly className: string }) {
  const ref = useRef<HTMLParagraphElement | null>(null);
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null || expanded) return;
    const measure = (): void => setOverflows(element.scrollHeight > element.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [expanded]);
  return (
    <>
      <p className={className} data-clamped={expanded ? undefined : ''} id={id} ref={ref}>
        {text}
      </p>
      {overflows ? (
        <button
          aria-controls={id}
          aria-expanded={expanded}
          className="fy-attn-panel__more"
          data-agenda-record-more=""
          onClick={() => setExpanded(open => !open)}
          type="button"
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </>
  );
}

/** Where a record lives when it is read across conversations: the ferret and machine, and a link to it. */
export interface ResolvedOrigin {
  readonly ferret: string;
  readonly machine: string;
  readonly href: string;
  readonly onNavigate: (to: string) => void;
}

/** One resolved item: what it asked, who cleared it and how — the same badge the audit ledger uses. */
export function ResolvedRow({
  record,
  id,
  highlighted = false,
  origin,
}: {
  readonly record: ResolvedAgendaItem;
  readonly id: string;
  readonly highlighted?: boolean;
  readonly origin?: ResolvedOrigin;
}) {
  const badge = resolutionBadge(record);
  const BadgeIcon = badge.icon;
  return (
    <li
      className="fy-attn-panel__record"
      data-agenda-record={record.id}
      data-highlighted={highlighted || undefined}
      id={id}
      tabIndex={-1}
    >
      {origin === undefined ? null : (
        <p className="fy-attn-panel__record-origin" data-agenda-record-origin="">
          {origin.ferret} · {origin.machine}
        </p>
      )}
      <p className="fy-attn-panel__record-subject">
        {origin === undefined ? (
          record.subject
        ) : (
          <RouteLink className="fy-attn-panel__record-link" onNavigate={origin.onNavigate} to={origin.href}>
            {record.subject}
          </RouteLink>
        )}
      </p>
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
        <span className="mono">{agendaReference(record.id)}</span>
        {highlighted ? <span className="fy-attn-card__pointer">linked</span> : null}
        <span>{resolvedWhen(record.resolvedAt)}</span>
      </p>
      {record.response ? (
        <ClampedText className="fy-attn-panel__record-answer" text={describeResponse(record.response)} />
      ) : null}
      {record.resolutionNote ? (
        <ClampedText className="fy-attn-panel__record-note" text={record.resolutionNote} />
      ) : null}
    </li>
  );
}
