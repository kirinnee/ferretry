import type { AppComponent, ScreenProps } from '@ferretry/kernel/manifest';
import { useRouter } from '@ferretry/app';
import type { ProjectsClient } from '../lib/client.ts';
import { ProjectDetailPage } from './project-detail.tsx';
import { ProjectsPage } from './projects-page.tsx';

/** The daemon the current route names; a project screen is only ever reached through one. */
function useDaemon(): string | undefined {
  const { route } = useRouter();
  return route.kind === 'screen' ? route.daemon : undefined;
}

const NO_DAEMON = (
  <p className="kt-panel m-panel p-panel" role="status">
    Open a paired daemon to see its projects.
  </p>
);

/** The `projects` screen: one daemon's registry and every way to add to it. */
export const createProjectsScreen = (client: ProjectsClient): AppComponent<ScreenProps> =>
  function ProjectsScreen() {
    const daemon = useDaemon();
    return daemon === undefined ? NO_DAEMON : <ProjectsPage client={client} daemon={daemon} />;
  };

/** The `project` screen: one registered project's provenance, board switch, ferrets and files. */
export const createProjectScreen = (client: ProjectsClient): AppComponent<ScreenProps> =>
  function ProjectScreen({ params }) {
    const daemon = useDaemon();
    const id = params.id;
    return daemon === undefined || id === undefined ? (
      NO_DAEMON
    ) : (
      <ProjectDetailPage client={client} daemon={daemon} projectId={id} />
    );
  };
