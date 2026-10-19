/**
 * HYPERMEDIA IN A FERRET'S ACTIONS MENU: one "Hypermedia" menuitemcheckbox, contributed to the session
 * action registry, and the polite status line that says what the switch did (docs/hypermedia.md).
 *
 * The switch decides only what the ferret is TOLD — that it may explain with diagrams, drawings,
 * interactive pages and media. Its instructions were fixed when it started, so a change takes effect at
 * its next launch and nothing is sent to it; the daemon's own `note` says so, and the host shows it.
 *
 * The state is the session's own `config.hypermedia` (absent means the mode default: on for interactive, off for auto). Until the list re-reads that
 * session, the answer the daemon gave is what the toggle shows, so it never flips back under the reader.
 */

import type { SessionView } from '@ferretry/protocol';
import { Shapes, X } from 'lucide-react';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { patchSessionHypermedia } from '../../lib/hypermedia-api.ts';
import type { DaemonFetch } from '../../lib/runtime-models.ts';
import type { SessionActionContribution } from '../session-actions/registry.ts';
import { hypermediaOn } from '../session-info/info-model.ts';

/** What the entry needs to know about the ferret the menu is for. */
export interface HypermediaActionContext {
  readonly view: SessionView;
  readonly canControl: boolean;
}

export const HYPERMEDIA_ACTION_ID = 'hypermedia';

export interface HypermediaSessionActions {
  readonly contributions: readonly SessionActionContribution<HypermediaActionContext>[];
  /** The switch's status line; render it beside the page. */
  readonly host: ReactNode;
  /** Whether one ferret is told to use hypermedia, with an answer the list has not caught up with yet. */
  readonly onFor: (view: SessionView) => boolean;
}

export function useHypermediaSessionActions({
  connection,
  fetcher,
}: {
  readonly connection: DaemonConnection;
  readonly fetcher: DaemonFetch;
}): HypermediaSessionActions {
  const [note, setNote] = useState<string | null>(null);
  const [answered, setAnswered] = useState<ReadonlyMap<string, boolean>>(new Map());

  const onFor = useCallback((view: SessionView) => answered.get(view.config.id) ?? hypermediaOn(view), [answered]);

  const toggle = useCallback(
    async (sessionId: string, next: boolean) => {
      setNote(null);
      const result = await patchSessionHypermedia(connection, sessionId, next, fetcher);
      setAnswered(current => new Map(current).set(sessionId, hypermediaOn(result.view)));
      setNote(result.note);
    },
    [connection, fetcher],
  );

  const contributions = useMemo<readonly SessionActionContribution<HypermediaActionContext>[]>(
    () => [
      {
        group: 'tools',
        order: 90,
        build: context => {
          if (!context.canControl) return null;
          const on = onFor(context.view);
          return {
            kind: 'toggle',
            id: HYPERMEDIA_ACTION_ID,
            label: 'Hypermedia',
            icon: Shapes,
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
        data-hypermedia-action-note=""
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

/** The mark a ferret's header carries while it is told it may use hypermedia. */
export function HypermediaMark() {
  return (
    <span
      className="inline-flex shrink-0 items-center text-accent"
      data-hypermedia-mark=""
      title="Hypermedia on: this ferret may explain with diagrams, drawings, interactive pages and media"
    >
      <Shapes size={13} aria-hidden="true" />
      <span className="sr-only">Hypermedia on</span>
    </span>
  );
}
