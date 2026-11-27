/**
 * Browser entry for F-120/F-121 (a project's branches and worktrees, and the offer to adopt a stray checkout): Projects' REAL
 * detail page over a scripted daemon. Fake names, no network. `?repos=<n>` repositories held (default 2);
 * `?worktrees=ok|failed|slow` is how the daemon answers the list; `?theme=<palette>-<mode>`.
 */
import { RouterProvider } from '@ferretry/app/testing/router';
import { createRoot } from 'react-dom/client';
import { type ProjectInfo, ProjectInfoSchema } from '../../../../contract/index.ts';
import { ProjectDetailPage } from '../../../../app/views/project-detail.tsx';
import { answerFor, FILES, summaryOf } from '../../../unit/app/support/finder-fixtures.ts';
import { PROJECT, scripted } from '../../../unit/app/support/client.ts';
import { ADOPT, ANSWERS, LIST, listAnswer, row } from '../../../unit/app/support/worktree-fixtures.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const count = Number(params.get('repos') ?? '2');
const mode = params.get('worktrees') ?? 'ok';
const NAMES = ['site', 'docs'];

const held: ProjectInfo = ProjectInfoSchema.parse({
  ...PROJECT,
  repos: NAMES.slice(0, count).map(path => ({
    path,
    remote: `https://github.com/fake-org/${path}`,
    provider: 'github',
  })),
});
const adopted = new Set<string>();

const client = scripted({
  'GET /v1/projects': () => [held],
  'GET /v1/ferrets': [],
  'GET /v1/board/projects/:projectId/switch': { projectId: PROJECT.id, on: false, setBy: 'default', setAt: null },
  [FILES]: (call: { query?: Readonly<Record<string, string>> }) =>
    answerFor(summaryOf(), call.query?.q, Number(call.query?.limit ?? 50)),
  [LIST]: (call: { query?: Readonly<Record<string, string>> }) => {
    const dir = call.query?.commonDir ?? '';
    if (mode === 'slow') return new Promise(() => undefined);
    if (mode === 'failed' && dir.endsWith('/docs/.git'))
      throw Object.assign(new Error('that folder is not a git common directory.'), { status: 422 });
    return listAnswer(
      dir,
      (ANSWERS[dir] ?? []).map(r =>
        adopted.has(r.path) ? row(r.path, r.live.branch ?? '', { tracked: 'adopted' }) : r,
      ),
    );
  },
  [ADOPT]: (call: { body?: unknown }) => {
    adopted.add((call.body as { path: string }).path);
    return {};
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
