/**
 * The browser entry for the compose shots: the REAL `PullPageView` over a scripted client and FAKE data (no real
 * repository, login or account). The client records every post on `window.__posts` so the test can read what was sent.
 *
 *   ?theme=<family>-<mode>   ?post=ok|secret|unknown   (what the next post answers)
 */
import { createRoot } from 'react-dom/client';
import type { PullsClient } from '../../../../app/lib/client.ts';
import { PullPageView } from '../../../../app/features/pr-page/pr-page.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const mode = params.get('post') ?? 'ok';

const URL_BASE = 'https://github.com/octo-fake/ferretry-demo/pull/42';
const BODY = [
  '## What this does',
  '',
  'Adds the **session handoff** so a ferret can pick a conversation up where another left off.',
  '',
  'Please keep the old route for one release, so nobody has to upgrade in a hurry.',
].join('\n');

const page = {
  kind: 'page',
  pull: {
    repo: { provider: 'github', owner: 'octo-fake', name: 'ferretry-demo' },
    number: 42,
    title: 'Add session handoff between ferrets',
    author: { login: 'alice-fake' },
    state: 'open',
    draft: false,
    review: 'changes_requested',
    ci: 'passing',
    headSha: 'b'.repeat(40),
    headRef: 'feature/handoff',
    baseRef: 'main',
    createdAt: '2026-02-01T10:00:00Z',
    updatedAt: '2026-02-03T15:30:00Z',
    url: URL_BASE,
    body: BODY,
    requestedReviewers: [],
    commits: 2,
    changedFiles: 1,
    additions: 3,
    deletions: 1,
  },
  comments: [
    {
      id: '1',
      author: { login: 'bob-fake' },
      body: 'Can we keep the route idempotent? A repeat with the same id should answer the first result.',
      createdAt: '2026-02-02T09:00:00Z',
      url: `${URL_BASE}#issuecomment-1`,
    },
  ],
  reviews: [],
  checks: {
    state: 'passing',
    total: 1,
    passed: 1,
    failed: 0,
    running: 0,
    queued: 0,
    items: [{ name: 'build', status: 'passed' }],
  },
  truncated: false,
  fromCache: false,
};

const PATCH = [
  '@@ -10,4 +10,5 @@ export function handoff()',
  ' const from = session.id;',
  '-const to = pick();',
  '+const to = pick(session);',
  '+const note = `handed off ${from}`;',
  ' return { from, to, note };',
].join('\n');

const comment = (id: string, login: string, body: string) => ({
  id,
  author: { login },
  body,
  createdAt: '2026-02-02T10:00:00Z',
  url: `${URL_BASE}#discussion_${id}`,
});

const posts: unknown[] = [];
(window as unknown as { __posts: unknown[] }).__posts = posts;
let secretStopped = false;

const client: PullsClient = {
  call: (async (route: string, init?: { body?: Record<string, unknown> }) => {
    if (route.endsWith('/poster')) return { login: 'octo-fake' };
    if (route.endsWith('/files'))
      return {
        files: [
          {
            path: 'src/handoff.ts',
            status: 'modified',
            additions: 3,
            deletions: 1,
            patch: PATCH,
            url: `${URL_BASE}/files`,
          },
        ],
        truncated: false,
        unreadable: 0,
        fromCache: false,
      };
    if (route.endsWith('/threads'))
      return {
        threads: [
          {
            id: 'PRRT_demo1',
            resolved: false,
            outdated: false,
            path: 'src/handoff.ts',
            line: 11,
            side: 'right',
            comments: [comment('c9', 'carol-fake', 'Should this take the whole session, or just its id?')],
          },
        ],
        truncated: false,
        fetchedAt: '2026-02-03T15:30:00Z',
      };
    if (route.startsWith('GET')) return page;
    posts.push({ route, body: init?.body });
    if (mode === 'secret' && !secretStopped && init?.body?.postAnyway !== true) {
      secretStopped = true;
      throw Object.assign(new Error('This looks like a secret. Remove it, or post anyway.'), {
        code: 'pulls_secret_shaped',
      });
    }
    if (mode === 'unknown') return { kind: 'unknown' };
    return { kind: 'posted', id: '9001', url: `${URL_BASE}#issuecomment-9001`, replayed: false };
  }) as PullsClient['call'],
};

createRoot(document.getElementById('root') as HTMLElement).render(
  <PullPageView
    address={{ project: '11111111-1111-4111-8111-111111111111', owner: 'octo-fake', name: 'ferretry-demo', number: 42 }}
    client={client}
    daemon="workstation"
    onNavigate={() => undefined}
  />,
);
