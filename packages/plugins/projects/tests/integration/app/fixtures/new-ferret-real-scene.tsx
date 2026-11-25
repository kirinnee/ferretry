/**
 * Browser entry for the Folder | Project hand-off over FAKE data: Ferrets' REAL `NewFerretPage` with Projects' REAL
 * "where it works" panel in its slot (no stand-in on either side), over one daemon that answers from memory and records
 * every call on `window.__calls`. No network. `?theme=<family>-<mode>`.
 */
import { NEW_FERRET_PROJECT_SLOT } from '@ferretry/core-ferrets/contract';
import { WithSlotPanels } from '@ferretry/app/testing/settings-shell';
import { applyTheme } from './explorer-toolbar.ts';
import { createRoot } from 'react-dom/client';
import type { FerretsClient } from '../../../../../../core/ferrets/app/lib/client.ts';
import { NewFerretPage } from '../../../../../../core/ferrets/app/features/new-ferret/new-ferret-page.tsx';
import { ProjectInfoSchema } from '../../../../contract/index.ts';
import type { ProjectsClient } from '../../../../app/lib/client.ts';
import { createNewFerretProjectsPanel } from '../../../../app/views/new-ferret-projects.tsx';

const params = new URLSearchParams(window.location.search);
applyTheme(params);

// `?twins=1`: two like-named folder-only projects deep under a temp directory, told apart only by their parent.
// `?slow=1`: the registry read is held until the test calls `window.__release()`.
const twins = params.get('twins') === '1';
const slow = params.get('slow') === '1';
const PATHS = twins ? ['/tmp/claude-1000/run-a/site', '/tmp/claude-1000/run-b/site'] : ['/fake/site', '/fake/api'];
const PROJECTS = PATHS.map((path, index) =>
  ProjectInfoSchema.parse({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    name: path.split('/').at(-1),
    path,
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
const win = window as unknown as { __calls: Recorded[]; __navigated: string[]; __release: () => void };
const gate = new Promise<void>(resolve => {
  win.__release = resolve;
});
win.__calls = calls;
win.__navigated = [];

const client = {
  call: async <Answer,>(
    route: string,
    init?: { headers?: Record<string, string>; body?: unknown; query?: Record<string, string> },
  ): Promise<Answer> => {
    calls.push({ route, headers: init?.headers, body: init?.body });
    if (route === 'GET /v1/projects') {
      if (slow) await gate;
      return PROJECTS as Answer;
    }
    if (route === 'GET /v1/ferrets') return FERRETS as Answer;
    if (route === 'POST /v1/ferrets') return { id: 'new-ferret' } as Answer;
    if (route === 'GET /v1/git-accounts') return [] as Answer;
    if (route === 'GET /v1/projects/folders') {
      // The folder finder's listing: a small fake home, enough for the explorer's toolbar to draw.
      const home = '/fake';
      const path = init?.query?.path ?? home;
      const folder = (name: string) => ({
        name,
        kind: 'folder',
        isRepo: false,
        hidden: false,
        modifiedAt: '2026-08-01T10:00:00.000Z',
      });
      return {
        path,
        crumbs: [{ name: '~', path: home }],
        entries: ['atlas', 'harbour', 'notes', 'scratch'].map(folder),
        truncated: false,
      } as Answer;
    }
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
