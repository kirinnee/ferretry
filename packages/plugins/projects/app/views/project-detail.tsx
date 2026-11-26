import { useAppHook, usePluginOffered, useRouter } from '@ferretry/app';
import { Loading, RouteLink } from '@ferretry/app/ui';
import { ArrowLeft, Bot, FolderTree, GitPullRequest, KanbanSquare, LayoutList, UserRound } from 'lucide-react';
import { createElement, type ReactNode, useEffect, useMemo, useState } from 'react';
import {
  isProjectsInsights,
  type ProjectInfo,
  ProjectInfoSchema,
  PROJECTS_INSIGHTS_HOOK,
} from '../../contract/index.ts';
import type { ProjectsClient } from '../lib/client.ts';
import { reasonOf } from '../lib/client.ts';
import { activeProjectFerrets, type FerretRow, projectFerrets, readFerrets } from '../lib/ferrets.ts';
import { ferretPath, projectLanesPath, projectsPath } from '../lib/paths.ts';
import { startFerretHref } from '../lib/start-href.ts';
import { ProjectAccountLinks } from '../features/create-project/account-links.tsx';
import { ProjectBoardSwitch } from './project-board-switch.tsx';
import { useProjectsSlice } from '../hooks/use-projects.ts';
import { ProjectFiles } from './project-files.tsx';
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
  onNavigate,
  onBack,
}: {
  readonly client: ProjectsClient;
  readonly daemon: string;
  readonly project: ProjectInfo;
  readonly reading: FerretsReading;
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
  // What another plugin tells about this project (PRs & CI, today), if one is installed on this daemon.
  const boardOffered = usePluginOffered(daemon, 'board');
  const provided = useAppHook(daemon, PROJECTS_INSIGHTS_HOOK);
  const insights = isProjectsInsights(provided) ? provided : undefined;
  // A saved link changes the project record, so the registry is read again and the list re-renders from the daemon's word.
  const onAccountsSaved = (): void => {
    void projectsStoreFor(client)
      .refresh()
      .catch(() => {});
  };
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
          <h1 className="m-0 font-display text-display font-bold tracking-display">{project.name}</h1>
        </div>
        <div className="flex flex-wrap items-start gap-md">
          <button
            className="kt-btn kt-btn--sm"
            type="button"
            data-project-lanes-link={project.id}
            onClick={() => onNavigate(projectLanesPath(daemon, project.id))}
          >
            Edit lanes
          </button>
          <div className="grid shrink-0 justify-items-start gap-1">
            <button
              className="kt-btn min-h-[44px] max-w-full justify-center"
              style={{ height: 'auto' }}
              data-project-start=""
              data-variant="primary"
              type="button"
              onClick={() => onNavigate(startFerretHref(daemon, project.path))}
            >
              Start a ferret here
            </button>
            <p className="m-0 text-meta text-muted">Starts in this project’s folder</p>
          </div>
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
          <Section icon={<UserRound className="text-muted" size={16} aria-hidden="true" />} title="GitHub accounts">
            {/* Keyed by project: same-daemon navigation reuses this tree, and an open editor's draft must not follow
                the person to the next project (its save would write the previous project's picks to the new id). */}
            <ProjectAccountLinks
              key={project.id}
              client={client}
              project={project}
              edit={{ projectId: project.id, onSaved: onAccountsSaved }}
            />
          </Section>
          {/* With Board off on this daemon (the work switch) the page offers no trace of it. */}
          {boardOffered && (
            <Section icon={<KanbanSquare className="text-muted" size={16} aria-hidden="true" />} title="Board">
              <ProjectBoardSwitch client={client} projectId={project.id} />
            </Section>
          )}
          {insights !== undefined && (
            <Section
              icon={<GitPullRequest className="text-muted" size={16} aria-hidden="true" />}
              title={insights.title}
            >
              {createElement(insights.panel as never, { project: project.id, daemon })}
            </Section>
          )}
        </div>
        {/* `content-start`, as the column beside it: when the left column is the taller one, these cards keep their own
            height instead of being stretched to fill it (a stretched card centres its content and the heading drifts). */}
        <div className="grid content-start gap-panel">
          <Section icon={<Bot className="text-muted" size={16} aria-hidden="true" />} title="Active ferrets">
            {reading === 'unread' ? (
              <Loading kind="bar" label="Loading this daemon’s ferrets…" />
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
                        className="flex min-w-0 items-center justify-between gap-sm rounded-panel border border-border-strong bg-surface-2 px-panel py-2"
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
          <Section icon={<FolderTree className="text-muted" size={16} aria-hidden="true" />} title="Files">
            {/* THE FINDER READS THE PROJECT'S FOLDER, NOT THE FERRET LIST, so a failed or unread ferret list no longer
                hides it. Only the link into a ferret's browser depends on that list, and an UNREAD or FAILED list is
                not an absent ferret: the link is offered only when the list was read and holds one. */}
            <ProjectFiles
              client={client}
              project={project}
              daemon={daemon}
              ferret={reading === 'ready' || reading === 'stale' ? (set[0] ?? null) : null}
              onNavigate={onNavigate}
            />
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
    return <Loading kind="page" label="Loading this daemon’s project registry…" />;
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

  return (
    <ProjectDetailView
      client={client}
      daemon={daemon}
      project={project}
      reading={ferrets}
      onNavigate={navigate}
      onBack={back}
    />
  );
}
