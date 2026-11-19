/**
 * The browser entry for the CI run page shots over FAKE data (no daemon, no network): the real `CiRunPage` for a fixed fake
 * run on a fixed fake clock.
 *
 *   ?theme=<family>-<mode>
 *   &run=long|big|stopped   (default long)
 *     long     a failed run whose run, job and step names are 500 characters with no break in them
 *     big      256 failed jobs x 500 steps, the most the contract allows
 *     stopped  a cancelled job holding a step E8 still flags live, read an hour after it stopped
 */
import { createRoot } from 'react-dom/client';
import { CiRunPage } from '../../../../app/features/ci-run/ci-run-page.tsx';
import type { CiClient } from '../../../../app/features/ci-run/ci-api.ts';
import type { CiRun } from '../../../../contract/wire.ts';
import { BIG_RUN, CANCELLED_RUN, FAILED_RUN, secondsAfterT0 } from '../../../fixtures/flame-runs.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const LONG = (letter: string): string => letter.repeat(500);

const longRun = (): CiRun => ({
  ...FAILED_RUN,
  name: LONG('R'),
  jobs: FAILED_RUN.jobs.map(job => ({
    ...job,
    name: job.status === 'failed' ? LONG('J') : job.name,
    steps: job.steps.map(step => (step.status === 'failed' ? { ...step, name: LONG('S') } : step)),
  })),
});

const bigRun = (): CiRun => {
  const run = BIG_RUN();
  return { ...run, jobs: run.jobs.map(job => ({ ...job, status: 'failed' as const })) };
};

const which = params.get('run') ?? 'long';
const run = which === 'big' ? bigRun() : which === 'stopped' ? CANCELLED_RUN : longRun();
const nowMs = which === 'stopped' ? secondsAfterT0(11 + 3_600) : secondsAfterT0(20_000);
const client: CiClient = { call: (async () => run) as CiClient['call'] };

const root = document.getElementById('root');
if (root === null) throw new Error('the scene page has no #root');
createRoot(root).render(
  <main data-scene-ready="" style={{ boxSizing: 'border-box', maxWidth: 960, margin: '0 auto', padding: 16 }}>
    <CiRunPage
      client={client}
      scope={{ project: '11111111-1111-4111-8111-111111111111', repo: { owner: 'octo', name: 'hello' } }}
      runId={run.id}
      nowMs={nowMs}
    />
  </main>,
);
