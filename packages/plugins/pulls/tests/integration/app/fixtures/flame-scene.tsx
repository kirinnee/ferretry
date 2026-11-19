/**
 * The browser entry for the CI flamegraph shots over FAKE data (no daemon, no network): the real `CiFlame` for a fixed fake
 * run on a fixed fake clock.
 *
 *   ?theme=<family>-<mode>
 *   &run=failed|running|check|big   (default failed; big is 256 jobs x 500 steps, the most the contract allows)
 */
import { createRoot } from 'react-dom/client';
import { CiFlame } from '../../../../app/features/ci-flame/index.ts';
import { BIG_RUN, CHECK_RUN, FAILED_RUN, RUNNING_RUN, secondsAfterT0 } from '../../../fixtures/flame-runs.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const which = params.get('run') ?? 'failed';
const run =
  which === 'running' ? RUNNING_RUN : which === 'check' ? CHECK_RUN : which === 'big' ? BIG_RUN() : FAILED_RUN;
const nowMs =
  which === 'running' ? secondsAfterT0(100) : which === 'big' ? secondsAfterT0(20_000) : secondsAfterT0(300);

const root = document.getElementById('root');
if (root === null) throw new Error('the scene page has no #root');
createRoot(root).render(
  <main data-scene-ready="" style={{ boxSizing: 'border-box', maxWidth: 960, margin: '0 auto', padding: 16 }}>
    <h1 style={{ margin: '0 0 12px', fontSize: 16 }}>CI · Fix the thing</h1>
    <CiFlame run={run} nowMs={nowMs} />
  </main>,
);
