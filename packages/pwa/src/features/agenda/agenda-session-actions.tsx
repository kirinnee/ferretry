/**
 * AGENDA MODE IN A FERRET'S ACTIONS MENU: one "Agenda mode" menuitemcheckbox, contributed to the session
 * action registry, and the polite status line that says what the switch did (docs/agenda.md).
 *
 * The switch decides only what the ferret is TOLD — whether it keeps an agenda the owner can see. Its
 * instructions were fixed when it started, so a change takes effect at its next launch and nothing is
 * sent to it; the daemon's own `note` says so, and the host shows it.
 *
 * The state is the session's own `config.agenda` (absent means OFF). Until the list re-reads that
 * session, the answer the daemon gave is what the toggle shows, so it never flips back under the reader.
 */

import type { SessionView } from '@ferretry/protocol';
import { ListTodo, X } from 'lucide-react';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { patchSessionAgenda } from '../../lib/agenda-api.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import type { DaemonFetch } from '../../lib/runtime-models.ts';
import type { SessionActionContribution } from '../session-actions/registry.ts';
import { agendaOn } from '../session-info/info-model.ts';

/** What the entry needs to know about the ferret the menu is for. */
export interface AgendaActionContext {
  readonly view: SessionView;
  readonly canControl: boolean;
}

export const AGENDA_ACTION_ID = 'agenda';

export interface AgendaSessionActions {
  readonly contributions: readonly SessionActionContribution<AgendaActionContext>[];
  /** The switch's status line; render it beside the page. */
  readonly host: ReactNode;
  /** Whether one ferret is told to keep an agenda, with an answer the list has not caught up with yet. */
  readonly onFor: (view: SessionView) => boolean;
  /**
   * Switches one ferret from outside the Actions menu — its header mark. A refusal is said in the same
   * status line as the answer, because a mark has no menu of its own to report it in.
   */
  readonly tap: (sessionId: string, next: boolean) => Promise<void>;
}

export function useAgendaSessionActions({
  connection,
  fetcher,
}: {
  readonly connection: DaemonConnection;
  readonly fetcher: DaemonFetch;
}): AgendaSessionActions {
  const [note, setNote] = useState<string | null>(null);
  const [answered, setAnswered] = useState<ReadonlyMap<string, boolean>>(new Map());

  const onFor = useCallback((view: SessionView) => answered.get(view.config.id) ?? agendaOn(view), [answered]);

  const toggle = useCallback(
    async (sessionId: string, next: boolean) => {
      setNote(null);
      const result = await patchSessionAgenda(connection, sessionId, next, fetcher);
      setAnswered(current => new Map(current).set(sessionId, agendaOn(result.view)));
      setNote(result.note);
    },
    [connection, fetcher],
  );

  const tap = useCallback(
    async (sessionId: string, next: boolean) => {
      try {
        await toggle(sessionId, next);
      } catch (reason) {
        setNote(`Agenda mode could not be switched: ${reason instanceof Error ? reason.message : String(reason)}`);
      }
    },
    [toggle],
  );

  const contributions = useMemo<readonly SessionActionContribution<AgendaActionContext>[]>(
    () => [
      {
        group: 'tools',
        order: 100,
        build: context => {
          if (!context.canControl) return null;
          const on = onFor(context.view);
          return {
            kind: 'toggle',
            id: AGENDA_ACTION_ID,
            label: 'Agenda mode',
            icon: ListTodo,
            checked: on,
            detail: on ? 'On' : 'Off',
            onToggle: next => toggle(context.view.config.id, next),
          };
        },
      },
    ],
    [onFor, toggle],
  );

  const host =
    note === null ? null : (
      <div
        role="status"
        aria-live="polite"
        data-agenda-action-note=""
        className="fixed inset-x-4 top-[calc(env(safe-area-inset-top,0px)+3.5rem)] z-[55] mx-auto flex max-w-[480px] items-center gap-2 rounded-control border border-accent-border bg-surface px-3 py-1 text-ui text-fg shadow-popover"
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
    );

  return { contributions, host, onFor, tap };
}
