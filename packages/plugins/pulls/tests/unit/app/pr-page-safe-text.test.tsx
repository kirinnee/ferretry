import { describe, expect, it } from 'bun:test';
import { ensureDom, interact, mount, must, RouterProvider, ShellContext, WithViewPlace } from '@ferretry/app/testing';
import type { ReactNode } from 'react';

ensureDom();
import type { PullPage, ReviewThread } from '../../../contract/index.ts';
import { CiTab } from '../../../app/features/pr-page/ci-tab.tsx';
import { Conversation, ENTRY_STEP } from '../../../app/features/pr-page/conversation.tsx';
import { PullHeader } from '../../../app/features/pr-page/header.tsx';
import { COLLAPSED_CHARS, SafeProse } from '../../../app/features/pr-page/safe-prose.tsx';
import { ThreadCard } from '../../../app/features/threads/thread-card.tsx';

/**
 * PR page text is from strangers (E4): a hidden control character is drawn as a visible chip on EVERY page path (the
 * description and comments, the title, a Files-tab review comment), every link it draws follows the "Open links in"
 * setting like any other link in the app and shows where it goes, and a page is drawn in a bounded few nodes.
 */
const URL = 'https://github.com/octo/demo/pull/7';

/** The whole requested control set: U+202A–202E, U+2066–2069, U+200B–200F, U+FEFF. */
const CODES = [
  ...[0x202a, 0x202b, 0x202c, 0x202d, 0x202e],
  ...[0x2066, 0x2067, 0x2068, 0x2069],
  ...[0x200b, 0x200c, 0x200d, 0x200e, 0x200f],
  0xfeff,
];
const CONTROLS = String.fromCodePoint(...CODES);
const LABELS = CODES.map(code => `U+${code.toString(16).toUpperCase().padStart(4, '0')}`);
const chips = (root: Element): (string | null)[] =>
  [...root.querySelectorAll('[data-diff-control]')].map(chip => chip.getAttribute('data-diff-control'));
const NO_RAW = /[‪-‮⁦-⁩​-‏﻿]/u;

const taken: string[] = [];
const provision = {
  activate: (click: Event, target: { readonly href: string | undefined }): boolean => {
    click.preventDefault();
    taken.push(target.href ?? '');
    return true;
  },
  open: () => undefined,
  sheet: null,
  destination: () => 'in-app',
};
const shell = {
  runtime: {
    linkProvision: () => provision,
    subscribe: () => () => undefined,
    version: () => 0,
  },
};
const placed = (child: ReactNode) => (
  <ShellContext.Provider value={shell as never}>
    <WithViewPlace place={{ daemon: 'desk', machine: 'Desk' } as never}>{child}</WithViewPlace>
  </ShellContext.Provider>
);
const tap = (link: Element) =>
  interact(() => link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));

