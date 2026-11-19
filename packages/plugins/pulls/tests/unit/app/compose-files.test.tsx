import { describe, expect, it } from 'bun:test';
import { interact, mount, must, settleUntil } from '@ferretry/app/testing';
import type { PullDetail, ReviewThread } from '../../../contract/index.ts';
import type { PullAddress, PullsClient } from '../../../app/features/compose/api.ts';
import { ComposeDock, ReviewableFiles } from '../../../app/features/compose/index.ts';

const ADDRESS: PullAddress = {
  project: '11111111-1111-4111-8111-111111111111',
  owner: 'octo',
  name: 'demo',
  number: 7,
};
const PULL = { updatedAt: '2026-11-01T10:00:00Z', headSha: 'b'.repeat(40) } as PullDetail;
const PATCH = ['@@ -10,4 +10,4 @@', ' keep', '-old line', '+new line', ' tail'].join('\n');
const comment = (id: string, body: string) => ({
  id,
  author: { login: 'reviewer' },
  body,
  createdAt: '2026-11-01T10:00:00Z',
  url: `https://github.com/octo/demo/pull/7#discussion_${id}`,
});
const thread = (id: string, patch: Partial<ReviewThread> = {}): ReviewThread => ({
  id,
  resolved: false,
  outdated: false,
  path: 'src/a.ts',
  line: 11,
  side: 'right',
  comments: [comment(`${id}c`, 'please rename')],
  ...patch,
});

function scene(threads: readonly ReviewThread[]) {
  const posts: Array<{ route: string; body: unknown }> = [];
  const client: PullsClient = {
    call: (async (route: string, init?: { body?: unknown }) => {
      if (route.endsWith('/files'))
        return {
          files: [{ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 1, patch: PATCH }],
          truncated: false,
          unreadable: 0,
          fromCache: false,
        };
      if (route.endsWith('/threads')) return { threads, truncated: false, fetchedAt: '2026-11-01T10:00:00Z' };
      if (route.endsWith('/poster')) return { login: 'octo-fake' };
      posts.push({ route, body: init?.body });
      return { kind: 'posted', id: 'PRRC_1', replayed: false };
    }) as PullsClient['call'],
  };
  const view = (
    <ComposeDock
      address={ADDRESS}
      client={client}
      headSha={PULL.headSha}
      onChanged={() => undefined}
      pullUrl="https://github.com/octo/demo/pull/7"
    >
      <ReviewableFiles address={ADDRESS} client={client} daemon="workstation" pull={PULL} />
    </ComposeDock>
  );
  return { view, posts };
}

describe('the Files tab with threads and a way to reply', () => {
  it('draws a thread under its line with a Reply, lists the outdated ones, and a reply posts to the thread', async () => {
    const { view, posts } = scene([
      thread('T1'),
      thread('T2', { outdated: true, line: 99 }),
      thread('T3', { line: 500 }),
    ]);
    const mounted = await mount(view);
    await settleUntil(
      () => mounted.container.querySelector('[data-diff-body] [data-thread="T1"]') !== null,
      'the thread under its line',
      interact,
    );
    // Placed once the files are known: the outdated and the unplaced ones are in the lists, not on a row.
    expect(mounted.container.querySelector('[data-outdated-group="outdated"] [data-thread="T2"]')).not.toBeNull();
    expect(mounted.container.querySelector('[data-outdated-group="elsewhere"] [data-thread="T3"]')).not.toBeNull();
    expect(mounted.container.querySelectorAll('[data-diff-body] [data-thread]')).toHaveLength(1);
    const reply = must(mounted.container.querySelector<HTMLButtonElement>('[data-reply-open="T1"]'), 'Reply');
    await interact(() => reply.click());
    const box = must(mounted.container.querySelector<HTMLTextAreaElement>('[data-reply-box="T1"] textarea'), 'box');
    await settleUntil(
      () =>
        [...mounted.container.querySelectorAll('[data-reply-box="T1"] button')].some(b =>
          b.textContent?.includes('@octo-fake'),
        ),
      'login',
      interact,
    );
    await interact(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(box, 'done');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const post = must(
      [...mounted.container.querySelectorAll<HTMLButtonElement>('[data-reply-box="T1"] button')].find(b =>
        b.textContent?.startsWith('Post as'),
      ),
      'post',
    );
    await interact(() => post.click());
    await settleUntil(() => posts.length === 1, 'the reply', interact);
    expect(posts[0]?.route).toBe('POST /v1/pulls/:project/:repo/:number/reply');
    expect(posts[0]?.body).toMatchObject({ body: 'done', threadId: 'T1' });
    await mounted.unmount();
  });
});
