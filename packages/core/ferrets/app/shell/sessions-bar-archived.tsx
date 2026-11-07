/**
 * THE ARCHIVED FOOTER under the sessions list: one quiet line — "3 older finished sessions archived"
 * — and the "Show" beside it that lists them again (docs/session-archive.md).
 *
 * The rows it lists are ordinary rows: the same component, the same click (it opens the session), the
 * same status mark the view carries. They are READ-ONLY — no row menu, no pin — because an archived
 * session is a transcript to open, not a ferret to act on, and they never enter the live set's
 * filters, counts, "Needs you" or the bulk stop (`sessions-bar-archived.ts`).
 *
 * Drawn only while a count has been read and is not zero. A daemon too old to serve the route leaves
 * the count unread and the footer absent, so the line never promises a reader something their machine
 * cannot do.
 */

import type { SessionView } from '@ferretry/protocol';
import { useId } from 'react';
import type { DaemonId } from '../lib/daemon-connection.ts';
import { SessionMenuContext } from './session-menu-context.ts';
import { SessionPinContext } from './session-pin-context.ts';
import { archivedFooterShown, archivedFooterWords, archivedRows } from './sessions-bar-archived.ts';
import { SessionsBarRow } from './sessions-bar-row.tsx';

/** What the bar needs to draw the footer; the host's archive hook owns every field. */
export interface SessionsBarArchived {
  /** Every archived session on this machine; `null` until a count read has answered. */
  readonly count: number | null;
  /** The rows the reader's "Show" loaded; `null` until they asked for them. */
  readonly sessions: readonly SessionView[] | null;
  /** Whether the rows are listed under the footer. */
  readonly shown: boolean;
  /** A "Show" load is still waiting on its answer. */
  readonly loading: boolean;
  /** Lists the rows: loads them once, on the reader's press, never on a beat. */
  readonly onShow: () => void;
  /** Collapses the rows again. */
  readonly onHide: () => void;
}

export function SessionsBarArchivedFooter({
  archived,
  daemonId,
  isActive,
  onNavigate,
}: {
  readonly archived: SessionsBarArchived;
  /** The machine the archived sessions run on, which their rows open. */
  readonly daemonId: DaemonId;
  readonly isActive: (view: SessionView) => boolean;
  readonly onNavigate: (to: string) => void;
}) {
  const rowsId = useId();
  const count = archived.count;
  if (!archivedFooterShown(count)) return null;
  const rows = archivedRows(archived.sessions ?? []);
  return (
    <section aria-label="Archived sessions" className="fy-sbar__archived" data-sbar-archived="">
      <div className="fy-sbar__archived-line">
        <span className="fy-sbar__archived-words">{archivedFooterWords(count)}</span>
        <button
          aria-controls={rowsId}
          aria-expanded={archived.shown}
          className="fy-sbar__show"
          data-sbar-archived-toggle=""
          onClick={archived.shown ? archived.onHide : archived.onShow}
          type="button"
        >
          {archived.shown ? 'Hide' : 'Show'}
        </button>
      </div>
      {archived.shown ? (
        rows.length === 0 ? (
          <p className="fy-sbar__empty" role="status">
            {archived.loading ? 'Reading archived sessions…' : 'No archived sessions found.'}
          </p>
        ) : (
          // Read-only rows: the bar's row menu and pin control are for the live set, so neither context
          // reaches an archived row.
          <SessionMenuContext.Provider value={undefined}>
            <SessionPinContext.Provider value={undefined}>
              <ul id={rowsId}>
                {rows.map(view => (
                  <SessionsBarRow
                    active={isActive(view)}
                    daemonId={daemonId}
                    key={view.config.id}
                    learningPassive={false}
                    onNavigate={onNavigate}
                    view={view}
                  />
                ))}
              </ul>
            </SessionPinContext.Provider>
          </SessionMenuContext.Provider>
        )
      ) : null}
    </section>
  );
}