describe('hidden control characters in a PR body', () => {
  it('draws U+202E as a visible chip, never passing it on', async () => {
    const mounted = await mount(<SafeProse sourceUrl={URL} text={'looks fine ‮evil.exe and **bold​here**'} />);
    const root = mounted.container;
    const labels = chips(root);
    expect(labels).toEqual(['U+202E', 'U+200B']);
    expect(must(root.querySelector('[data-diff-control="U+202E"]'), 'the chip').textContent).toBe('<U+202E>');
    expect(root.textContent).not.toContain('‮');
    expect(root.textContent).not.toContain('​');
    await mounted.unmount();
  });

  it('marks the whole control set in a description, a comment and a review, and a lone U+FEFF is not "no description"', async () => {
    const entry = (over: object) => ({
      author: { login: 'mallory-fake' },
      createdAt: '2026-02-02T09:00:00Z',
      url: `${URL}#x`,
      ...over,
    });
    const page = {
      kind: 'page',
      pull: { url: URL, body: '﻿', author: { login: 'a' }, createdAt: '2026-02-01T10:00:00Z' },
      comments: [entry({ id: '1', body: `see ${CONTROLS}` })],
      reviews: [entry({ id: '2', verdict: 'commented', body: `and ${CONTROLS}`, submittedAt: '2026-02-03T09:00:00Z' })],
      truncated: false,
    } as unknown as PullPage;
    const mounted = await mount(<Conversation page={page} />);
    const [description, comment, review] = [...mounted.container.querySelectorAll('[data-pull-entry]')];
    expect(description?.textContent).not.toContain('No description provided');
    expect(chips(must(description, 'the description'))).toEqual(['U+FEFF']);
    expect(chips(must(comment, 'the comment'))).toEqual(LABELS);
    expect(chips(must(review, 'the review'))).toEqual(LABELS);
    expect(mounted.container.textContent).not.toMatch(NO_RAW);
    await mounted.unmount();
  });

  it('marks the whole control set in the title', async () => {
    const pull = {
      repo: { owner: 'octo', name: 'demo' },
      title: `Fix ${CONTROLS}`,
      number: 7,
      state: 'open',
      draft: false,
      review: 'none',
      ci: 'none',
      author: { login: 'a' },
      requestedReviewers: [],
      url: URL,
      createdAt: '2026-02-01T10:00:00Z',
      updatedAt: '2026-02-01T10:00:00Z',
      commits: 1,
      changedFiles: 1,
      additions: 1,
      deletions: 0,
    } as never;
    const mounted = await mount(<PullHeader pull={pull} />);
    expect(chips(must(mounted.container.querySelector('h1'), 'the title'))).toEqual(LABELS);
    expect(must(mounted.container.querySelector('h1'), 'the title').textContent).not.toMatch(NO_RAW);
    await mounted.unmount();
  });

  it('marks the whole control set in a Files-tab review comment', async () => {
    const thread: ReviewThread = {
      id: 't1',
      resolved: false,
      outdated: false,
      path: 'src/a.ts',
      line: 3,
      side: 'right',
      comments: [
        {
          id: 'c1',
          author: { login: 'mallory-fake' },
          body: `rename ${CONTROLS}`,
          createdAt: '2026-02-02T09:00:00Z',
          url: `${URL}#d1`,
        },
      ],
    };
    const mounted = await mount(<ThreadCard thread={thread} />);
    const body = must(mounted.container.querySelector('[data-thread-comment] p'), 'the comment');
    expect(chips(body)).toEqual(LABELS);
    expect(mounted.container.textContent).not.toMatch(NO_RAW);
    await mounted.unmount();
  });

  it('draws a very long run of controls as a bounded few chips that still say how many there are', async () => {
    const mounted = await mount(<SafeProse sourceUrl={URL} text={`a${'​'.repeat(900)}b`} />);
    const labels = chips(mounted.container);
    expect(labels.length).toBeLessThanOrEqual(101);
    expect(labels.at(-1)).toBe('800 more');
    expect(mounted.container.textContent).not.toMatch(NO_RAW);
    await mounted.unmount();
  });
});

describe('a link in a PR page says where it goes', () => {
  it('draws the real address in the page beside a label that says something else', async () => {
    const text = '[https://github.com/octo/demo](https://evil.example/steal?x=1) and <https://example.com/doc>';
    const mounted = await mount(<SafeProse sourceUrl={URL} text={text} />);
    const dest = [...mounted.container.querySelectorAll('[data-gh-dest]')].map(node => node.textContent);
    // A label that already is the address says it once; one that is not shows the address it really opens.
    expect(dest).toEqual(['(https://evil.example/steal?x=1)']);
    await mounted.unmount();
  });
});

