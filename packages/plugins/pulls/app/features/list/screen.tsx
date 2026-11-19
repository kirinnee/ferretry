import { useRouter } from '@ferretry/app';
import type { AppComponent, ScreenProps } from '@ferretry/kernel/manifest';
import type { ListClient } from './api.ts';
import { PullsList } from './pulls-list.tsx';
import { ProjectPulls, type ProjectPullsProps } from './project-section.tsx';

/** The `pulls` screen: `pulls`. A daemon-less address is said so, never read. */
export const createPullsScreen = (client: ListClient): AppComponent<ScreenProps> =>
  function PullsScreen() {
    const { route, navigate } = useRouter();
    const daemon = route.kind === 'screen' ? route.daemon : undefined;
    if (daemon === undefined)
      return (
        <p className="kt-panel m-panel p-panel" role="status">
          Open a paired daemon to see its pull requests.
        </p>
      );
    return <PullsList client={client} daemon={daemon} onNavigate={navigate} />;
  };

/**
 * The project page's section, in the shell: it takes the router from the shell. It lives with the screen's module so the
 * app half has ONE dynamic import and the build sees one file.
 */
export function ProjectPullsInShell(props: Omit<ProjectPullsProps, 'onNavigate'>) {
  const { navigate } = useRouter();
  return <ProjectPulls {...props} onNavigate={navigate} />;
}
