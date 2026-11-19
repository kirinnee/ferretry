/**
 * The browser entry for the CI timeline shots over FAKE data (no daemon): the real `CiTimeline` on E8's fixtures.
 *
 *   ?theme=<family>-<mode>&case=finished|running|matrix
 */
import { createRoot } from 'react-dom/client';
import { CiTimeline } from '../../../../app/features/ci-timeline/index.ts';
import { FINISHED, MATRIX, RUNNING } from '../../../fixtures/ci-timeline-runs.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const chosen = params.get('case') ?? 'finished';
const scene = chosen === 'running' ? RUNNING : chosen === 'matrix' ? MATRIX : FINISHED;

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <div className="mx-auto max-w-5xl p-4" data-scene-ready="">
      <h1 className="mb-3 text-sm font-semibold text-fg">Timeline · {scene.run.name}</h1>
      <CiTimeline run={scene.run} now={scene.now} />
    </div>,
  );
