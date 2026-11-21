/**
 * The browser entry for the PRs & CI screen: the REAL `PullsList` over a scripted client and FAKE data (no real
 * repository, login or account), on a fixed clock. Cases: `?case=empty|mixed|running|paused|long`. `?theme=<family>-<mode>`.
 *
 * `?case=default&project=A|B` (r11 S7) draws the project page's PRs section over a client that behaves like the daemon:
 * project A has a linked account and NO stored choice, project B has none. It uses the REAL `settingsOf` / `nextSetting`,
 * records every PATCH body in `window.__patches` and every GitHub look in `window.__reads` (a project is only "read" while
 * its effective watch is on), so a test can assert on what the daemon would have been asked.
 */
import { ScreenHrefProvider } from '@ferretry/app';
import { createRoot } from 'react-dom/client';
import type { ListClient } from '../../../../app/features/list/api.ts';
import { ProjectPulls } from '../../../../app/features/list/project-section.tsx';
import { PullsList } from '../../../../app/features/list/pulls-list.tsx';
import {
  nextSetting,
  settingsOf,
  WatchOverviewSchema,
  type PullsConfig,
  type WatchPatch,
} from '../../../../contract/index.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const kind = params.get('case') ?? 'mixed';

const NOW = Date.parse('2026-02-03T12:00:00Z');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const REPO = { provider: 'github', owner: 'octo-fake', name: 'ferretry-demo' } as const;
const NOTIFY = {
  ciFailed: true,
  reviewRequested: true,
  changesRequested: true,
  approved: true,
  ciPassed: false,
  comment: false,
  closed: false,
};

const pull = (number: number, over: Record<string, unknown> = {}) => ({
  repo: REPO,
  number,
  title: `Change number ${number}`,
  author: { login: 'alice-fake' },
  state: 'open',
  draft: false,
  review: 'none',
  ci: 'passing',
  headSha: 'a'.repeat(40),
  headRef: `branch-${number}`,
  baseRef: 'main',
  createdAt: '2026-02-01T10:00:00Z',
  updatedAt: '2026-02-03T11:56:00Z',
  url: `https://github.com/octo-fake/ferretry-demo/pull/${number}`,
  mine: false,
  requestedMe: false,
  comments: 0,
  ...over,
});

const watched = (pulls: unknown[], over: Record<string, unknown> = {}) => ({
  project: A,
  watch: true,
  watchedBy: 'you',
  notify: NOTIFY,
  repos: [{ repo: REPO, account: 'gha_1', login: 'me-fake', checkedAt: '2026-02-03T11:59:00Z', pulls }],
  needsAccount: [],
  ...over,
});

const mixedPulls = [
  pull(41, { mine: true, ci: 'failing', review: 'changes_requested', title: 'Fix the flaky retry in the handoff' }),
  pull(42, { requestedMe: true, ci: 'running', title: 'Add the export button', author: { login: 'bob-fake' } }),
  pull(43, { draft: true, ci: 'queued', title: 'Draft: try a new layout', updatedAt: '2026-02-02T09:00:00Z' }),
  pull(44, { mine: true, review: 'approved', ci: 'passing', title: 'Docs pass', author: { login: 'me-fake' } }),
];

