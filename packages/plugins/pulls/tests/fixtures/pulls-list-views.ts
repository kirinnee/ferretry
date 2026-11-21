/** Fake watch overviews for the PRs screen (r9 E3): fixed instants, fake people, no network. Never a real login. */
import { WatchOverviewSchema, WatchedPullSchema, type WatchedPull, type WatchOverview } from '../../contract/index.ts';

export const NOW = Date.parse('2026-02-03T12:00:00Z');
export const PROJECT = '11111111-1111-4111-8111-111111111111';
export const OTHER = '22222222-2222-4222-8222-222222222222';
export const REPO = { provider: 'github', owner: 'octo', name: 'demo' } as const;

export const pull = (number: number, over: Record<string, unknown> = {}): WatchedPull =>
  WatchedPullSchema.parse({
    repo: REPO,
    number,
    title: `Change number ${number}`,
    author: { login: 'alice' },
    state: 'open',
    draft: false,
    review: 'none',
    ci: 'passing',
    headSha: 'a'.repeat(40),
    headRef: `branch-${number}`,
    baseRef: 'main',
    createdAt: '2026-02-01T10:00:00Z',
    updatedAt: '2026-02-03T11:56:00Z',
    url: `https://github.com/octo/demo/pull/${number}`,
    mine: false,
    requestedMe: false,
    comments: 0,
    ...over,
  });

const NOTIFY = {
  ciFailed: true,
  reviewRequested: true,
  changesRequested: true,
  approved: true,
  ciPassed: false,
  comment: false,
  closed: false,
};

export const view = (over: Record<string, unknown> = {}) => ({
  project: PROJECT,
  watch: true,
  watchedBy: 'you',
  notify: NOTIFY,
  repos: [
    {
      repo: REPO,
      account: 'gha_1',
      login: 'me',
      pulls: [] as WatchedPull[],
      checkedAt: '2026-02-03T11:59:00Z',
    },
  ],
  needsAccount: [],
  ...over,
});

export const overview = (...views: Record<string, unknown>[]): WatchOverview =>
  WatchOverviewSchema.parse({ projects: views });

/** A project with a mix of states: mine/failing, asked of me/running, a draft, and one nobody asked about. */
export const mixed = (): WatchOverview =>
  overview(
    view({
      repos: [
        {
          repo: REPO,
          account: 'gha_1',
          login: 'me',
          checkedAt: '2026-02-03T11:59:00Z',
          pulls: [
            pull(1, { mine: true, ci: 'failing', review: 'changes_requested', title: 'Fix the flaky retry' }),
            pull(2, { requestedMe: true, ci: 'running', title: 'Add the export button', author: { login: 'bob' } }),
            pull(3, { draft: true, ci: 'queued', title: 'Draft: try a new layout', updatedAt: '2026-02-02T09:00:00Z' }),
            pull(4, { review: 'approved', ci: 'passing', title: 'Docs pass', author: { login: 'carol' } }),
          ],
        },
      ],
    }),
  );
