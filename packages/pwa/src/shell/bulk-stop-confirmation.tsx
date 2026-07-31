/**
 * THE SECOND, EXPLICIT STEP FOR EVERY BULK STOP. Ported from the
 * `BulkStopConfirmation` half of kteam `ui/src/components/AgentSidebar.tsx`.
 *
 * Stopping sessions is the most destructive thing this app does and it is
 * reachable from a row menu two taps away, so the confirmation deliberately
 * renders the COMPLETE target list rather than a reassuring-but-opaque count:
 * "Stop 7 sessions?" is not consent, seeing the seven names is.
 *
 * The dialog is presentational on purpose. Every decision it displays — who the
 * targets are, who gets orphaned, whether this run is still the current one —
 * was made by `agent-sidebar-model.ts` and `stop-actions.ts`, so the sweep and
 * the screen describing it cannot drift apart.
 *
 * Daemon scope: nothing is stored or cached here. The `sessions` list is passed
 * in by the caller that already holds a `(daemonId, …)`-scoped fleet, so one
 * daemon's fleet can never be named in another daemon's confirmation.
 */

import type { SessionView } from '@ferretry/protocol';
import { useCallback, useRef } from 'react';
import { useDialogFocus } from '../hooks/use-dialog-focus.ts';
import { displayCallsign } from '../lib/callsign.ts';
import { activeSessionAncestorIds, type BulkStopRequest } from './agent-sidebar-model.ts';
import { stopScopeLabel } from './stop-actions.ts';

/**
 * How a session is named to someone about to end it. The callsign first because
 * that is what the fleet is discussed in; the raw id last but always present,
 * because two teammates can share a display name and only one of them is being
 * stopped.
 */
export const stopTargetName = (view: SessionView): string =>
  displayCallsign(view.config.teammate) || view.config.name || view.config.id;

export interface BulkStopConfirmationProps {
  readonly request: BulkStopRequest | null;
  /** The session currently on screen, so the dialog can warn when it is in the sweep. */
  readonly activeId?: string;
  readonly sessions: readonly SessionView[];
  readonly onClose: () => void;
  readonly onConfirm: () => void;
  readonly onConfirmNew: (targets: readonly SessionView[]) => void;
}

