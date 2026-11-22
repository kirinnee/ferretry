import { describe, expect, it } from 'bun:test';
import { useState } from 'react';
import { interact, type Mounted, mount, must, settleUntil, ShellContext, WithViewPlace } from '@ferretry/app/testing';
import { PullPageAnswerSchema, type ReviewThread } from '../../../contract/index.ts';
import type { PullAddress, PullsClient } from '../../../app/features/compose/api.ts';
import { useCompose } from '../../../app/features/compose/context.tsx';
import { ComposeDock, OpenComment } from '../../../app/features/compose/index.ts';
import { ReplyBox } from '../../../app/features/compose/reply-box.tsx';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const ADDRESS: PullAddress = { project: PROJECT, owner: 'octo', name: 'demo', number: 7 };
const HEAD = 'b'.repeat(40);
const POSTED = {
  kind: 'posted',
  id: '9001',
  url: 'https://github.com/octo/demo/pull/7#issuecomment-9001',
  replayed: false,
};
const SECRET = 'my key is ghp_0123456789abcdefghijklmnopqrstuvwxyzAB';

interface Call {
  readonly route: string;
  readonly body: Record<string, unknown> | undefined;
}

const PAGE = PullPageAnswerSchema.parse({
  kind: 'page',
  pull: {
    repo: { provider: 'github', owner: 'octo', name: 'demo' },
    number: 7,
    title: 'Add the thing',
    author: { login: 'alice' },
    state: 'open',
    draft: false,
    review: 'none',
    ci: 'passing',
    headSha: HEAD,
    headRef: 'feature',
    baseRef: 'main',
    createdAt: '2026-02-01T10:00:00Z',
    updatedAt: '2026-02-02T10:00:00Z',
    url: 'https://github.com/octo/demo/pull/7',
    body: '',
    requestedReviewers: [],
    commits: 1,
    changedFiles: 1,
    additions: 1,
    deletions: 0,
  },
  comments: [],
  reviews: [],
  checks: { state: 'passing', total: 0, passed: 0, failed: 0, running: 0, queued: 0, items: [] },
  truncated: false,
  fromCache: false,
});
const THREADS = { threads: [], truncated: false, fetchedAt: '2026-11-19T00:00:00.000Z' };

/**
 * A scripted client: the poster read answers an account, every post goes to `onPost` (which may hold, throw or answer),
 * and every other read (the page, the threads) goes to `read` and is listed in `reads`.
 */
function scripted(
  onPost: (call: Call, count: number) => unknown,
  login: string | Error | (() => string) = 'octo-fake',
  read: (route: string, count: number) => unknown = route => (route.endsWith('/threads') ? THREADS : PAGE),
) {
  const calls: Call[] = [];
  const reads: string[] = [];
  const client: PullsClient = {
    call: (async (route: string, init?: { body?: Record<string, unknown> }) => {
      if (route.startsWith('GET') && route.endsWith('/poster')) {
        if (login instanceof Error) throw login;
        return { id: 'gha_4242', login: typeof login === 'function' ? login() : login };
      }
      if (route.startsWith('GET')) {
        reads.push(route);
        return await read(route, reads.length);
      }
      calls.push({ route, body: init?.body });
      return await onPost({ route, body: init?.body }, calls.length);
    }) as PullsClient['call'],
  };
  return { client, calls, reads };
}

const refusal = (code: string, message: string, extra: object = {}) =>
  Object.assign(new Error(message), { code, ...extra });

function Probe() {
  const compose = useCompose();
  return (
    <div>
      <button data-probe="quote" onClick={() => compose.quote('first line\n\nsecond line')} type="button" />
      <button
        data-probe="range"
        onClick={() => compose.commentOnLines({ path: 'src/a.ts', side: 'right', startLine: 10, line: 12 })}
        type="button"
      />
      <button
        data-probe="left"
        onClick={() => compose.commentOnLines({ path: 'src/b.ts', side: 'left', startLine: 3, line: 3 })}
        type="button"
      />
      <OpenComment />
      <span data-probe="reload">{compose.threadsReload}</span>
    </div>
  );
}

