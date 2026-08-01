/** The focused session's local lineage, rendered for the Tree side-pane tab. */
import { useMemo, useState } from 'react';
import type { SessionStatus, SessionView } from '@ferretry/protocol';

import { useFleetView } from '../../hooks/use-fleet-view.ts';
import type { DaemonControlsStore } from '../../lib/controls.ts';
import type { DaemonId } from '../../lib/daemon-connection.ts';
import type { DaemonFleetStore } from '../../lib/fleet-store.ts';
import { lineageIndent, lineageLabel, MAX_INDENT_DEPTH } from '../../lib/lineage.ts';
import { daemonSessionPath } from '../../lib/pages/routes.ts';
import { cn } from '../../lib/class-names.ts';
import { Badge } from '../../shell/primitives.tsx';
import { RouteLink } from '../../shell/route-link.tsx';
import { StatusMark, statusMark } from '../../shell/status-mark.tsx';
import { LineageName } from './lineage-name.tsx';
import {
  buildLineageSurfaceModel,
  filterLineageRows,
  lineageFilterSummary,
  orderedStatuses,
  statusCounts,
  surfaceRows,
  toggleLineageStatusFilter,
  type FilteredLineageRow,
  type LineageSurfaceModel,
  type LineageSurfaceParent,
} from './lineage-surface-model.ts';

const statusLabel = (status: SessionStatus): string => status.replaceAll('_', ' ');

function StatusFilter({
  counts,
  selected,
  onSelect,
  onShowAll,
}: {
  readonly counts: ReadonlyMap<SessionStatus, number>;
  readonly selected: ReadonlySet<SessionStatus> | null;
  readonly onSelect: (status: SessionStatus) => void;
  readonly onShowAll: () => void;
}) {
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  return (
    <div
      className="flex gap-xs overflow-x-auto overscroll-x-contain pb-1 scroll-thin"
      role="toolbar"
      aria-label="Filter lineage by status"
    >
      <button
        type="button"
        aria-pressed={selected === null}
        onClick={onShowAll}
        className={cn(
          'inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center gap-xs rounded-control border px-2 text-2xs font-semibold',
          selected === null
            ? 'border-accent bg-accent-soft text-accent'
            : 'border-border-soft bg-surface text-muted hover:border-accent-border hover:text-fg',
        )}
      >
        All <span className="mono text-faint">{total}</span>
      </button>
      {orderedStatuses(counts, selected).map(status => {
        const active = selected?.has(status) ?? false;
        const count = counts.get(status) ?? 0;
        return (
          <button
            key={status}
            type="button"
            aria-pressed={active}
            aria-label={`${statusLabel(status)}, ${count} ${count === 1 ? 'session' : 'sessions'}`}
            title={active ? `Remove ${statusLabel(status)} from the filter` : `Show ${statusLabel(status)} sessions`}
            onClick={() => onSelect(status)}
            className={cn(
              'inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center gap-xs rounded-control border px-2 text-2xs font-semibold',
              active
                ? 'border-accent bg-accent-soft text-accent'
                : 'border-border-soft bg-surface text-muted hover:border-accent-border hover:text-fg',
            )}
          >
            {statusLabel(status)} <span className="mono text-faint">{count}</span>
          </button>
        );
      })}
    </div>
  );
}

type LineageRole = 'current' | 'parent' | 'descendant';

const roleFor = (view: SessionView, model: LineageSurfaceModel): LineageRole => {
  if (view.config.id === model.current?.config.id) return 'current';
  if (model.parent?.kind === 'resolved' && view.config.id === model.parent.view.config.id) return 'parent';
  return 'descendant';
};

