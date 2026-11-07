import { RouteLink, useRouter } from '@ferretry/app';
import { ArrowLeft, Bot, FolderTree, KanbanSquare, LayoutList } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { type ProjectInfo, ProjectInfoSchema } from '../../contract/index.ts';
import type { ProjectsClient } from '../lib/client.ts';
import { reasonOf } from '../lib/client.ts';
import {
  activeProjectFerrets,
  type FerretRow,
  projectFerrets,
  projectLaunchRequest,
  readFerrets,
  startFerret,
} from '../lib/ferrets.ts';
import { ferretPath, projectBoardPath, projectsPath } from '../lib/paths.ts';
import { ProjectBoardSwitch } from './project-board-switch.tsx';
import { useProjectsSlice } from '../hooks/use-projects.ts';
import { ProjectFiles } from './project-files.tsx';
import { ProjectLaunch } from './project-launch.tsx';
import { ProjectProvenance } from './project-provenance.tsx';
import { projectsStoreFor } from './context.ts';

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

/** The ferrets list as the page reads it: not yet read, failed with nothing to show, stale, or ready. */
export interface FerretsReading {
  readonly ferrets: readonly FerretRow[] | null;
  readonly failure: string | null;
}

function ProjectDetailView({
  client,
  daemon,
  project,
  reading: read,
  onLaunch,
  onNavigate,
  onBack,
}: {
  readonly client: ProjectsClient;
  readonly daemon: string;
  readonly project: ProjectInfo;
  readonly reading: FerretsReading;
  readonly onLaunch: (request: ReturnType<typeof projectLaunchRequest>) => Promise<void>;
  readonly onNavigate: (to: string) => void;
  readonly onBack: (to: string) => void;
}) {
  /**
   * THREE READINGS OF THE FERRET LIST, NEVER TWO — the same rule the projects hub states for the registry, applied to
   * every panel on this screen rather than to one of them.
   *
   * `null` ferrets is "not read", and the page keeps it null until a read SUCCEEDS, so a failure with no rows is a
   * failed first read while a failure WITH rows is a stale list it deliberately preserved. Collapsing any of that to an
   * empty array is how "unknown" became the affirmative claims "this project has no ferret" and "nothing exposes a
   * board".
   */
  const reading: 'unread' | 'failed' | 'stale' | 'ready' =
    read.ferrets === null ? (read.failure === null ? 'unread' : 'failed') : read.failure === null ? 'ready' : 'stale';
  const set = useMemo(() => (read.ferrets === null ? [] : projectFerrets(project.path, read.ferrets)), [project, read]);
  const active = useMemo(() => activeProjectFerrets(set), [set]);
  return (
    <main
      className="grid h-full min-h-0 content-start gap-panel overflow-y-auto p-panel"
      data-project-detail={project.id}
    >
      <div className="flex flex-wrap items-start justify-between gap-md border-b border-border-strong pb-panel">
        <div className="grid min-w-0 gap-xs">
          <button
            className="w-fit text-meta text-muted hover:text-fg"
            type="button"
            onClick={() => onBack(projectsPath(daemon))}
          >
            <ArrowLeft size={14} aria-hidden="true" /> Back to Projects
          </button>
          <p className="m-0 text-meta font-semibold uppercase tracking-wide text-muted">Workspace registry / project</p>
          <h1 className="m-0 font-display text-display font-bold tracking-display">{project.name}</h1>
        </div>
        <div className="flex flex-wrap items-start gap-md">
          <button
            className="kt-btn kt-btn--sm"
            type="button"
            data-project-lanes-link={project.id}
            onClick={() => onNavigate(projectBoardPath(daemon, project.id))}
          >
            Lanes ✎
          </button>
          <ProjectLaunch project={project} onLaunch={onLaunch} />
        </div>
      </div>

      <div className="grid gap-panel lg:grid-cols-[minmax(16rem,0.72fr)_minmax(0,1.5fr)]">
        <div className="grid content-start gap-panel">
          <Section icon={<LayoutList className="text-muted" size={16} aria-hidden="true" />} title="Provenance">
            <ProjectProvenance project={project} />
            {project.lastActivity && (
              <p className="m-0 text-meta text-muted">Project activity: {project.lastActivity}</p>
            )}
          </Section>
          <Section icon={<KanbanSquare className="text-muted" size={16} aria-hidden="true" />} title="Board">
            <ProjectBoardSwitch client={client} projectId={project.id} />
          </Section>
        </div>
        <div className="grid gap-panel">
          <Section icon={<Bot className="text-muted" size={16} aria-hidden="true" />} title="Active ferrets">
            {reading === 'unread' ? (
              <p className="m-0 text-meta text-muted" aria-busy="true" data-project-agents="unread">
                Loading this daemon’s ferrets…
              </p>
            ) : reading === 'failed' ? (
              <p className="m-0 text-meta text-warn" role="status" data-project-agents="failed">
                Could not read this daemon’s ferrets: {read.failure ?? 'the read failed'}.
              </p>
            ) : (
              <>
                {/* STALE ROWS STAY ON SCREEN. The page keeps the ferrets it already had when a refresh fails,
                    precisely so a transient failure cannot read as an empty fleet — and Files below are still drawn
                    from that same set. Replacing the rail with the warning alone contradicted both. */}
                {reading === 'stale' && (
                  <p className="m-0 text-meta text-warn" role="status" data-project-agents="stale">
                    The ferret list is stale: {read.failure ?? 'the refresh failed'}.
                  </p>
                )}
                {active.length === 0 ? (
                  <p className="m-0 text-meta text-faint" data-project-agents="empty">
                    No active ferrets are working in this project.
                  </p>
                ) : (
                  <ul className="m-0 grid list-none gap-xs p-0" data-project-agents="ready">
                    {active.map(ferret => (
                      <li
                        className="flex min-w-0 items-center justify-between gap-sm rounded-control border border-border-strong bg-surface-2 px-control-x py-2"
                        key={ferret.id}
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-ui font-medium text-fg">{ferret.name}</span>
                          <span className="mono block truncate text-2xs text-muted">
                            {ferret.harness} · {ferret.state}
                          </span>
                        </span>
                        <RouteLink
                          className="kt-btn kt-btn--sm shrink-0"
                          to={ferretPath(daemon, ferret.id)}
                          onNavigate={onNavigate}
                        >
                          Open
                        </RouteLink>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </Section>
          <Section
            icon={<FolderTree className="text-muted" size={16} aria-hidden="true" />}
            title="Files of this project’s ferrets"
          >
            {/* AN UNREAD LIST IS NOT AN ABSENT FERRET. `ProjectFiles` says "this project has no ferret", which is a
                conclusion only a SUCCESSFUL read supports; handing it the collapsed empty set turned "not known yet"
                into that claim. */}
            {reading === 'unread' ? (
              <p className="m-0 text-meta text-muted" aria-busy="true" data-project-files="unread">
                Files are unknown until this daemon’s ferret list is read.
              </p>
            ) : reading === 'failed' ? (
              <p className="m-0 text-meta text-warn" role="status" data-project-files="failed">
                Could not read this daemon’s ferrets, so this project’s files are unknown:{' '}
                {read.failure ?? 'the read failed'}.
              </p>
            ) : (
              <ProjectFiles daemon={daemon} ferret={set[0] ?? null} onNavigate={onNavigate} />
            )}
          </Section>
        </div>
      </div>
    </main>
  );
}

/** Route-bound detail screen. It fences every read and write to its explicit daemon connection (the client). */
export function ProjectDetailPage({
  client,
  daemon,
  projectId,
}: {
  readonly client: ProjectsClient;
  readonly daemon: string;
  readonly projectId: string;
}) {
  const store = projectsStoreFor(client);
  const { navigate, back } = useRouter();
  const projects = useProjectsSlice(store);
  const [ferrets, setFerrets] = useState<FerretsReading>({ ferrets: null, failure: null });

  useEffect(() => {
    let current = true;
    void readFerrets(client)
      .then(rows => {
        if (current) setFerrets({ ferrets: rows, failure: null });
      })
      .catch((cause: unknown) => {
        // A failed read never blanks a good list.
        if (current) setFerrets(previous => ({ ferrets: previous.ferrets, failure: reasonOf(cause) }));
      });
    return () => {
      current = false;
    };
  }, [client]);

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
          <button className="kt-btn w-fit" type="button" onClick={() => navigate(projectsPath(daemon))}>
            View registered projects
          </button>
        </section>
      </main>
    );

  const launch = async (request: ReturnType<typeof projectLaunchRequest>): Promise<void> => {
    const created = await startFerret(client, request);
    navigate(ferretPath(daemon, created.id));
  };
  return (
    <ProjectDetailView
      client={client}
      daemon={daemon}
      project={project}
      reading={ferrets}
      onLaunch={launch}
      onNavigate={navigate}
      onBack={back}
    />
  );
}
