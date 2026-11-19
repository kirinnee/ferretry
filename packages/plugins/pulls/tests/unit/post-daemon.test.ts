import { describe, expect, test } from 'bun:test';
import { FakeGate, ferretStanding, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { ApiError, type CallStanding } from '@ferretry/kernel/contract';
import { testHost } from '@ferretry/kernel/testing';
import type { GitAccountsApi } from '@ferretry/plugin-git-accounts/contract';
import type { ProjectInfo } from '@ferretry/plugin-projects/contract';
import { MAX_POST_BODY, NO_SECRET_FIELDS, POST_CODES } from '../../contract/index.ts';
import daemon from '../../daemon/index.ts';
import { LEDGER_MAX_ENTRIES } from '../../daemon/features/post/ledger.ts';
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
/** The account the person was shown on the button (the fake's one connected account). */
const SHOWN = { id: 'gha_4242', login: 'octo-fake' };
const BASE = `/v1/pulls/${P1}/octo~demo/7`;

async function boot(
  options: {
    api?: GitAccountsApi['api'];
    /** Wraps the fake's own `api`, so a call can reach GitHub and still end badly. */
    wrap?: (real: GitAccountsApi['api']) => GitAccountsApi['api'];
    gate?: FakeGate | null;
    accounts?: () => Promise<readonly { id: string; login: string }[]>;
  } = {},
) {
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
        ...(options.accounts === undefined ? {} : { list: options.accounts as GitAccountsApi['list'] }),
        ...(options.api === undefined ? {} : { api: options.api }),
        ...(options.wrap === undefined ? {} : { api: options.wrap(github.accounts.api) }),
        run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
        recordKeys: async () => undefined,
      },
      projects: { list: async () => [project()], find: async (id: string) => (id === P1 ? project() : undefined) },
    },
    ...(gate === null ? {} : { uses: { gate } }),
  });
  const logs = () => host.logs;
  const post = async (leaf: string, body: unknown) => await host.request('POST', `${BASE}/${leaf}`, { body });
  return {
    host,
    logs,
    github,
    posts,
    gate,
    post,
    as: (next: CallStanding) => {
      standing = next;
    },
  };
}

