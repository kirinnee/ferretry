/**
 * Browser entry for F-101 (clone another repository into a project): Projects' REAL detail page over a scripted daemon.
 * Fake names, no network. `?repos=<n>` repositories held (default 2); `?clone=ok|refused|slow` is how the daemon answers
 * a clone (`ok` adds `cloned` to the registry). `?theme=<palette>-<mode>`.
 */
import { RouterProvider } from '@ferretry/app/testing/router';
import { createRoot } from 'react-dom/client';
import { type ProjectInfo, ProjectInfoSchema } from '../../../../contract/index.ts';
import { ProjectDetailPage } from '../../../../app/views/project-detail.tsx';
import { answerFor, FILES, summaryOf } from '../../../unit/app/support/finder-fixtures.ts';
import { PROJECT, scripted } from '../../../unit/app/support/client.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const count = Number(params.get('repos') ?? '2');
const clone = params.get('clone') ?? 'ok';
const NAMES = ['site', 'docs', 'tools'];

const holding = (names: readonly string[]): ProjectInfo =>
  ProjectInfoSchema.parse({
    ...PROJECT,
    repos: names.map(path => ({ path, remote: `https://github.com/fake-org/${path}`, provider: 'github' })),
  });
let held = holding(NAMES.slice(0, count));

const client = scripted({
  'GET /v1/projects': () => [held],
  'GET /v1/ferrets': [],
  'GET /v1/board/projects/:projectId/switch': { projectId: PROJECT.id, on: false, setBy: 'default', setAt: null },
  [FILES]: (call: { query?: Readonly<Record<string, string>> }) =>
    answerFor(summaryOf(), call.query?.q, Number(call.query?.limit ?? 50)),
  'POST /v1/projects/:id/repos': () => {
    if (clone === 'slow') return new Promise(() => undefined);
    if (clone === 'refused') throw Object.assign(new Error('cloned already exists in this project.'), { status: 422 });
    held = holding([...(held.repos ?? []).map(repo => repo.path), 'cloned']);
    return { repos: held.repos, truncated: false };
  },
});

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <div data-scene-ready="" style={{ height: '100dvh' }}>
      <RouterProvider>
        <ProjectDetailPage client={client} daemon="fake" projectId={PROJECT.id} />
      </RouterProvider>
    </div>,
  );