async function open(client: PullsClient, onChanged: () => void = () => undefined) {
  const mounted = await mount(
    <ComposeDock
      address={ADDRESS}
      client={client}
      headSha={HEAD}
      onChanged={onChanged}
      pullUrl="https://github.com/octo/demo/pull/7"
    >
      <Probe />
    </ComposeDock>,
  );
  return mounted;
}

const press = async (mounted: Mounted, selector: string) => {
  const element = must(mounted.container.querySelector<HTMLElement>(selector), selector);
  await interact(() => element.click());
};
const type = async (mounted: Mounted, value: string) => {
  const box = must(mounted.container.querySelector<HTMLTextAreaElement>('[data-compose-box]'), 'the box');
  await interact(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    set?.call(box, value);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const postButton = (mounted: Mounted) =>
  must(
    [...mounted.container.querySelectorAll<HTMLButtonElement>('[data-compose] button')].find(b =>
      (b.textContent ?? '').startsWith('Post'),
    ),
    'the post button',
  );
const ready = async (mounted: Mounted) =>
  await settleUntil(() => postButton(mounted).textContent?.includes('@octo-fake') === true, 'login', interact);
const tap = async (mounted: Mounted) => {
  const button = postButton(mounted);
  await interact(() => button.click());
};
const settled = async (mounted: Mounted, selector: string) =>
  await settleUntil(() => mounted.container.querySelector(selector) !== null, selector, interact);

describe('the comment box', () => {
  it('says who it posts as, always, and posts nothing until it knows', async () => {
    const { client, calls } = scripted(() => POSTED);
    const mounted = await open(client);
    await press(mounted, '[data-compose-open]');
    expect(postButton(mounted).disabled).toBe(true);
    await ready(mounted);
    expect(postButton(mounted).textContent).toBe('Post as @octo-fake');
    // Nothing to post yet: the button waits for text.
    expect(postButton(mounted).disabled).toBe(true);
    expect(calls).toHaveLength(0);
    await mounted.unmount();
  });

  it('shows that no account is linked when there is none, and offers no post', async () => {
    const { client } = scripted(() => POSTED, new Error('no account'));
    const mounted = await open(client);
    await press(mounted, '[data-compose-open]');
    await settled(mounted, '[data-compose-as]');
    await settleUntil(
      () => mounted.container.textContent?.includes('No GitHub account') === true,
      'no account',
      interact,
    );
    await type(mounted, 'hello');
    expect(postButton(mounted).disabled).toBe(true);
    await mounted.unmount();
  });

  it('the link to a posted comment follows the "Open links in" setting', async () => {
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
    const shell = { runtime: { linkProvision: () => provision, subscribe: () => () => undefined, version: () => 0 } };
    const { client } = scripted(() => POSTED);
    const mounted = await mount(
      <ShellContext.Provider value={shell as never}>
        <WithViewPlace place={{ daemon: 'desk', machine: 'Desk' } as never}>
          <ComposeDock
            address={ADDRESS}
            client={client}
            headSha={HEAD}
            onChanged={() => undefined}
            pullUrl="https://github.com/octo/demo/pull/7"
          >
            <Probe />
          </ComposeDock>
        </WithViewPlace>
      </ShellContext.Provider>,
    );
    await press(mounted, '[data-compose-open]');
    await ready(mounted);
    await type(mounted, 'Looks good to me.');
    await tap(mounted);
    await settled(mounted, '[data-compose-posted]');
    const link = must(mounted.container.querySelector('[data-compose-posted] a'), 'the posted link');
    await interact(() => link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })));
    expect(taken).toEqual([POSTED.url]);
    await mounted.unmount();
  });

  it('posts the text with a request id, no token, and clears the draft once it is on GitHub', async () => {
    const { client, calls } = scripted(() => POSTED);
    const changed: number[] = [];
    const mounted = await open(client, () => changed.push(1));
    await press(mounted, '[data-compose-open]');
    await ready(mounted);
    await type(mounted, 'Looks good to me.');
    await tap(mounted);
    await settled(mounted, '[data-compose-posted]');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.route).toBe('POST /v1/pulls/:project/:repo/:number/comment');
    expect(Object.keys(calls[0]?.body ?? {}).sort()).toEqual(['account', 'body', 'requestId']);
    expect(calls[0]?.body?.account).toEqual({ id: 'gha_4242', login: 'octo-fake' });
    expect(calls[0]?.body?.body).toBe('Looks good to me.');
    expect(String(calls[0]?.body?.requestId)).toMatch(/^[A-Za-z0-9_-]{16,64}$/u);
    expect(mounted.container.querySelector<HTMLTextAreaElement>('[data-compose-box]')?.value).toBe('');
    expect(mounted.container.querySelector('[data-compose-posted] a')?.getAttribute('href')).toBe(POSTED.url);
    expect(changed.length).toBeGreaterThan(0);
    await mounted.unmount();
  });

  it('a double tap posts once: the second press finds the first still in flight', async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>(resolve => (release = resolve));
    const { client, calls } = scripted(async () => {
      await hold;
      return POSTED;
    });
    const mounted = await open(client);
    await press(mounted, '[data-compose-open]');
    await ready(mounted);
    await type(mounted, 'once');
    const button = postButton(mounted);
    await interact(() => {
      button.click();
      button.click();
    });
    await tap(mounted);
    expect(calls).toHaveLength(1);
    expect(postButton(mounted).disabled).toBe(true);
    release();
    await settled(mounted, '[data-compose-posted]');
    expect(calls).toHaveLength(1);
    await mounted.unmount();
  });

  it('the same words typed again after a post are a new comment with a new id', async () => {
    const { client, calls } = scripted(() => POSTED);
    const mounted = await open(client);
    await press(mounted, '[data-compose-open]');
    await ready(mounted);
    await type(mounted, '+1');
    await tap(mounted);
    await settled(mounted, '[data-compose-posted]');
    await type(mounted, '+1');
    await tap(mounted);
    await settleUntil(() => calls.length === 2, 'second post', interact);
    expect(calls[0]?.body?.requestId).not.toBe(calls[1]?.body?.requestId);
    await mounted.unmount();
  });

  it('refuses a body past 65,536 characters before any request, and says how far over it is', async () => {
    const { client, calls } = scripted(() => POSTED);
    const mounted = await open(client);
    await press(mounted, '[data-compose-open]');
    await ready(mounted);
    await type(mounted, 'a'.repeat(65_537));
    expect(postButton(mounted).disabled).toBe(true);
    expect(mounted.container.querySelector('[data-compose-count]')?.textContent).toBe('65,537 / 65,536');
    await type(mounted, 'a'.repeat(65_536));
    expect(postButton(mounted).disabled).toBe(false);
    expect(calls).toHaveLength(0);
    await mounted.unmount();
  });

  it('a secret-shaped body stops with a warning and needs a second, explicit tap that reuses the same id', async () => {
    const { client, calls } = scripted((call, count) => {
      if (count === 1) throw refusal('pulls_secret_shaped', 'This looks like a secret. Remove it, or post anyway.');
      expect(call.body?.postAnyway).toBe(true);
      return POSTED;
    });
    const mounted = await open(client);
    await press(mounted, '[data-compose-open]');
    await ready(mounted);
    await type(mounted, SECRET);
    await tap(mounted);
    await settled(mounted, '[data-compose-secret]');
    expect(mounted.container.querySelector('[data-compose-secret]')?.textContent).toContain(
      'This looks like a secret.',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).not.toHaveProperty('postAnyway');
    // The text is still there to edit.
    expect(mounted.container.querySelector<HTMLTextAreaElement>('[data-compose-box]')?.value).toBe(SECRET);
    const anyway = must(
      [...mounted.container.querySelectorAll<HTMLButtonElement>('[data-compose-secret] button')].find(b =>
        b.textContent?.includes('Post anyway'),
      ),
      'post anyway',
    );
    await interact(() => anyway.click());
    await settled(mounted, '[data-compose-posted]');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body?.requestId).toBe(calls[0]?.body?.requestId);
    await mounted.unmount();
  });

  it('when the answer is lost it says "not sure", reads the thread again, and a new post is the person’s choice', async () => {
    const { client, calls } = scripted((_call, count) => {
      if (count === 1) throw refusal('carrier', 'the connection closed', { carrier: true });
      return POSTED;
    });
    const changed: number[] = [];
    const mounted = await open(client, () => changed.push(1));
    await press(mounted, '[data-compose-open]');
    await ready(mounted);
    await type(mounted, 'maybe');
    await tap(mounted);
    await settled(mounted, '[data-compose-unknown] button');
    expect(changed).toHaveLength(1);
    // Nothing was sent again on its own.
    expect(calls).toHaveLength(1);
    // The text is kept; "post again" is a choice, and it is a new request.
    expect(mounted.container.querySelector<HTMLTextAreaElement>('[data-compose-box]')?.value).toBe('maybe');
    await press(mounted, '[data-compose-unknown] button');
    await tap(mounted);
    await settled(mounted, '[data-compose-posted]');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body?.requestId).not.toBe(calls[0]?.body?.requestId);
    await mounted.unmount();
  });

  it('a daemon "unknown" answer reads the same way, and a refusal is shown in the daemon’s own words', async () => {
    const { client } = scripted((_call, count) =>
      count === 1
        ? { kind: 'unknown' }
        : Promise.reject(refusal('pulls_denied', 'GitHub did not let this account comment here')),
    );
    const mounted = await open(client);
    await press(mounted, '[data-compose-open]');
    await ready(mounted);
    await type(mounted, 'hello');
    await tap(mounted);
    await settled(mounted, '[data-compose-unknown] button');
    await press(mounted, '[data-compose-unknown] button');
    await tap(mounted);
    await settled(mounted, '[data-compose-failed]');
    expect(mounted.container.querySelector('[data-compose-failed]')?.textContent).toBe(
      'GitHub did not let this account comment here',
    );
    await mounted.unmount();
  });

  it('the preview is the inert renderer: no script, no image, no fy-render, no reference link', async () => {
    const { client } = scripted(() => POSTED);
    const mounted = await open(client);
    await press(mounted, '[data-compose-open]');
    await ready(mounted);
    await type(
      mounted,
      '<script>boom()</script><img src=x onerror=alert(1)> [x](javascript:alert(1)) &F1 :agent\n\n```fy-render\nsvg\n```\n\n![pic](https://tracker.invalid/p.png)',
    );
    const preview = must(
      [...mounted.container.querySelectorAll<HTMLButtonElement>('[data-compose] button')].find(
        b => b.textContent === 'Preview',
      ),
      'preview',
    );
    await interact(() => preview.click());
    const root = must(mounted.container.querySelector('[data-compose-preview]'), 'preview area');
    expect(root.querySelector('script, img, iframe, svg, style')).toBeNull();
    expect(root.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(root.textContent).toContain('<script>boom()</script>');
    expect(root.textContent).toContain('&F1');
    expect(root.querySelector('[data-ref], [data-reference]')).toBeNull();
    await mounted.unmount();
  });
});