const cases: Record<string, unknown> = {
  empty: {
    projects: [
      watched([], {
        repos: [],
        needsAccount: [
          { provider: 'github', owner: 'octo-fake', name: 'ferretry-demo' },
          { provider: 'github', owner: 'octo-fake', name: 'a-private-repository-with-a-long-name' },
        ],
      }),
      { ...watched([]), project: B, watch: false, repos: [] },
    ],
  },
  mixed: { projects: [watched(mixedPulls), { ...watched([]), project: B, watch: false, repos: [] }] },
  running: {
    projects: [
      watched([
        pull(50, { mine: true, ci: 'running', title: 'Rebuild the cache index', updatedAt: '2026-02-03T11:58:30Z' }),
        pull(51, { mine: true, ci: 'running', title: 'Split the watch loop', updatedAt: '2026-02-03T11:50:00Z' }),
        pull(52, { mine: true, ci: 'queued', title: 'Bump the toolchain', updatedAt: '2026-02-03T11:30:00Z' }),
      ]),
    ],
  },
  paused: { projects: [watched(mixedPulls, { pausedUntil: '2026-02-03T12:30:00Z' })] },
  long: {
    projects: [
      watched([
        pull(60, {
          mine: true,
          title: `A very long title ${'unbroken'.repeat(14)} and then some words that wrap`,
          author: { login: 'a-fake-login-that-is-really-quite-long' },
        }),
        pull(61, { mine: true, title: '‮evil right-to-left override title', author: { login: 'bidi-fake' } }),
        ...Array.from({ length: 24 }, (_, i) =>
          pull(100 + i, {
            mine: true,
            title: `Routine change ${i + 1}`,
            updatedAt: `2026-02-02T${10 + (i % 10)}:00:00Z`,
          }),
        ),
      ]),
    ],
  },
};

// ─── r11 S7: a client that decides like the daemon ───────────────────────────────────────────────────────────────────
const stored: PullsConfig['projects'] = {};
const LINKED: Record<string, boolean> = { [A]: true, [B]: false };
const patches: WatchPatch[] = [];
const reads: Record<string, number> = { [A]: 0, [B]: 0 };
Object.assign(window, { __patches: patches, __reads: reads });

const defaultOverview = () => ({
  projects: [A, B].map(id => {
    const settings = settingsOf({ projects: stored }, id, LINKED[id] === true);
    if (settings.watch) reads[id] = (reads[id] ?? 0) + 1;
    const pulls = id === A ? mixedPulls : [];
    return {
      project: id,
      watch: settings.watch,
      watchedBy: settings.watchedBy,
      notify: settings.notify,
      repos: settings.watch
        ? [{ repo: REPO, account: 'gha_1', login: 'me-fake', checkedAt: '2026-02-03T11:59:00Z', pulls }]
        : [],
      needsAccount: [],
    };
  }),
});

const defaultClient: ListClient = {
  call: (async (route: string, init?: { params?: { project?: string }; body?: WatchPatch }) => {
    if (route === 'GET /v1/pulls/watch') return WatchOverviewSchema.parse(defaultOverview());
    if (route === 'GET /v1/projects') return [{ id: A, name: 'ferretry-demo', repos: [{}] }];
    if (route === 'PATCH /v1/pulls/watch/:project') {
      const id = init?.params?.project ?? '';
      const body = init?.body ?? {};
      patches.push(body);
      stored[id] = nextSetting(stored[id], body);
      return { view: {} };
    }
    return { view: {} };
  }) as ListClient['call'],
};

const client: ListClient = {
  call: (async (route: string) => {
    if (route === 'GET /v1/pulls/watch') return WatchOverviewSchema.parse(cases[kind]);
    if (route === 'GET /v1/projects')
      return [
        { id: A, name: 'ferretry-demo' },
        { id: B, name: 'notes' },
      ];
    return { view: {} };
  }) as ListClient['call'],
};

const root = document.getElementById('root');
if (root === null) throw new Error('the scene page has no #root');
createRoot(root).render(
  <ScreenHrefProvider href={(_daemon, _plugin, _screen, p = {}) => `/pulls/${p.repo ?? ''}/${p.number ?? ''}`}>
    <div data-scene-ready="" style={{ height: '100%' }}>
      {kind === 'default' ? (
        <main className="mx-auto w-full max-w-3xl p-panel" data-scene-project="">
          <section className="kt-panel grid gap-sm p-panel">
            <ProjectPulls
              client={defaultClient}
              daemon="workstation"
              nowMs={NOW}
              onNavigate={() => undefined}
              project={params.get('project') === 'B' ? B : A}
            />
          </section>
        </main>
      ) : (
        <PullsList client={client} daemon="workstation" nowMs={NOW} onNavigate={() => undefined} />
      )}
    </div>
  </ScreenHrefProvider>,
);
