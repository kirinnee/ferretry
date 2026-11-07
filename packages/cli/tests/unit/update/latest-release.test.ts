import { describe, it } from 'bun:test';
import should from 'should';
import { GitHubLatestRelease, type ReleaseFetch } from '../../../src/adapters/update/latest-release';

const release = {
  tag_name: 'v1.3.0',
  html_url: 'https://github.com/kirinnee/ferretry/releases/tag/v1.3.0',
  draft: false,
  prerelease: false,
};

const answering =
  (response: () => Response, seen: string[] = []): ReleaseFetch =>
  input => {
    seen.push(input);
    return Promise.resolve(response());
  };

describe('GitHubLatestRelease', () => {
  it('reads the latest published release from the releases API', async () => {
    const seen: string[] = [];
    const answer = await new GitHubLatestRelease('ferretry', {
      fetcher: answering(() => Response.json(release), seen),
    }).latest();
    should(answer).deepEqual({ kind: 'found', release: { version: '1.3.0', url: release.html_url } });
    should(seen).deepEqual(['https://api.github.com/repos/kirinnee/ferretry/releases/latest']);
  });

  it('reads the newest stable tag from the tags API', async () => {
    const seen: string[] = [];
    const tags = [{ name: 'v1.3.0' }, { name: 'v1.3.1' }, { name: 'v1.4.0-rc.1' }, { name: 'nightly' }];
    const answer = await new GitHubLatestRelease('ferretry', {
      fetcher: answering(() => Response.json(tags), seen),
    }).newestTag();
    should(answer).deepEqual({
      kind: 'found',
      release: { version: '1.3.1', url: 'https://github.com/kirinnee/ferretry/releases/tag/v1.3.1' },
    });
    should(seen).deepEqual(['https://api.github.com/repos/kirinnee/ferretry/tags?per_page=30']);
  });

  it('turns every tag failure into one sentence too', async () => {
    const read = (fetcher: ReleaseFetch) => new GitHubLatestRelease('ferretry', { fetcher, timeoutMs: 50 }).newestTag();
    should(await read(() => Promise.reject(new Error('offline')))).deepEqual({
      kind: 'failed',
      reason: 'could not reach GitHub',
    });
    should(await read(answering(() => new Response('', { status: 500 })))).deepEqual({
      kind: 'failed',
      reason: 'GitHub answered 500',
    });
    should(await read(answering(() => Response.json([{ name: 'nightly' }])))).deepEqual({
      kind: 'failed',
      reason: 'GitHub named no release tag',
    });
  });

  it('turns every failure into one sentence', async () => {
    const read = (fetcher: ReleaseFetch) => new GitHubLatestRelease('ferretry', { fetcher, timeoutMs: 50 }).latest();
    should(await read(() => Promise.reject(new Error('offline')))).deepEqual({
      kind: 'failed',
      reason: 'could not reach GitHub',
    });
    should(await read(answering(() => new Response('', { status: 403 })))).deepEqual({
      kind: 'failed',
      reason: 'GitHub answered 403',
    });
    should(await read(answering(() => new Response('<html>')))).deepEqual({
      kind: 'failed',
      reason: 'GitHub answered something that is not JSON',
    });
    should(await read(answering(() => Response.json({ ...release, draft: true })))).deepEqual({
      kind: 'failed',
      reason: 'GitHub named no published release',
    });
  });
});