function SessionLineageLink({
  daemonId,
  view,
  role,
  current = false,
  displayDepth,
  descendantDepth,
  matchesFilter,
  hasChildren,
  topLevel,
  onNavigate,
}: {
  readonly daemonId: DaemonId;
  readonly view: SessionView;
  readonly role: LineageRole;
  readonly current?: boolean;
  readonly displayDepth: number;
  /** Direct child = 0. */
  readonly descendantDepth?: number;
  readonly matchesFilter: boolean;
  readonly hasChildren: boolean;
  readonly topLevel?: boolean;
  readonly onNavigate?: (to: string) => void;
}) {
  const label = lineageLabel(view);
  const mark = statusMark(view);
  const compressedDepth = displayDepth > MAX_INDENT_DEPTH;
  const contextNote = matchesFilter ? undefined : 'Shown as a path to a matching descendant';
  return (
    <RouteLink
      to={daemonSessionPath(daemonId, view.config.id)}
      onNavigate={onNavigate}
      aria-current={current ? 'page' : undefined}
      data-lineage-role={role}
      data-lineage-origin={topLevel ? 'top-level' : undefined}
      data-lineage-filter={matchesFilter ? 'match' : 'context'}
      data-session-status={view.state.status}
      data-lineage-depth={role === 'descendant' ? descendantDepth : undefined}
      data-lineage-tree-depth={displayDepth}
      title={[label.full, mark.label, contextNote].filter(Boolean).join('\n')}
      className={cn(
        'group relative flex min-h-[44px] w-full min-w-0 items-center gap-xs border-l-2 px-2 py-1 text-left',
        'hover:bg-surface-2 focus-visible:bg-surface-2',
        current ? 'border-l-accent bg-accent-soft' : 'border-l-transparent',
        !matchesFilter && 'bg-surface-2',
      )}
    >
      {hasChildren && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-0 left-[15px] top-1/2 border-l border-border-soft"
        />
      )}
      <StatusMark view={view} size={8} className="relative z-[2]" />
      {compressedDepth && (
        <span aria-hidden="true" className="mono shrink-0 text-2xs text-faint" title={`Tree level ${displayDepth + 1}`}>
          ›{displayDepth}
        </span>
      )}
      <LineageName
        label={label}
        className={cn(
          'min-w-0 flex-1 text-ui',
          matchesFilter ? (current ? 'font-semibold text-accent' : 'font-semibold text-fg') : 'font-medium text-muted',
        )}
      />
      {matchesFilter ? (
        <Badge aria-hidden="true" tone={mark.tone} className="max-w-[104px] shrink-0 truncate text-2xs">
          {statusLabel(view.state.status)}
        </Badge>
      ) : (
        <span
          aria-hidden="true"
          className="mono shrink-0 rounded-badge border border-dashed border-border px-xs text-2xs font-semibold uppercase text-muted"
        >
          path
        </span>
      )}
      {contextNote && <span className="sr-only"> — {contextNote}; this session does not match the status filter</span>}
      {topLevel && <span className="sr-only"> — top-level session; no parent was recorded</span>}
    </RouteLink>
  );
}

