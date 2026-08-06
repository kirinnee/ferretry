import { describe, it } from 'bun:test';
import type { AttentionResponse } from '@ferretry/protocol';
import should from 'should';
import {
  applyAttentionAction,
  DaemonAttentionClient,
  fetchAttentionCount,
  fetchAttentionSnapshot,
} from '../../src/lib/attention-client.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { DaemonResponseError } from '../../src/lib/runtime-models.ts';

const daemonA = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceToken: 'token-a' });
const daemonB = daemonConnection({ daemonId: 'daemon-b', baseUrl: 'https://b.example.test', deviceToken: 'token-b' });
const scopeA = daemonSessionScope(daemonA, 'same/session');
const scopeB = daemonSessionScope(daemonB, 'same/session');

const snapshot = (sessionId: string, updatedAt = '2026-07-31T00:00:00.000Z', count = 0) => ({
  v: 1,
  sessionId,
  items: Array.from({ length: count }, (_, index) => ({
    id: `A${index + 1}`,
    source: 'question',
    sourceRef: null,
    subject: `Question ${index + 1}`,
    why: 'A decision is needed.',
    waitingSince: '2026-07-31T00:00:00.000Z',
    howToResolve: 'Choose an option.',
    raisedBy: 'human',
    raisedBySession: null,
    raisedByName: null,
  })),
  resolved: [],
  count,
  parseErrors: 0,
  updatedAt,
});

const response = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
};

describe('attention transport', () => {
  it('binds board, derived badge, and mutation requests to the paired daemon', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), init: init ?? {} });
      return calls.length === 1
        ? response(snapshot('same/session'))
        : calls.length === 2
          ? response(snapshot('same/session', '2026-07-31T00:30:00.000Z', 3))
          : response(snapshot('same/session', '2026-07-31T01:00:00.000Z'));
    };

    should((await fetchAttentionSnapshot(daemonA, scopeA, fetcher)).sessionId).equal('same/session');
    should((await fetchAttentionCount(daemonA, scopeA, fetcher)).count).equal(3);
    await applyAttentionAction(daemonA, scopeA, { action: 'dismiss', id: 'A1', note: 'stale' }, fetcher);

    should(calls.map(call => call.url)).deepEqual([
      'https://a.example.test/v1/sessions/same%2Fsession/attention',
      'https://a.example.test/v1/sessions/same%2Fsession/attention',
      'https://a.example.test/v1/sessions/same%2Fsession/attention',
    ]);
    should(new Headers(calls[2]?.init.headers).get('authorization')).equal('Bearer token-a');
    should(new Headers(calls[2]?.init.headers).get('content-type')).equal('application/json');
    should(new Headers(calls[2]?.init.headers).get('x-fy-request-id')).not.be.empty();
    should(calls[2]?.init.method).equal('POST');
    should(JSON.parse(String(calls[2]?.init.body))).deepEqual({ action: 'dismiss', id: 'A1', note: 'stale' });
  });

  it('rejects mismatched scopes, malformed responses, and daemon failures', async () => {
    await should(
      fetchAttentionSnapshot(daemonA, scopeB, async () => response(snapshot('same/session'))),
    ).be.rejectedWith('attention scope must belong to the requested daemon');
    await should(fetchAttentionSnapshot(daemonA, scopeA, async () => response(snapshot('other')))).be.rejectedWith(
      'daemon returned another session',
    );
    await should(
      fetchAttentionCount(daemonA, scopeA, async () => response({ sessionId: 'same/session', count: -1 })),
    ).be.rejected();
    const failure = fetchAttentionSnapshot(daemonA, scopeA, async () =>
      response({ error: 'offline', code: 'offline' }, 503),
    );
    await should(failure).be.rejectedWith('offline');
    await failure.catch(error => {
      should(error).be.instanceOf(DaemonResponseError);
      should((error as DaemonResponseError).code).equal('offline');
    });
  });
});

