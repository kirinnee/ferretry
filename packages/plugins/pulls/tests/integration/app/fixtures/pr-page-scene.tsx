/**
 * The browser entry for the PR page: the REAL `PullPageView` over a scripted client and FAKE data (no real repository,
 * login or account). Cases: `?case=long|merged|draft|paused|hostile|flood`. `?pixel=<url>` plants a remote image in the description so
 * a test can prove the page never requests it. `?theme=<family>-<mode>`.
 */
import { createRoot } from 'react-dom/client';
import { PullPageAnswerSchema } from '../../../../contract/index.ts';
import type { PullsClient } from '../../../../app/lib/client.ts';
import { PullPageView } from '../../../../app/features/pr-page/pr-page.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const kind = params.get('case') ?? 'long';
const pixel = params.get('pixel') ?? 'https://tracker.invalid/pixel.png';

const URL_BASE = 'https://github.com/octo-fake/ferretry-demo/pull/42';
const LONG = [
  '## What this does',
  '',
  'Adds the **session handoff** so a ferret can pick a conversation up where another left off. It touches three places:',
  '',
  '- the daemon route (`POST /v1/handoff`)',
  '- the list, which now groups by project',
  '- the docs, see [the design note](https://example.com/design)',
  '',
  `![the new list](${pixel})`,
  '',
  '> Note from the reviewer: please keep the old route for one release.',
  '',
  '```ts',
  'const handoff = await client.call("POST /v1/handoff", { body: { from, to } });',
  '```',
  '',
  '1. Run the migration.',
  '2. Restart the daemon.',
  '3. Check the board.',
  '',
  '- [x] tests added',
  '- [ ] docs reviewed',
  '',
  '<!-- template: remember to link the ticket -->',
  'Closes the handoff work. '.repeat(12),
].join('\n');

const pull = (over: Record<string, unknown>) => ({
  repo: { provider: 'github', owner: 'octo-fake', name: 'ferretry-demo' },
  number: 42,
  title: 'Add session handoff between ferrets',
  author: { login: 'alice-fake' },
  state: 'open',
  draft: false,
  review: 'changes_requested',
  ci: 'failing',
  headSha: 'b'.repeat(40),
  headRef: 'feature/handoff',
  baseRef: 'main',
  createdAt: '2026-02-01T10:00:00Z',
  updatedAt: '2026-02-03T15:30:00Z',
  url: URL_BASE,
  body: LONG,
  requestedReviewers: ['bob-fake'],
  commits: 6,
  changedFiles: 14,
  additions: 412,
  deletions: 87,
  ...over,
});

const comments = [
  {
    id: '1',
    author: { login: 'bob-fake' },
    body: 'Looks good overall. Can we keep `POST /v1/handoff` idempotent?',
    createdAt: '2026-02-02T09:00:00Z',
    url: `${URL_BASE}#issuecomment-1`,
  },
  {
    id: '2',
    author: { login: 'alice-fake' },
    body: 'Yes, a repeat with the same id answers the first result.\n\n> idempotent\n\nDone in the last commit.',
    createdAt: '2026-02-02T11:20:00Z',
    url: `${URL_BASE}#issuecomment-2`,
  },
];
const reviews = [
  {
    id: '9',
    author: { login: 'carol-fake' },
    verdict: 'changes_requested',
    body: 'The list grouping needs a test.',
    submittedAt: '2026-02-02T13:00:00Z',
    url: `${URL_BASE}#pullrequestreview-9`,
  },
];
const checks = {
  state: 'failing',
  total: 3,
  passed: 1,
  failed: 1,
  running: 1,
  queued: 0,
  items: [
    { name: 'build', status: 'passed' },
    { name: 'unit tests', status: 'failed' },
    { name: 'lint', status: 'running' },
  ],
};

const MAX_TEXT = 65_536;
/** Hidden control characters of every kind the page must mark. */
const CONTROLS = '‪‫‬‭‮⁦⁧⁨⁩​‌‍‎‏﻿';
/** Control characters in the title and a description that looks empty, and a link whose label lies about its address. */
const hostile = {
  kind: 'page',
  pull: pull({ title: 'Fix ‮gnp.exe​ handoff﻿', body: '﻿' }),
  comments: [
    {
      id: '1',
      author: { login: 'mallory-fake' },
      body: `[https://github.com/octo-fake/ferretry-demo/pull/42](https://evil.example/steal?token=1) and ${CONTROLS}`,
      createdAt: '2026-02-02T09:00:00Z',
      url: `${URL_BASE}#issuecomment-1`,
    },
  ],
  reviews: [],
  checks,
  truncated: false,
  fromCache: false,
};
/** The wire's largest page: 500 comments and 500 reviews, each 65,536 characters of tiny spans and hidden characters. */
const FLOOD_BODY = '​*a* '.repeat(Math.ceil(MAX_TEXT / 6)).slice(0, MAX_TEXT);
const flood = {
  kind: 'page',
  pull: pull({ body: FLOOD_BODY }),
  comments: Array.from({ length: 500 }, (_, index) => ({
    id: String(index + 1),
    author: { login: 'flood-fake' },
    body: FLOOD_BODY,
    createdAt: new Date(Date.UTC(2026, 1, 2, 0, 0, index)).toISOString(),
    url: `${URL_BASE}#issuecomment-${index + 1}`,
  })),
  reviews: Array.from({ length: 500 }, (_, index) => ({
    id: String(index + 1),
    author: { login: 'flood-fake' },
    verdict: 'commented',
    body: FLOOD_BODY,
    submittedAt: new Date(Date.UTC(2026, 1, 3, 0, 0, index)).toISOString(),
    url: `${URL_BASE}#pullrequestreview-${index + 1}`,
  })),
  checks,
  truncated: false,
  fromCache: false,
};

const answers: Record<string, unknown> = {
  hostile,
  flood,
  long: { kind: 'page', pull: pull({}), comments, reviews, checks, truncated: false, fromCache: false },
  merged: {
    kind: 'page',
    pull: pull({
      state: 'merged',
      review: 'approved',
      ci: 'passing',
      mergedAt: '2026-02-04T08:00:00Z',
      closedAt: '2026-02-04T08:00:00Z',
      body: 'Small fix.',
    }),
    comments: comments.slice(0, 1),
    reviews: [{ ...reviews[0], verdict: 'approved', body: '' }],
    checks: {
      ...checks,
      state: 'passing',
      passed: 3,
      failed: 0,
      running: 0,
      items: checks.items.map(item => ({ ...item, status: 'passed' })),
    },
    truncated: false,
    fromCache: true,
  },
  draft: {
    kind: 'page',
    pull: pull({ draft: true, review: 'none', ci: 'none', body: '' }),
    comments: [],
    reviews: [],
    checks: { state: 'none', total: 0, passed: 0, failed: 0, running: 0, queued: 0, items: [] },
    truncated: false,
    fromCache: false,
  },
  paused: { kind: 'paused', until: '2026-02-03T16:00:00.000Z' },
};

const client: PullsClient = {
  call: (async () => PullPageAnswerSchema.parse(answers[kind])) as PullsClient['call'],
};

createRoot(document.getElementById('root') as HTMLElement).render(
  <PullPageView
    address={{ project: '11111111-1111-4111-8111-111111111111', owner: 'octo-fake', name: 'ferretry-demo', number: 42 }}
    client={client}
    daemon="workstation"
    onNavigate={() => undefined}
  />,
);
