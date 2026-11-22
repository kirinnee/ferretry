/**
 * Browser entry for F6061 U4 (the broad-root warning at registration) over FAKE data: the REAL create flow's folder step,
 * driven by a client that answers from a tiny fake home, and the REAL typed-path form.
 *
 *   ?theme=<family>-<mode>&view=flow|form[&path=<typed path>]
 *   flow: the home (`/home/sam`) is a broad root (the daemon says `broad: true`); `~/project1` is an ordinary folder.
 */
import { createRoot } from 'react-dom/client';
import { CreateProjectFlow } from '../../../../app/features/create-project/create-project-flow.tsx';
import { explorerViewPreference } from '../../../../app/features/folder-explorer/explorer-view-preference.ts';
import type { ProjectsClient } from '../../../../app/lib/client.ts';
import { emptyProjectRegistrationDraft } from '../../../../app/lib/registration-model.ts';
import { AddProjectForm } from '../../../../app/views/add-project-form.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
explorerViewPreference.write('list');

const at = '2026-08-01T10:00:00.000Z';
const entry = (name: string) => ({ name, kind: 'folder' as const, isRepo: false, hidden: false, modifiedAt: at });
const HOME = '/home/sam';

const client: ProjectsClient = {
  call: async <Answer,>(route: string, init?: { query?: Record<string, string> }): Promise<Answer> => {
    if (route !== 'GET /v1/projects/folders') throw new Error(`no route ${route}`);
    const raw = init?.query?.path ?? HOME;
    const path = raw === '~' ? HOME : raw.startsWith('~/') ? `${HOME}${raw.slice(1)}` : raw;
    if (path === HOME)
      return {
        path,
        crumbs: [{ name: '~', path: HOME }],
        entries: [entry('project1'), entry('notes')],
        truncated: false,
        broad: true,
      } as Answer;
    return {
      path,
      crumbs: [
        { name: '~', path: HOME },
        { name: 'project1', path: `${HOME}/project1` },
      ],
      entries: [entry('src')],
      truncated: false,
    } as Answer;
  },
};

const root = document.getElementById('root');
if (root !== null) {
  const view = params.get('view') ?? 'flow';
  createRoot(root).render(
    view === 'form' ? (
      <div data-scene-ready="" data-explorer-state="ready" className="max-w-[640px] p-panel">
        <AddProjectForm
          draft={{ ...emptyProjectRegistrationDraft, path: params.get('path') ?? '/home/sam' }}
          onDraftChange={() => {}}
          onSubmit={() => {}}
          onCancel={() => {}}
          status={null}
        />
      </div>
    ) : (
      <div data-scene-ready="">
        <CreateProjectFlow client={client} status={null} onRegister={async () => false} onClose={() => {}} />
      </div>
    ),
  );
}
