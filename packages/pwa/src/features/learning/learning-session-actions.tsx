/**
 * LEARNING IN A FERRET'S ACTIONS MENU: "Passive learning" (a menuitemcheckbox) and "Scan this ferret for
 * lessons…", contributed to the session action registry.
 *
 * The switch only decides whether the ferret is INSTRUCTED to file lessons. Switching a running ferret
 * re-instructs it with a queued message that costs it one turn; the daemon's own note says so, and the
 * host shows that note in a polite status line. The scan opens the same dialog as the Learning hub,
 * scoped to this ferret — estimate first, and nothing runs until Start.
 */

import type { LearningScanScope, SessionView } from '@ferretry/protocol';
import { GraduationCap, ScanSearch, X } from 'lucide-react';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import type { PickerAccount } from '../../lib/account-picker-catalog.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import type { FleetProject } from '../../lib/fleet-grouping.ts';
import type { DaemonFetch } from '../../lib/runtime-models.ts';
import type { SessionActionContribution } from '../session-actions/registry.ts';
import { usePassiveLearning } from './passive-learning.tsx';
import { ScanDialog } from './scan-dialog.tsx';
import { useLearningScan } from './use-learning-scan.ts';

/** What a learning entry needs to know about the ferret the menu is for. */
export interface LearningActionContext {
  readonly view: SessionView;
  readonly canControl: boolean;
}

export const LEARNING_ACTION_IDS = { passive: 'passive-learning', scan: 'scan-ferret' } as const;

export interface LearningSessionActionsOptions {
  readonly connection: DaemonConnection;
  readonly fetcher: DaemonFetch;
  readonly sessions?: readonly SessionView[] | null;
  readonly projects?: readonly FleetProject[];
  readonly accounts?: readonly PickerAccount[] | null;
  /** "View in Learning" after a scan: the host takes the reader to the hub. */
  readonly onViewLearning?: () => void;
}

export interface LearningSessionActions {
  readonly contributions: readonly SessionActionContribution<LearningActionContext>[];
  /** The scan dialog and the switch's status line; render it beside the page. */
  readonly host: ReactNode;
  /** Whether one ferret is instructed to learn: null until the first read answers (or when the daemon cannot say). */
  readonly passiveFor: (sessionId: string) => boolean | null;
}

const NO_PROJECTS: readonly FleetProject[] = [];

export function useLearningSessionActions({
  connection,
  fetcher,
  sessions = null,
  projects = NO_PROJECTS,
  accounts = null,
  onViewLearning,
}: LearningSessionActionsOptions): LearningSessionActions {
  const learning = usePassiveLearning(connection, fetcher);
  const [note, setNote] = useState<string | null>(null);
  const [scanScope, setScanScope] = useState<LearningScanScope | null>(null);
  const { passive, set } = learning;

  const toggle = useCallback(
    async (sessionId: string, next: boolean) => {
      setNote(null);
      setNote((await set(sessionId, next)).note);
    },
    [set],
  );

  const contributions = useMemo<readonly SessionActionContribution<LearningActionContext>[]>(
    () => [
      {
        group: 'learning',
        order: 10,
        build: context => {
          if (!context.canControl) return null;
          const on = passive.has(context.view.config.id);
          return {
            kind: 'toggle',
            id: LEARNING_ACTION_IDS.passive,
            label: 'Passive learning',
            icon: GraduationCap,
            checked: on,
            detail: on ? 'On' : 'Off',
            onToggle: next => toggle(context.view.config.id, next),
          };
        },
      },
      {
        group: 'learning',
        order: 20,
        build: context =>
          context.canControl
            ? {
                kind: 'run',
                id: LEARNING_ACTION_IDS.scan,
                label: 'Scan this ferret for lessons…',
                icon: ScanSearch,
                run: () => setScanScope({ kind: 'sessions', sessionIds: [context.view.config.id] }),
              }
            : null,
      },
    ],
    [passive, toggle],
  );

  const host = (
    <>
      {note !== null && (
        <div
          role="status"
          aria-live="polite"
          data-learning-action-note=""
          className="fixed inset-x-4 top-[calc(env(safe-area-inset-top,0px)+3.5rem)] z-[55] mx-auto flex max-w-[480px] items-center gap-2 rounded-control border border-accent-border bg-surface-1 px-3 py-1 text-ui text-fg shadow-popover"
        >
          <span className="min-w-0 flex-1">{note}</span>
          <button
            type="button"
            className="kt-btn h-11 w-11 shrink-0 p-0"
            aria-label="Dismiss"
            onClick={() => setNote(null)}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
      {scanScope !== null && (
        <SessionScanHost
          connection={connection}
          fetcher={fetcher}
          scope={scanScope}
          onClose={() => setScanScope(null)}
          onView={() => {
            setScanScope(null);
            onViewLearning?.();
          }}
          sessions={sessions}
          projects={projects}
          accounts={accounts}
          passive={passive}
        />
      )}
    </>
  );

  const passiveFor = useCallback(
    (sessionId: string) => (learning.sessions === null ? null : passive.has(sessionId)),
    [learning.sessions, passive],
  );

  return { contributions, host, passiveFor };
}

/** Mounted only while the dialog is open, so a session page does not read scans it never shows. */
function SessionScanHost({
  connection,
  fetcher,
  scope,
  onClose,
  onView,
  sessions,
  projects,
  accounts,
  passive,
}: {
  readonly connection: DaemonConnection;
  readonly fetcher: DaemonFetch;
  readonly scope: LearningScanScope;
  readonly onClose: () => void;
  readonly onView: () => void;
  readonly sessions: readonly SessionView[] | null;
  readonly projects: readonly FleetProject[];
  readonly accounts: readonly PickerAccount[] | null;
  readonly passive: ReadonlySet<string>;
}) {
  const control = useLearningScan(connection, fetcher);
  return (
    <ScanDialog
      connection={connection}
      fetcher={fetcher}
      control={control}
      initialScope={scope}
      onClose={onClose}
      onView={onView}
      sessions={sessions}
      projects={projects}
      accounts={accounts}
      passive={passive}
    />
  );
}
