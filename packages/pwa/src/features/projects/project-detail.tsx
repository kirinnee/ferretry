import { type ProjectInfo, ProjectInfoSchema, type SessionView, type StartSessionRequest } from '@ferretry/protocol';
import { ArrowLeft, Bot, FolderTree, LayoutList } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useProjectsSlice } from '../../hooks/use-projects.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { daemonProjectsPath, daemonSessionPath } from '../../lib/pages/routes.ts';
import { useRouter } from '../../lib/router.tsx';
import { useAppStore } from '../../lib/store.tsx';
import { ProjectBoards } from './project-boards.tsx';
import { activeProjectSessions, projectBoardSessions, projectSessions } from './project-detail-model.ts';
import { ProjectFiles } from './project-files.tsx';
import { ProjectLaunch } from './project-launch.tsx';
import { ProjectProvenance } from './project-provenance.tsx';

function Section({
  title,
  icon,
  children,
}: {
  readonly title: string;
  readonly icon: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="kt-panel grid gap-sm p-panel" aria-label={title}>
      <h2 className="m-0 flex items-center gap-xs text-title font-semibold text-fg">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

function ProjectDetailView({
  connection,
  project,
  sessions,
  fleetStatus,
  fleetError,
  onLaunch,
}: {
  readonly connection: DaemonConnection;
  readonly project: ProjectInfo;
  readonly sessions: readonly SessionView[] | null;
  readonly fleetStatus: string;
  readonly fleetError: string | null;
  readonly onLaunch: (request: StartSessionRequest) => Promise<void>;
}) {
  const { navigate } = useRouter();
  /**
   * THREE READINGS OF THE SESSION LIST, NEVER TWO — the same rule the projects
   * hub states for the registry, applied to every panel on this screen rather
   * than to one of them.
   *
   * `null` sessions is "not read", and the fleet store keeps it null until a read
   * SUCCEEDS, so an error with no rows is a failed first read while an error WITH
   * rows is a stale list it deliberately preserved. Collapsing any of that to an
   * empty array is how "unknown" became the affirmative claims "this project has
   * no session" and "nothing exposes a board".
   */
  const reading: 'unread' | 'failed' | 'stale' | 'ready' =
    sessions === null ? (fleetStatus === 'error' ? 'failed' : 'unread') : fleetStatus === 'error' ? 'stale' : 'ready';
  const set = useMemo(() => (sessions === null ? [] : projectSessions(project, sessions)), [project, sessions]);
  const active = useMemo(() => activeProjectSessions(set), [set]);
  const boards = useMemo(() => projectBoardSessions(set), [set]);
  return (
    <main className="grid min-h-0 gap-panel p-panel" data-project-detail={project.id}>
      <div className="flex flex-wrap items-start justify-between gap-md border-b border-border-strong pb-panel">
        <div className="grid min-w-0 gap-xs">
          <button
            className="w-fit text-meta text-muted hover:text-fg"
            type="button"
            onClick={() => navigate(daemonProjectsPath(connection.daemonId))}
          >
            <ArrowLeft size={14} aria-hidden="true" /> Back to Projects
          </button>
          <p className="m-0 text-meta font-semibold uppercase tracking-wide text-muted">Workspace registry / project</p>
          <h1 className="m-0 font-display text-display font-bold tracking-display">{project.name}</h1>
        </div>
        <ProjectLaunch project={project} onLaunch={onLaunch} />
      </div>

      <div className="grid gap-panel lg:grid-cols-[minmax(16rem,0.72fr)_minmax(0,1.5fr)]">
        <Section icon={<LayoutList className="text-muted" size={16} aria-hidden="true" />} title="Provenance">
          <ProjectProvenance project={project} />
          {project.lastActivity && <p className="m-0 text-meta text-muted">Project activity: {project.lastActivity}</p>}
        </Section>
        <div className="grid gap-panel">
          <Section
            icon={<Bot className="text-muted" size={16} aria-hidden="true" />}
            title="Active agents and sessions"
          >
            {reading === 'unread' ? (
              <p className="m-0 text-meta text-muted" aria-busy="true" data-project-agents="unread">
                Loading this daemon’s sessions…
              </p>
            ) : reading === 'failed' ? (
              <p className="m-0 text-meta text-warn" role="status" data-project-agents="failed">
                Could not read this daemon’s sessions: {fleetError ?? 'the read failed'}.
              </p>
            ) : (
              <>
                {/* STALE ROWS STAY ON SCREEN. `fleet-store.ts` keeps the sessions
                    it already had when a refresh fails, precisely so a transient
                    failure cannot read as an empty fleet — and Files and Boards
                    below are still drawn from that same set. Replacing the rail
                    with the warning alone contradicted both. */}
                {reading === 'stale' && (
                  <p className="m-0 text-meta text-warn" role="status" data-project-agents="stale">
                    The session list is stale: {fleetError ?? 'the refresh failed'}.
                  </p>
                )}
                {active.length === 0 ? (
                  <p className="m-0 text-meta text-faint" data-project-agents="empty">
                    No active agents are working in this project.
                  </p>
                ) : (
                  <ul className="m-0 grid list-none gap-xs p-0" data-project-agents="ready">
                    {active.map(session => (
                      <li
                        className="flex min-w-0 items-center justify-between gap-sm rounded-control border border-border-strong bg-surface-2 px-control-x py-2"
                        key={session.config.id}
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-ui font-medium text-fg">{session.config.name}</span>
                          <span className="mono block truncate text-2xs text-muted">
                            {session.config.agent} · {session.state.status}
                          </span>
                        </span>
                        <button
                          className="kt-btn kt-btn--sm shrink-0"
                          type="button"
                          onClick={() => navigate(daemonSessionPath(connection.daemonId, session.config.id))}
                        >
                          Open
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </Section>
          <Section
            icon={<FolderTree className="text-muted" size={16} aria-hidden="true" />}
            title="Files of this project’s sessions"
          >
            {/* AN UNREAD LIST IS NOT AN ABSENT SESSION. `ProjectFiles` says
                "this project has no session", which is a conclusion only a
                SUCCESSFUL read supports; handing it the collapsed empty set
                turned "not known yet" into that claim. */}
            {reading === 'unread' ? (
              <p className="m-0 text-meta text-muted" aria-busy="true" data-project-files="unread">
                Files are unknown until this daemon’s session list is read.
              </p>
            ) : reading === 'failed' ? (
              <p className="m-0 text-meta text-warn" role="status" data-project-files="failed">
                Could not read this daemon’s sessions, so this project’s files are unknown:{' '}
                {fleetError ?? 'the read failed'}.
              </p>
            ) : (
              <ProjectFiles connection={connection} session={set[0] ?? null} />
            )}
          </Section>
          <Section
            icon={<LayoutList className="text-muted" size={16} aria-hidden="true" />}
            title="Boards of this project’s sessions"
          >
            {reading === 'unread' ? (
              <p className="m-0 text-meta text-muted" aria-busy="true" data-project-boards="unread">
                Boards are unknown until this daemon’s session list is read.
              </p>
            ) : reading === 'failed' ? (
              <p className="m-0 text-meta text-warn" role="status" data-project-boards="failed">
                Could not read this daemon’s sessions, so this project’s boards are unknown:{' '}
                {fleetError ?? 'the read failed'}.
              </p>
            ) : (
              <ProjectBoards sessions={boards} />
            )}
          </Section>
        </div>
      </div>
    </main>
  );
}

/** Route-bound detail screen. It fences every read and write to its explicit daemon connection. */
export function ProjectDetailPage({
  connection,
  projectId,
}: {
  readonly connection: DaemonConnection;
  readonly projectId: string;
}) {
  const store = useAppStore();
  const { navigate } = useRouter();
  const projects = useProjectsSlice(store.projects, connection);
  const subscribe = useCallback((listener: () => void) => store.fleet.subscribe(listener), [store.fleet]);
  const snapshot = useSyncExternalStore(
    subscribe,
    () => store.fleet.getSnapshot(),
    () => store.fleet.getSnapshot(),
  );
  const fleet = snapshot.daemons.get(connection.daemonId);
  useEffect(() => {
    void store.fleet.hydrate(connection).catch(() => {});
  }, [connection, store.fleet]);

  if (projects.projects === null) {
    if (projects.status === 'error')
      return (
        <section className="kt-panel m-panel p-panel" role="alert">
          Could not read this daemon’s project registry: {projects.error}
        </section>
      );
    return (
      <section className="kt-panel m-panel p-panel" aria-busy="true">
        Loading this daemon’s project registry…
      </section>
    );
  }
  const candidate = projects.projects.find(project => project.id === projectId);
  const parsed = candidate === undefined ? undefined : ProjectInfoSchema.safeParse(candidate);
  const project = parsed?.success ? parsed.data : undefined;
  if (project === undefined)
    return (
      <main className="grid gap-panel p-panel" data-project-detail="missing">
        <section className="kt-panel grid gap-sm p-panel" role="status">
          <h1 className="m-0 font-display text-title font-bold">Project unavailable</h1>
          <p className="m-0 text-ui text-muted">
            This daemon no longer holds that project. The bookmark was kept so you can see what changed.
          </p>
          <button
            className="kt-btn w-fit"
            type="button"
            onClick={() => navigate(daemonProjectsPath(connection.daemonId))}
          >
            View registered projects
          </button>
        </section>
      </main>
    );

  const launch = async (request: StartSessionRequest): Promise<void> => {
    const created = await (await store.clients.client(connection)).start(request);
    navigate(daemonSessionPath(connection.daemonId, created.config.id));
  };
  return (
    <ProjectDetailView
      connection={connection}
      project={project}
      sessions={fleet?.sessions ?? null}
      fleetStatus={fleet?.status ?? 'idle'}
      fleetError={fleet?.error ?? null}
      onLaunch={launch}
    />
  );
}
