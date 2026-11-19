import { describe, expect, test } from 'bun:test';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import type { Log } from '@ferretry/kernel/contract';
import type { GitAccountId } from '@ferretry/plugin-git-accounts/contract';
import { PULLS_CACHE, PULLS_CODES } from '../../contract/index.ts';
import { RateBudget } from '../../daemon/adapters/github/budget.ts';
import { GithubClient } from '../../daemon/adapters/github/client.ts';
import { nextPagePath } from '../../daemon/adapters/github/link.ts';
import { PullsCache } from '../../daemon/lib/cache/store.ts';
import { FAKE_ACCOUNT, FakeGithub } from '../fixtures/fake-github/index.ts';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const quiet: Log = { debug() {}, info() {}, warn() {}, error() {}, child: () => quiet };
const NOW_SEC = 1_789_990_000;

function world() {
  const github = new FakeGithub();
  github.rate(5000, NOW_SEC + 3000);
  let nowMs = NOW_SEC * 1000;
  const folder = new MemoryStateFolder(() => nowMs);
  const cache = new PullsCache(folder.port([PULLS_CACHE]), () => nowMs, quiet);
  const client = new GithubClient(github.accounts, cache, () => nowMs, quiet);
  return {
    github,
    cache,
    client,
    folder,
    advance: (ms: number) => (nowMs += ms),
    reading: (path: string, account: GitAccountId = FAKE_ACCOUNT) => ({ project: PROJECT, account, path }),
  };
}

describe('conditional reads', () => {
  test('a second identical read sends If-None-Match and serves the cached body on 304', async () => {
    const w = world();
    w.github.set('/repos/o/r/pulls?state=open', [{ number: 1 }]);
    const first = await w.client.get(w.reading('/repos/o/r/pulls?state=open'));
    expect(first.ok && first.value).toMatchObject({ body: [{ number: 1 }], fromCache: false });
    expect(w.github.seen[0]?.ifNoneMatch).toBeUndefined();
    const spent = w.github.remaining;

    const second = await w.client.get(w.reading('/repos/o/r/pulls?state=open'));
    expect(second.ok && second.value).toMatchObject({ body: [{ number: 1 }], fromCache: true });
    expect(w.github.seen[1]?.ifNoneMatch).toBe('W/"1-1"');
    // A 304 costs no rate limit.
    expect(w.github.remaining).toBe(spent);
  });

  test('a changed resource answers 200 and replaces the cached body', async () => {
    const w = world();
    w.github.set('/repos/o/r/pulls?state=open', [{ number: 1 }]);
    await w.client.get(w.reading('/repos/o/r/pulls?state=open'));
    w.github.set('/repos/o/r/pulls?state=open', [{ number: 1 }, { number: 2 }]);
    const changed = await w.client.get(w.reading('/repos/o/r/pulls?state=open'));
    expect(changed.ok && changed.value).toMatchObject({ body: [{ number: 1 }, { number: 2 }], fromCache: false });
    const again = await w.client.get(w.reading('/repos/o/r/pulls?state=open'));
    expect(again.ok && again.value).toMatchObject({ body: [{ number: 1 }, { number: 2 }], fromCache: true });
  });

  test('the cache is per account: another account never reads or validates against this one’s answer', async () => {
    const w = world();
    const other = 'gha_9' as GitAccountId;
    w.github.knownAccounts.add(other);
    w.github.set('/repos/o/r', { id: 1 });
    await w.client.get(w.reading('/repos/o/r'));
    await w.client.get(w.reading('/repos/o/r', other));
    expect(w.github.seen[1]?.ifNoneMatch).toBeUndefined();
  });

  test('a 404 and a refused path are failures that carry none of GitHub’s text', async () => {
    const w = world();
    const missing = await w.client.get(w.reading('/repos/o/r/nothing'));
    expect(!missing.ok && missing.error).toMatchObject({ code: PULLS_CODES.notFound, status: 404 });
    const refused = await w.client.get(w.reading('/repos/o/../r'));
    expect(!refused.ok && refused.error.code).toBe(PULLS_CODES.refused);
    const unknown = await w.client.get(w.reading('/repos/o/r', 'gha_1' as GitAccountId));
    expect(!unknown.ok && unknown.error.code).toBe(PULLS_CODES.refused);
    expect(JSON.stringify([missing, refused, unknown])).not.toContain('Not Found');
  });
});

