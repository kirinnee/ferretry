/**
 * Browser entry for F-120/F-121 (a project's branches and worktrees, and the offer to adopt a stray checkout): Projects' REAL
 * detail page over a scripted daemon. Fake names, no network. `?repos=<n>` repositories held (default 2);
 * `?git=1` records the project's own common directory (and `repos=0` leaves the saved list absent); `?worktrees=ok|failed|slow|blocked` is how the daemon answers the list (`blocked` adds a detached and a missing stray checkout); `?theme=<palette>-<mode>`.
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
  ...(params.get('git') === '1' ? { git: { commonDirectory: '/work/ferretry/site/.git' } } : {}),
  repos: NAMES.slice(0, count).map(path => ({
    path,
    remote: `https://github.com/fake-org/${path}`,
    provider: 'github',
  })),
});
const adopted = new Set<string>();
let moved = false;
const MOVE = 'POST /v1/worktrees/move';
const FROM = '/work/trees/site-nav';
const TO = '/home/fake/.ferretry-worktrees/ferretry-project1/site-ab12345678/feat-nav-12345678';

const client = scripted({
  'GET /v1/projects': () => [held],
  'GET /v1/ferrets': [],
  'GET /v1/board/projects/:projectId/switch': { projectId: PROJECT.id, on: false, setBy: 'default', setAt: null },
  [FILES]: (call: { query?: Readonly<Record<string, string>> }) =>
    answerFor(summaryOf(), call.query?.q, Number(call.query?.limit ?? 50)),
  [LIST]: (call: { query?: Readonly<Record<string, string>> }) => {
    // A project's own repository is asked about by its id; the scene's project records this directory.
    const dir = call.query?.commonDir ?? (call.query?.project === undefined ? '' : '/work/ferretry/site/.git');
    if (mode === 'slow') return new Promise(() => undefined);
    if (mode === 'failed' && dir.endsWith('/docs/.git'))
      throw Object.assign(new Error('that folder is not a git common directory.'), { status: 422 });
    const extra =
      mode === 'blocked' && dir.endsWith('/docs/.git')
        ? [
            row('/home/fake/detached-checkout', '', { tracked: 'none', live: { branch: undefined, detached: true } }),
            row('/home/fake/gone-checkout', 'docs/gone', {
              tracked: 'none',
              live: { prunable: 'gitdir file points to non-existent location' },
            }),
          ]
        : [];
    return listAnswer(
      dir,
      [...(ANSWERS[dir] ?? []), ...extra].map(r => {
        if (mode.startsWith('move')) {
          if (r.path === FROM)
            return row(moved ? TO : FROM, 'feat/nav', {
              ferrets: [{ id: 'stopped-fixture', active: false }],
              move: moved
                ? { worktreeId: 'nav', reason: 'It is already in the project’s worktree root.' }
                : { worktreeId: 'nav', destination: TO, reviewedIdentity: 'a'.repeat(64) },
            });
          return {
            ...r,
            move: {
              worktreeId: r.path,
              reason: r.main ? 'The main checkout cannot move.' : 'Adopt it first to move it.',
            },
          };
        }
        return adopted.has(r.path) ? row(r.path, r.live.branch ?? '', { tracked: 'adopted' }) : r;
      }),
    );
  },
  [ADOPT]: (call: { body?: unknown }) => {
    adopted.add((call.body as { path: string }).path);
    return {};
  },
  [MOVE]: () => {
    if (mode === 'move-refused') throw new Error('a live ferret started in this checkout; nothing was moved');
    moved = true;
    return { from: FROM, to: TO };
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
