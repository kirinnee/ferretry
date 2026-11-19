import { describe, expect, test } from 'bun:test';
import { FakeGate, ferretStanding, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { ApiError, type CallStanding } from '@ferretry/kernel/contract';
import { testHost } from '@ferretry/kernel/testing';
import type { GitAccountsApi } from '@ferretry/plugin-git-accounts/contract';
import type { ProjectInfo } from '@ferretry/plugin-projects/contract';
import { MAX_POST_BODY, NO_SECRET_FIELDS, POST_CODES } from '../../contract/index.ts';
import daemon from '../../daemon/index.ts';
import { FakeGithub, servePosts } from '../fixtures/fake-github/index.ts';

const P1 = '11111111-1111-4111-8111-111111111111';
const project = (): ProjectInfo =>
  ({
    id: P1,
    path: '/work/demo',
    name: 'demo',
    accounts: ['gha_4242'],
    repos: [{ path: '.', remote: 'https://github.com/octo/demo', provider: 'github' }],
  }) as ProjectInfo;

const ID = 'req-aaaaaaaaaaaaaaaa';
const BASE = `/v1/pulls/${P1}/octo~demo/7`;

async function boot(options: { api?: GitAccountsApi['api']; gate?: FakeGate | null } = {}) {
  const github = new FakeGithub();
  const posts = servePosts(github);
  const gate = options.gate === undefined ? new FakeGate() : options.gate;
  let standing: CallStanding = ownerStanding();
  const host = await testHost({
    plugins: [daemon],
    gate: new StandInAdmission(() => standing),
    fakes: {
      gitAccounts: {
        ...github.accounts,
        ...(options.api === undefined ? {} : { api: options.api }),
        run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        recordKeys: async () => undefined,
      },
      projects: { list: async () => [project()], find: async (id: string) => (id === P1 ? project() : undefined) },
    },
    ...(gate === null ? {} : { uses: { gate } }),
  });
  const post = async (leaf: string, body: unknown) => await host.request('POST', `${BASE}/${leaf}`, { body });
  return {
    host,
    github,
    posts,
    gate,
    post,
    as: (next: CallStanding) => {
      standing = next;
    },
  };
}

const comment = (extra: object = {}) => ({ requestId: ID, body: 'Looks good to me.', ...extra });
const posted = (w: { github: FakeGithub }) => w.github.seen.filter(call => call.method === 'POST');

describe('POST …/comment', () => {
  test('posts to the issue-comments endpoint with the body alone, and answers the id and address', async () => {
    const w = await boot();
    const answer = await w.post('comment', comment());
    expect(answer.status).toBe(201);
    expect(answer.json()).toEqual({
      kind: 'posted',
      id: '9001',
      url: 'https://github.com/octo/demo/pull/7#issuecomment-9001',
      replayed: false,
    });
    expect(posted(w).map(call => [call.path, call.body, call.account])).toEqual([
      ['/repos/octo/demo/issues/7/comments', { body: 'Looks good to me.' }, 'gha_4242'],
    ]);
  });

  test('the same request id posts once, whether the taps come one after the other or at the same moment', async () => {
    const w = await boot();
    const first = await w.post('comment', comment());
    const again = await w.post('comment', comment());
    expect(again.status).toBe(201);
    expect(again.json()).toMatchObject({ id: (first.json() as { id: string }).id, replayed: true });
    const both = await Promise.all([
      w.post('comment', comment({ requestId: 'req-bbbbbbbbbbbbbbbb' })),
      w.post('comment', comment({ requestId: 'req-bbbbbbbbbbbbbbbb' })),
    ]);
    expect(both.map(answer => answer.status)).toEqual([201, 201]);
    expect(new Set(both.map(answer => (answer.json() as { id: string }).id)).size).toBe(1);
    expect(w.posts.posted).toHaveLength(2);
    // A repeat is not a second act: one line per post that went out.
    expect(w.gate?.audits).toHaveLength(2);
  });

  test('a request id used for a different comment is refused and sends nothing', async () => {
    const w = await boot();
    await w.post('comment', comment());
    const other = await w.post('comment', comment({ body: 'something else' }));
    expect(other.status).toBe(409);
    expect(other.json()).toMatchObject({ code: POST_CODES.requestReused });
    expect(w.posts.posted).toHaveLength(1);
  });

  test('a ferret is refused owner_only, and nothing reaches GitHub or the log', async () => {
    const w = await boot();
    w.as(ferretStanding('lead' as never));
    const answer = await w.post('comment', comment());
    expect(answer.status).toBe(403);
    expect(answer.json()).toMatchObject({ code: 'owner_only' });
    expect(w.github.seen).toHaveLength(0);
    expect(w.gate?.audits).toHaveLength(0);
  });

  test('a body over 65,536 characters, or a blank one, is refused before any request', async () => {
    const w = await boot();
    const over = await w.post('comment', comment({ body: 'a'.repeat(MAX_POST_BODY + 1) }));
    expect(over.status).toBeGreaterThanOrEqual(400);
    expect(over.status).toBeLessThan(500);
    const exact = await w.post(
      'comment',
      comment({ requestId: 'req-cccccccccccccccc', body: 'a'.repeat(MAX_POST_BODY) }),
    );
    expect(exact.status).toBe(201);
    const blank = await w.post('comment', comment({ requestId: 'req-dddddddddddddddd', body: '  \n ' }));
    expect(blank.status).toBeGreaterThanOrEqual(400);
    expect(posted(w)).toHaveLength(1);
  });

  test('a secret-shaped body needs a second, explicit tap', async () => {
    const w = await boot();
    const body = 'my key is ghp_0123456789abcdefghijklmnopqrstuvwxyzAB';
    const stopped = await w.post('comment', comment({ body }));
    expect(stopped.status).toBe(409);
    expect(stopped.json()).toMatchObject({ code: POST_CODES.secretShaped });
    expect(w.github.seen).toHaveLength(0);
    // The stop is on the log, as a refusal, with no text.
    expect(JSON.stringify(w.gate?.audits)).not.toContain('ghp_');
    const anyway = await w.post('comment', comment({ body, postAnyway: true }));
    expect(anyway.status).toBe(201);
    expect(w.posts.posted).toHaveLength(1);
  });

  test('the audit line names the project, repository, number, kind and comment id, never the text', async () => {
    const w = await boot();
    await w.post('comment', comment({ body: 'a private sentence about the release' }));
    expect(w.gate?.audits).toHaveLength(1);
    const line = w.gate?.audits[0] as {
      event: string;
      subject?: string;
      outcome: string;
      detail?: Record<string, unknown>;
    };
    expect(line.event).toBe('pulls.comment.posted');
    expect(line.subject).toBe(P1);
    expect(line.outcome).toBe('succeeded');
    expect(line.detail).toEqual({ repo: 'octo/demo', number: 7, kind: 'comment', commentId: '9001' });
    expect(JSON.stringify(w.gate?.audits)).not.toContain('private sentence');
  });

  test('a refusal from GitHub is worded by us, is not remembered, and the same id can try again', async () => {
    const w = await boot();
    w.posts.status = 422;
    const refused = await w.post('comment', comment());
    expect(refused.status).toBe(422);
    expect(refused.body).not.toContain('fake refusal with GitHub words');
    w.posts.status = 201;
    const retry = await w.post('comment', comment());
    expect(retry.status).toBe(201);
    expect(retry.json()).toMatchObject({ replayed: false });
    expect(w.posts.posted).toHaveLength(1);
    expect((w.gate?.audits ?? []).map(line => line.outcome)).toEqual(['refused', 'succeeded']);
  });

  test('a call that may have reached GitHub answers "unknown" and is never sent again, under that id', async () => {
    let calls = 0;
    const w = await boot({
      api: async () => {
        calls += 1;
        throw new ApiError(502, 'GitHub could not be reached (timeout)', 'provider_unreachable');
      },
    });
    const first = await w.post('comment', comment());
    expect(first.status).toBe(202);
    expect(first.json()).toEqual({ kind: 'unknown' });
    const second = await w.post('comment', comment());
    expect(second.status).toBe(202);
    expect(calls).toBe(1);
    const line = w.gate?.audits[0] as { outcome: string; detail?: Record<string, unknown> };
    expect([line.outcome, line.detail?.unknown]).toEqual(['failed', true]);
    expect(w.gate?.audits).toHaveLength(1);
  });

  test('a server error is unknown too (it may have been acted on), but a refusal before sending is not', async () => {
    const w = await boot();
    w.posts.status = 503;
    expect((await w.post('comment', comment())).status).toBe(202);
    let calls = 0;
    const closed = await boot({
      api: async () => {
        calls += 1;
        throw new ApiError(403, 'that GitHub API call is not one Git accounts makes', 'invalid_request');
      },
    });
    const answer = await closed.post('comment', comment());
    expect(answer.status).toBe(502);
    expect(calls).toBe(1);
    // Nothing was sent, so the same id may try again.
    expect((await closed.post('comment', comment())).status).toBe(502);
    expect(calls).toBe(2);
  });

  test('with no Gate there is no post at all', async () => {
    const w = await boot({ gate: null });
    const answer = await w.post('comment', comment());
    expect(answer.status).toBe(503);
    expect(answer.json()).toMatchObject({ code: POST_CODES.notRecorded });
    expect(w.github.seen).toHaveLength(0);
  });

  test('a project without that repository, an unknown project and a bad number are refused', async () => {
    const w = await boot();
    expect((await w.host.request('POST', `/v1/pulls/${P1}/octo~other/7/comment`, { body: comment() })).status).toBe(
      404,
    );
    expect(
      (
        await w.host.request('POST', `/v1/pulls/33333333-3333-4333-8333-333333333333/octo~demo/7/comment`, {
          body: comment(),
        })
      ).status,
    ).toBe(404);
    expect((await w.host.request('POST', `/v1/pulls/${P1}/octo~demo/0/comment`, { body: comment() })).status).toBe(400);
    expect(w.github.seen).toHaveLength(0);
  });
});

describe('POST …/line-comment', () => {
  const line = (extra: object = {}) => ({
    requestId: ID,
    body: 'rename this',
    commitId: 'abc1234def5678',
    path: 'src/a.ts',
    side: 'right',
    line: 12,
    ...extra,
  });

  test('posts one single comment with the commit, path, line and side GitHub wants', async () => {
    const w = await boot();
    const answer = await w.post('line-comment', line({ startLine: 10 }));
    expect(answer.status).toBe(201);
    expect(posted(w).map(call => [call.path, call.body])).toEqual([
      [
        '/repos/octo/demo/pulls/7/comments',
        {
          body: 'rename this',
          commit_id: 'abc1234def5678',
          path: 'src/a.ts',
          line: 12,
          side: 'RIGHT',
          start_line: 10,
          start_side: 'RIGHT',
        },
      ],
    ]);
    const left = await w.post('line-comment', line({ requestId: 'req-eeeeeeeeeeeeeeee', side: 'left', line: 3 }));
    expect(left.status).toBe(201);
    expect(posted(w)[1]?.body).toMatchObject({ side: 'LEFT', line: 3 });
    expect(posted(w)[1]?.body).not.toHaveProperty('start_line');
  });

  test('a range that runs backwards, a path with a control character or a bad commit is refused', async () => {
    const w = await boot();
    for (const bad of [{ startLine: 12 }, { startLine: 13 }, { path: 'a\u0000b' }, { commitId: 'main' }, { line: 0 }])
      expect((await w.post('line-comment', line({ requestId: 'req-ffffffffffffffff', ...bad }))).status).toBe(400);
    expect(w.github.seen).toHaveLength(0);
  });
});

describe('POST …/reply', () => {
  const reply = (extra: object = {}) => ({ requestId: ID, body: 'thanks, fixed', threadId: 'PRRT_abc123', ...extra });

  test('asks which pull request the thread is on, then replies with the mutation', async () => {
    const w = await boot();
    const answer = await w.post('reply', reply());
    expect(answer.status).toBe(201);
    expect(answer.json()).toMatchObject({ kind: 'posted', replayed: false });
    const calls = posted(w);
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1]?.body)).toContain('addPullRequestReviewThreadReply');
    expect((calls[1]?.body as { variables: unknown } | undefined)?.variables).toEqual({
      thread: 'PRRT_abc123',
      body: 'thanks, fixed',
    });
    expect(w.posts.posted.map(each => each.kind)).toEqual(['reply']);
  });

  test('a thread of another pull request or repository is never replied to from here', async () => {
    const w = await boot();
    w.posts.threadHome = { number: 99, nameWithOwner: 'octo/demo' };
    expect((await w.post('reply', reply())).status).toBe(404);
    w.posts.threadHome = { number: 7, nameWithOwner: 'someone/else' };
    expect((await w.post('reply', reply({ requestId: 'req-gggggggggggggggg' }))).status).toBe(404);
    w.posts.threadHome = null;
    expect((await w.post('reply', reply({ requestId: 'req-hhhhhhhhhhhhhhhh' }))).status).toBe(404);
    expect(w.posts.posted).toHaveLength(0);
  });

  test('a thread id that is not a plain node id is refused', async () => {
    const w = await boot();
    expect((await w.post('reply', reply({ threadId: 'x" } ){ y' }))).status).toBe(400);
    expect(w.github.seen).toHaveLength(0);
  });
});

describe('GET …/poster', () => {
  test('says which login a post goes out as, and nothing else', async () => {
    const w = await boot();
    const answer = await w.host.request('GET', `${BASE}/poster`);
    expect(answer.status).toBe(200);
    expect(answer.json()).toEqual({ login: 'octo-fake' });
  });
});

describe('the wire shapes', () => {
  test('no field of a post request or answer is named like a credential', async () => {
    const {
      PostCommentRequestSchema,
      PostLineRequestSchema,
      PostReplyRequestSchema,
      PostedAnswerSchema,
      PosterAnswerSchema,
    } = await import('../../contract/index.ts');
    for (const schema of [
      PostCommentRequestSchema,
      PostReplyRequestSchema,
      PostLineRequestSchema,
      PostedAnswerSchema,
      PosterAnswerSchema,
    ]) {
      const shape = (schema as unknown as { def: { shape?: Record<string, unknown> } }).def.shape ?? {};
      for (const key of Object.keys(shape)) expect(NO_SECRET_FIELDS.test(key)).toBe(false);
    }
  });
});
