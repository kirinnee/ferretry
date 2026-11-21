/**
 * Browser entry for PR 2288's review fixes over FAKE data: Projects' REAL detail page with its GitHub accounts section,
 * drawn from a fake client. No daemon, no network.
 *
 *   ?theme=<family>-<mode>
 *   ?case=none-stepup   a project with NO links whose account list wants the passkey first (the confirm action shows)
 *   ?case=none          the same project once the accounts can be read ("Link an account")
 *   ?case=removed       a project whose default link points at a removed account (the editor shows it, with a warning)
 */
import { RouterProvider } from '@ferretry/app/testing/router';
import { createRoot } from 'react-dom/client';
import { ProjectInfoSchema } from '../../../../contract/index.ts';
import type { ProjectsClient } from '../../../../app/lib/client.ts';
import { ProjectDetailPage } from '../../../../app/views/project-detail.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const scene = params.get('case') ?? 'removed';

const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const project = ProjectInfoSchema.parse({
  id: PROJECT_ID,
  name: 'fake-site',
  path: '/fake/site',
  source: 'existing-folder',
  createdAt: '2026-08-01T10:00:00.000Z',
  ...(scene === 'removed' ? { accounts: ['gha_gone', 'gha_1'] } : {}),
});
const accounts = [
  { id: 'gha_1', login: 'fake-octocat', keys: {} },
  { id: 'gha_2', login: 'fake-hubot', keys: {} },
];

const client = {
  call: async (route: string, init?: { readonly quiet?: boolean }) => {
    if (route === 'GET /v1/projects') return [project];
    if (route === 'GET /v1/ferrets') return [];
    if (route === 'GET /v1/board/projects/:projectId/switch')
      return { projectId: PROJECT_ID, on: false, setBy: 'default', setAt: null };
    if (route === 'GET /v1/git-accounts') {
      if (scene === 'none-stepup' && init?.quiet !== false)
        throw Object.assign(new Error('passkey first'), { status: 403, code: 'grant_step_up_required' });
      return accounts;
    }
    throw new Error(`no route ${route}`);
  },
} as ProjectsClient;

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <div data-scene-ready="" style={{ height: '100dvh' }}>
      <RouterProvider>
        <ProjectDetailPage client={client} daemon="fake" projectId={PROJECT_ID} />
      </RouterProvider>
    </div>,
  );
