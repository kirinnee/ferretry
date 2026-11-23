/**
 * Browser entry for r11 S8 ("Start a ferret here") over FAKE data: Projects' REAL "where it works" panel drawn the way
 * Ferrets' New ferret page draws its slot (a plugin's tests may not import another plugin's page, so the host is a
 * stand-in of the slot contract; the real page's order and prefill are proved in Ferrets' own suite), and Projects' REAL
 * project page, over a daemon that answers from memory and records every call on `window.__calls`. No network.
 *
 *   ?view=new      the slot host     ?view=project  the project page of /fake/p1
 *   ?projects=<n>  how many projects the fake daemon registers (default 2)
 *   ?recent=<n>    how many recent folders the host hands the panel (default 3)
 *   ?accounts=<n>  how many GitHub accounts the fake daemon has connected (default 1)
 *   ?theme=<family>-<mode>
 */
import { WithAppHooks } from '@ferretry/app/testing/settings-shell';
import { RouterProvider } from '@ferretry/app/testing/router';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ProjectInfoSchema,
  PROJECTS_CONNECT_ACCOUNT_HOOK,
  type ProjectsConnectAccountProps,
} from '../../../../contract/index.ts';
import type { ProjectsClient } from '../../../../app/lib/client.ts';
import { createNewFerretProjectsPanel } from '../../../../app/views/new-ferret-projects.tsx';
import { ProjectDetailPage } from '../../../../app/views/project-detail.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const view = params.get('view') ?? 'new';
const count = Number(params.get('projects') ?? '2');
const ACCOUNTS = Number(params.get('accounts') ?? '1');
const RECENT = ['/fake/work/api', '/fake/work/web-redesign', '/fake/scratch', '/fake/work/docs'].slice(
  0,
  Number(params.get('recent') ?? '3'),
);

const id = (index: number): string => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const PROJECTS = Array.from({ length: count }, (_, index) =>
  ProjectInfoSchema.parse({
    id: id(index + 1),
    name: `project-${index + 1}`,
    path: `/fake/p${index + 1}`,
    source: 'existing-folder',
    createdAt: '2026-08-01T10:00:00.000Z',
    ...(index === 0 ? { repos: [{ path: '.', remote: 'https://github.com/fake-org/site', provider: 'github' }] } : {}),
  }),
);

interface Recorded {
  route: string;
  headers: Record<string, string> | undefined;
  body: unknown;
}
const calls: Recorded[] = [];
(window as unknown as { __calls: Recorded[] }).__calls = calls;

const client = {
  call: async <Answer,>(
    route: string,
    init?: { headers?: Record<string, string>; body?: unknown },
  ): Promise<Answer> => {
    calls.push({ route, headers: init?.headers, body: init?.body });
    if (route === 'GET /v1/projects') return PROJECTS as Answer;
    if (route === 'GET /v1/ferrets') return [] as Answer;
    if (route === 'GET /v1/git-accounts')
      return [{ id: 'acct-1', login: 'fake-octo', keys: {} }].slice(0, ACCOUNTS) as Answer;
    if (route === 'GET /v1/projects/folders')
      return {
        path: '/fake/work',
        crumbs: [
          { name: '/', path: '/' },
          { name: 'fake', path: '/fake' },
          { name: 'work', path: '/fake/work' },
        ],
        entries: ['api', 'web-redesign', 'docs', 'notes'].map(name => ({
          name,
          kind: 'folder',
          isRepo: name !== 'notes',
          hidden: false,
          modifiedAt: '2026-11-01T10:00:00.000Z',
        })),
        truncated: false,
      } as Answer;
    throw new Error(`no route ${route}`);
  },
} as unknown as ProjectsClient;

/**
 * A STAND-IN for Git accounts' connect card (another plugin's, reached only through its contract hook): its idle button,
 * in the position and size the real one has. The real card's consent words and code are Git accounts' own to shoot.
 */
const connectProvider = {
  panel: ({ connected }: ProjectsConnectAccountProps) => (
    <div>
      <button className="kt-btn min-h-[44px]" data-fake-connect-card="" type="button">
        {connected === 0 ? 'Connect a GitHub account' : 'Connect another GitHub account'}
      </button>
    </div>
  ),
};

const ProjectsPanel = createNewFerretProjectsPanel(client) as (props: {
  readonly daemon: string;
  readonly value: string;
  readonly id: string;
  readonly recent: readonly string[];
  readonly onPick: (folder: string) => void;
}) => ReactNode;

/** The slot host: the panel under the page's own label, the folder state owned here (and echoed), as the New ferret page owns it. */
function FolderHost() {
  const [folder, setFolder] = useState('');
  return (
    <main className="mx-auto w-full max-w-[720px] p-3">
      <label className="mb-1.5 block text-ui font-semibold text-fg" htmlFor="fy-new-ferret-folder">
        Where it works
      </label>
      <ProjectsPanel daemon="fake" id="fy-new-ferret-folder" onPick={setFolder} recent={RECENT} value={folder} />
      <output className="mt-3 block text-meta text-muted" data-chosen-folder={folder}>
        Folder in the form: {folder === '' ? 'none' : folder}
      </output>
    </main>
  );
}

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <div data-scene-ready="">
      {view === 'project' ? (
        <RouterProvider>
          <ProjectDetailPage client={client} daemon="fake" projectId={id(1)} />
        </RouterProvider>
      ) : (
        <WithAppHooks provided={{ [PROJECTS_CONNECT_ACCOUNT_HOOK]: connectProvider }}>
          <FolderHost />
        </WithAppHooks>
      )}
    </div>,
  );
