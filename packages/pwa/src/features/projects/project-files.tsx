import type { SessionView } from '@ferretry/protocol';

import { FilesTab } from '../../components/files-tab.tsx';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { daemonSessionScope } from '../../lib/daemon-scope.ts';

/** Files remain rooted in a named session, never a directory a caller supplied. */
export function ProjectFiles({
  connection,
  session,
}: {
  readonly connection: DaemonConnection;
  readonly session: SessionView | null;
}) {
  if (session === null)
    return (
      <p className="m-0 text-meta leading-base text-faint" data-project-files="unavailable">
        Files are unavailable until this project has a session. Ferretry does not browse a project root directly.
      </p>
    );
  return (
    <div className="grid gap-xs" data-project-files={session.config.id}>
      <p className="m-0 text-meta leading-base text-muted">
        Files of most recently active session <span className="font-medium text-fg">{session.config.name}</span>.
      </p>
      <FilesTab
        daemon={connection}
        scope={daemonSessionScope(connection, session.config.id)}
        cwd={session.config.cwd}
      />
    </div>
  );
}
