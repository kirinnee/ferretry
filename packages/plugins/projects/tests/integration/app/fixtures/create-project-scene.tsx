/**
 * The browser entry for "Create a project" over FAKE data (no daemon, no account, no real folder): the REAL folder
 * explorer, the REAL create flow and the REAL account links, driven by a client that answers from a tiny fake home.
 *
 *   ?theme=<family>-<mode>&stage=<before|explorer|links|flow|hub-empty|hub-list>[&view=card|list][&at=<folder>][&source=clone]
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AccountLinksView } from '../../../../app/features/create-project/account-links.tsx';
import { CreateProjectFlow } from '../../../../app/features/create-project/create-project-flow.tsx';
import { FolderExplorer } from '../../../../app/features/folder-explorer/folder-explorer.tsx';
import { FolderPicker } from '../../../../app/features/folder-explorer/folder-picker.tsx';
import { explorerViewPreference } from '../../../../app/features/folder-explorer/explorer-view-preference.ts';
import type { ProjectsClient } from '../../../../app/lib/client.ts';
import {
  emptyProjectRegistrationDraft,
  type ProjectRegistrationStatus,
} from '../../../../app/lib/registration-model.ts';
import { AddProjectForm } from '../../../../app/views/add-project-form.tsx';
import { ProjectsHub } from '../../../../app/views/projects-hub.tsx';
import {
  type ProjectsConnectAccountProps,
  ProjectInfoSchema,
  type RegisterProjectRequest,
} from '../../../../contract/index.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const stage = params.get('stage') ?? 'flow';
const view = params.get('view');
if (view === 'card' || view === 'list') explorerViewPreference.write(view);
const startAt = params.get('at') ?? undefined;
const source = params.get('source') === 'clone' ? 'clone' : 'folder';

const at = '2026-08-01T10:00:00.000Z';
const entry = (name: string, kind: 'folder' | 'file' = 'folder', isRepo = false) => ({
  name,
  kind,
  isRepo,
  hidden: false,
  modifiedAt: at,
});
const HOME = '/home/sam';
const TREE: Record<string, readonly ReturnType<typeof entry>[]> = {
  [HOME]: [
    entry('Documents'),
    entry('Downloads'),
    entry('notes', 'folder'),
    entry('work'),
    entry('ferretry-demo', 'folder', true),
    entry('todo.txt', 'file'),
    entry('recipes.md', 'file'),
  ],
  [`${HOME}/work`]: [entry('clients'), entry('ferretry-demo', 'folder', true), entry('scratch')],
  [`${HOME}/work/clients`]: [entry('acme', 'folder', true), entry('globex'), entry('initech', 'folder', true)],
  [`${HOME}/work/clients/acme`]: [
    entry('api', 'folder', true),
    entry('web', 'folder', true),
    entry('README.md', 'file'),
  ],
};
const crumbsFor = (path: string) => {
  const parts = path.slice(HOME.length).split('/').filter(Boolean);
  return [
    { name: '~', path: HOME },
    ...parts.map((name, index) => ({ name, path: `${HOME}/${parts.slice(0, index + 1).join('/')}` })),
  ];
};

const project = ProjectInfoSchema.parse({
  id: '11111111-1111-4111-8111-111111111111',
  name: 'acme',
  path: `${HOME}/work/clients/acme`,
  source: 'existing-folder',
  createdAt: at,
});
const ACCOUNTS = [
  { id: 'gha_101', login: 'sam-dev', keys: {} },
  { id: 'gha_202', login: 'sam-at-work', keys: { ssh: { githubKeyId: '1', title: 'Ferretry' } } },
];

/**
 * A STAND-IN for Git accounts' connect card, which a plugin's suite cannot import (another package is reached only through
 * its contract). The flow mounts whatever provides `projects.connect-account`; the real card's own shots (consent words,
 * code, countdown) are Git accounts', so here it is only its idle button, in the position and size the real one has.
 */
const connectProvider = {
  panel: ({ connected }: ProjectsConnectAccountProps) => (
    <div>
      <button type="button" className="kt-btn min-h-[44px]" data-fake-connect-card="">
        {connected === 0 ? 'Connect a GitHub account' : 'Connect another GitHub account'}
      </button>
    </div>
  ),
};