describe('quoting and commenting on lines', () => {
  it('a quote opens the box with the words behind "> " and adds to what is already written', async () => {
    const { client } = scripted(() => POSTED);
    const mounted = await open(client);
    await press(mounted, '[data-probe="quote"]');
    const box = () => must(mounted.container.querySelector<HTMLTextAreaElement>('[data-compose-box]'), 'box');
    expect(box().value).toBe('> first line\n>\n> second line\n\n');
    await type(mounted, `${box().value}my answer`);
    await press(mounted, '[data-probe="quote"]');
    expect(box().value).toBe('> first line\n>\n> second line\n\nmy answer\n\n> first line\n>\n> second line\n\n');
    await mounted.unmount();
  });

  it('a range of diff lines posts one single comment on those lines, against the head commit', async () => {
    const { client, calls } = scripted(() => POSTED);
    const mounted = await open(client);
    await press(mounted, '[data-probe="range"]');
    expect(mounted.container.querySelector('[data-compose-dock="line"] h3')?.textContent).toBe(
      'Comment on src/a.ts:10-12',
    );
    await ready(mounted);
    await type(mounted, 'rename this');
    await tap(mounted);
    await settled(mounted, '[data-compose-posted]');
    expect(calls[0]?.route).toBe('POST /v1/pulls/:project/:repo/:number/line-comment');
    expect(calls[0]?.body).toMatchObject({
      body: 'rename this',
      commitId: HEAD,
      path: 'src/a.ts',
      side: 'right',
      line: 12,
      startLine: 10,
    });
    await mounted.unmount();
  });

  it('a one-line comment on the old side sends no start line; another range does not replace a draft with words in it', async () => {
    const { client, calls } = scripted(() => POSTED);
    const mounted = await open(client);
    await press(mounted, '[data-probe="left"]');
    await ready(mounted);
    await type(mounted, 'old side');
    await tap(mounted);
    await settled(mounted, '[data-compose-posted]');
    expect(calls[0]?.body).toMatchObject({ side: 'left', line: 3 });
    expect(calls[0]?.body).not.toHaveProperty('startLine');
    await type(mounted, 'a draft I am keeping');
    await press(mounted, '[data-probe="range"]');
    expect(mounted.container.querySelector('[data-compose-notice]')?.textContent).toContain('Finish or close');
    expect(mounted.container.querySelector('[data-compose-dock] h3')?.textContent).toBe(
      'Comment on src/b.ts:3 (old side)',
    );
    expect(mounted.container.querySelector<HTMLTextAreaElement>('[data-compose-box]')?.value).toBe(
      'a draft I am keeping',
    );
    await mounted.unmount();
  });

  it('a path with an override character is drawn plain in the heading, in an isolate', async () => {
    const { client } = scripted(() => POSTED);
    const mounted = await mount(
      <ComposeDock
        address={ADDRESS}
        client={client}
        headSha={HEAD}
        onChanged={() => undefined}
        pullUrl="https://github.com/octo/demo/pull/7"
      >
        <EvilPath />
      </ComposeDock>,
    );
    await press(mounted, '[data-probe="evil"]');
    const heading = must(mounted.container.querySelector('[data-compose-dock] h3'), 'heading');
    expect(heading.textContent).toBe('Comment on src/gnp.ts:1');
    expect(heading.querySelector('bdi')).not.toBeNull();
    await mounted.unmount();
  });
});

