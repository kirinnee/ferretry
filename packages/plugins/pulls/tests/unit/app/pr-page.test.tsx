import { describe, expect, it } from 'bun:test';
import { interact, mount, must, RouterProvider, settleUntil } from '@ferretry/app/testing';
import { PullPageAnswerSchema, type PullPageAnswer } from '../../../contract/index.ts';
import type { PullsClient } from '../../../app/lib/client.ts';
import { PullPageView } from '../../../app/features/pr-page/pr-page.tsx';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const ADDRESS = { project: PROJECT, owner: 'octo', name: 'demo', number: 7 } as const;
const URL = 'https://github.com/octo/demo/pull/7';

const HOSTILE = [
  'Intro <script>alert(1)</script> <img src="https://tracker.example/pixel.png" onerror="alert(1)">',
  '',
  '![remote](https://tracker.example/p.png)',
  '',
  '[bad](javascript:alert(1)) [good](https://example.com/x)',
  '',
  '```fy-render',
  '{"type":"image","src":"https://tracker.example/q.png"}',
  '```',
  '',
  'refs &F1 :britnee %terminal:dev ^A3',
].join('\n');

const page = (over: Record<string, unknown> = {}): PullPageAnswer =>
  PullPageAnswerSchema.parse({
    kind: 'page',
    pull: {
      repo: { provider: 'github', owner: 'octo', name: 'demo' },
      number: 7,
      title: 'Add the thing',
      author: { login: 'alice' },
      state: 'open',
      draft: false,
      review: 'changes_requested',
      ci: 'failing',
      headSha: 'a'.repeat(40),
      headRef: 'feature',
      baseRef: 'main',
      createdAt: '2026-02-01T10:00:00Z',
      updatedAt: '2026-02-02T10:00:00Z',
      url: URL,
      body: HOSTILE,
      requestedReviewers: ['bob'],
      commits: 2,
      changedFiles: 3,
      additions: 10,
      deletions: 4,
    },
    comments: [
      {
        id: '1',
        author: { login: 'bob' },
        body: '<b>hi</b> [x](javascript:1)',
        createdAt: '2026-02-01T11:00:00Z',
        url: `${URL}#c1`,
      },
    ],
    reviews: [
      {
        id: '2',
        author: { login: 'carol' },
        verdict: 'approved',
        body: '',
        submittedAt: '2026-02-01T12:00:00Z',
        url: `${URL}#r2`,
      },
    ],
    checks: {
      state: 'failing',
      total: 2,
      passed: 1,
      failed: 1,
      running: 0,
      queued: 0,
      items: [
        { name: 'build', status: 'passed', url: 'https://github.com/octo/demo/runs/1' },
        { name: 'test', status: 'failed' },
      ],
    },
    truncated: false,
    fromCache: false,
    ...over,
  });

const clientOf = (answer: unknown, calls: unknown[] = []): PullsClient => ({
  call: (async (route: string, init?: unknown) => {
    calls.push({ route, init });
    if (answer instanceof Error) throw answer;
    return answer;
  }) as PullsClient['call'],
});

const view = (client: PullsClient) => (
  <RouterProvider>
    <PullPageView address={ADDRESS} client={client} daemon="workstation" onNavigate={() => undefined} />
  </RouterProvider>
);

const shown = async (mounted: Awaited<ReturnType<typeof mount>>, selector = '[data-pull-header]') =>
  await settleUntil(() => mounted.container.querySelector(selector) !== null, selector, interact);