describe('answers that are not a body', () => {
  test('a refusal is denied, a server error is a GitHub error, a 304 with nothing cached is an error; none carries GitHub’s text', async () => {
    const w = world();
    w.github.fail('/repos/o/r/forbidden', 403);
    w.github.fail('/repos/o/r/broken', 500);
    w.github.on('GET', '/repos/o/r/odd', () => ({ status: 304 }));
    const denied = await w.client.get(w.reading('/repos/o/r/forbidden'));
    const broken = await w.client.get(w.reading('/repos/o/r/broken'));
    const odd = await w.client.get(w.reading('/repos/o/r/odd'));
    expect(!denied.ok && denied.error).toMatchObject({ code: PULLS_CODES.denied, status: 403 });
    expect(!broken.ok && broken.error).toMatchObject({ code: PULLS_CODES.github, status: 500 });
    expect(!odd.ok && odd.error).toMatchObject({ code: PULLS_CODES.github, status: 304 });
    expect(JSON.stringify([denied, broken, odd])).not.toContain('fake failure');
  });

  test('a list read that gets an object says so', async () => {
    const w = world();
    w.github.set('/repos/o/r/object', { a: 1 });
    const read = await w.client.getAll(w.reading('/repos/o/r/object'));
    expect(!read.ok && read.error.code).toBe(PULLS_CODES.github);
  });
});

describe('a 200 that is not a body is never kept', () => {
  test.each([
    ['null (the seam’s mark for text it could not parse)', null],
    ['nothing', undefined],
    ['a string', 'plain text'],
    ['a number', 7],
  ])('%s: an error, nothing cached, not served on the next read', async (_name, body) => {
    const w = world();
    w.github.on('GET', '/repos/o/r/odd', () => ({ status: 200, body, headers: { etag: 'W/"x"' } }));
    const first = await w.client.get(w.reading('/repos/o/r/odd'));
    expect(!first.ok && first.error).toMatchObject({ code: PULLS_CODES.github, status: 200 });
    expect(await w.cache.usage(PROJECT)).toEqual({ bytes: 0, files: 0 });
    expect(w.folder.bytes.size).toBe(0);
    await w.client.get(w.reading('/repos/o/r/odd'));
    expect(w.github.seen[1]?.ifNoneMatch).toBeUndefined(); // no validator was ever kept
  });

  test('a list and an object are bodies and are kept', async () => {
    const w = world();
    w.github.set('/repos/o/r/list', []);
    w.github.set('/repos/o/r/obj', {});
    expect((await w.client.get(w.reading('/repos/o/r/list'))).ok).toBe(true);
    expect((await w.client.get(w.reading('/repos/o/r/obj'))).ok).toBe(true);
    expect(await w.cache.usage(PROJECT)).toMatchObject({ files: 2 });
  });
});

describe('a purge while a read is out', () => {
  /** A seam that holds every answer until `release()`, as a slow network would. */
  function slow(w: ReturnType<typeof world>) {
    let release: () => void = () => undefined;
    const held = new Promise<void>(resolve => (release = resolve));
    const accounts = {
      ...w.github.accounts,
      api: async (...args: Parameters<typeof w.github.accounts.api>) => {
        const answer = await w.github.accounts.api(...args);
        await held;
        return answer;
      },
    };
    const client = new GithubClient(accounts, w.cache, () => NOW_SEC * 1000, quiet);
    return { client, release };
  }

  test('a project removed meanwhile: the answer is served to the caller and written nowhere', async () => {
    const w = world();
    w.github.set('/repos/o/r', { id: 1 });
    const { client, release } = slow(w);
    const reading = client.get(w.reading('/repos/o/r'));
    await w.cache.purgeProject(PROJECT);
    release();
    const answer = await reading;
    expect(answer.ok && answer.value.body).toEqual({ id: 1 });
    expect(w.folder.bytes.size).toBe(0);
    expect(await w.cache.usage(PROJECT)).toEqual({ bytes: 0, files: 0 });
  });

  test('an account removed meanwhile (and reconnected under the same id): nothing is written for it', async () => {
    const w = world();
    w.github.set('/repos/o/r', { id: 1 });
    const { client, release } = slow(w);
    const reading = client.get(w.reading('/repos/o/r'));
    await w.cache.purgeAccount(FAKE_ACCOUNT);
    release();
    await reading;
    expect(w.folder.bytes.size).toBe(0);
    // A read begun after the purge is kept again.
    const after = await w.client.get(w.reading('/repos/o/r'));
    expect(after.ok).toBe(true);
    expect(w.folder.bytes.size).toBe(1);
  });
});