function EvilPath() {
  const compose = useCompose();
  return (
    <button
      data-probe="evil"
      onClick={() => compose.commentOnLines({ path: 'src/‮gnp.ts', side: 'right', startLine: 1, line: 1 })}
      type="button"
    />
  );
}

const THREAD: ReviewThread = {
  id: 'PRRT_abc123',
  resolved: false,
  outdated: false,
  path: 'src/a.ts',
  line: 11,
  side: 'right',
  comments: [
    {
      id: 'c1',
      author: { login: 'reviewer' },
      body: 'rename',
      createdAt: '2026-11-01T10:00:00Z',
      url: 'https://github.com/octo/demo/pull/7#discussion_c1',
    },
  ],
};

describe('a reply under a thread', () => {
  it('opens its own box, posts to the reply route with the thread id, and keeps one draft per thread', async () => {
    const { client, calls } = scripted(() => ({ ...POSTED, id: 'PRRC_1' }));
    const mounted = await mount(
      <ComposeDock
        address={ADDRESS}
        client={client}
        headSha={HEAD}
        onChanged={() => undefined}
        pullUrl="https://github.com/octo/demo/pull/7"
      >
        <ReplyBox thread={THREAD} />
      </ComposeDock>,
    );
    expect(mounted.container.querySelector('[data-reply-box]')).toBeNull();
    await press(mounted, '[data-reply-open]');
    await ready(mounted);
    await type(mounted, 'thanks, fixed');
    await tap(mounted);
    await settled(mounted, '[data-compose-posted]');
    expect(calls[0]?.route).toBe('POST /v1/pulls/:project/:repo/:number/reply');
    expect(calls[0]?.body).toMatchObject({ body: 'thanks, fixed', threadId: 'PRRT_abc123' });
    await mounted.unmount();
  });
});

