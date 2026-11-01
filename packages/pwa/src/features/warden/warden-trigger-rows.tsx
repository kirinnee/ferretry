/**
 * Recent triggers: one row per flag on a ferret, filters above, a quiet "Show more" below. Render-only —
 * the join, the columns, the filtering and the paging are `warden-trigger-rows-model.ts`.
 *
 * Wide (md+): a table — `when · ferret · flagged · who · runtime · result`. On a phone each trigger stacks
 * into three short lines (when and ferret; flag, who and runtime; result). The row toggles its own
 * timeline — flag, Jev's check, the investigation, the act — and nothing else.
 */

import type { SessionView, WardenStatusView } from '@ferretry/protocol';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';

import { cn } from '../../lib/class-names.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { sessionTitles } from '../../shell/session-title.ts';
import { FerretLink, ferretName, ReportButton, SectionTitle, WardenChipBadge } from './warden-chips.tsx';
import type { WardenReportTarget } from './warden-overview-model.ts';
import {
  filterTriggerRows,
  NO_FILTERS,
  pageTriggerRows,
  type ResultFilter,
  resultFilterOptions,
  type TriggerFilters,
  type TriggerRow,
  type TriggerStep,
  triggerRows,
  type WhoFilter,
  WHO_FILTERS,
} from './warden-trigger-rows-model.ts';

const GRID =
  'grid grid-cols-[2.5rem_minmax(0,1fr)_auto] gap-x-sm gap-y-xs md:grid-cols-[3.5rem_minmax(0,1.3fr)_8rem_6.5rem_minmax(0,13rem)_minmax(0,1.2fr)_4.5rem]';