function LineageTreeRows({
  daemonId,
  rows,
  model,
  onNavigate,
  depth = 0,
  descendantDepth,
}: {
  readonly daemonId: DaemonId;
  readonly rows: readonly FilteredLineageRow[];
  readonly model: LineageSurfaceModel;
  readonly onNavigate?: (to: string) => void;
  readonly depth?: number;
  readonly descendantDepth?: number;
}) {
  return (
    <ul className="m-0 list-none p-0" aria-label={depth === 0 ? 'Session lineage tree' : undefined}>
      {rows.map((filtered, index) => {
        const { view, children, matchesFilter } = filtered;
        const role = roleFor(view, model);
        const step = depth === 0 ? 0 : Math.max(0, lineageIndent(depth) - lineageIndent(depth - 1));
        const rowDescendantDepth = role === 'descendant' ? descendantDepth : undefined;
        const nextDescendantDepth =
          role === 'current' ? 0 : role === 'descendant' ? (descendantDepth ?? 0) + 1 : undefined;
        const last = index === rows.length - 1;
        return (
          <li key={view.config.id} className="relative">
            {depth > 0 && (
              <>
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute left-4 top-0 z-[1] h-[22px] border-l border-border-soft"
                />
                {step > 0 && (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute left-4 top-[21px] z-[1] border-t border-border-soft"
                    style={{ width: `${step}px` }}
                  />
                )}
                {!last && (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute bottom-0 left-4 top-[22px] z-[1] border-l border-border-soft"
                  />
                )}
              </>
            )}
            <div className="relative" style={step > 0 ? { marginLeft: `${step}px` } : undefined}>
              <SessionLineageLink
                daemonId={daemonId}
                view={view}
                role={role}
                current={role === 'current'}
                displayDepth={depth}
                descendantDepth={rowDescendantDepth}
                matchesFilter={matchesFilter}
                hasChildren={children.length > 0}
                topLevel={role === 'current' && model.parent === null}
                onNavigate={onNavigate}
              />
              {children.length > 0 && (
                <LineageTreeRows
                  daemonId={daemonId}
                  rows={children}
                  model={model}
                  onNavigate={onNavigate}
                  depth={depth + 1}
                  descendantDepth={nextDescendantDepth}
                />
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function ParentIssue({
  parent,
  hasChildren,
}: {
  readonly parent: Extract<LineageSurfaceParent, { readonly kind: 'missing' | 'invalid' }>;
  readonly hasChildren: boolean;
}) {
  const invalid = parent.kind === 'invalid';
  return (
    <div
      data-lineage-role={invalid ? 'invalid-parent' : 'missing-parent'}
      data-lineage-filter="context"
      role="note"
      title={
        invalid
          ? 'The configured parent edge is self-referential or cyclic and was ignored'
          : 'The configured parent session no longer resolves'
      }
      className={cn(
        'relative flex min-h-[44px] min-w-0 items-center gap-xs border-l-2 px-2 py-1',
        invalid ? 'border-l-warn' : 'border-l-err',
      )}
    >
      {hasChildren && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-0 left-[15px] top-1/2 border-l border-border-soft"
        />
      )}
      <span
        aria-hidden="true"
        className={cn(
          'relative z-[2] flex h-3 w-3 shrink-0 items-center justify-center rounded-full border text-2xs',
          invalid ? 'border-warn-border text-warn' : 'border-err-border text-err',
        )}
      >
        {invalid ? '!' : '×'}
      </span>
      <span className="min-w-0 flex-1 truncate text-ui font-semibold text-muted">
        {invalid ? 'Invalid parent link' : 'Missing parent'}
      </span>
      <span className="mono shrink-0 text-2xs text-faint">{parent.shortId}</span>
    </div>
  );
}

function LineageSurfaceBody({
  daemonId,
  sessionId,
  sessions,
  onNavigate,
}: {
  readonly daemonId: DaemonId;
  readonly sessionId: string;
  readonly sessions: readonly SessionView[];
  readonly onNavigate?: (to: string) => void;
}) {
  const model = useMemo(() => buildLineageSurfaceModel(sessionId, sessions), [sessionId, sessions]);
  const rows = useMemo(() => surfaceRows(model), [model]);
  const counts = useMemo(() => statusCounts(rows), [rows]);
  const [selectedStatuses, setSelectedStatuses] = useState<ReadonlySet<SessionStatus> | null>(null);
  const filtered = useMemo(() => filterLineageRows(rows, selectedStatuses), [rows, selectedStatuses]);

  if (!model.current) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-panel py-6" role="status">
        <p className="m-0 text-center text-cell text-muted">
          This session is not in this daemon’s live fleet snapshot.
        </p>
      </div>
    );
  }

  const totalCount = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const filtering = selectedStatuses !== null;
  const filterSummary = filtering
    ? lineageFilterSummary(filtered.matchCount, filtered.contextCount)
    : `All ${totalCount}`;
  const parentIssue = model.parent?.kind === 'missing' || model.parent?.kind === 'invalid' ? model.parent : null;

  return (
    <section
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-panel pb-4 scroll-thin"
      aria-label="Session lineage"
    >
      <div className="sticky top-0 z-10 -mx-panel bg-surface px-panel pb-2 pt-2">
        <div className="mb-xs flex items-baseline justify-between gap-sm">
          <h3 className="kt-label m-0">Status</h3>
          <span className="mono shrink-0 text-2xs text-faint" aria-live="polite">
            {filterSummary}
          </span>
        </div>
        <StatusFilter
          counts={counts}
          selected={selectedStatuses}
          onSelect={status => setSelectedStatuses(current => toggleLineageStatusFilter(current, status))}
          onShowAll={() => setSelectedStatuses(null)}
        />
        {filtering && filtered.contextCount > 0 && (
          <p className="mb-0 mt-xs text-meta text-muted">
            Path rows keep matching descendants attached to their ancestors.
          </p>
        )}
      </div>

      <section aria-label="Session lineage tree" className="pt-2">
        <div className="mb-xs flex items-baseline justify-between gap-sm">
          <h3 className="kt-label m-0">Lineage tree</h3>
          <span className="mono shrink-0 text-2xs text-faint">
            {model.descendantCount} {model.descendantCount === 1 ? 'descendant' : 'descendants'}
          </span>
        </div>
        {filtered.rows.length > 0 ? (
          <div className="rounded-control border border-border-soft bg-surface p-px">
            {parentIssue && <ParentIssue parent={parentIssue} hasChildren={filtered.rows.length > 0} />}
            <LineageTreeRows
              daemonId={daemonId}
              rows={filtered.rows}
              model={model}
              onNavigate={onNavigate}
              depth={parentIssue ? 1 : 0}
            />
          </div>
        ) : (
          <div
            data-lineage-role="no-matches"
            role="status"
            className="flex min-h-[88px] flex-wrap items-center justify-between gap-sm rounded-control border border-dashed border-border-soft px-3 py-2 text-cell text-muted"
          >
            <span>No sessions currently match this status filter.</span>
            <button
              type="button"
              onClick={() => setSelectedStatuses(null)}
              className="min-h-[44px] rounded-control border border-border px-3 text-ui font-semibold text-fg hover:border-accent-border hover:text-accent"
            >
              Show all
            </button>
          </div>
        )}
      </section>
    </section>
  );
}

/** Hostless renderer for side-pane composition, tests, and the screenshot harness. */
export function LineageSurfaceContent({
  daemonId,
  sessionId,
  sessions,
  onNavigate,
}: {
  readonly daemonId: DaemonId;
  readonly sessionId: string;
  readonly sessions: readonly SessionView[];
  readonly onNavigate?: (to: string) => void;
}) {
  return (
    <LineageSurfaceBody
      key={`${daemonId}:${sessionId}`}
      daemonId={daemonId}
      sessionId={sessionId}
      sessions={sessions}
      onNavigate={onNavigate}
    />
  );
}

/** Live adapter: reads only the selected daemon's fleet slice. */
export function LineageSurface({
  daemonId,
  sessionId,
  fleet,
  controls,
  onNavigate,
}: {
  readonly daemonId: DaemonId;
  readonly sessionId: string;
  readonly fleet: DaemonFleetStore;
  readonly controls: DaemonControlsStore;
  readonly onNavigate?: (to: string) => void;
}) {
  const { slice } = useFleetView({ fleet, controls, daemonId });
  if (slice.sessions === null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-panel py-6" role="status">
        <p className="m-0 text-center text-cell text-muted">Loading lineage…</p>
      </div>
    );
  }
  return (
    <LineageSurfaceContent
      daemonId={daemonId}
      sessionId={sessionId}
      sessions={slice.sessions}
      onNavigate={onNavigate}
    />
  );
}