const lostAnswer = (_call: Call, count: number) => {
  if (count === 1) throw refusal('carrier', 'the connection closed', { carrier: true });
  return POSTED;
};
const unknownText = (mounted: Mounted) => mounted.container.querySelector('[data-compose-unknown]')?.textContent ?? '';

describe('after an unknown answer', () => {
  it('reads the thread again first, and offers "post again" only once it has been read', async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>(resolve => (release = resolve));
    const { client, reads } = scripted(lostAnswer, 'octo-fake', async route => {
      await hold;
      return route.endsWith('/threads') ? THREADS : PAGE;
    });
    const mounted = await open(client);
    await press(mounted, '[data-compose-open]');
    await ready(mounted);
    await type(mounted, 'maybe');
    await tap(mounted);
    await settled(mounted, '[data-compose-unknown]');
    // The read is in flight: there is nothing to decide on yet.
    expect(unknownText(mounted)).toContain('Reading the thread again');
    expect(mounted.container.querySelector('[data-compose-unknown] button')).toBeNull();
    release();
    await settled(mounted, '[data-compose-unknown] button');
    expect(unknownText(mounted)).toContain('The thread has been read again');
    // A PR comment's place is the page; the threads read is for replies and line comments.
    expect(reads.every(route => route === 'GET /v1/pulls/:project/:repo/:number')).toBe(true);
    expect(reads.length).toBeGreaterThan(0);
    await mounted.unmount();
  });

  it("a reply reads the actual threads (not the page), and the page's thread list is told to reload", async () => {
    const { client, reads, calls } = scripted(lostAnswer);
    const mounted = await mount(
      <ComposeDock
        address={ADDRESS}
        client={client}
        headSha={HEAD}
        onChanged={() => undefined}
        pullUrl="https://github.com/octo/demo/pull/7"
      >
        <ReplyBox thread={THREAD} />
        <Probe />
      </ComposeDock>,
    );
    expect(mounted.container.querySelector('[data-probe="reload"]')?.textContent).toBe('0');
    await press(mounted, '[data-reply-open]');
    await ready(mounted);
    await type(mounted, 'thanks');
    await tap(mounted);
    await settled(mounted, '[data-compose-unknown] button');
    expect(reads).toEqual(['GET /v1/pulls/:project/:repo/:number/threads']);
    expect(mounted.container.querySelector('[data-probe="reload"]')?.textContent).toBe('1');
    expect(calls).toHaveLength(1);
    await mounted.unmount();
  });

  it('when the thread cannot be read it says so, offers to read again, and "post again" waits for a read that worked', async () => {
    const { client, reads } = scripted(lostAnswer, 'octo-fake', (_route, count) => {
      if (count === 1) throw new Error('GitHub is not answering');
      return PAGE;
    });
    const mounted = await open(client);
    await press(mounted, '[data-compose-open]');
    await ready(mounted);
    await type(mounted, 'maybe');
    await tap(mounted);
    await settled(mounted, '[data-compose-unknown] button');
    expect(unknownText(mounted)).toContain('could not be read again');
    expect(unknownText(mounted)).toContain('Read the thread again');
    expect(unknownText(mounted)).not.toContain('post again');
    await press(mounted, '[data-compose-unknown] button');
    await settleUntil(() => unknownText(mounted).includes('post again'), 'second read', interact);
    expect(reads).toHaveLength(2);
    await mounted.unmount();
  });
});

