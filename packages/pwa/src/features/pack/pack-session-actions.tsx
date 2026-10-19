/**
 * PACK MODE IN A FERRET'S ACTIONS MENU: one "Pack mode" menuitemcheckbox, contributed to the session
 * action registry, and the polite status line that says what the switch did (docs/pack-mode.md).
 *
 * The switch decides only what the ferret is TOLD — that it may delegate to sub-ferrets and pick the
 * model each runs on. Its instructions were fixed when it started, so a change takes effect at its
 * next launch and nothing is sent to it; the daemon's own `note` says so, and the host shows it. The
 * machine's own switch and the depth limit still apply on top of it.
 *
 * The state is the session's own `config.pack` (absent means on). Until the list re-reads that
 * session, the answer the daemon gave is what the toggle shows, so it never flips back under the reader.
 */

import type { SessionView } from '@ferretry/protocol';
import { PawPrint, X } from 'lucide-react';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { patchSessionPack } from '../../lib/pack-api.ts';
import type { DaemonFetch } from '../../lib/runtime-models.ts';
import type { SessionActionContribution } from '../session-actions/registry.ts';
import { packOn } from '../session-info/info-model.ts';

/** What the entry needs to know about the ferret the menu is for. */
export interface PackActionContext {
  readonly view: SessionView;
  readonly canControl: boolean;
}

export const PACK_ACTION_ID = 'pack';

export interface PackSessionActions {
  readonly contributions: readonly SessionActionContribution<PackActionContext>[];
  /** The switch's status line; render it beside the page. */
  readonly host: ReactNode;
  /** Whether one ferret may delegate, with an answer the list has not caught up with yet. */
  readonly onFor: (view: SessionView) => boolean;
}

export function usePackSessionActions({
  connection,
  fetcher,
}: {
  readonly connection: DaemonConnection;
  readonly fetcher: DaemonFetch;
}): PackSessionActions {
  const [note, setNote] = useState<string | null>(null);
  const [answered, setAnswered] = useState<ReadonlyMap<string, boolean>>(new Map());

  const onFor = useCallback((view: SessionView) => answered.get(view.config.id) ?? packOn(view), [answered]);

  const toggle = useCallback(
    async (sessionId: string, next: boolean) => {
      setNote(null);
      const result = await patchSessionPack(connection, sessionId, next, fetcher);
      setAnswered(current => new Map(current).set(sessionId, packOn(result.view)));
      setNote(result.note);
    },
    [connection, fetcher],
  );

  const contributions = useMemo<readonly SessionActionContribution<PackActionContext>[]>(
    () => [
      {
        group: 'tools',
        order: 95,
        build: context => {
          if (!context.canControl) return null;
          const on = onFor(context.view);
          return {
            kind: 'toggle',
            id: PACK_ACTION_ID,
            label: 'Pack mode',
            icon: PawPrint,
            checked: on,
            detail: on ? 'On · next launch' : 'Off · next launch',
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
        data-pack-action-note=""
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

  return { contributions, host, onFor };
}
