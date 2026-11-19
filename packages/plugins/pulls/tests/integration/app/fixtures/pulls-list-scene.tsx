/**
 * The browser entry for the PRs & CI screen: the REAL `PullsList` over a scripted client and FAKE data (no real
 * repository, login or account), on a fixed clock. Cases: `?case=empty|mixed|running|paused|long`. `?theme=<family>-<mode>`.
 */
import { ScreenHrefProvider } from '@ferretry/app';
import { createRoot } from 'react-dom/client';
import type { ListClient } from '../../../../app/features/list/api.ts';
import { PullsList } from '../../../../app/features/list/pulls-list.tsx';
import { WatchOverviewSchema } from '../../../../contract/index.ts';

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
      <PullsList client={client} daemon="workstation" nowMs={NOW} onNavigate={() => undefined} />
    </div>
  </ScreenHrefProvider>,
);