describe('DaemonAttentionClient', () => {
  it('coalesces only one daemon/session and publishes reversed completions independently', async () => {
    const a = deferred<Response>();
    const b = deferred<Response>();
    let calls = 0;
    const client = new DaemonAttentionClient(undefined, async input => {
      calls += 1;
      return String(input).startsWith('https://a.') ? a.promise : b.promise;
    });

    const first = client.hydrate(daemonA, scopeA);
    const same = client.hydrate(daemonA, scopeA);
    const other = client.hydrate(daemonB, scopeB);
    should(first).equal(same);
    should(calls).equal(2);

    b.resolve(response(snapshot('same/session', '2026-07-31T02:00:00.000Z')));
    await other;
    a.resolve(response(snapshot('same/session', '2026-07-31T01:00:00.000Z')));
    await first;

    should(client.store.attention(scopeA)?.updatedAt).equal('2026-07-31T01:00:00.000Z');
    should(client.store.attention(scopeB)?.updatedAt).equal('2026-07-31T02:00:00.000Z');
  });

  it('revalidates a ready board while coalescing every overlapping full-board read', async () => {
    const refreshed = deferred<Response>();
    let calls = 0;
    const client = new DaemonAttentionClient(undefined, async () => {
      calls += 1;
      return calls === 1 ? response(snapshot('same/session')) : refreshed.promise;
    });

    await client.hydrate(daemonA, scopeA);
    const first = client.revalidate(daemonA, scopeA);
    const same = client.revalidate(daemonA, scopeA);
    const hydration = client.hydrate(daemonA, scopeA);

    should(first).equal(same);
    should(first).equal(hydration);
    should(calls).equal(2);
    should(client.store.status(scopeA)).equal('ready');

    refreshed.resolve(response(snapshot('same/session', '2026-07-31T01:00:00.000Z', 1)));
    await first;
    should(client.store.count(scopeA)).equal(1);
    should(client.store.attention(scopeA)?.updatedAt).equal('2026-07-31T01:00:00.000Z');
  });

  it('keeps badge hydration distinct from full readiness and leaves failures unknown', async () => {
    const responses = [
      response(snapshot('same/session', '2026-07-31T00:30:00.000Z', 4)),
      response(snapshot('same/session')),
    ];
    const client = new DaemonAttentionClient(undefined, async () => {
      const next = responses.shift();
      if (next === undefined) throw new Error('unexpected request');
      return next;
    });

    await client.hydrateCount(daemonA, scopeA);
    should(client.store.count(scopeA)).equal(4);
    should(client.store.status(scopeA)).equal('idle');
    await client.hydrate(daemonA, scopeA);
    should(client.store.status(scopeA)).equal('ready');

    const fresh = daemonSessionScope(daemonA, 'badge-failure');
    const failed = new DaemonAttentionClient(undefined, async () => response({ error: 'down' }, 503));
    await should(failed.hydrateCount(daemonA, fresh)).be.rejectedWith('down');
    should(failed.store.count(fresh)).be.undefined();
    should(failed.store.status(fresh)).equal('idle');
  });

  it('applies resolve, structured response, and dismiss through authoritative snapshots', async () => {
    const actions: unknown[] = [];
    const client = new DaemonAttentionClient(undefined, async (_input, init) => {
      actions.push(JSON.parse(String(init?.body)));
      return response(snapshot('same/session'));
    });
    const answer: AttentionResponse = { kind: 'permission', decision: 'approve' };

    await client.resolve(daemonA, scopeA, 'A1', 'done');
    await client.respond(daemonA, scopeA, 'A2', answer);
    await client.dismiss(daemonA, scopeA, 'A3');

    should(actions).deepEqual([
      { action: 'resolve', id: 'A1', note: 'done' },
      { action: 'resolve', id: 'A2', response: answer },
      { action: 'dismiss', id: 'A3' },
    ]);
    should(client.store.status(scopeA)).equal('ready');
  });

  it('marks a current full load or mutation as errored when its daemon request fails', async () => {
    const client = new DaemonAttentionClient(undefined, async () => response({ error: 'down' }, 503));

    await should(client.hydrate(daemonA, scopeA)).be.rejectedWith('down');
    should(client.store.status(scopeA)).equal('error');
    await should(client.dismiss(daemonA, scopeA, 'A1')).be.rejectedWith('down');
    should(client.store.status(scopeA)).equal('error');
  });

  it('does not let an older load overwrite a later mutation', async () => {
    const load = deferred<Response>();
    const mutation = deferred<Response>();
    const client = new DaemonAttentionClient(undefined, async (_input, init) =>
      init?.method === 'POST' ? mutation.promise : load.promise,
    );

    const loading = client.hydrate(daemonA, scopeA);
    const dismissing = client.dismiss(daemonA, scopeA, 'A1');
    mutation.resolve(response(snapshot('same/session', '2026-07-31T02:00:00.000Z', 2)));
    await dismissing;
    load.resolve(response(snapshot('same/session', '2026-07-31T01:00:00.000Z', 1)));
    await loading;

    should(client.store.attention(scopeA)?.updatedAt).equal('2026-07-31T02:00:00.000Z');
    should(client.store.count(scopeA)).equal(2);
  });

  it('does not let an in-flight revalidation overwrite a later mutation', async () => {
    const refresh = deferred<Response>();
    const mutation = deferred<Response>();
    let calls = 0;
    const client = new DaemonAttentionClient(undefined, async (_input, init) => {
      calls += 1;
      if (calls === 1) return response(snapshot('same/session'));
      return init?.method === 'POST' ? mutation.promise : refresh.promise;
    });

    await client.hydrate(daemonA, scopeA);
    const refreshing = client.revalidate(daemonA, scopeA);
    const dismissing = client.dismiss(daemonA, scopeA, 'A1');
    mutation.resolve(response(snapshot('same/session', '2026-07-31T03:00:00.000Z', 2)));
    await dismissing;
    refresh.resolve(response(snapshot('same/session', '2026-07-31T02:00:00.000Z', 1)));
    await refreshing;

    should(client.store.attention(scopeA)?.updatedAt).equal('2026-07-31T03:00:00.000Z');
    should(client.store.count(scopeA)).equal(2);
  });

  it('keeps the newest mutation when mutation responses settle in reverse order', async () => {
    const firstResponse = deferred<Response>();
    const secondResponse = deferred<Response>();
    let calls = 0;
    const client = new DaemonAttentionClient(undefined, async () => {
      calls += 1;
      return calls === 1 ? firstResponse.promise : secondResponse.promise;
    });

    const first = client.dismiss(daemonA, scopeA, 'A1');
    const second = client.resolve(daemonA, scopeA, 'A2');
    secondResponse.resolve(response(snapshot('same/session', '2026-07-31T03:00:00.000Z', 2)));
    await second;
    firstResponse.resolve(response(snapshot('same/session', '2026-07-31T02:00:00.000Z', 1)));
    await first;

    should(client.store.attention(scopeA)?.updatedAt).equal('2026-07-31T03:00:00.000Z');
    should(client.store.count(scopeA)).equal(2);
  });

  it('does not let an older count disagree with a later full snapshot', async () => {
    const count = deferred<Response>();
    const full = deferred<Response>();
    let calls = 0;
    const client = new DaemonAttentionClient(undefined, async () => {
      calls += 1;
      return calls === 1 ? count.promise : full.promise;
    });

    const counting = client.hydrateCount(daemonA, scopeA);
    const loading = client.hydrate(daemonA, scopeA);
    full.resolve(response(snapshot('same/session', '2026-07-31T03:00:00.000Z', 2)));
    await loading;
    count.resolve(response(snapshot('same/session', '2026-07-31T02:00:00.000Z', 1)));
    await counting;

    should(client.store.attention(scopeA)?.count).equal(2);
    should(client.store.count(scopeA)).equal(2);
    should(client.store.status(scopeA)).equal('ready');
  });

  it('keeps a full board authoritative when a later count completes first', async () => {
    const full = deferred<Response>();
    const count = deferred<Response>();
    let calls = 0;
    const client = new DaemonAttentionClient(undefined, async () => {
      calls += 1;
      return calls === 1 ? full.promise : count.promise;
    });

    const loading = client.hydrate(daemonA, scopeA);
    const counting = client.hydrateCount(daemonA, scopeA);
    count.resolve(response(snapshot('same/session', '2026-07-31T02:00:00.000Z', 1)));
    await counting;
    full.resolve(response(snapshot('same/session', '2026-07-31T03:00:00.000Z', 2)));
    await loading;

    should(client.store.attention(scopeA)?.updatedAt).equal('2026-07-31T03:00:00.000Z');
    should(client.store.count(scopeA)).equal(2);
    should(client.store.status(scopeA)).equal('ready');
  });

  it('keeps a full board authoritative when a later count completes last', async () => {
    const full = deferred<Response>();
    const count = deferred<Response>();
    let calls = 0;
    const client = new DaemonAttentionClient(undefined, async () => {
      calls += 1;
      return calls === 1 ? full.promise : count.promise;
    });

    const loading = client.hydrate(daemonA, scopeA);
    const counting = client.hydrateCount(daemonA, scopeA);
    full.resolve(response(snapshot('same/session', '2026-07-31T03:00:00.000Z', 2)));
    await loading;
    count.resolve(response(snapshot('same/session', '2026-07-31T02:00:00.000Z', 1)));
    await counting;

    should(client.store.attention(scopeA)?.updatedAt).equal('2026-07-31T03:00:00.000Z');
    should(client.store.count(scopeA)).equal(2);
    should(client.store.status(scopeA)).equal('ready');
  });

  it('keeps a mutation authoritative when a later count completes first', async () => {
    const mutation = deferred<Response>();
    const count = deferred<Response>();
    const client = new DaemonAttentionClient(undefined, async (_input, init) =>
      init?.method === 'POST' ? mutation.promise : count.promise,
    );

    const mutating = client.dismiss(daemonA, scopeA, 'A1');
    const counting = client.hydrateCount(daemonA, scopeA);
    count.resolve(response(snapshot('same/session', '2026-07-31T02:00:00.000Z', 1)));
    await counting;
    mutation.resolve(response(snapshot('same/session', '2026-07-31T03:00:00.000Z', 2)));
    await mutating;

    should(client.store.attention(scopeA)?.updatedAt).equal('2026-07-31T03:00:00.000Z');
    should(client.store.count(scopeA)).equal(2);
    should(client.store.status(scopeA)).equal('ready');
  });

  it('keeps a mutation authoritative when a later count completes last', async () => {
    const mutation = deferred<Response>();
    const count = deferred<Response>();
    const client = new DaemonAttentionClient(undefined, async (_input, init) =>
      init?.method === 'POST' ? mutation.promise : count.promise,
    );

    const mutating = client.dismiss(daemonA, scopeA, 'A1');
    const counting = client.hydrateCount(daemonA, scopeA);
    mutation.resolve(response(snapshot('same/session', '2026-07-31T03:00:00.000Z', 2)));
    await mutating;
    count.resolve(response(snapshot('same/session', '2026-07-31T02:00:00.000Z', 1)));
    await counting;

    should(client.store.attention(scopeA)?.updatedAt).equal('2026-07-31T03:00:00.000Z');
    should(client.store.count(scopeA)).equal(2);
    should(client.store.status(scopeA)).equal('ready');
  });

  it('rejects a stale count request after re-pairing without publishing it', async () => {
    const oldCount = deferred<Response>();
    const rotated = daemonConnection({
      daemonId: 'daemon-a',
      baseUrl: 'https://new-a.example.test',
      deviceToken: 'new-token',
    });
    const rotatedScope = daemonSessionScope(rotated, 'same/session');
    const client = new DaemonAttentionClient(undefined, async input =>
      String(input).startsWith('https://new-a.')
        ? response(snapshot('same/session', '2026-07-31T03:00:00.000Z', 2))
        : oldCount.promise,
    );

    const stale = client.hydrateCount(daemonA, scopeA);
    const rejected = should(stale).be.rejectedWith('old count failed');
    await client.hydrateCount(rotated, rotatedScope);
    oldCount.reject(new Error('old count failed'));
    await rejected;

    should(client.store.count(rotatedScope)).equal(2);
    should(client.store.status(rotatedScope)).equal('idle');
  });

  it('fences old work across unpair and same-id re-pair without touching another daemon', async () => {
    const old = deferred<Response>();
    const fresh = deferred<Response>();
    const other = deferred<Response>();
    const rotated = daemonConnection({
      daemonId: 'daemon-a',
      baseUrl: 'https://new-a.example.test',
      deviceToken: 'new-token',
    });
    const rotatedScope = daemonSessionScope(rotated, 'same/session');
    const client = new DaemonAttentionClient(undefined, async input => {
      const url = String(input);
      if (url.startsWith('https://new-a.')) return fresh.promise;
      if (url.startsWith('https://b.')) return other.promise;
      return old.promise;
    });

    const oldLoad = client.hydrate(daemonA, scopeA);
    const bLoad = client.hydrate(daemonB, scopeB);
    const newLoad = client.hydrate(rotated, rotatedScope);
    old.resolve(response(snapshot('same/session', '2026-07-31T01:00:00.000Z')));
    other.resolve(response(snapshot('same/session', '2026-07-31T02:00:00.000Z')));
    fresh.resolve(response(snapshot('same/session', '2026-07-31T03:00:00.000Z')));
    await Promise.all([oldLoad, bLoad, newLoad]);

    should(client.store.attention(rotatedScope)?.updatedAt).equal('2026-07-31T03:00:00.000Z');
    should(client.store.attention(scopeB)?.updatedAt).equal('2026-07-31T02:00:00.000Z');
    client.clearDaemon(rotated.daemonId);
    should(client.store.attention(rotatedScope)).be.undefined();
    should(client.store.attention(scopeB)).not.be.undefined();
  });
});