const comment = (extra: object = {}) => ({ requestId: ID, body: 'Looks good to me.', account: SHOWN, ...extra });
const posted = (w: { github: FakeGithub }) => w.github.seen.filter(call => call.method === 'POST');
/** The lines a post leaves on the log: the intent before it is sent, and the outcome after. */
const lines = (w: { gate: FakeGate | null }, event: 'pulls.comment.intent' | 'pulls.comment.posted') =>
  (w.gate?.audits ?? []).filter(line => (line.event as string) === event);

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
    expect(lines(w, 'pulls.comment.posted')).toHaveLength(2);
    expect(lines(w, 'pulls.comment.intent')).toHaveLength(2);
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

  test('the audit lines name the project, repository, number, kind and comment id, never the text', async () => {
    const w = await boot();
    await w.post('comment', comment({ body: 'a private sentence about the release' }));
    expect(w.gate?.audits).toHaveLength(2);
    const line = lines(w, 'pulls.comment.posted')[0] as {
      event: string;
      subject?: string;
      outcome: string;
      detail?: Record<string, unknown>;
    };
    expect(line.event).toBe('pulls.comment.posted');
    expect(line.subject).toBe(P1);
    expect(line.outcome).toBe('succeeded');
    const shared = { repo: 'octo/demo', number: 7, kind: 'comment', requestId: ID, account: 'gha_4242' };
    expect(line.detail).toEqual({ ...shared, commentId: '9001' });
    const intent = lines(w, 'pulls.comment.intent')[0] as typeof line;
    expect([intent.outcome, intent.subject, intent.detail]).toEqual(['succeeded', P1, shared]);
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
    expect(lines(w, 'pulls.comment.posted').map(line => line.outcome)).toEqual(['refused', 'succeeded']);
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
    const line = lines(w, 'pulls.comment.posted')[0] as { outcome: string; detail?: Record<string, unknown> };
    expect([line.outcome, line.detail?.unknown]).toEqual(['failed', true]);
    expect(lines(w, 'pulls.comment.posted')).toHaveLength(1);
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
    account: SHOWN,
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
  const reply = (extra: object = {}) => ({
    requestId: ID,
    account: SHOWN,
    body: 'thanks, fixed',
    threadId: 'PRRT_abc123',
    ...extra,
  });

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
    expect(answer.json()).toEqual({ id: 'gha_4242', login: 'octo-fake' });
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

/** A Gate whose audit door fails for the lines `fails` says, and counts every try. */
class FlakyGate extends FakeGate {
  tries = 0;
  constructor(private readonly fails: (draft: { event: string }, attempt: number) => boolean) {
    super();
  }
  override async audit(draft: Parameters<FakeGate['audit']>[0]): Promise<void> {
    this.tries += 1;
    if (this.fails(draft as { event: string }, this.tries)) throw new Error('the log is not there');
    await super.audit(draft);
  }
}

describe('the account the person was shown', () => {
  test('a post whose account is not the one the project posts as is refused with our words and sends nothing', async () => {
    const w = await boot();
    for (const [i, shown] of [
      { id: 'gha_4242', login: 'someone-else' },
      { id: 'gha_9999', login: 'octo-fake' },
    ].entries()) {
      const refused = await w.post(
        'comment',
        comment({ requestId: `req-account-${String(i)}aaaaaaa`, account: shown }),
      );
      expect(refused.status).toBe(409);
      expect(refused.json()).toMatchObject({
        code: POST_CODES.accountChanged,
        error: 'the account for this project changed to @octo-fake; check and post again',
      });
    }
    expect(w.github.seen).toHaveLength(0);
    expect(lines(w, 'pulls.comment.intent')).toHaveLength(0);
    expect(lines(w, 'pulls.comment.posted').map(line => [line.outcome, line.detail?.reason])).toEqual([
      ['refused', 'account-changed'],
      ['refused', 'account-changed'],
    ]);
  });

  test('a post without the account is a bad request, and the one shown posts as it was shown', async () => {
    const w = await boot();
    const { account: _shown, ...bare } = comment();
    expect((await w.post('comment', bare)).status).toBe(400);
    expect((await w.post('comment', comment())).status).toBe(201);
    expect(posted(w).map(call => call.account)).toEqual(['gha_4242']);
  });

  test('the answer follows the project: when the account changes between the poster read and the tap, the tap is refused', async () => {
    let login = 'octo-fake';
    const w = await boot({ accounts: async () => [{ id: 'gha_4242', login }] });
    const shown = (await w.host.request('GET', `${BASE}/poster`)).json() as { id: string; login: string };
    login = 'renamed-fake';
    expect((await w.post('comment', comment({ account: shown }))).status).toBe(409);
    expect(w.github.seen).toHaveLength(0);
  });
});

describe('a call that may have reached GitHub is never "unsent"', () => {
  test('an error after GitHub accepted the post (the reply could not be read) is unknown, and the id never posts twice', async () => {
    let calls = 0;
    const w = await boot({
      wrap: real => async (account, call) => {
        calls += 1;
        await real(account, call);
        // The seam read the reply as a stream and the stream died: the post is on GitHub.
        throw new TypeError('terminated');
      },
    });
    const first = await w.post('comment', comment());
    expect(first.status).toBe(202);
    expect(first.json()).toEqual({ kind: 'unknown' });
    const retry = await w.post('comment', comment());
    expect(retry.status).toBe(202);
    expect(calls).toBe(1);
    expect(w.posts.posted).toHaveLength(1);
  });

  test('a plain failure of the seam, or one with a code of its own, is unknown too; only its two pre-send refusals are not', async () => {
    for (const thrown of [new Error('boom'), new ApiError(413, 'x', 'something_else'), new ApiError(500, 'x')]) {
      const w = await boot({
        api: async () => {
          throw thrown;
        },
      });
      expect((await w.post('comment', comment())).status).toBe(202);
    }
    for (const refused of [
      new ApiError(404, 'no such Git account', 'unknown_account'),
      new ApiError(413, 'that request body is too large', 'invalid_request'),
    ]) {
      const w = await boot({
        api: async () => {
          throw refused;
        },
      });
      expect((await w.post('comment', comment())).status).toBe(502);
    }
  });
});

describe('the audit trail of a post', () => {
  test('the intent is on the log before anything is sent, and the outcome is written against it', async () => {
    const order: string[] = [];
    const gate = new FlakyGate(draft => {
      order.push(draft.event);
      return false;
    });
    const w = await boot({
      gate,
      wrap: real => async (account, call) => {
        order.push('github');
        return await real(account, call);
      },
    });
    expect((await w.post('comment', comment())).status).toBe(201);
    expect(order).toEqual(['pulls.comment.intent', 'github', 'pulls.comment.posted']);
    const [intent] = lines(w, 'pulls.comment.intent');
    const [outcome] = lines(w, 'pulls.comment.posted');
    expect(intent?.detail?.requestId).toBe(outcome?.detail?.requestId);
  });

  test('when the intent cannot be written nothing is sent; it may try again under the same id', async () => {
    const gate = new FlakyGate(draft => draft.event === 'pulls.comment.intent');
    const w = await boot({ gate });
    const refused = await w.post('comment', comment());
    expect(refused.status).toBe(503);
    expect(refused.json()).toMatchObject({ code: POST_CODES.notRecorded });
    expect(w.github.seen).toHaveLength(0);
    // The refusal is not remembered: once the log is back the same id posts.
    const back = new FlakyGate(() => false);
    const again = await boot({ gate: back });
    expect((await again.post('comment', comment())).status).toBe(201);
  });

  test('an outcome line that fails is written again, and when it never lands the failure is said in the log', async () => {
    const once = new FlakyGate((draft, attempt) => draft.event === 'pulls.comment.posted' && attempt < 3);
    const retried = await boot({ gate: once });
    expect((await retried.post('comment', comment())).status).toBe(201);
    expect(lines(retried, 'pulls.comment.posted')).toHaveLength(1);
    expect(retried.logs().filter(line => line.level === 'error')).toHaveLength(0);

    const never = new FlakyGate(draft => draft.event === 'pulls.comment.posted');
    const lost = await boot({ gate: never });
    // The post went out, and the answer says so.
    expect((await lost.post('comment', comment())).status).toBe(201);
    expect(lost.posts.posted).toHaveLength(1);
    const said = lost.logs().filter(line => line.level === 'error');
    expect(said).toHaveLength(1);
    expect(JSON.stringify(said)).toContain(ID);
    expect(JSON.stringify(said)).not.toContain('Looks good');
  });
});

describe('a full ledger', () => {
  test('a new id is refused busy once the ledger holds as many live posts as it may; a held id is still answered', async () => {
    const w = await boot();
    const id = (n: number) => `req-fill-${String(n).padStart(8, '0')}`;
    for (let n = 0; n < LEDGER_MAX_ENTRIES; n += 1)
      expect((await w.post('comment', comment({ requestId: id(n) }))).status).toBe(201);
    const full = await w.post('comment', comment({ requestId: id(LEDGER_MAX_ENTRIES) }));
    expect(full.status).toBe(503);
    expect(full.json()).toMatchObject({ code: POST_CODES.busy });
    // The oldest is the one a retry would be: it is still there, and is answered, not posted again.
    const retry = await w.post('comment', comment({ requestId: id(0) }));
    expect(retry.status).toBe(201);
    expect(retry.json()).toMatchObject({ replayed: true });
    expect(w.posts.posted).toHaveLength(LEDGER_MAX_ENTRIES);
  });
});
