import { describe, it } from 'bun:test';
import should from 'should';
import { GitHubLatestRelease, type ReleaseFetch } from '../../../src/adapters/index.ts';

const RELEASE = {
  tag_name: 'v4.29.0',
  html_url: 'https://github.com/kirinnee/ferretry/releases/tag/v4.29.0',
  draft: false,
  prerelease: false,
  published_at: '2026-10-18T08:00:00Z',
};

/** A fetcher that answers once and records how it was asked. */
function answering(respond: () => Response | Promise<Response>) {
  const calls: { input: string; init: RequestInit | undefined }[] = [];
  const fetcher: ReleaseFetch = async (input, init) => {
    calls.push({ input, init });
    return await respond();
  };
  return { calls, fetcher };
}

const source = (fetcher: ReleaseFetch) =>
  new GitHubLatestRelease('ferretry', { fetcher, userAgent: 'fyd/4.28.0', timeoutMs: 1_000 });

describe('the GitHub latest-release read', () => {
  it('asks the release API uncached, with a user agent, and reads the release', async () => {
    const { calls, fetcher } = answering(() => Response.json(RELEASE));
    should(await source(fetcher).latest()).deepEqual({
      kind: 'ok',
      release: { version: '4.29.0', url: RELEASE.html_url, publishedAt: '2026-10-18T08:00:00Z' },
    });
    should(calls[0]?.input).equal('https://api.github.com/repos/kirinnee/ferretry/releases/latest');
    should(calls[0]?.init).containDeep({ cache: 'no-store', headers: { 'user-agent': 'fyd/4.28.0' } });
  });

  it('turns every failure into one sentence, never a throw', async () => {
    const failing = answering(() => {
      throw new TypeError('network down');
    });
    should(await source(failing.fetcher).latest()).deepEqual({ kind: 'failed', reason: 'could not reach GitHub' });
    const refused = answering(() => new Response('rate limited', { status: 403 }));
    should(await source(refused.fetcher).latest()).deepEqual({ kind: 'failed', reason: 'GitHub answered 403' });
    const garbled = answering(() => new Response('<html>', { status: 200 }));
    should(await source(garbled.fetcher).latest()).deepEqual({
      kind: 'failed',
      reason: 'GitHub did not name a published release',
    });
    const draft = answering(() => Response.json({ ...RELEASE, draft: true }));
    should((await source(draft.fetcher).latest()).kind).equal('failed');
  });

  it('builds with the default fetch and timeout without dialling anything', () => {
    should(() => new GitHubLatestRelease('ferretry', { userAgent: 'fyd/4.28.0' })).not.throw();
  });
});