export function BulkStopConfirmation({
  request,
  activeId,
  sessions,
  onClose,
  onConfirm,
  onConfirmNew,
}: BulkStopConfirmationProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  // A running sweep cannot be cancelled by hiding this dialog — the requests
  // are already in flight — so keep the report reachable until every outcome
  // has been rendered.
  const dismiss = useCallback(() => {
    if (!request?.running) onClose();
  }, [request?.running, onClose]);
  const { onKeyDown } = useDialogFocus(request !== null, dialogRef, dismiss);
  if (!request) return null;

  const isResult = request.outcomes !== undefined;
  const isOrphan = request.scope === 'orphan';
  const callerIncluded = request.targets.some(target => target.config.id === activeId);
  const ancestorIds = activeSessionAncestorIds(activeId, sessions);
  const orphanedDescendants = request.orphanedDescendants ?? [];
  const newOrphanedDescendants = request.newOrphanedDescendants ?? [];
  const newTargets = request.newTargets ?? [];

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end bg-scrim p-2 sm:items-center sm:justify-center"
      role="presentation"
    >
      {/* Phone-first: the sheet sits at the BOTTOM under `items-end` and only
          centres from `sm:` up, so the confirm button stays in thumb reach. */}
      <button
        type="button"
        aria-label="Close stop confirmation"
        disabled={request.running}
        onClick={dismiss}
        className="absolute inset-0"
      />
      <div
        ref={dialogRef}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        role="dialog"
        aria-modal="true"
        aria-labelledby="bulk-stop-title"
        className="kt-panel relative flex max-h-[min(82dvh,620px)] w-full max-w-md flex-col overflow-hidden px-cell-x py-3 shadow-popover focus:outline-none"
      >
        <h2 id="bulk-stop-title" className="text-ui font-semibold">
          {isResult ? `${stopScopeLabel(request.scope)} results` : `${stopScopeLabel(request.scope)} — confirm`}
        </h2>
        {!isResult && !isOrphan && (
          <p className="mt-1 text-cell text-muted">
            Stop these {request.targets.length} {request.targets.length === 1 ? 'session' : 'sessions'}? This cannot be
            undone.
          </p>
        )}
        {/* Orphan mode stops exactly one session, so it leads with WHICH one
            rather than a count — the list below is what survives, not what dies. */}
        {!isResult && isOrphan && request.targets[0] && (
          <p className="mt-1 text-cell text-muted">
            Session to stop: <span className="font-medium text-fg">{stopTargetName(request.targets[0])}</span>{' '}
            <span className="mono text-meta">{request.targets[0].config.id}</span>
            {ancestorIds.has(request.targets[0].config.id) && (
              <span className="ml-2 text-meta text-warn">Current-session ancestor</span>
            )}
          </p>
        )}
        {callerIncluded && (
          <p className="mt-2 rounded-control border border-warn/50 bg-warn/10 p-2 text-cell text-warn">
            Current session is included and will be stopped.
          </p>
        )}
        {isResult ? (
          <ul
            aria-label="Stop outcomes"
            className="my-3 min-h-0 flex-1 divide-y divide-border-soft overflow-y-auto rounded-control border border-border-soft"
          >
            {request.outcomes!.map(outcome => (
              <li key={outcome.id} className="flex min-h-[44px] items-center gap-sm px-3 py-2 text-cell">
                <span className={outcome.ok ? 'text-ok' : 'text-err'}>{outcome.ok ? 'Stopped' : 'Failed'}</span>
                <span className="min-w-0 flex-1 truncate">{outcome.name}</span>
                <span className="mono shrink-0 text-meta text-muted">{outcome.id}</span>
                {outcome.detail && <span className="max-w-[45%] truncate text-meta text-muted">{outcome.detail}</span>}
              </li>
            ))}
          </ul>
        ) : isOrphan ? (
          <section className="my-3 min-h-0 flex-1" aria-labelledby="orphaned-descendants-title">
            <h3 id="orphaned-descendants-title" className="text-cell font-semibold text-warn">
              Live descendants left running / parentless ({orphanedDescendants.length})
            </h3>
            {orphanedDescendants.length === 0 ? (
              <p className="mt-2 text-cell text-muted">No descendants will be orphaned.</p>
            ) : (
              <ul className="mt-2 max-h-[42dvh] divide-y divide-border-soft overflow-y-auto rounded-control border border-warn/40">
                {orphanedDescendants.map(descendant => (
                  <li key={descendant.config.id} className="flex min-h-[44px] items-center gap-sm px-3 py-2 text-cell">
                    <span className="min-w-0 flex-1 truncate">{stopTargetName(descendant)}</span>
                    <span className="mono shrink-0 text-meta text-muted">{descendant.config.id}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : (
          <ul
            aria-label="Sessions to stop"
            className="my-3 min-h-0 flex-1 divide-y divide-border-soft overflow-y-auto rounded-control border border-border-soft"
          >
            {request.targets.map(target => (
              <li key={target.config.id} className="flex min-h-[44px] items-center gap-sm px-3 py-2 text-cell">
                <span className="min-w-0 flex-1 truncate">{stopTargetName(target)}</span>
                {ancestorIds.has(target.config.id) && (
                  <span className="shrink-0 text-meta text-warn">Current-session ancestor</span>
                )}
                <span className="mono shrink-0 text-meta text-muted">{target.config.id}</span>
              </li>
            ))}
          </ul>
        )}
        {/* A sweep is not atomic: sessions can start matching while it runs.
            Those are REPORTED, never silently swept — they were not in what the
            person confirmed, so they need their own confirmation. */}
        {isResult && newOrphanedDescendants.length > 0 && (
          <div className="mb-3 rounded-control border border-warn/40 bg-warn/10 p-2 text-cell text-warn">
            <p>
              {newOrphanedDescendants.length} newly appeared live{' '}
              {newOrphanedDescendants.length === 1 ? 'descendant was' : 'descendants were'} left running.
            </p>
            <ul
              className="mt-2 max-h-[24dvh] divide-y divide-warn/20 overflow-y-auto"
              aria-label="Newly left running descendants"
            >
              {newOrphanedDescendants.map(descendant => (
                <li key={descendant.config.id} className="flex min-h-[44px] items-center gap-sm">
                  <span className="min-w-0 flex-1 truncate">{stopTargetName(descendant)}</span>
                  <span className="mono shrink-0 text-meta">{descendant.config.id}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {isResult && newTargets.length > 0 && (
          <div className="mb-3 rounded-control border border-warn/40 bg-warn/10 p-2 text-cell text-warn">
            <p>
              {newTargets.length} newly appeared matching {newTargets.length === 1 ? 'session was' : 'sessions were'}{' '}
              not stopped.
            </p>
            <ul
              className="mt-2 max-h-[24dvh] divide-y divide-warn/20 overflow-y-auto"
              aria-label="Newly matching sessions"
            >
              {newTargets.map(target => (
                <li key={target.config.id} className="flex min-h-[44px] items-center gap-sm">
                  <span className="min-w-0 flex-1 truncate">{stopTargetName(target)}</span>
                  <span className="mono shrink-0 text-meta">{target.config.id}</span>
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => onConfirmNew(newTargets)}
              className="kt-btn mt-2 min-h-[44px] w-full justify-center"
            >
              Review newly appeared sessions
            </button>
          </div>
        )}
        <div className="flex shrink-0 gap-sm">
          {/* 44px is the touch-target floor, not a look — these two buttons are
              the last thing between a finger and an irreversible sweep. */}
          <button
            type="button"
            disabled={request.running}
            onClick={dismiss}
            className="kt-btn min-h-[44px] flex-1 justify-center"
          >
            {isResult ? 'Close' : 'Cancel'}
          </button>
          {!isResult && (
            <button
              type="button"
              disabled={request.running || request.targets.length === 0}
              onClick={onConfirm}
              data-variant="danger"
              className="kt-btn min-h-[44px] flex-1 justify-center"
            >
              {request.running ? 'Refreshing…' : `Stop ${request.targets.length}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