describe('the account on the button', () => {
  it('sends the account it showed; when the daemon says it changed, it is shown again and the next post is a new one', async () => {
    let who = 'octo-fake';
    const { client, calls } = scripted(
      (_call, count) => {
        if (count === 1) {
          who = 'someone-else';
          throw refusal(
            'pulls_account_changed',
            'the account for this project changed to @someone-else; check and post again',
          );
        }
        return POSTED;
      },
      () => who,
    );
    const mounted = await open(client);
    await press(mounted, '[data-compose-open]');
    await ready(mounted);
    await type(mounted, 'hello');
    await tap(mounted);
    await settled(mounted, '[data-compose-failed]');
    expect(mounted.container.querySelector('[data-compose-failed]')?.textContent).toBe(
      'the account for this project changed to @someone-else; check and post again',
    );
    // The label follows: the person sees who it would post as before tapping again.
    await settleUntil(() => postButton(mounted).textContent?.includes('@someone-else') === true, 'new label', interact);
    await tap(mounted);
    await settled(mounted, '[data-compose-posted]');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body?.account).toEqual({ id: 'gha_4242', login: 'octo-fake' });
    expect(calls[1]?.body?.account).toEqual({ id: 'gha_4242', login: 'someone-else' });
    await mounted.unmount();
  });
});