const client: ProjectsClient = {
  call: async <Answer,>(route: string, init?: { query?: Record<string, string>; body?: unknown }): Promise<Answer> => {
    if (route === 'GET /v1/projects/folders') {
      const path = init?.query?.path ?? HOME;
      return { path, crumbs: crumbsFor(path), entries: TREE[path] ?? [], truncated: false } as Answer;
    }
    if (route === 'GET /v1/git-accounts') return ACCOUNTS as Answer;
    if (route === 'PUT /v1/projects/:id/accounts')
      return { ...project, accounts: (init?.body as { accounts: string[] } | undefined)?.accounts ?? [] } as Answer;
    if (route === 'POST /v1/git-accounts/:id/keys')
      return {
        fingerprint: 'SHA256:Zq1kF0x2VdRk8n5mJc3oYwB7sLpA4tHeU9iGvNyXr6E',
        registered: ['auth', 'signing'],
      } as Answer;
    throw new Error(`no route ${route}`);
  },
};

function Flow() {
  const [status, setStatus] = useState<ProjectRegistrationStatus | null>(null);
  const onRegister = async (request: RegisterProjectRequest): Promise<boolean> => {
    setStatus({ phase: 'registered', request, project, alreadyRegistered: false });
    return true;
  };
  return (
    <CreateProjectFlow
      client={client}
      connectAccount={connectProvider}
      initialSource={source}
      status={status}
      onRegister={onRegister}
      onClose={() => {}}
      projectHref={id => `/d/demo/projects/${id}`}
    />
  );
}

const NOW = Date.parse(at) + 3_600_000;
const DISCOVERY = [
  { kind: 'recent' as const, key: 'd1', name: 'globex', path: `${HOME}/work/clients/globex`, lastActivity: at },
];
function Hub({ projects, open }: { readonly projects: readonly (typeof project)[]; readonly open: boolean }) {
  const [status, setStatus] = useState<ProjectRegistrationStatus | null>(null);
  return (
    <div style={{ height: '100dvh' }} data-scene-ready="">
      <ProjectsHub
        slice={{ projects, status: 'ready', error: null }}
        discoveries={DISCOVERY}
        ferretsError={null}
        status={status}
        onRegister={async request => {
          setStatus({ phase: 'registered', request, project, alreadyRegistered: false });
          return true;
        }}
        onDismiss={() => setStatus(null)}
        projectHref={id => `/d/demo/projects/${id}`}
        now={NOW}
        client={client}
        connectAccount={connectProvider}
        initiallyOpen={open}
      />
    </div>
  );
}

function Scene() {
  if (stage === 'hub-empty') return <Hub projects={[]} open={false} />;
  if (stage === 'hub-list') return <Hub projects={[project]} open={false} />;
  if (stage === 'hub-open') return <Hub projects={[project]} open />;
  if (stage === 'before')
    return (
      <AddProjectForm
        draft={emptyProjectRegistrationDraft}
        onDraftChange={() => {}}
        onSubmit={() => {}}
        onCancel={() => {}}
        status={null}
      />
    );
  if (stage === 'explorer')
    return <FolderPicker client={client} {...(startAt === undefined ? {} : { startAt })} onChoose={() => {}} />;
  if (stage === 'links')
    return (
      <AccountLinksView
        project={{ accounts: ['gha_101', 'gha_404'] }}
        existing={[{ id: 'gha_101', login: 'sam-dev' }]}
        error={null}
      />
    );
  if (stage === 'listing')
    return (
      <FolderExplorer
        listing={null}
        loading
        error={null}
        view="list"
        onViewChange={() => {}}
        showHidden={false}
        onShowHiddenChange={() => {}}
        onOpen={() => {}}
        onChoose={() => {}}
        onMakeFolder={async () => null}
      />
    );
  return <Flow />;
}

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    stage.startsWith('hub-') ? (
      <Scene />
    ) : (
      <div className="mx-auto max-w-[760px] p-4" data-scene-ready="">
        <div className="kt-panel grid gap-panel p-panel">
          <Scene />
        </div>
      </div>
    ),
  );
