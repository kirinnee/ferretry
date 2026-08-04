import { useId } from 'react';

import type { DaemonConnection } from '../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../lib/daemon-scope.ts';
import { SessionSurfaceReferences, type SurfaceTerminalLister } from './session-surface-references.tsx';
import { SessionTerminalDeck, type TerminalDeckDependencies } from './session-terminal-deck.tsx';
import { type PaneSnapshotReader, TerminalSnapshotView } from './terminal-snapshot.tsx';

export interface SessionTerminalSurfaceProps {
  readonly connection: DaemonConnection;
  readonly scope: DaemonSessionScope;
  /** Test seam; production keeps TerminalSnapshotView's daemon-bound reader. */
  readonly readSnapshot?: PaneSnapshotReader;
  /** Test seam for the addressing list; production asks the paired daemon. */
  readonly listTerminals?: SurfaceTerminalLister;
  /** Test seam for the live deck; production opens real sockets. */
  readonly deck?: TerminalDeckDependencies;
}

/**
 * The terminal half of the workspace: co-control first, then addressing, then
 * the read-only session pane.
 *
 * THE ORDER IS THE ARGUMENT. The deck is what the reader came for — live shells
 * they and an agent drive together — so it is first and it is the tall one. The
 * addressing rows below it are how a shell gets NAMED in a message, which is a
 * different act from using one and belongs under it. The session pane snapshot
 * is last because it is not a shell at all: it is the agent's own managed pane,
 * read-only by construction, and burying the live deck under it (as this file
 * did while no renderer existed) misrepresented which one is the real surface.
 *
 * The attach route behind the snapshot is deliberately loopback-only, so a
 * remote reader does not ask it for private host-runtime identity merely to
 * label a snapshot; the public session id is never presented as a tmux name.
 */
export function SessionTerminalSurface({
  connection,
  scope,
  readSnapshot,
  listTerminals,
  deck,
}: SessionTerminalSurfaceProps) {
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="flex min-h-0 flex-1 flex-col gap-2 p-2">
      <div className="flex min-h-[18rem] flex-1 flex-col overflow-hidden rounded-md border border-border">
        <SessionTerminalDeck
          connection={connection}
          scope={scope}
          {...(deck === undefined ? {} : { dependencies: deck })}
        />
      </div>
      <div className="shrink-0">
        <SessionSurfaceReferences
          connection={connection}
          scope={scope}
          {...(listTerminals === undefined ? {} : { listTerminals })}
        />
      </div>
      <div className="shrink-0">
        <div className="flex items-center gap-2">
          <h2 className="m-0 font-display text-title font-semibold" id={headingId}>
            Session pane snapshot
          </h2>
          <span className="kt-badge">Read only</span>
        </div>
        <p className="mb-0 mt-1 text-ui text-muted">
          This is the agent’s own managed pane, not one of the shells above. The cached snapshot is real daemon evidence
          and refreshes while this page is visible.
        </p>
      </div>
      <TerminalSnapshotView
        daemon={connection}
        scope={scope}
        {...(readSnapshot === undefined ? {} : { readSnapshot })}
      />
    </section>
  );
}