function Moving() {
  const [head, setHead] = useState(HEAD);
  return (
    <>
      <button data-probe="move" onClick={() => setHead('c'.repeat(40))} type="button" />
      <ComposeDock
        address={ADDRESS}
        client={MOVING.client}
        headSha={head}
        onChanged={() => undefined}
        pullUrl="https://github.com/octo/demo/pull/7"
      >
        <Probe />
      </ComposeDock>
    </>
  );
}
let MOVING = scripted(() => POSTED);

describe('lines picked on one commit', () => {
  it('are posted against that commit; when the head moves the comment says so, will not post, and a new pick works', async () => {
    MOVING = scripted(() => POSTED);
    const mounted = await mount(<Moving />);
    await press(mounted, '[data-probe="range"]');
    await ready(mounted);
    await type(mounted, 'rename this');
    await press(mounted, '[data-probe="move"]');
    expect(mounted.container.querySelector('[data-compose-stale]')?.textContent).toContain('select the lines again');
    expect(postButton(mounted).disabled).toBe(true);
    expect(MOVING.calls).toHaveLength(0);
    // The words are kept; closing and picking again binds the lines to the commit the page shows now.
    expect(mounted.container.querySelector<HTMLTextAreaElement>('[data-compose-box]')?.value).toBe('rename this');
    await press(mounted, '[data-compose-dock] header button:last-child');
    await press(mounted, '[data-probe="range"]');
    expect(mounted.container.querySelector('[data-compose-stale]')).toBeNull();
    await type(mounted, 'rename this');
    await tap(mounted);
    await settled(mounted, '[data-compose-posted]');
    expect(MOVING.calls[0]?.body?.commitId).toBe('c'.repeat(40));
    await mounted.unmount();
  });

  it('a comment on lines whose head has not moved posts against the commit it was picked on', async () => {
    MOVING = scripted(() => POSTED);
    const mounted = await mount(<Moving />);
    await press(mounted, '[data-probe="range"]');
    await ready(mounted);
    await type(mounted, 'first');
    await tap(mounted);
    await settled(mounted, '[data-compose-posted]');
    expect(MOVING.calls[0]?.body?.commitId).toBe(HEAD);
    await mounted.unmount();
  });
});
