/**
 * Fake GitHub's comment endpoints (E7): `servePosts` answers the three posts and the thread-home question, and keeps
 * what was posted so a test can count it. Fake data only.
 */
import type { FakeGithub } from './server.ts';

export interface FakePosted {
  readonly kind: 'comment' | 'line' | 'reply';
  readonly body: string;
  readonly payload: unknown;
  readonly id: string;
}

export interface FakePosts {
  readonly posted: FakePosted[];
  /** The pull request a thread is on, for the reply pre-check. */
  threadHome: { readonly number: number; readonly nameWithOwner: string } | null;
  /** The status the next post answers (default 201); 422 and friends make nothing. */
  status: number;
}

export function servePosts(fake: FakeGithub, repo = 'octo/demo', number = 7): FakePosts {
  const state: FakePosts = { posted: [], threadHome: { number, nameWithOwner: repo }, status: 201 };
  let next = 9000;
  const rest = (kind: 'comment' | 'line') => (request: { readonly body: unknown }) => {
    const body = request.body as { body: string };
    if (state.status !== 201) return { status: state.status, body: { message: 'fake refusal with GitHub words' } };
    next += 1;
    state.posted.push({ kind, body: body.body, payload: request.body, id: String(next) });
    return {
      status: 201,
      body: { id: next, html_url: `https://github.com/${repo}/pull/${number}#issuecomment-${next}` },
    };
  };
  fake.on('POST', `/repos/${repo}/issues/${number}/comments`, rest('comment'));
  fake.on('POST', `/repos/${repo}/pulls/${number}/comments`, rest('line'));
  fake.on('POST', '/graphql', request => {
    const { query, variables } = request.body as { query: string; variables: { thread: string; body?: string } };
    if (query.includes('addPullRequestReviewThreadReply')) {
      if (state.status !== 201) return { status: state.status, body: { message: 'fake refusal' } };
      next += 1;
      const id = `PRRC_fake${next}`;
      state.posted.push({ kind: 'reply', body: variables.body ?? '', payload: request.body, id });
      return {
        status: 200,
        body: {
          data: {
            addPullRequestReviewThreadReply: {
              comment: { id, url: `https://github.com/${repo}/pull/${number}#discussion_r${next}` },
            },
          },
        },
      };
    }
    return {
      status: 200,
      body: {
        data: {
          node:
            state.threadHome === null
              ? null
              : {
                  pullRequest: {
                    number: state.threadHome.number,
                    repository: { nameWithOwner: state.threadHome.nameWithOwner },
                  },
                },
        },
      },
    };
  });
  return state;
}