describe('paging', () => {
  const items = Array.from({ length: 5 }, (_, i) => ({ n: i + 1 }));

  test('follows Link rel=next to the last page, each page conditional', async () => {
    const w = world();
    w.github.setPaged('/repos/o/r/pulls?state=open', items, 2);
    const all = await w.client.getAll(w.reading('/repos/o/r/pulls?state=open&per_page=2'));
    expect(all.ok && all.value).toMatchObject({ items, fromCache: false, truncated: false });
    expect(w.github.seen.map(seen => seen.path)).toEqual([
      '/repos/o/r/pulls?state=open&per_page=2',
      '/repos/o/r/pulls?state=open&per_page=2&page=2',
      '/repos/o/r/pulls?state=open&per_page=2&page=3',
    ]);
    const again = await w.client.getAll(w.reading('/repos/o/r/pulls?state=open&per_page=2'));
    expect(again.ok && again.value).toMatchObject({ items, fromCache: true, truncated: false });
    // Every page of the second walk was conditional, and the Link survived the 304s.
    expect(w.github.seen.slice(3).every(seen => seen.ifNoneMatch !== undefined)).toBe(true);
    expect(w.github.seen).toHaveLength(6);
  });

  test('stops at maxPages and says it was cut', async () => {
    const w = world();
    w.github.setPaged('/repos/o/r/pulls?state=open', items, 2);
    const some = await w.client.getAll(w.reading('/repos/o/r/pulls?state=open&per_page=2'), 2);
    expect(some.ok && some.value).toMatchObject({ items: items.slice(0, 4), truncated: true });
  });

  test('a Link that leaves api.github.com is not followed', () => {
    expect(
      nextPagePath('<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last"'),
    ).toBe('/x?page=2');
    expect(nextPagePath('<https://evil.example/x?page=2>; rel="next"')).toBeUndefined();
    expect(nextPagePath('<http://api.github.com/x?page=2>; rel="next"')).toBeUndefined();
    expect(nextPagePath('<https://user:pw@api.github.com/x>; rel="next"')).toBeUndefined();
    expect(nextPagePath('<https://api.github.com/x?page=1>; rel="prev"')).toBeUndefined();
    expect(nextPagePath('<not a url>; rel="next"')).toBeUndefined();
    expect(nextPagePath(undefined)).toBeUndefined();
  });
});

describe('the rate budget', () => {
  test('below 10 % polling pauses until the reset, makes no request, and resumes after it', async () => {
    const w = world();
    w.github.set('/repos/o/r', { id: 1 });
    w.github.rate(499, NOW_SEC + 1200);
    // The call that sees 499 left (it is spent: 498 shown) tips the budget.
    const read = await w.client.get(w.reading('/repos/o/r'));
    expect(read.ok).toBe(true);
    const seen = w.github.seen.length;
    const paused = await w.client.get(w.reading('/repos/o/r'));
    expect(!paused.ok && paused.error).toMatchObject({
      code: PULLS_CODES.paused,
      pausedUntilMs: (NOW_SEC + 1200) * 1000,
    });
    expect(w.github.seen).toHaveLength(seen);
    expect(w.client.budget.snapshot()[0]).toMatchObject({
      account: FAKE_ACCOUNT,
      resource: 'rest',
      pausedUntil: new Date((NOW_SEC + 1200) * 1000).toISOString(),
    });
    w.advance(1201 * 1000);
    w.github.rate(5000, NOW_SEC + 4800);
    const resumed = await w.client.get(w.reading('/repos/o/r'));
    expect(resumed.ok).toBe(true);
    expect(w.client.budget.pausedUntil(FAKE_ACCOUNT, 'rest')).toBeUndefined();
  });

  test('exactly 10 % left does not pause; just under does', async () => {
    const at = world();
    at.github.set('/repos/o/r', { id: 1 });
    at.github.rate(501, NOW_SEC + 600); // 500 left after the call: 10 % of 5000, not below it
    await at.client.get(at.reading('/repos/o/r'));
    expect(at.client.budget.pausedUntil(FAKE_ACCOUNT, 'rest')).toBeUndefined();
    const under = world();
    under.github.set('/repos/o/r', { id: 1 });
    under.github.rate(500, NOW_SEC + 600);
    await under.client.get(under.reading('/repos/o/r'));
    expect(under.client.budget.pausedUntil(FAKE_ACCOUNT, 'rest')).toBeDefined();
  });

  test('a larger allowance (15,000) is learned from what remains, so 10 % scales', async () => {
    const w = world();
    w.github.set('/repos/o/r', { id: 1 });
    w.github.rate(15_001, NOW_SEC + 600, 15_000);
    await w.client.get(w.reading('/repos/o/r'));
    w.github.rate(1400, NOW_SEC + 600, 15_000); // 1399 < 10 % of 15,000
    await w.client.get(w.reading('/repos/o/r'));
    expect(w.client.budget.pausedUntil(FAKE_ACCOUNT, 'rest')).toBeDefined();
  });

  test('a 403 with nothing left reads as paused, not denied; a reset hours away is clamped to an hour', async () => {
    const w = world();
    w.github.set('/repos/o/r', { id: 1 });
    w.github.rate(0, NOW_SEC + 90_000);
    const spent = await w.client.get(w.reading('/repos/o/r'));
    expect(!spent.ok && spent.error.code).toBe(PULLS_CODES.paused);
    expect(w.client.budget.pausedUntil(FAKE_ACCOUNT, 'rest')).toBe(NOW_SEC * 1000 + 3_600_000);
  });

  test('REST and GraphQL are separate buckets', async () => {
    const w = world();
    w.github.set('/repos/o/r', { id: 1 });
    w.github.rate(100, NOW_SEC + 600);
    await w.client.get(w.reading('/repos/o/r'));
    expect(w.client.budget.pausedUntil(FAKE_ACCOUNT, 'rest')).toBeDefined();
    expect(w.client.budget.pausedUntil(FAKE_ACCOUNT, 'graphql')).toBeUndefined();
  });
});

