/**
 * Browser entry for r11 S9 (the Projects list as cards) over FAKE data: Projects' REAL hub, drawn from a registry of
 * `?projects=<n>` projects (the first has a repository, the second an active ferret) and two discoveries. No network.
 *
 *   ?projects=<n>   how many projects are registered (default 2)      ?discoveries=<n>   default 2
 *   ?theme=<family>-<mode>
 */
import { RouterProvider } from '@ferretry/app/testing/router';
import { createRoot } from 'react-dom/client';
import { ProjectInfoSchema } from '../../../../contract/index.ts';
import type { RecentProjectOption } from '../../../../app/lib/discoveries.ts';
import type { FerretRow } from '../../../../app/lib/ferrets.ts';
import type { ProjectsSlice } from '../../../../app/lib/projects-store.ts';
import { ProjectsHub } from '../../../../app/views/projects-hub.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const count = Number(params.get('projects') ?? '2');
const found = Number(params.get('discoveries') ?? '2');

const id = (index: number): string => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const projects = Array.from({ length: count }, (_, index) =>
  ProjectInfoSchema.parse({
    id: id(index + 1),
    name: `project-${index + 1}`,
    path: `/fake/p${index + 1}`,
    source: 'existing-folder',
    createdAt: '2026-08-01T10:00:00.000Z',
    ...(index === 0
      ? {
          repos: [{ path: '.', remote: 'https://github.com/fake-org/site', provider: 'github' }],
          git: { commonDirectory: '/fake/p1/.git' },
        }
      : {}),
  }),
);
const slice: ProjectsSlice = { projects, status: 'ready', error: null };
const ferrets: FerretRow[] = [
  {
    id: 'f1',
    name: 'ms-1',
    harness: 'claude',
    folder: '/fake/p2',
    state: 'working',
    stateAt: '2026-08-06T10:00:00.000Z',
  },
  { id: 'f2', name: 'ms-2', harness: 'claude', folder: '/fake/p2', state: 'idle', stateAt: '2026-08-06T10:00:00.000Z' },
  {
    id: 'f3',
    name: 'ms-3',
    harness: 'claude',
    folder: '/fake/p2',
    state: 'stopped',
    stateAt: '2026-08-06T10:00:00.000Z',
  },
];
const discoveries: RecentProjectOption[] = Array.from({ length: found }, (_, index) => ({
  kind: 'recent',
  key: `/fake/d${index + 1}`,
  name: `scratch-${index + 1}`,
  path: `/fake/d${index + 1}`,
  lastActivity: '2026-08-06T10:00:00.000Z',
}));

(window as unknown as { __navigated: string[] }).__navigated = [];
const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <div data-scene-ready="" style={{ height: '100dvh' }}>
      <RouterProvider>
        <ProjectsHub
          slice={slice}
          discoveries={discoveries}
          ferrets={ferrets}
          daemon="fake"
          ferretsError={null}
          status={null}
          onRegister={async () => true}
          onDismiss={() => undefined}
          projectHref={projectId => `/d/fake/projects/${projectId}`}
          onNavigate={to => {
            (window as unknown as { __navigated: string[] }).__navigated.push(to);
          }}
          now={Date.parse('2026-08-06T12:00:00.000Z')}
        />
      </RouterProvider>
    </div>,
  );
