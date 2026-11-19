import { useRouter } from '@ferretry/app';
import type { AppComponent, ScreenProps } from '@ferretry/kernel/manifest';
import { parseRepoSegment } from '../../../contract/repo-segment.ts';
import type { CiClient } from './ci-api.ts';
import { CiRunPage } from './ci-run-page.tsx';

/** The `ci-run` screen: `/pulls/:project/:repo/runs/:runId`, one workflow run's jobs, steps and timing. */
export const createCiRunScreen = (client: CiClient): AppComponent<ScreenProps> =>
  function CiRunScreen({ params }) {
    const { route } = useRouter();
    const repo = parseRepoSegment(params.repo ?? '');
    const runId = /^[0-9]{1,15}$/u.test(params.runId ?? '') ? Number(params.runId) : undefined;
    if (route.kind !== 'screen' || params.project === undefined || repo === undefined || runId === undefined)
      return (
        <p className="kt-panel m-panel p-panel" role="status">
          This address does not name a CI run.
        </p>
      );
    return (
      <div className="m-panel">
        <CiRunPage client={client} scope={{ project: params.project, repo }} runId={runId} />
      </div>
    );
  };