describe('the budget with nothing to read', () => {
  test('a 429 or 403 with no usable headers pauses for a minute; other answers with none change nothing', () => {
    let now = 5_000_000;
    const budget = new RateBudget(() => now);
    budget.observe(FAKE_ACCOUNT, 'rest', {}, 200);
    budget.observe(FAKE_ACCOUNT, 'rest', { rateLimitRemaining: 'many', rateLimitReset: 'soon' }, 500);
    expect(budget.snapshot()).toEqual([]);
    budget.observe(FAKE_ACCOUNT, 'rest', {}, 429);
    expect(budget.pausedUntil(FAKE_ACCOUNT, 'rest')).toBe(now + 60_000);
    now += 60_001;
    expect(budget.pausedUntil(FAKE_ACCOUNT, 'rest')).toBeUndefined();
  });
});

describe('GraphQL', () => {
  test('posts the query, returns data, never caches, and treats errors as a failure without their text', async () => {
    const w = world();
    w.github.on('POST', '/graphql', ({ body }) =>
      (body as { query: string }).query.includes('boom')
        ? { status: 200, body: { errors: [{ message: 'secret detail' }] } }
        : { status: 200, body: { data: { viewer: { login: 'octo-fake' } } } },
    );
    const ok = await w.client.graphql(FAKE_ACCOUNT, '{ viewer { login } }');
    expect(ok.ok && ok.value).toEqual({ viewer: { login: 'octo-fake' } });
    expect(w.github.seen[0]).toMatchObject({ method: 'POST', path: '/graphql' });
    expect(w.github.seen[0]?.ifNoneMatch).toBeUndefined();
    const failed = await w.client.graphql(FAKE_ACCOUNT, '{ boom }');
    expect(!failed.ok && failed.error.code).toBe(PULLS_CODES.github);
    expect(JSON.stringify(failed)).not.toContain('secret detail');
    expect(await w.cache.usage(PROJECT)).toEqual({ bytes: 0, files: 0 });
  });
});