describe('links in a PR page follow the "Open links in" setting', () => {
  it('hands a tap on a body link to the setting', async () => {
    taken.length = 0;
    const mounted = await mount(placed(<SafeProse sourceUrl={URL} text="see [the doc](https://example.com/doc)" />));
    await tap(must(mounted.container.querySelector('[data-gh-link]'), 'the link'));
    expect(taken).toEqual(['https://example.com/doc']);
    await mounted.unmount();
  });

  it('hands a tap on a check link to the setting', async () => {
    taken.length = 0;
    const checks = {
      state: 'passing',
      total: 1,
      passed: 1,
      failed: 0,
      running: 0,
      queued: 0,
      items: [{ name: 'build', status: 'passed', url: 'https://github.com/octo/demo/runs/1' }],
    } as never;
    const pull = { url: URL } as never;
    const mounted = await mount(<RouterProvider>{placed(<CiTab checks={checks} pull={pull} />)}</RouterProvider>);
    await tap(must(mounted.container.querySelector('a[href$="/runs/1"]'), 'the check link'));
    expect(taken).toEqual(['https://github.com/octo/demo/runs/1']);
    await mounted.unmount();
  });

  it('hands a tap on a Files-tab comment link and thread link to the setting', async () => {
    taken.length = 0;
    const thread: ReviewThread = {
      id: 't1',
      resolved: false,
      outdated: false,
      path: 'src/a.ts',
      line: 3,
      side: 'right',
      omittedReplies: 2,
      comments: [
        {
          id: 'c1',
          author: { login: 'bob-fake' },
          body: 'hi',
          createdAt: '2026-02-02T09:00:00Z',
          url: `${URL}#discussion_r1`,
        },
      ],
    };
    const mounted = await mount(placed(<ThreadCard thread={thread} />));
    const links = [...mounted.container.querySelectorAll('a')];
    expect(links.map(link => link.textContent)).toEqual(['Open on GitHub', 'Open the thread']);
    for (const link of links) await tap(link);
    expect(taken).toEqual([`${URL}#discussion_r1`, `${URL}#discussion_r1`]);
    await mounted.unmount();
  });
});

describe('a page the wire allows at its limit is drawn in a bounded few nodes', () => {
  // 500 comments and 500 reviews, each 65,536 characters (the strings are shared, the shape is the wire's).
  const body = '​*a* '.repeat(13_200).slice(0, 65_536);
  const flood = {
    kind: 'page',
    pull: {
      url: URL,
      body,
      author: { login: 'a' },
      createdAt: '2026-02-01T10:00:00Z',
    },
    comments: Array.from({ length: 500 }, (_, index) => ({
      id: `c${index}`,
      author: { login: 'flood-fake' },
      body,
      createdAt: new Date(Date.UTC(2026, 1, 2, 0, 0, index)).toISOString(),
      url: `${URL}#c${index}`,
    })),
    reviews: Array.from({ length: 500 }, (_, index) => ({
      id: `r${index}`,
      author: { login: 'flood-fake' },
      verdict: 'commented',
      body,
      submittedAt: new Date(Date.UTC(2026, 1, 3, 0, 0, index)).toISOString(),
      url: `${URL}#r${index}`,
    })),
    truncated: false,
  } as unknown as PullPage;

  it('draws the description and the first few entries, collapsed, and more only when asked', async () => {
    const mounted = await mount(<Conversation page={flood} />);
    const entries = () => mounted.container.querySelectorAll('[data-pull-entry]').length;
    expect(entries()).toBe(1 + ENTRY_STEP);
    expect(mounted.container.querySelectorAll('*').length).toBeLessThan(12_000);
    // Every long text is cut to its first COLLAPSED_CHARS and offers the rest.
    const collapsed = mounted.container.querySelectorAll('[data-gh-collapsed]');
    expect(collapsed.length).toBe(1 + ENTRY_STEP);
    expect(must(collapsed[0], 'the button').textContent).toContain('65,536 characters');
    // (the chips for the controls in the first COLLAPSED_CHARS are in that count; the other ~64,000 characters are not)
    expect(must(mounted.container.querySelector('[data-gh-text]'), 'the text').textContent?.length).toBeLessThan(
      COLLAPSED_CHARS * 4,
    );
    const more = must(mounted.container.querySelector('[data-pull-more] button'), 'Show more');
    expect(more.textContent).toContain(`${1_000 - ENTRY_STEP} not shown yet`);
    await tap(more);
    expect(entries()).toBe(1 + 2 * ENTRY_STEP);
    await mounted.unmount();
  });

  it('opens a long text whole when asked', async () => {
    const mounted = await mount(
      <Conversation
        page={{ ...flood, pull: { ...flood.pull, body: body.slice(0, 3_000) }, comments: [], reviews: [] }}
      />,
    );
    const button = must(mounted.container.querySelector('[data-gh-collapsed] button'), 'Show all');
    await tap(button);
    expect(mounted.container.querySelectorAll('[data-gh-collapsed]').length).toBe(0);
    await mounted.unmount();
  });
});