function WhoFilterGroup({
  value,
  onChange,
}: {
  readonly value: WhoFilter;
  readonly onChange: (next: WhoFilter) => void;
}) {
  return (
    <div className="flex items-center gap-xs">
      <span className="text-meta text-faint">Who</span>
      <div
        role="toolbar"
        aria-label="Filter by who handled it"
        className="flex flex-wrap rounded-control border border-border bg-surface p-0.5"
      >
        {WHO_FILTERS.map(option => (
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

const STEP_DOT: Readonly<Record<TriggerStep['kind'], string>> = {
  flag: 'bg-warn',
  jev: 'bg-accent',
  llm: 'bg-accent',
  act: 'bg-ok',
};

function Timeline({
  row,
  onOpenReport,
}: {
  readonly row: TriggerRow;
  readonly onOpenReport: (reportPath: string) => void;
}) {
  return (
    <ol className="m-0 flex min-w-0 list-none flex-col gap-xs p-0 pb-row-y pl-[calc(2.5rem+theme(spacing.sm))] pr-cell-x md:pl-[calc(3.5rem+theme(spacing.sm))]">
      {row.timeline.map(step => (
        <li
          key={step.key}
          className="flex min-w-0 items-start gap-sm text-meta leading-base"
          data-warden-step={step.kind}
        >
          <span aria-hidden="true" className={cn('mt-[0.35rem] h-2 w-2 shrink-0 rounded-full', STEP_DOT[step.kind])} />
          <div className="flex min-w-0 flex-col">
            <span className="flex flex-wrap items-baseline gap-x-sm text-fg-soft">
              <span className="font-semibold">{step.label}</span>
              {step.time !== undefined && <span className="text-faint">{step.time}</span>}
              {step.cost !== undefined && <span className="text-faint">{step.cost}</span>}
              {step.reportPath !== undefined && (
                <button
                  type="button"
                  className="kt-btn kt-btn--sm"
                  onClick={() => onOpenReport(step.reportPath as string)}
                >
                  Read report
                </button>
              )}
            </span>
            {step.detail !== undefined && (
              <span className="whitespace-pre-wrap break-words text-muted">{step.detail}</span>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

function TriggerItem({
  connection,
  row,
  session,
  onNavigate,
  onOpenReport,
}: {
  readonly connection: DaemonConnection;
  readonly row: TriggerRow;
  readonly session: SessionView | undefined;
  readonly onNavigate: ((to: string) => void) | undefined;
  readonly onOpenReport: (target: WardenReportTarget) => void;
}) {
  const [open, setOpen] = useState(false);
  const newest = row.times[0] as TriggerRow['times'][number];
  const titles = session === undefined ? undefined : sessionTitles(session.config);
  const open_ = (reportPath: string) =>
    onOpenReport({
      sessionId: row.sessionId,
      reportPath,
      at: newest.full,
      ...(row.jev === undefined ? {} : { jev: row.jev }),
    });
  return (
    <li className="flex min-w-0 flex-col" data-warden-trigger={row.key}>
      {/* The whole row is the phone's tap target (any spot outside the link and buttons toggles the
          timeline); the chevron button is the same toggle for a keyboard and a screen reader. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the chevron button inside is the accessible toggle */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the chevron button inside is the keyboard toggle */}
      <div
        className={cn(GRID, 'min-h-[44px] items-center px-cell-x py-xs md:min-h-0 md:py-row-y')}
        onClick={event => {
          if (!(event.target instanceof Element && event.target.closest('a, button'))) setOpen(current => !current);
        }}
      >
        <span
          className="text-meta leading-base text-faint [font-variant-numeric:tabular-nums]"
          title={`${newest.ago} · ${newest.full}`}
        >
          {newest.compact}
        </span>
        <span className="flex min-w-0 flex-col md:flex-row md:items-baseline md:gap-sm">
          <FerretLink
            connection={connection}
            sessionId={row.sessionId}
            name={ferretName(session, { sessionId: row.sessionId })}
            onNavigate={onNavigate}
            className="shrink-0 md:max-w-[9rem]"
          />
          {titles !== undefined && titles.ferret !== null && (
            <span className="min-w-0 truncate text-meta text-muted" data-warden-task>
              {titles.title}
            </span>
          )}
        </span>
        <span className="col-start-3 row-start-1 flex items-center justify-end gap-xs md:col-start-7">
          {row.count > 1 && (
            <span className="shrink-0 text-meta font-semibold text-muted" title={`${row.count} identical triggers`}>
              ×{row.count}
            </span>
          )}
          {row.reportPath !== undefined && <ReportButton onClick={() => open_(row.reportPath as string)} />}
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? 'Hide timeline' : 'Show timeline'}
            title={open ? 'Hide timeline' : 'Show timeline'}
            className="inline-flex !min-h-7 !min-w-7 shrink-0 items-center justify-center bg-transparent !p-0 text-faint"
            onClick={() => setOpen(current => !current)}
          >
            {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
          </button>
        </span>
        <span className="col-span-2 col-start-2 flex min-w-0 flex-wrap items-center gap-x-sm gap-y-xs md:contents">
          <span className="md:col-start-3">
            <WardenChipBadge chip={row.flag} />
          </span>
          <span className="inline-flex items-center text-meta text-fg-soft md:col-start-4" data-warden-who={row.who}>
            {row.whoLabel}
          </span>
          {row.runtime === undefined ? (
            <span className="hidden text-meta text-faint md:col-start-5 md:block">—</span>
          ) : (
            <span className="min-w-0 truncate text-meta text-muted md:col-start-5" title={row.runtime}>
              {row.runtime}
            </span>
          )}
        </span>
        <span
          className="col-span-2 col-start-2 flex min-w-0 flex-wrap items-center gap-x-sm gap-y-0 md:col-span-1 md:col-start-6"
          data-warden-result={row.result.key}
        >
          <WardenChipBadge
            wrap
            chip={{
              label: row.result.label,
              tone: row.result.tone,
              ...(row.result.busy === true ? { busy: true } : {}),
            }}
          />
          {row.result.note !== undefined && (
            <span className="min-w-0 truncate text-meta text-muted" title={row.result.note}>
              {row.result.note}
            </span>
          )}
        </span>
      </div>
      {open && <Timeline row={row} onOpenReport={open_} />}
    </li>
  );
}

export function RecentTriggers({
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
  const [filters, setFilters] = useState<TriggerFilters>(NO_FILTERS);
  const [pages, setPages] = useState(1);
  const all = triggerRows(status, now);
  const rows = filterTriggerRows(all, filters);
  const page = pageTriggerRows(rows, pages);
  return (
    <section aria-labelledby="warden-triggers" className="flex min-w-0 flex-col gap-sm">
      <div className="flex flex-wrap items-center justify-between gap-x-md gap-y-sm">
        <SectionTitle id="warden-triggers" title="Recent triggers" count={all.length} />
        <div className="flex flex-wrap items-center gap-x-md gap-y-xs">
          <WhoFilterGroup
            value={filters.who}
            onChange={who => {
              setFilters(current => ({ ...current, who }));
              setPages(1);
            }}
          />
          <label className="flex items-center gap-xs text-meta text-faint">
            Result
            <select
              className="kt-input !min-h-8 !w-auto sm:!min-h-0"
              value={filters.result}
              onChange={event => {
                setFilters(current => ({ ...current, result: event.target.value as ResultFilter }));
                setPages(1);
              }}
            >
              {resultFilterOptions(all).map(option => (
                <option key={option.key} value={option.key}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      {all.length === 0 ? (
        <p className="m-0 text-meta text-muted">The Warden has not flagged or acted on any ferret yet.</p>
      ) : rows.length === 0 ? (
        <p className="m-0 text-meta text-muted">No triggers match</p>
      ) : (
        <div className="flex min-w-0 flex-col">
          <div
            aria-hidden="true"
            className={cn(GRID, 'hidden px-cell-x pb-xs text-meta text-faint md:grid')}
            data-warden-trigger-head
          >
            <span>When</span>
            <span>Ferret</span>
            <span>Flagged</span>
            <span>Who</span>
            <span>Runtime</span>
            <span>Result</span>
            <span />
          </div>
          <ul className="m-0 flex list-none flex-col divide-y divide-border-soft p-0">
            {page.rows.map(row => (
              <TriggerItem
                key={row.key}
                connection={connection}
                row={row}
                session={sessions.get(row.sessionId)}
                onNavigate={onNavigate}
                onOpenReport={onOpenReport}
              />
            ))}
          </ul>
        </div>
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
