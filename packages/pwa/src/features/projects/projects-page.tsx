import { FolderOpen, TriangleAlert } from 'lucide-react';
import { useProjectsSlice } from '../../hooks/use-projects.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { useAppStore } from '../../lib/store.tsx';

/** One daemon's durable registry. A missing read is never rendered as an empty registry. */
export function ProjectsPage({ connection }: { readonly connection: DaemonConnection }) {
  const { projects } = useAppStore();
  const slice = useProjectsSlice(projects, connection);
  if (slice.status === 'loading' || slice.status === 'idle')
    return (
      <section className="kt-panel p-panel text-ui text-muted" aria-busy="true">
        Loading registered projects…
      </section>
    );
  if (slice.status === 'error')
    return (
      <section className="kt-panel flex items-center gap-sm p-panel text-ui text-err" role="alert">
        <TriangleAlert size={16} aria-hidden="true" />
        Could not read this daemon’s project registry: {slice.error}
      </section>
    );
  if (slice.projects === null) throw new Error('a ready project registry must carry evidence');
  return (
    <section className="grid gap-panel p-panel" aria-labelledby="projects-heading">
      <header className="grid gap-xs">
        <p className="m-0 text-meta font-semibold uppercase tracking-wide text-muted">Workspace registry</p>
        <h1 id="projects-heading" className="m-0 text-heading font-semibold">
          Projects
        </h1>
        <p className="m-0 max-w-[72ch] text-ui text-muted">
          Registered folders on this daemon. Folders discovered from sessions are not added here until you confirm them.
        </p>
      </header>
      {slice.projects.length === 0 ? (
        <div className="kt-panel grid gap-xs p-panel text-ui text-muted">
          <FolderOpen size={20} aria-hidden="true" />
          <p className="m-0 font-medium text-fg">No projects registered</p>
          <p className="m-0">Add an existing folder, create one, clone a repository, or confirm a discovery.</p>
        </div>
      ) : (
        <ul className="m-0 grid list-none gap-sm p-0">
          {slice.projects.map(project => (
            <li className="kt-panel flex min-w-0 items-start gap-md p-panel" key={project.path}>
              <FolderOpen className="shrink-0 text-muted" size={18} aria-hidden="true" />
              <div className="min-w-0">
                <h2 className="m-0 text-title font-semibold">{project.name}</h2>
                <p className="mono m-0 truncate text-meta text-muted" title={project.path}>
                  {project.path}
                </p>
                <p className="m-0 mt-xs text-meta text-muted">Registered workspace folder</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
