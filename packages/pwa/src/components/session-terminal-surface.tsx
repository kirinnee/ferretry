import type { IFyApiClient } from '@ferretry/protocol';
import { useEffect, useId, useState } from 'react';

import type { DaemonConnection } from '../lib/daemon-connection.ts';
import { sameDaemonConnection } from '../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../lib/daemon-scope.ts';
import { type PaneSnapshotReader, TerminalSnapshotView } from './terminal-snapshot.tsx';

type AttachClient = Pick<IFyApiClient, 'attachTarget'>;

export interface SessionTerminalSurfaceProps {
  readonly client: AttachClient;
  readonly connection: DaemonConnection;
  readonly scope: DaemonSessionScope;
  /** Test seam; production keeps TerminalSnapshotView's daemon-bound reader. */
  readonly readSnapshot?: PaneSnapshotReader;
}

interface RuntimeIdentity {
  readonly connection: DaemonConnection;
  readonly sessionId: string;
  readonly tmuxSession?: string;
  readonly error?: string;
}

/**
 * Honest terminal fallback for the workspace.
 *
 * The daemon can prove and snapshot the managed session pane today, but it
 * cannot mint the one-time WebSocket ticket required by the interactive
 * terminal viewer. Resolve the real tmux identity before labelling the cached
 * snapshot; a session id is never presented as if it were a tmux name.
 */
export function SessionTerminalSurface({ client, connection, scope, readSnapshot }: SessionTerminalSurfaceProps) {
  const headingId = useId();
  const [identity, setIdentity] = useState<RuntimeIdentity | null>(null);
  const current =
    identity !== null && identity.sessionId === scope.sessionId && sameDaemonConnection(identity.connection, connection)
      ? identity
      : null;

  useEffect(() => {
    let live = true;
    setIdentity(null);
    void client.attachTarget(scope.sessionId).then(
      target => {
        if (live) setIdentity({ connection, sessionId: scope.sessionId, tmuxSession: target.tmuxSession });
      },
      reason => {
        if (live) {
          setIdentity({
            connection,
            sessionId: scope.sessionId,
            error: reason instanceof Error ? reason.message : String(reason),
          });
        }
      },
    );
    return () => {
      live = false;
    };
  }, [client, connection, scope.sessionId]);

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-2 p-2" aria-labelledby={headingId}>
      <div className="shrink-0">
        <div className="flex items-center gap-2">
          <h2 className="m-0 font-display text-title font-semibold" id={headingId}>
            Session pane snapshot
          </h2>
          <span className="kt-badge">Read only</span>
        </div>
        <p className="mb-0 mt-1 text-ui text-muted">
          Interactive terminal streaming is not available yet because the paired daemon does not mint a one-time stream
          ticket. The cached pane snapshot below is real daemon evidence and refreshes while this page is visible.
        </p>
      </div>
      {current === null ? (
        <p className="m-0 text-ui text-muted" role="status">
          Verifying the managed session pane…
        </p>
      ) : current.error !== undefined ? (
        <p className="m-0 text-ui text-err" role="alert">
          Could not verify this session’s terminal: {current.error}
        </p>
      ) : current.tmuxSession !== undefined ? (
        <TerminalSnapshotView
          daemon={connection}
          scope={scope}
          tmuxSession={current.tmuxSession}
          {...(readSnapshot === undefined ? {} : { readSnapshot })}
        />
      ) : null}
    </section>
  );
}
