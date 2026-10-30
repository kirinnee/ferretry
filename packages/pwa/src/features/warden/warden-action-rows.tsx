/**
 * Recent actions: one line per action, filters above, a quiet "Show more" below. Render-only — the rows,
 * the grouping, the filtering and the paging are `warden-action-rows-model.ts`.
 *
 * Wide: `time · ferret · action · actor · ×N · reason… · report`. On a phone the reason drops to a second
 * line; a row is never a card. The reason line toggles the full detail underneath it.
 */

import type { SessionView, WardenStatusView } from '@ferretry/protocol';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';

import { cn } from '../../lib/class-names.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import {
  ACTOR_FILTERS,
  type ActionFilters,
  actionRows,
  filterActionRows,
  NO_FILTERS,
  OUTCOME_FILTERS,
  pageActionRows,
  type WardenActionRow,
} from './warden-action-rows-model.ts';
import { ActorMark, FerretLink, ferretName, ReportButton, SectionTitle, WardenChipBadge } from './warden-chips.tsx';
import type { WardenReportTarget } from './warden-overview-model.ts';

function FilterGroup<K extends string>({
  label,
  options,
  value,
  onChange,
}: {
  readonly label: string;
  readonly options: readonly { readonly key: K; readonly label: string }[];
  readonly value: K;
  readonly onChange: (next: K) => void;
}) {
  return (
    <div className="flex items-center gap-xs">
      <span className="text-meta text-faint">{label}</span>
      <div
        role="toolbar"
        aria-label={`Filter by ${label.toLowerCase()}`}
        className="flex flex-wrap rounded-control border border-border bg-surface p-0.5"
      >
        {options.map(option => (
          <button
            key={option.key}
            type="button"
            aria-pressed={value === option.key}
            className="kt-tab !px-xs !min-h-8 !min-w-0 sm:!min-h-0"
            onClick={() => onChange(option.key)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Detail({ row }: { readonly row: WardenActionRow }) {
  return (
    <dl className="m-0 flex min-w-0 flex-col gap-xs px-cell-x pb-row-y text-meta leading-base text-muted">
      <div className="whitespace-pre-wrap break-words text-cell text-fg-soft">{row.reason}</div>
      {row.jevReason !== undefined && (
        <div>
          <dt className="inline text-faint">Jev’s reason: </dt>
          <dd className="m-0 inline whitespace-pre-wrap break-words">{row.jevReason}</dd>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-sm gap-y-xs">
        <span className="text-faint">{row.verb}</span>
        {row.anomaly !== undefined && <WardenChipBadge chip={row.anomaly} />}
        {row.failoverTo !== undefined && <span>Moved to {row.failoverTo}</span>}
        {row.investigator !== undefined && <span>Investigated by {row.investigator}</span>}
        {row.cost !== undefined && <span>Cost {row.cost}</span>}
      </div>
      <div className="flex flex-wrap gap-x-sm text-faint">
        {row.times.map(time => (
          <span key={time.full}>{time.full}</span>
        ))}
      </div>
    </dl>
  );
}

function ActionRow({
  connection,
  row,
  session,
  onNavigate,
  onOpenReport,
}: {
  readonly connection: DaemonConnection;
  readonly row: WardenActionRow;
  readonly session: SessionView | undefined;
  readonly onNavigate: ((to: string) => void) | undefined;
  readonly onOpenReport: (target: WardenReportTarget) => void;
}) {
  const [open, setOpen] = useState(false);
  const newest = row.times[0];
  const { reportPath } = row;
  return (
    <li className="flex min-w-0 flex-col" data-warden-action={row.key}>
      {/* The whole row is the phone's tap target (any spot outside the link and buttons toggles the detail);
          the reason button is the same toggle for a keyboard and a screen reader. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the reason button inside is the accessible toggle */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the reason button inside is the keyboard toggle */}
      <div
        className="flex min-h-[44px] min-w-0 flex-wrap items-center gap-x-sm gap-y-0 px-cell-x py-xs sm:min-h-0 sm:flex-nowrap sm:py-row-y"
        onClick={event => {
          if (!(event.target instanceof Element && event.target.closest('a, button'))) setOpen(current => !current);
        }}
      >
        <span
          className="w-8 shrink-0 text-meta leading-base text-faint [font-variant-numeric:tabular-nums]"
          title={newest?.full}
        >
          {newest?.compact}
        </span>
        <FerretLink
          connection={connection}
          sessionId={row.sessionId}
          name={ferretName(session, { sessionId: row.sessionId })}
          onNavigate={onNavigate}
          className="max-w-[9rem] flex-1 sm:w-36 sm:flex-none sm:shrink-0"
        />
        <WardenChipBadge chip={row.chip} title={row.verb} />
        <ActorMark actor={row.actor} label={row.actorLabel} title={row.actorTitle} />
        {row.investigator !== undefined && (
          <span className="hidden shrink-0 text-meta text-faint lg:inline">{row.investigator}</span>
        )}
        {row.count > 1 && (
          <span className="shrink-0 text-meta font-semibold text-muted" title={`${row.count} identical actions`}>
            ×{row.count}
          </span>
        )}
        <span className="order-last flex min-w-0 basis-full items-center gap-xs sm:contents">
          <button
            type="button"
            aria-expanded={open}
            title={open ? 'Hide detail' : 'Show detail'}
            className="flex min-w-0 flex-1 items-center gap-xs bg-transparent !p-0 !min-h-0 !min-w-0 text-left text-cell leading-base text-fg-soft"
            onClick={() => setOpen(current => !current)}
          >
            <span className={cn('min-w-0 flex-1', open ? 'sr-only' : 'truncate')}>{row.reason}</span>
            {open ? (
              <ChevronDown size={14} aria-hidden="true" className="ml-auto shrink-0 text-faint" />
            ) : (
              <ChevronRight size={14} aria-hidden="true" className="shrink-0 text-faint" />
            )}
          </button>
          {reportPath !== undefined && (
            <ReportButton
              onClick={() =>
                onOpenReport({
                  sessionId: row.sessionId,
                  reportPath,
                  ...(newest === undefined ? {} : { at: newest.full }),
                })
              }
            />
          )}
        </span>
      </div>
      {open && <Detail row={row} />}
    </li>
  );
}

export function RecentActions({
  connection,
  status,
  sessions,
  now,
  onNavigate,
  onOpenReport,
}: {
  readonly connection: DaemonConnection;
  readonly status: WardenStatusView;
  readonly sessions: ReadonlyMap<string, SessionView>;
  readonly now: number;
  readonly onNavigate: ((to: string) => void) | undefined;
  readonly onOpenReport: (target: WardenReportTarget) => void;
}) {
  const [filters, setFilters] = useState<ActionFilters>(NO_FILTERS);
  const [pages, setPages] = useState(1);
  const all = actionRows(status, now);
  const rows = filterActionRows(all, filters);
  const page = pageActionRows(rows, pages);
  return (
    <section aria-labelledby="warden-actions" className="flex min-w-0 flex-col gap-sm">
      <div className="flex flex-wrap items-center justify-between gap-x-md gap-y-sm">
        <SectionTitle id="warden-actions" title="Recent actions" count={all.length} />
        <div className="flex flex-wrap items-center gap-x-md gap-y-xs">
          <FilterGroup
            label="Actor"
            options={ACTOR_FILTERS}
            value={filters.actor}
            onChange={actor => {
              setFilters(current => ({ ...current, actor }));
              setPages(1);
            }}
          />
          <FilterGroup
            label="Action"
            options={OUTCOME_FILTERS}
            value={filters.outcome}
            onChange={outcome => {
              setFilters(current => ({ ...current, outcome }));
              setPages(1);
            }}
          />
        </div>
      </div>
      {all.length === 0 ? (
        <p className="m-0 text-meta text-muted">The Warden has not acted or blessed anything yet.</p>
      ) : rows.length === 0 ? (
        <p className="m-0 text-meta text-muted">No actions match</p>
      ) : (
        <ul className="m-0 flex list-none flex-col divide-y divide-border-soft p-0">
          {page.rows.map(row => (
            <ActionRow
              key={row.key}
              connection={connection}
              row={row}
              session={sessions.get(row.sessionId)}
              onNavigate={onNavigate}
              onOpenReport={onOpenReport}
            />
          ))}
        </ul>
      )}
      {page.hidden > 0 && (
        <button
          type="button"
          className="kt-btn kt-btn--sm min-h-[44px] self-start sm:min-h-0"
          onClick={() => setPages(current => current + 1)}
        >
          Show more ({page.hidden})
        </button>
      )}
    </section>
  );
}
