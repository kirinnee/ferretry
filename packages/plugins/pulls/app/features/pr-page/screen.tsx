import { useRouter } from '@ferretry/app';
import type { AppComponent, ScreenProps } from '@ferretry/kernel/manifest';
import { GITHUB_LOGIN, GITHUB_REPO_NAME } from '../../../contract/index.ts';
import type { PullsClient } from '../../lib/client.ts';
import { parseRepoSegment } from '../../../contract/repo-segment.ts';
import { PullPageView } from './pr-page.tsx';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The `pull` screen: `pulls/:project/:repo/:number`. An address that does not parse is said so, never fetched. */
export const createPullScreen = (client: PullsClient): AppComponent<ScreenProps> =>
  function PullScreen({ params }) {
    const { route, navigate } = useRouter();
    const daemon = route.kind === 'screen' ? route.daemon : undefined;
    const repo = parseRepoSegment(params.repo ?? '');
    const number = /^[1-9][0-9]{0,8}$/u.test(params.number ?? '') ? Number(params.number) : 0;
    const project = params.project ?? '';
    if (daemon === undefined)
      return (
        <p className="kt-panel m-panel p-panel" role="status">
          Open a paired daemon to see its pull requests.
        </p>
      );
    if (
      !UUID.test(project) ||
      repo === undefined ||
      number === 0 ||
      !GITHUB_LOGIN.test(repo.owner) ||
      !GITHUB_REPO_NAME.test(repo.name)
    )
      return (
        <p className="kt-panel m-panel p-panel" role="alert">
          That pull request address is not one Ferretry can open.
        </p>
      );
    return (
      <PullPageView
        address={{ project, owner: repo.owner, name: repo.name, number }}
        client={client}
        daemon={daemon}
        onNavigate={navigate}
      />
    );
  };
