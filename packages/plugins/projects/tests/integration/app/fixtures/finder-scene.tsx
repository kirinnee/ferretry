/**
 * Browser entry for F6061 U7 (the project page's file finder) over FAKE data: Projects' REAL project page, over a daemon
 * that answers from memory — the project list, an empty ferret list and the three finder routes — and records every call on
 * `window.__calls`. No network.
 *
 *   ?theme=<family>-<mode>
 *   &view=ready       a complete index of 12,594 files
 *   &view=cap         an index that hit the 50,000 cap (banner: where, skipped, tip)
 *   &view=building    a build is running (the button says Updating…), then it finishes after ~1.2 s
 *   &view=ferret      a complete index and a ferret working in the project (a row opens its file in that ferret's view)
 *   &view=outside     a project OUTSIDE the home: Rescan starts a build, and then every look at it is refused, 403, as a
 *                     real daemon does once the per-act confirmation is spent (filesystem.configure on every status GET)
 *   &find=<text>      the address seeds the finder's box (how "Go to file" arrives)
 */
import { RouterProvider } from '@ferretry/app/testing/router';
import { createRoot } from 'react-dom/client';
import { ProjectInfoSchema } from '../../../../contract/index.ts';
import type { ProjectsClient } from '../../../../app/lib/client.ts';
import { ProjectDetailPage } from '../../../../app/views/project-detail.tsx';
import {
  answerFor,
  CAPPED,
  FILES,
  RESCAN,
  STATUS,
  statusOf,
  summaryOf,
} from '../../../unit/app/support/finder-fixtures.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const view = params.get('view') ?? 'ready';

const PROJECT = ProjectInfoSchema.parse({
  id: '00000000-0000-4000-8000-000000000001',
  name: 'ferretry',
  path: '/work/ferretry',
  source: 'existing-folder',
  createdAt: '2026-08-01T10:00:00.000Z',
});

const index = view === 'cap' ? CAPPED : summaryOf({ builtAt: new Date(Date.now() - 3 * 60_000).toISOString() });
const startedAt = Date.now();
/** The fake build ends 1.2 s after the page loaded. */
const building = (): boolean => view === 'building' && Date.now() - startedAt < 1_200;

// A project with a few hundred files, so the page and the list are drawn the way a real one is.
const PATHS = [
  'README.md',
  'package.json',
  'Taskfile.yaml',
  // Two names that differ only by `.` and `-`: the command bar once made one DOM id of both.
  'src/entry.ts',
  'src/entry-ts',
  ...Array.from({ length: 14 }, (_, row) => `packages/plugins/projects/daemon/features/files/module-${String(row)}.ts`),
  'packages/plugins/projects/app/features/file-finder/some-very-long-file-name-that-has-to-truncate-instead-of-scrolling-the-page-sideways.tsx',
];

/** What the daemon's gate throws for a folder outside the home when the per-act confirmation is spent (a DaemonCallError). */
const REFUSED = Object.assign(new Error('listing a folder outside the home folder needs filesystem.configure'), {
  status: 403,
  code: 'step-up-required',
});

interface Recorded {
  route: string;
  query: unknown;
}
const calls: Recorded[] = [];
(window as unknown as { __calls: Recorded[] }).__calls = calls;

const client = {
  call: async <Answer,>(route: string, init?: { query?: Record<string, string> }): Promise<Answer> => {
    calls.push({ route, query: init?.query });
    if (route === 'GET /v1/projects') return [PROJECT] as Answer;
    if (route === 'GET /v1/ferrets')
      return (
        view === 'ferret' || view === 'outside'
          ? [
              {
                id: 'f-1',
                name: 'hayden',
                harness: 'claude-code',
                folder: PROJECT.path,
                state: 'working',
                stateAt: '2026-08-06T10:00:00.000Z',
              },
            ]
          : []
      ) as Answer;
    if (route === 'GET /v1/board/projects/:projectId/switch')
      return { projectId: PROJECT.id, on: false, setBy: 'default', setAt: null } as Answer;
    if (route === FILES)
      return answerFor(index, init?.query?.q, Number(init?.query?.limit ?? 50), building(), PATHS) as Answer;
    if (route === STATUS) {
      if (view === 'outside') throw REFUSED;
      return statusOf(index, building()) as Answer;
    }
    if (route === RESCAN) return statusOf(index, true) as Answer;
    throw new Error(`no route ${route}`);
  },
} as unknown as ProjectsClient;

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <div data-scene-ready="">
      <RouterProvider>
        <ProjectDetailPage client={client} daemon="fake" projectId={PROJECT.id} />
      </RouterProvider>
    </div>,
  );