describe('PullPageView', () => {
  it('asks for the one PR by project, owner~name and number', async () => {
    const calls: unknown[] = [];
    const mounted = await mount(view(clientOf(page(), calls)));
    await shown(mounted);
    expect(calls).toEqual([
      {
        route: 'GET /v1/pulls/:project/:repo/:number',
        init: { params: { project: PROJECT, repo: 'octo~demo', number: '7' } },
      },
    ]);
    await mounted.unmount();
  });

  it('draws the header and the conversation, and a hostile body renders inert', async () => {
    const mounted = await mount(view(clientOf(page())));
    await shown(mounted);
    const root = mounted.container;
    expect(root.textContent).toContain('Add the thing');
    expect(root.querySelector('[data-pull-state="open"]')?.textContent).toBe('Open');
    expect(root.querySelector('[data-pull-review="changes_requested"]')).not.toBeNull();
    // Nothing a stranger wrote became an element: no script, no image, no iframe, no raw tag.
    for (const tag of ['script', 'img', 'iframe', 'object', 'embed', 'svg', 'style', 'form', 'input'])
      expect(root.querySelector(`[data-gh-text] ${tag}`)).toBeNull();
    // Nowhere on the page is there a picture, a frame or a script either (the only svg is our own back arrow).
    for (const tag of ['script', 'img', 'iframe', 'object', 'embed']) expect(root.querySelector(tag)).toBeNull();
    // The tags are on screen as text.
    expect(root.textContent).toContain('<script>alert(1)</script>');
    expect(root.textContent).toContain('<b>hi</b>');
    // A remote image is "image: <alt>" and a link to GitHub; its address appears nowhere in the DOM.
    expect(must(root.querySelector('[data-gh-image]'), 'the image note').textContent).toContain('image: remote');
    // No element carries a src, and no link points at the stranger's picture host.
    expect(root.querySelector('[src]')).toBeNull();
    expect([...root.querySelectorAll('a')].some(a => (a.getAttribute('href') ?? '').includes('tracker.example'))).toBe(
      false,
    );
    expect(must(root.querySelector('[data-gh-image] a'), 'its link').getAttribute('href')).toBe(URL);
    // A javascript: link is text; the good link opens outside the app, safely.
    const hrefs = [...root.querySelectorAll('[data-gh-text] a')].map(a => a.getAttribute('href'));
    expect(hrefs.some(href => (href ?? '').toLowerCase().startsWith('javascript'))).toBe(false);
    const good = must(
      [...root.querySelectorAll('[data-gh-text] a')].find(a => a.getAttribute('href') === 'https://example.com/x'),
      'the good link',
    );
    expect(good.getAttribute('rel')).toBe('noopener noreferrer');
    expect(good.getAttribute('target')).toBe('_blank');
    // The fy-render fence is plain code text.
    expect(root.querySelector('pre')?.textContent).toContain('"type":"image"');
    // Ferretry references are not linked inside GitHub text.
    expect(root.querySelector('[data-fy-reference], [data-card-reference]')).toBeNull();
    expect(
      [...root.querySelectorAll('[data-gh-text] a')].every(a => (a.getAttribute('rel') ?? '').includes('noopener')),
    ).toBe(true);
    await mounted.unmount();
  });

  it('shows a review with its verdict and an empty description plainly', async () => {
    const answer = page();
    if (answer.kind !== 'page') throw new Error('fixture');
    const mounted = await mount(view(clientOf({ ...answer, pull: { ...answer.pull, body: '' } })));
    await shown(mounted);
    expect(mounted.container.textContent).toContain('No description provided.');
    expect(mounted.container.querySelector('[data-pull-verdict="approved"]')).not.toBeNull();
    await mounted.unmount();
  });

  it('switches to Files and CI', async () => {
    const mounted = await mount(view(clientOf(page())));
    await shown(mounted);
    const tab = (label: string) =>
      must(
        [...mounted.container.querySelectorAll<HTMLButtonElement>('[data-pull-tab]')].find(b =>
          (b.textContent ?? '').startsWith(label),
        ),
        label,
      );
    await interact(() => tab('CI').click());
    expect(mounted.container.querySelector('[data-pull-ci-summary="failing"]')?.textContent).toContain(
      '1 passed, 1 failed',
    );
    expect(mounted.container.querySelectorAll('[data-pull-check]').length).toBe(2);
    await interact(() => tab('Files').click());
    expect(mounted.container.querySelector('[data-pull-files]')?.textContent).toContain('3 files changed');
    await mounted.unmount();
  });

  it('says "Paused until <time>" and reads nothing else while the budget is spent', async () => {
    const mounted = await mount(view(clientOf({ kind: 'paused', until: '2026-02-03T10:00:00.000Z' })));
    await shown(mounted, '[data-pull-paused]');
    expect(mounted.container.textContent).toContain('Paused until ');
    expect(mounted.container.textContent).toContain("to stay inside GitHub's limit");
    await mounted.unmount();
  });

  it('names why a read failed, in the daemon’s own words', async () => {
    const mounted = await mount(view(clientOf(new Error('This project is not linked to a GitHub account.'))));
    await shown(mounted, '[data-pull-failed]');
    expect(mounted.container.textContent).toContain('not linked to a GitHub account');
    await mounted.unmount();
  });

  it('says when more than a page of conversation exists', async () => {
    const mounted = await mount(view(clientOf(page({ truncated: true }))));
    await shown(mounted);
    expect(mounted.container.textContent).toContain('Read the rest on GitHub');
    await mounted.unmount();
  });
});
