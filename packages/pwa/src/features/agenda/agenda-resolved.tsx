/**
 * THE RESOLVED RECORDS: what was asked, who cleared it and how — kept out of the chat feed.
 *
 * A conversation shows only what is open. The history is one step away instead of one line under every
 * chat: the header menu's "N resolved" entry opens {@link AgendaResolvedList} in a drawer (a full
 * screen on a phone), and the Attention inbox's "Resolved" filter draws the same {@link ResolvedRow}
 * across every conversation.
 */

import type { AgendaId, ResolvedAgendaItem } from '@ferretry/protocol';
import { CheckCheck } from 'lucide-react';
import { type ReactNode, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../../lib/class-names.ts';
import { RouteLink } from '../../shell/route-link.tsx';
import type { SessionActionContribution } from '../session-actions/registry.ts';
import { agendaReference, describeResponse, resolutionBadge } from './agenda-board.tsx';

/** The action id the header menu opens this list by; the page also opens it for a `!A3` that is resolved. */
export const AGENDA_RESOLVED_ACTION_ID = 'agenda-resolved';

/** The DOM id one item is drawn under, so a link can scroll to it. */
const agendaPanelItemId = (panelId: string, id: AgendaId): string => `${panelId}-item-${id}`;

/** Newest resolution first: the one just made is the one the reader is looking for. */
export const byNewestResolution = (left: ResolvedAgendaItem, right: ResolvedAgendaItem): number =>
  Date.parse(right.resolvedAt) - Date.parse(left.resolvedAt);

/** "7 resolved" — the words the menu entry and the inbox filter use. */
export const resolvedWords = (count: number): string => `${count} resolved`;

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

/** This conversation's resolved items, newest first; `highlighted` is rung and focused once, on open. */
export function AgendaResolvedList({
  records,
  panelId,
  highlighted = null,
}: {
  readonly records: readonly ResolvedAgendaItem[];
  readonly panelId: string;
  readonly highlighted?: AgendaId | null;
}) {
  const sorted = useMemo(() => [...records].sort(byNewestResolution), [records]);
  useEffect(() => {
    if (highlighted === null) return;
    const row = document.getElementById(agendaPanelItemId(panelId, highlighted));
    row?.scrollIntoView?.({ block: 'nearest' });
    row?.focus({ preventScroll: true });
  }, [highlighted, panelId]);
  return sorted.length === 0 ? (
    <p className="fy-attn-panel__note" data-agenda-resolved-empty="">
      Nothing has been resolved in this conversation.
    </p>
  ) : (
    <ul aria-label="Resolved" className="fy-attn-panel__records" data-agenda-resolved-list="">
      {sorted.map(record => (
        <ResolvedRow
          highlighted={highlighted === record.id}
          id={agendaPanelItemId(panelId, record.id)}
          key={`${record.id}:${record.resolvedAt}`}
          record={record}
        />
      ))}
    </ul>
  );
}

/**
 * The header menu's "N resolved" entry, as the registry's contribution. Hidden when nothing is resolved,
 * so a conversation with no history shows no row; `highlighted` rings the item a `!A3` link named.
 */
export const resolvedActionContribution = (
  records: readonly ResolvedAgendaItem[],
  panelId: string,
  highlighted: AgendaId | null,
): SessionActionContribution<unknown> => ({
  group: 'session',
  order: 25,
  build: () =>
    records.length === 0
      ? null
      : {
          kind: 'form',
          id: AGENDA_RESOLVED_ACTION_ID,
          label: resolvedWords(records.length),
          title: 'Resolved in Inbox',
          heading: `Resolved · ${records.length}`,
          presentation: 'drawer',
          icon: CheckCheck,
          render: (): ReactNode => <AgendaResolvedList highlighted={highlighted} panelId={panelId} records={records} />,
        },
});
