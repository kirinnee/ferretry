import { useId } from 'react';

import type { DaemonConnection } from '../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../lib/daemon-scope.ts';
import { SessionSurfaceReferences, type SurfaceTerminalLister } from './session-surface-references.tsx';
import { type PaneSnapshotReader, TerminalSnapshotView } from './terminal-snapshot.tsx';

export interface SessionTerminalSurfaceProps {
  readonly connection: DaemonConnection;
  readonly scope: DaemonSessionScope;
  /** Test seam; production keeps TerminalSnapshotView's daemon-bound reader. */
  readonly readSnapshot?: PaneSnapshotReader;
  /** Test seam for the addressing list; production asks the paired daemon. */
  readonly listTerminals?: SurfaceTerminalLister;
}

/**
 * Honest terminal fallback for the workspace.
 *
 * The daemon can prove and snapshot the managed session pane today, and its
 * terminal API can mint a stream-scoped WebSocket ticket. What is still absent
 * is a PWA terminal renderer/deck that redeems that ticket. The attach route is
 * intentionally loopback-only, so a remote reader does not ask it for private
 * host-runtime identity merely to label a snapshot; the public session id is
 * never presented as if it were a tmux name.
 */
export function SessionTerminalSurface({
  connection,
  scope,
  readSnapshot,
  listTerminals,
}: SessionTerminalSurfaceProps) {
  const headingId = useId();

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-2 p-2" aria-labelledby={headingId}>
      {/* ADDRESSING COMES FIRST, above the snapshot, because it is the half of
          this pane that works: the daemon can name and attribute every terminal
          it holds even though this build cannot yet render one interactively. */}
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
          Interactive terminal streaming is not available in the PWA yet. The paired daemon can mint a one-time terminal
          ticket, but this build has no interactive terminal renderer to redeem it. The cached pane snapshot below is
          real daemon evidence and refreshes while this page is visible.
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
