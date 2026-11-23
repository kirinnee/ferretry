/**
 * Browser entry for the Folder | Project hand-off over FAKE data: Ferrets' REAL `NewFerretPage` with Projects' REAL
 * "where it works" panel in its slot (no stand-in on either side), over one daemon that answers from memory and records
 * every call on `window.__calls`. No network. `?theme=<family>-<mode>`.
 */
import { NEW_FERRET_PROJECT_SLOT } from '@ferretry/core-ferrets/contract';
import { WithSlotPanels } from '@ferretry/app/testing/settings-shell';
import { createRoot } from 'react-dom/client';
import type { FerretsClient } from '../../../../../../core/ferrets/app/lib/client.ts';
import { NewFerretPage } from '../../../../../../core/ferrets/app/features/new-ferret/new-ferret-page.tsx';
import { ProjectInfoSchema } from '../../../../contract/index.ts';
import type { ProjectsClient } from '../../../../app/lib/client.ts';
import { createNewFerretProjectsPanel } from '../../../../app/views/new-ferret-projects.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const PROJECTS = ['site', 'api'].map((name, index) =>
  ProjectInfoSchema.parse({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    name,
    path: `/fake/${name}`,
    source: 'existing-folder',
    createdAt: '2026-08-01T10:00:00.000Z',
  }),
);
// Ferrets already started in two folders that are NOT projects: they become the page's "Recent" quick picks.
const FERRETS = ['/fake/scratch', '/fake/notes'].map((folder, index) => ({
  folder,
  stateAt: `2026-11-0${index + 1}T10:00:00.000Z`,
}));

interface Recorded {
  route: string;
  headers: Record<string, string> | undefined;
  body: unknown;
}
const calls: Recorded[] = [];
const win = window as unknown as { __calls: Recorded[]; __navigated: string[] };
win.__calls = calls;
win.__navigated = [];

const client = {
  call: async <Answer,>(
    route: string,
    init?: { headers?: Record<string, string>; body?: unknown },
  ): Promise<Answer> => {
    calls.push({ route, headers: init?.headers, body: init?.body });
    if (route === 'GET /v1/projects') return PROJECTS as Answer;
    if (route === 'GET /v1/ferrets') return FERRETS as Answer;
    if (route === 'POST /v1/ferrets') return { id: 'new-ferret' } as Answer;
    if (route === 'GET /v1/git-accounts') return [] as Answer;
    throw new Error(`no route ${route}`);
  },
};

const Panel = createNewFerretProjectsPanel(client as unknown as ProjectsClient);

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <div data-scene-ready="">
      <WithSlotPanels
        slots={{ [NEW_FERRET_PROJECT_SLOT]: [{ plugin: 'projects', id: 'new-ferret-projects', view: Panel as never }] }}
      >
        <NewFerretPage
          AccountSlot={({ fallback }) => fallback}
          client={client as unknown as FerretsClient}
          daemon="fake"
          onNavigate={path => win.__navigated.push(path)}
        />
      </WithSlotPanels>
    </div>,
  );
