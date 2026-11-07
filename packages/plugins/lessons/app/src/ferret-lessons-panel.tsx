/**
 * LESSONS IN A FERRET'S TOOLBAR: "Passive lessons" (a switch) and "Scan this ferret for lessons…".
 *
 * The switch only decides whether the ferret is INSTRUCTED to file lessons. Switching a running ferret
 * re-instructs it with a queued message that costs it one turn; the daemon's own note says so, and this
 * panel shows that note in a polite status line. The scan opens the same dialog as the Lessons screen,
 * scoped to this ferret — estimate first, and nothing runs until Start.
 */

import { GraduationCap, ScanSearch, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@ferretry/app/ui';
import type { LessonsFerret, LessonsScanScope } from '../../contract/index.ts';
import { type LessonsConnection, lessonsErrorMessage } from './api.ts';
import { usePassiveLessons } from './passive.tsx';
import { ScanDialog } from './scan-dialog.tsx';
import { useLessonsScan } from './use-scan.ts';

export interface FerretLessonsPanelProps {
  readonly connection: LessonsConnection;
  /** The ferret the toolbar is for. */
  readonly ferretId: string;
  readonly ferrets: readonly LessonsFerret[] | null;
  /** "View in Lessons" after a scan: the host takes the reader to the screen. */
  readonly onViewLessons?: () => void;
  /** Test seam: how often an open scan dialog re-reads a running scan. */
  readonly scanPollMs?: number;
}

export function FerretLessonsPanel({
  connection,
  ferretId,
  ferrets,
  onViewLessons,
  scanPollMs,
}: FerretLessonsPanelProps) {
  const lessons = usePassiveLessons(connection);
  const [note, setNote] = useState<string | null>(null);
  const [scanScope, setScanScope] = useState<LessonsScanScope | null>(null);
  const known = lessons.records !== null;
  const on = lessons.passive.has(ferretId);

  const toggle = async (next: boolean) => {
    setNote(null);
    try {
      setNote((await lessons.set(ferretId, next)).note);
    } catch (reason) {
      setNote(lessonsErrorMessage(reason));
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-2" data-ferret-lessons="">
      <label className="flex min-h-[44px] cursor-pointer items-center gap-2 text-ui">
        <input
          type="checkbox"
          role="switch"
          checked={on}
          disabled={!known}
          onChange={event => void toggle(event.target.checked)}
        />
        <GraduationCap size={15} aria-hidden="true" />
        Passive lessons
        <span className="text-meta text-muted">{known ? (on ? 'On' : 'Off') : ''}</span>
      </label>
      <Button
        className="min-h-[44px] items-center gap-1.5"
        onClick={() => setScanScope({ kind: 'ferrets', ferretIds: [ferretId] })}
      >
        <ScanSearch size={15} aria-hidden="true" />
        Scan this ferret for lessons…
      </Button>
      {note !== null && (
        <div
          role="status"
          aria-live="polite"
          data-lessons-action-note=""
          className="flex items-center gap-2 rounded-control border border-accent-border bg-surface px-3 py-1 text-ui text-fg"
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
        <FerretScanHost
          connection={connection}
          scope={scanScope}
          onClose={() => setScanScope(null)}
          onView={() => {
            setScanScope(null);
            onViewLessons?.();
          }}
          ferrets={ferrets}
          passive={lessons.passive}
          pollMs={scanPollMs}
        />
      )}
    </div>
  );
}

/** Mounted only while the dialog is open, so a ferret's toolbar does not read scans it never shows. */
function FerretScanHost({
  connection,
  scope,
  onClose,
  onView,
  ferrets,
  passive,
  pollMs,
}: {
  readonly connection: LessonsConnection;
  readonly scope: LessonsScanScope;
  readonly onClose: () => void;
  readonly onView: () => void;
  readonly ferrets: readonly LessonsFerret[] | null;
  readonly passive: ReadonlySet<string>;
  readonly pollMs: number | undefined;
}) {
  const control = useLessonsScan(connection, pollMs);
  return (
    <ScanDialog
      connection={connection}
      control={control}
      initialScope={scope}
      onClose={onClose}
      onView={onView}
      ferrets={ferrets}
      passive={passive}
    />
  );
}