describe('the budget and the secondary limit', () => {
  const NOW = 5_000_000;
  const healthy = { rateLimitRemaining: '4000', rateLimitReset: String(Math.floor(NOW / 1000) + 600) };

  test('Retry-After on a 403, 429 or 503 pauses for exactly that long, whatever the allowance says', () => {
    for (const status of [403, 429, 503]) {
      const budget = new RateBudget(() => NOW);
      budget.observe(FAKE_ACCOUNT, 'rest', { ...healthy, retryAfter: '120' }, status);
      expect(budget.pausedUntil(FAKE_ACCOUNT, 'rest')).toBe(NOW + 120_000);
    }
  });

  test('Retry-After may be an HTTP date; a past date, nonsense or more than an hour is clamped or ignored', () => {
    const budget = new RateBudget(() => NOW);
    budget.observe(FAKE_ACCOUNT, 'rest', { ...healthy, retryAfter: new Date(NOW + 30_000).toUTCString() }, 429);
    // An HTTP date has whole-second precision.
    expect(budget.pausedUntil(FAKE_ACCOUNT, 'rest')).toBe(Math.floor((NOW + 30_000) / 1000) * 1000);

    const long = new RateBudget(() => NOW);
    long.observe(FAKE_ACCOUNT, 'rest', { ...healthy, retryAfter: '999999' }, 429);
    expect(long.pausedUntil(FAKE_ACCOUNT, 'rest')).toBe(NOW + 3_600_000);

    // A 503 whose Retry-After is junk or already past is just a 5xx: no pause here (the watch backs off on its own).
    for (const retryAfter of ['soon', 'Thu, 01 Jan 1970 00:00:00 GMT', '0']) {
      const odd = new RateBudget(() => NOW);
      odd.observe(FAKE_ACCOUNT, 'rest', { ...healthy, retryAfter }, 503);
      expect(odd.pausedUntil(FAKE_ACCOUNT, 'rest')).toBeUndefined();
    }
  });

  test('a 403 that says it is a limit, with a healthy allowance and no Retry-After, pauses a minute; a plain refusal or a 500 does not', () => {
    const budget = new RateBudget(() => NOW);
    budget.observe(FAKE_ACCOUNT, 'rest', healthy, 500);
    budget.observe(FAKE_ACCOUNT, 'rest', healthy, 403);
    expect(budget.pausedUntil(FAKE_ACCOUNT, 'rest')).toBeUndefined();
    budget.observe(FAKE_ACCOUNT, 'rest', healthy, 403, true);
    expect(budget.pausedUntil(FAKE_ACCOUNT, 'rest')).toBe(NOW + 60_000);
  });

  test('a longer pause already in force is never shortened by a later, shorter ask; a 429 never lands with no pause', () => {
    const budget = new RateBudget(() => NOW);
    budget.observe(FAKE_ACCOUNT, 'rest', { ...healthy, retryAfter: '300' }, 429);
    budget.observe(FAKE_ACCOUNT, 'rest', { retryAfter: '10' }, 429);
    expect(budget.pausedUntil(FAKE_ACCOUNT, 'rest')).toBe(NOW + 300_000);

    // A 429 whose reset is already past used to pause nothing at all.
    const past = new RateBudget(() => NOW);
    past.observe(FAKE_ACCOUNT, 'rest', { rateLimitRemaining: '10', rateLimitReset: '1' }, 429);
    expect(past.pausedUntil(FAKE_ACCOUNT, 'rest')).toBe(NOW + 60_000);
  });

  test('through the client: a 403 whose message is GitHub’s secondary limit pauses a minute; its text is not passed on', async () => {
    const w = world();
    w.github.on('GET', '/repos/o/r', () => ({
      status: 403,
      body: { message: 'You have exceeded a secondary rate limit.' },
    }));
    const first = await w.client.get(w.reading('/repos/o/r'));
    expect(!first.ok && first.error.code).toBe(PULLS_CODES.paused);
    expect(JSON.stringify(first)).not.toContain('secondary');
    expect(w.client.budget.pausedUntil(FAKE_ACCOUNT, 'rest')).toBe(NOW_SEC * 1000 + 60_000);
    // A reply that has no message at all is no limit.
    const other = world();
    other.github.on('GET', '/repos/o/r', () => ({ status: 403 }));
    await other.client.get(other.reading('/repos/o/r'));
    expect(other.client.budget.pausedUntil(FAKE_ACCOUNT, 'rest')).toBeUndefined();
  });

  test('through the client: a 403 with Retry-After reads as paused, and the next read makes no request', async () => {
    const w = world();
    w.github.fail('/repos/o/r', 403, { retryAfter: '120' });
    const first = await w.client.get(w.reading('/repos/o/r'));
    expect(!first.ok && first.error.code).toBe(PULLS_CODES.paused);
    const asked = w.github.seen.length;
    const second = await w.client.get(w.reading('/repos/o/r'));
    expect(!second.ok && second.error.code).toBe(PULLS_CODES.paused);
    expect(w.github.seen.length).toBe(asked);
  });
});
