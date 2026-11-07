import { describe, it } from 'bun:test';
import { type AgendaResponse, MACHINE_AGENDA_ID } from '../../../app/wire/index.ts';
import should from 'should';
import {
  AGENDA_READS_PER_DAEMON,
  applyAgendaAction,
  DaemonAgendaClient,
  fetchAgendaConversation,
  fetchAgendaCount,
  fetchAgendaSnapshot,
  fetchAgendaVersion,
  fetchAgendaVersions,
  MAX_CONVERSATION_FRAGMENTS,
  markAgendaVersionSeen,
  sendAgendaReplies,
} from '../../../app/lib/agenda-client.ts';
import { daemonConnection } from '../../../app/shell.ts';
import { daemonSessionScope } from '../../../app/shell.ts';
import { DaemonResponseError } from '../../../app/shell.ts';

const daemonA = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceId: 'token-a' });
const daemonB = daemonConnection({ daemonId: 'daemon-b', baseUrl: 'https://b.example.test', deviceId: 'token-b' });
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

/** Let queued continuations run. */
const tick = async (): Promise<void> => {
  for (let spin = 0; spin < 5; spin += 1) await new Promise(resolve => setTimeout(resolve, 0));
};

describe('attention transport', () => {
  it('refuses machine history, seen and replies without dialing a session alias', async () => {
    const machine = daemonSessionScope(daemonA, MACHINE_AGENDA_ID);
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return response({});
    };
    const operations = [
      () => fetchAgendaVersions(daemonA, machine, 'A1', fetcher),
      () => fetchAgendaVersion(daemonA, machine, 'A1', 1, fetcher),
      () => fetchAgendaConversation(daemonA, machine, 'A1', {}, fetcher),
      () => markAgendaVersionSeen(daemonA, machine, 'A1', 1, fetcher),
      () => sendAgendaReplies(daemonA, machine, fetcher),
      () => sendAgendaReplies(daemonA, machine, fetcher),
    ];
    for (const operation of operations)
      await should(operation()).be.rejectedWith(/unavailable on \/v1\/machine\/agenda/u);
    should(calls).equal(0);
  });
  it('should opt into the channel on Send now and retain its request identity', async () => {
    await sendAgendaReplies(daemonA, scopeA, async (_input, init) => {
      should(new Headers(init?.headers).get('x-fy-agenda-channel')).equal('2');
      should(new Headers(init?.headers).get('x-fy-request-id')).not.be.empty();
      return response(snapshot(scopeA.sessionId));
    });
  });
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

    should((await fetchAgendaSnapshot(daemonA, scopeA, fetcher)).sessionId).equal('same/session');
    should((await fetchAgendaCount(daemonA, scopeA, fetcher)).count).equal(3);
    await applyAgendaAction(daemonA, scopeA, { action: 'dismiss', id: 'A1', note: 'stale' }, fetcher);

    should(calls.map(call => call.url)).deepEqual([
      'https://a.example.test/v1/ferrets/same%2Fsession/agenda',
      'https://a.example.test/v1/ferrets/same%2Fsession/agenda',
      'https://a.example.test/v1/ferrets/same%2Fsession/agenda',
    ]);
    should(new Headers(calls[2]?.init.headers).has('authorization')).be.false();
    should(new Headers(calls[2]?.init.headers).get('content-type')).equal('application/json');
    should(new Headers(calls[2]?.init.headers).get('x-fy-request-id')).not.be.empty();
    should(calls[2]?.init.method).equal('POST');
    for (const call of calls) should(new Headers(call.init.headers).get('x-fy-agenda-channel')).equal('2');
    should(JSON.parse(String(calls[2]?.init.body))).deepEqual({ action: 'dismiss', id: 'A1', note: 'stale' });
  });

  it('dials the machine agenda for the machine-agenda scope', async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), method: init?.method });
      return response(snapshot('machine-agenda'));
    };
    const machine = daemonSessionScope(daemonA, 'machine-agenda');

    await fetchAgendaSnapshot(daemonA, machine, fetcher);
    await applyAgendaAction(daemonA, machine, { action: 'dismiss', id: 'A1' }, fetcher);

    should(calls).deepEqual([
      { url: 'https://a.example.test/v1/machine/agenda', method: 'GET' },
      { url: 'https://a.example.test/v1/machine/agenda', method: 'POST' },
    ]);
  });

  it('rejects mismatched scopes, malformed responses, and daemon failures', async () => {
    await should(fetchAgendaSnapshot(daemonA, scopeB, async () => response(snapshot('same/session')))).be.rejectedWith(
      'attention scope must belong to the requested daemon',
    );
    await should(fetchAgendaSnapshot(daemonA, scopeA, async () => response(snapshot('other')))).be.rejectedWith(
      'daemon returned another session',
    );
    await should(
      fetchAgendaCount(daemonA, scopeA, async () => response({ sessionId: 'same/session', count: -1 })),
    ).be.rejected();
    const failure = fetchAgendaSnapshot(daemonA, scopeA, async () =>
      response({ error: 'offline', code: 'offline' }, 503),
    );
    await should(failure).be.rejectedWith('offline');
    await failure.catch(error => {
      should(error).be.instanceOf(DaemonResponseError);
      should((error as DaemonResponseError).code).equal('offline');
    });
  });
});

describe('DaemonAgendaClient', () => {
  it('coalesces only one daemon/session and publishes reversed completions independently', async () => {
    const a = deferred<Response>();
    const b = deferred<Response>();
    let calls = 0;
    const client = new DaemonAgendaClient(undefined, async input => {
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

    should(client.store.agenda(scopeA)?.updatedAt).equal('2026-07-31T01:00:00.000Z');
    should(client.store.agenda(scopeB)?.updatedAt).equal('2026-07-31T02:00:00.000Z');
  });

  it('revalidates a ready board while coalescing every overlapping full-board read', async () => {
    const refreshed = deferred<Response>();
    let calls = 0;
    const client = new DaemonAgendaClient(undefined, async () => {
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
    should(client.store.agenda(scopeA)?.updatedAt).equal('2026-07-31T01:00:00.000Z');
  });

  it('keeps badge hydration distinct from full readiness and leaves failures unknown', async () => {
    const responses = [
      response(snapshot('same/session', '2026-07-31T00:30:00.000Z', 4)),
      response(snapshot('same/session')),
    ];
    const client = new DaemonAgendaClient(undefined, async () => {
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
    const failed = new DaemonAgendaClient(undefined, async () => response({ error: 'down' }, 503));
    await should(failed.hydrateCount(daemonA, fresh)).be.rejectedWith('down');
    should(failed.store.count(fresh)).be.undefined();
    should(failed.store.status(fresh)).equal('idle');
  });

  it('applies resolve, structured response, and dismiss through authoritative snapshots', async () => {
    const actions: unknown[] = [];
    const client = new DaemonAgendaClient(undefined, async (_input, init) => {
      actions.push(JSON.parse(String(init?.body)));
      return response(snapshot('same/session'));
    });
    const answer: AgendaResponse = { kind: 'permission', decision: 'approve' };

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

  it("sends the gate mark on an answer to a thread's attached gate", async () => {
    const actions: unknown[] = [];
    const client = new DaemonAgendaClient(undefined, async (_input, init) => {
      actions.push(JSON.parse(String(init?.body)));
      return response(snapshot('same/session'));
    });
    const choice: AgendaResponse = { kind: 'multiple-choice', choice: 'Done' };

    await client.respond(daemonA, scopeA, 'A2', choice, 'ok', true);

    should(actions).deepEqual([{ action: 'resolve', id: 'A2', response: choice, note: 'ok', gate: true }]);
  });

  it('names the ask version an answer was given to', async () => {
    const actions: unknown[] = [];
    const client = new DaemonAgendaClient(undefined, async (_input, init) => {
      actions.push(JSON.parse(String(init?.body)));
      return response(snapshot('same/session'));
    });
    const choice: AgendaResponse = { kind: 'multiple-choice', choice: 'EU' };

    await client.respond(daemonA, scopeA, 'A1', choice);
    await client.respond(daemonA, scopeA, 'A1', choice, undefined, undefined, undefined, 1);
    await client.respond(daemonA, scopeA, 'A1', choice, undefined, undefined, undefined, 2);

    should(actions).deepEqual([
      { action: 'resolve', id: 'A1', response: choice },
      { action: 'resolve', id: 'A1', response: choice, askVersion: 1 },
      { action: 'resolve', id: 'A1', response: choice, askVersion: 2 },
    ]);
  });

  it('names the ask version a Done or a Skip was given from, and none when it names none', async () => {
    const actions: unknown[] = [];
    const client = new DaemonAgendaClient(undefined, async (_input, init) => {
      actions.push(JSON.parse(String(init?.body)));
      return response(snapshot('same/session'));
    });

    await client.resolve(daemonA, scopeA, 'A1', undefined, 1);
    await client.dismiss(daemonA, scopeA, 'A1', 'no', 2);
    await client.resolve(daemonA, scopeA, 'A1', 'ok');

    should(actions).deepEqual([
      { action: 'resolve', id: 'A1', askVersion: 1 },
      { action: 'dismiss', id: 'A1', note: 'no', askVersion: 2 },
      { action: 'resolve', id: 'A1', note: 'ok' },
    ]);
  });

  it('names the card ask an answer is to, and only for a gate answer', async () => {
    const actions: unknown[] = [];
    const client = new DaemonAgendaClient(undefined, async (_input, init) => {
      actions.push(JSON.parse(String(init?.body)));
      return response(snapshot('same/session'));
    });
    const choice: AgendaResponse = { kind: 'multiple-choice', choice: 'Done' };
    const reference = 'gate:F1:tested:2';

    await client.respond(daemonA, scopeA, 'A1', choice, undefined, true, undefined, undefined, reference);
    await client.respond(daemonA, scopeA, 'A1', choice, undefined, undefined, undefined, undefined, reference);

    should(actions).deepEqual([
      { action: 'resolve', id: 'A1', response: choice, gate: true, cardAsk: reference },
      { action: 'resolve', id: 'A1', response: choice },
    ]);
  });

  it('sends the files of a Not good with its answer, and none when there are none', async () => {
    const actions: unknown[] = [];
    const client = new DaemonAgendaClient(undefined, async (_input, init) => {
      actions.push(JSON.parse(String(init?.body)));
      return response(snapshot('same/session'));
    });
    const choice: AgendaResponse = { kind: 'multiple-choice', choice: 'Not good' };
    const attachments = { from: 'same', ids: [`att_${'a'.repeat(64)}`] };

    await client.respond(daemonA, scopeA, 'A2', choice, 'blank', undefined, attachments);

    should(actions).deepEqual([{ action: 'resolve', id: 'A2', response: choice, note: 'blank', attachments }]);
  });

  it('sends a snooze with its instant and an unsnooze alone', async () => {
    const actions: unknown[] = [];
    const client = new DaemonAgendaClient(undefined, async (_input, init) => {
      actions.push(JSON.parse(String(init?.body)));
      return response(snapshot('same/session'));
    });

    await client.snooze(daemonA, scopeA, 'A1', '2026-10-30T15:00:00.000Z');
    await client.unsnooze(daemonA, scopeA, 'A1');

    should(actions).deepEqual([
      { action: 'snooze', id: 'A1', until: '2026-10-30T15:00:00.000Z' },
      { action: 'unsnooze', id: 'A1' },
    ]);
  });

  it('marks a current full load or mutation as errored when its daemon request fails', async () => {
    const client = new DaemonAgendaClient(undefined, async () => response({ error: 'down' }, 503));

    await should(client.hydrate(daemonA, scopeA)).be.rejectedWith('down');
    should(client.store.status(scopeA)).equal('error');
    await should(client.dismiss(daemonA, scopeA, 'A1')).be.rejectedWith('down');
    should(client.store.status(scopeA)).equal('error');
  });

  it('does not let an older load overwrite a later mutation', async () => {
    const load = deferred<Response>();
    const mutation = deferred<Response>();
    const client = new DaemonAgendaClient(undefined, async (_input, init) =>
      init?.method === 'POST' ? mutation.promise : load.promise,
    );

    const loading = client.hydrate(daemonA, scopeA);
    const dismissing = client.dismiss(daemonA, scopeA, 'A1');
    mutation.resolve(response(snapshot('same/session', '2026-07-31T02:00:00.000Z', 2)));
    await dismissing;
    load.resolve(response(snapshot('same/session', '2026-07-31T01:00:00.000Z', 1)));
    await loading;

    should(client.store.agenda(scopeA)?.updatedAt).equal('2026-07-31T02:00:00.000Z');
    should(client.store.count(scopeA)).equal(2);
  });

  it('does not let an in-flight revalidation overwrite a later mutation', async () => {
    const refresh = deferred<Response>();
    const mutation = deferred<Response>();
    let calls = 0;
    const client = new DaemonAgendaClient(undefined, async (_input, init) => {
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

    should(client.store.agenda(scopeA)?.updatedAt).equal('2026-07-31T03:00:00.000Z');
    should(client.store.count(scopeA)).equal(2);
  });

  it('queues a revalidation behind an earlier mutation so a pre-action GET cannot win', async () => {
    const mutation = deferred<Response>();
    const staleRefresh = deferred<Response>();
    const freshRefresh = deferred<Response>();
    let initialized = false;
    let mutationCommitted = false;
    let refreshBeforeCommit = false;
    let refreshes = 0;
    const client = new DaemonAgendaClient(undefined, async (_input, init) => {
      if (init?.method === 'POST') {
        const result = await mutation.promise;
        mutationCommitted = true;
        return result;
      }
      if (!initialized) {
        initialized = true;
        return response(snapshot('same/session', '2026-07-31T01:00:00.000Z', 1));
      }
      refreshes += 1;
      if (!mutationCommitted) {
        refreshBeforeCommit = true;
        return staleRefresh.promise;
      }
      return freshRefresh.promise;
    });

    await client.hydrate(daemonA, scopeA);
    const mutating = client.dismiss(daemonA, scopeA, 'A1');
    const refreshing = client.revalidate(daemonA, scopeA);
    const sameRefresh = client.revalidate(daemonA, scopeA);
    should(refreshing).equal(sameRefresh);

    // This is the response the old implementation let arrive before the POST.
    // The coordinator keeps its GET from being issued, so resolving it cannot
    // advance the board revision or suppress the mutation's own snapshot.
    staleRefresh.resolve(response(snapshot('same/session', '2026-07-31T02:00:00.000Z', 1)));
    should(refreshBeforeCommit).be.false();
    mutation.resolve(response(snapshot('same/session', '2026-07-31T03:00:00.000Z')));
    await mutating;

    // Published as soon as the action returns, before the caller waits for the
    // queued refresh or that refresh publishes its later post-action board.
    should(client.store.agenda(scopeA)?.updatedAt).equal('2026-07-31T03:00:00.000Z');
    should(client.store.count(scopeA)).equal(0);

    freshRefresh.resolve(response(snapshot('same/session', '2026-07-31T04:00:00.000Z')));
    await refreshing;
    should(refreshes).equal(1);
    should(client.store.agenda(scopeA)?.updatedAt).equal('2026-07-31T04:00:00.000Z');
    should(client.store.count(scopeA)).equal(0);
  });

  it('releases queued revalidation after a rejected mutation without retaining either promise', async () => {
    const mutation = deferred<Response>();
    let initialized = false;
    let refreshes = 0;
    const client = new DaemonAgendaClient(undefined, async (_input, init) => {
      if (init?.method === 'POST') return mutation.promise;
      if (!initialized) {
        initialized = true;
        return response(snapshot('same/session', '2026-07-31T01:00:00.000Z', 1));
      }
      refreshes += 1;
      return response(snapshot('same/session', `2026-07-31T0${refreshes + 1}:00:00.000Z`, 2));
    });

    await client.hydrate(daemonA, scopeA);
    const mutating = client.dismiss(daemonA, scopeA, 'A1');
    const rejected = should(mutating).be.rejectedWith('action failed');
    const refreshing = client.revalidate(daemonA, scopeA);
    should(refreshes).equal(0);

    mutation.reject(new Error('action failed'));
    await rejected;
    await refreshing;
    should(refreshes).equal(1);
    should(client.store.status(scopeA)).equal('ready');
    should(client.store.agenda(scopeA)?.updatedAt).equal('2026-07-31T02:00:00.000Z');

    await client.revalidate(daemonA, scopeA);
    should(refreshes).equal(2);
    should(client.store.agenda(scopeA)?.updatedAt).equal('2026-07-31T03:00:00.000Z');
  });

  it('waits for every outstanding mutation while preserving reverse-completion authority', async () => {
    const firstResponse = deferred<Response>();
    const secondResponse = deferred<Response>();
    const mutations = [firstResponse, secondResponse];
    let initialized = false;
    let refreshes = 0;
    const client = new DaemonAgendaClient(undefined, async (_input, init) => {
      if (init?.method === 'POST') {
        const next = mutations.shift();
        if (next === undefined) throw new Error('unexpected mutation');
        return next.promise;
      }
      if (!initialized) {
        initialized = true;
        return response(snapshot('same/session', '2026-07-31T01:00:00.000Z', 2));
      }
      refreshes += 1;
      return response(snapshot('same/session', '2026-07-31T04:00:00.000Z'));
    });

    await client.hydrate(daemonA, scopeA);
    const first = client.dismiss(daemonA, scopeA, 'A1');
    const second = client.resolve(daemonA, scopeA, 'A2');
    const refreshing = client.revalidate(daemonA, scopeA);

    secondResponse.resolve(response(snapshot('same/session', '2026-07-31T03:00:00.000Z')));
    await second;
    should(client.store.agenda(scopeA)?.updatedAt).equal('2026-07-31T03:00:00.000Z');
    should(refreshes).equal(0);

    firstResponse.resolve(response(snapshot('same/session', '2026-07-31T02:00:00.000Z', 1)));
    await first;
    await refreshing;
    should(refreshes).equal(1);
    should(client.store.agenda(scopeA)?.updatedAt).equal('2026-07-31T04:00:00.000Z');
    should(client.store.count(scopeA)).equal(0);
  });

  it('keeps the newest mutation when mutation responses settle in reverse order', async () => {
    const firstResponse = deferred<Response>();
    const secondResponse = deferred<Response>();
    let calls = 0;
    const client = new DaemonAgendaClient(undefined, async () => {
      calls += 1;
      return calls === 1 ? firstResponse.promise : secondResponse.promise;
    });

    const first = client.dismiss(daemonA, scopeA, 'A1');
    const second = client.resolve(daemonA, scopeA, 'A2');
    secondResponse.resolve(response(snapshot('same/session', '2026-07-31T03:00:00.000Z', 2)));
    await second;
    firstResponse.resolve(response(snapshot('same/session', '2026-07-31T02:00:00.000Z', 1)));
    await first;

    should(client.store.agenda(scopeA)?.updatedAt).equal('2026-07-31T03:00:00.000Z');
    should(client.store.count(scopeA)).equal(2);
  });

  it('does not let an older count disagree with a later full snapshot', async () => {
    const count = deferred<Response>();
    const full = deferred<Response>();
    let calls = 0;
    const client = new DaemonAgendaClient(undefined, async () => {
      calls += 1;
      return calls === 1 ? count.promise : full.promise;
    });

    const counting = client.hydrateCount(daemonA, scopeA);
    const loading = client.hydrate(daemonA, scopeA);
    full.resolve(response(snapshot('same/session', '2026-07-31T03:00:00.000Z', 2)));
    await loading;
    count.resolve(response(snapshot('same/session', '2026-07-31T02:00:00.000Z', 1)));
    await counting;

    should(client.store.agenda(scopeA)?.count).equal(2);
    should(client.store.count(scopeA)).equal(2);
    should(client.store.status(scopeA)).equal('ready');
  });

  it('keeps a full board authoritative when a later count completes first', async () => {
    const full = deferred<Response>();
    const count = deferred<Response>();
    let calls = 0;
    const client = new DaemonAgendaClient(undefined, async () => {
      calls += 1;
      return calls === 1 ? full.promise : count.promise;
    });

    const loading = client.hydrate(daemonA, scopeA);
    const counting = client.hydrateCount(daemonA, scopeA);
    count.resolve(response(snapshot('same/session', '2026-07-31T02:00:00.000Z', 1)));
    await counting;
    full.resolve(response(snapshot('same/session', '2026-07-31T03:00:00.000Z', 2)));
    await loading;

    should(client.store.agenda(scopeA)?.updatedAt).equal('2026-07-31T03:00:00.000Z');
    should(client.store.count(scopeA)).equal(2);
    should(client.store.status(scopeA)).equal('ready');
  });

  it('keeps a full board authoritative when a later count completes last', async () => {
    const full = deferred<Response>();
    const count = deferred<Response>();
    let calls = 0;
    const client = new DaemonAgendaClient(undefined, async () => {
      calls += 1;
      return calls === 1 ? full.promise : count.promise;
    });

    const loading = client.hydrate(daemonA, scopeA);
    const counting = client.hydrateCount(daemonA, scopeA);
    full.resolve(response(snapshot('same/session', '2026-07-31T03:00:00.000Z', 2)));
    await loading;
    count.resolve(response(snapshot('same/session', '2026-07-31T02:00:00.000Z', 1)));
    await counting;

    should(client.store.agenda(scopeA)?.updatedAt).equal('2026-07-31T03:00:00.000Z');
    should(client.store.count(scopeA)).equal(2);
    should(client.store.status(scopeA)).equal('ready');
  });

  it('keeps a mutation authoritative when a later count completes first', async () => {
    const mutation = deferred<Response>();
    const count = deferred<Response>();
    const client = new DaemonAgendaClient(undefined, async (_input, init) =>
      init?.method === 'POST' ? mutation.promise : count.promise,
    );

    const mutating = client.dismiss(daemonA, scopeA, 'A1');
    const counting = client.hydrateCount(daemonA, scopeA);
    count.resolve(response(snapshot('same/session', '2026-07-31T02:00:00.000Z', 1)));
    await counting;
    mutation.resolve(response(snapshot('same/session', '2026-07-31T03:00:00.000Z', 2)));
    await mutating;

    should(client.store.agenda(scopeA)?.updatedAt).equal('2026-07-31T03:00:00.000Z');
    should(client.store.count(scopeA)).equal(2);
    should(client.store.status(scopeA)).equal('ready');
  });

  it('keeps a mutation authoritative when a later count completes last', async () => {
    const mutation = deferred<Response>();
    const count = deferred<Response>();
    const client = new DaemonAgendaClient(undefined, async (_input, init) =>
      init?.method === 'POST' ? mutation.promise : count.promise,
    );

    const mutating = client.dismiss(daemonA, scopeA, 'A1');
    const counting = client.hydrateCount(daemonA, scopeA);
    mutation.resolve(response(snapshot('same/session', '2026-07-31T03:00:00.000Z', 2)));
    await mutating;
    count.resolve(response(snapshot('same/session', '2026-07-31T02:00:00.000Z', 1)));
    await counting;

    should(client.store.agenda(scopeA)?.updatedAt).equal('2026-07-31T03:00:00.000Z');
    should(client.store.count(scopeA)).equal(2);
    should(client.store.status(scopeA)).equal('ready');
  });

  it('rejects a stale count request after re-pairing without publishing it', async () => {
    const oldCount = deferred<Response>();
    const rotated = daemonConnection({
      daemonId: 'daemon-a',
      baseUrl: 'https://new-a.example.test',
      deviceId: 'new-token',
    });
    const rotatedScope = daemonSessionScope(rotated, 'same/session');
    const client = new DaemonAgendaClient(undefined, async input =>
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
      deviceId: 'new-token',
    });
    const rotatedScope = daemonSessionScope(rotated, 'same/session');
    const client = new DaemonAgendaClient(undefined, async input => {
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

    should(client.store.agenda(rotatedScope)?.updatedAt).equal('2026-07-31T03:00:00.000Z');
    should(client.store.agenda(scopeB)?.updatedAt).equal('2026-07-31T02:00:00.000Z');
    client.clearDaemon(rotated.daemonId);
    should(client.store.agenda(rotatedScope)).be.undefined();
    should(client.store.agenda(scopeB)).not.be.undefined();
  });

  it('clears a mutation-queued revalidation across same-id re-pair before it can issue transport', async () => {
    const oldMutation = deferred<Response>();
    const rotated = daemonConnection({
      daemonId: 'daemon-a',
      baseUrl: 'https://new-a.example.test',
      deviceId: 'new-token',
    });
    const rotatedScope = daemonSessionScope(rotated, 'same/session');
    let oldInitialized = false;
    let oldRefreshes = 0;
    const client = new DaemonAgendaClient(undefined, async (input, init) => {
      if (String(input).startsWith('https://new-a.')) {
        return response(snapshot('same/session', '2026-07-31T04:00:00.000Z', 2));
      }
      if (init?.method === 'POST') return oldMutation.promise;
      if (!oldInitialized) {
        oldInitialized = true;
        return response(snapshot('same/session', '2026-07-31T01:00:00.000Z', 1));
      }
      oldRefreshes += 1;
      return response(snapshot('same/session', '2026-07-31T03:00:00.000Z', 1));
    });

    await client.hydrate(daemonA, scopeA);
    const mutating = client.dismiss(daemonA, scopeA, 'A1');
    const queued = client.revalidate(daemonA, scopeA);
    await client.hydrate(rotated, rotatedScope);

    oldMutation.resolve(response(snapshot('same/session', '2026-07-31T02:00:00.000Z')));
    await Promise.all([mutating, queued]);
    should(oldRefreshes).equal(0);
    should(client.store.agenda(rotatedScope)?.updatedAt).equal('2026-07-31T04:00:00.000Z');
    should(client.store.count(rotatedScope)).equal(2);
  });
});

describe('the agenda transport', () => {
  const recorder = () => {
    const calls: Array<{ url: string; method: string | undefined }> = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), method: init?.method });
      return response(snapshot('same/session'));
    };
    return { calls, fetcher };
  };

  it('dials the agenda routes for board, badge, mutation and send-now ; always the agenda routes', async () => {
    const { calls, fetcher } = recorder();

    await fetchAgendaSnapshot(daemonA, scopeA, fetcher);
    await fetchAgendaCount(daemonA, scopeA, fetcher);
    await applyAgendaAction(daemonA, scopeA, { action: 'dismiss', id: 'A1' }, fetcher);
    await sendAgendaReplies(daemonA, scopeA, fetcher);

    should(calls).deepEqual([
      { url: 'https://a.example.test/v1/ferrets/same%2Fsession/agenda', method: undefined },
      { url: 'https://a.example.test/v1/ferrets/same%2Fsession/agenda', method: undefined },
      { url: 'https://a.example.test/v1/ferrets/same%2Fsession/agenda', method: 'POST' },
      { url: 'https://a.example.test/v1/ferrets/same%2Fsession/agenda/replies', method: 'POST' },
    ]);
  });
});

describe('DaemonAgendaClient reading many boards', () => {
  it('asks one daemon for a few boards at a time, in order, without holding another daemon behind it', async () => {
    // The inbox reads a board for every session with an open item. Fired at once, that burst ended the
    // relay session every panel shares (`4400`); bounded, every board still arrives.
    const gates: ReturnType<typeof deferred<Response>>[] = [];
    const asked: string[] = [];
    let inFlight = 0;
    let peak = 0;
    const client = new DaemonAgendaClient(undefined, async input => {
      const url = String(input);
      if (url.startsWith('https://b.')) return response(snapshot('same/session'));
      asked.push(url);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      const gate = deferred<Response>();
      gates.push(gate);
      const answer = await gate.promise;
      inFlight -= 1;
      return answer;
    });
    const sessions = Array.from({ length: 40 }, (_, index) => `s${index}`);
    const reads = sessions.map(id => client.revalidate(daemonA, daemonSessionScope(daemonA, id)));
    await client.revalidate(daemonB, scopeB);
    await tick();
    should(asked).have.length(AGENDA_READS_PER_DAEMON);
    for (const [index, id] of sessions.entries()) {
      while (gates.length <= index) await tick();
      gates[index]?.resolve(response(snapshot(id)));
    }
    await Promise.all(reads);
    should(peak).equal(AGENDA_READS_PER_DAEMON);
    should(asked).deepEqual(sessions.map(id => `https://a.example.test/v1/ferrets/${id}/agenda`));
    should(client.store.agenda(daemonSessionScope(daemonA, 's39'))?.sessionId).equal('s39');
  });

  it('frees a slot when a board read fails', async () => {
    let calls = 0;
    const client = new DaemonAgendaClient(undefined, async () => {
      calls += 1;
      return calls <= AGENDA_READS_PER_DAEMON ? response({ error: 'down' }, 503) : response(snapshot('last'));
    });
    const failing = Array.from({ length: AGENDA_READS_PER_DAEMON }, (_, index) =>
      client.revalidate(daemonA, daemonSessionScope(daemonA, `s${index}`)).catch(() => 'failed'),
    );
    await client.revalidate(daemonA, daemonSessionScope(daemonA, 'last'));
    should(await Promise.all(failing)).deepEqual(Array.from({ length: AGENDA_READS_PER_DAEMON }, () => 'failed'));
    should(client.store.agenda(daemonSessionScope(daemonA, 'last'))?.sessionId).equal('last');
  });

  it('sends nothing for a board read still waiting for a slot when its machine is unpaired', async () => {
    const gates: ReturnType<typeof deferred<Response>>[] = [];
    const asked: string[] = [];
    const client = new DaemonAgendaClient(undefined, async input => {
      asked.push(String(input));
      const gate = deferred<Response>();
      gates.push(gate);
      return await gate.promise;
    });
    const reads = Array.from({ length: AGENDA_READS_PER_DAEMON + 1 }, (_, index) =>
      client.revalidate(daemonA, daemonSessionScope(daemonA, `s${index}`)),
    );
    await tick();
    should(asked).have.length(AGENDA_READS_PER_DAEMON);
    client.clearDaemon(daemonA.daemonId);
    for (const [index, gate] of gates.entries()) gate.resolve(response(snapshot(`s${index}`)));
    await Promise.allSettled(reads);
    should(asked).have.length(AGENDA_READS_PER_DAEMON);
    should(client.store.agenda(daemonSessionScope(daemonA, 's0'))).be.undefined();
  });
});

describe('item versions', () => {
  it('lists the versions of an item from the item’s own path, with this device’s last seen', async () => {
    const asked: Array<{ url: string; method: string | undefined }> = [];
    const list = {
      sessionId: 'same/session',
      id: 'A1',
      latest: 2,
      seen: 1,
      versions: [
        { version: 1, at: '2026-07-31T00:00:00.000Z', by: 'ferret', change: 'created', lifecycle: 'active' },
        { version: 2, at: '2026-07-31T00:01:00.000Z', by: 'owner', change: 'replied', lifecycle: 'active' },
      ],
    };

    const got = await fetchAgendaVersions(daemonA, scopeA, 'A1', async (input, init) => {
      asked.push({ url: String(input), method: init?.method });
      return response(list);
    });

    should(got).deepEqual(list);
    should(asked).deepEqual([
      { url: 'https://a.example.test/v1/ferrets/same%2Fsession/agenda/A1/versions', method: 'GET' },
    ]);
  });

  it('fetches one version in full, and marks a version seen with a PUT that answers the mark that stands', async () => {
    const asked: Array<{ url: string; method: string | undefined; body: unknown }> = [];
    const version = {
      version: 2,
      at: '2026-07-31T00:01:00.000Z',
      by: 'owner',
      change: 'replied',
      lifecycle: 'active',
      item: snapshot('same/session', undefined, 1).items[0],
    };
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      asked.push({ url: String(input), method: init?.method, body: init?.body });
      return String(input).endsWith('/seen') ? response({ seen: 3 }) : response(version);
    };

    const got = await fetchAgendaVersion(daemonA, scopeA, 'A1', 2, fetcher);
    const mark = await markAgendaVersionSeen(daemonA, scopeA, 'A1', 2, fetcher);

    should(got.version).equal(2);
    should(mark).equal(3);
    should(asked.map(each => [each.method, each.url.replace('https://a.example.test', '')])).deepEqual([
      ['GET', '/v1/ferrets/same%2Fsession/agenda/A1/versions/2'],
      ['PUT', '/v1/ferrets/same%2Fsession/agenda/A1/seen'],
    ]);
    should(asked[1]?.body).equal(JSON.stringify({ version: 2 }));
  });
});

describe('merging agendas', () => {
  it('sends a merge', async () => {
    const actions: unknown[] = [];
    const client = new DaemonAgendaClient(undefined, async (_input, init) => {
      actions.push(JSON.parse(String(init?.body)));
      return response(snapshot('same/session'));
    });

    await client.merge(daemonA, scopeA, 'A2', 'A5');

    should(actions).deepEqual([{ action: 'merge', id: 'A2', from: 'A5' }]);
  });
});

describe('the whole stored conversation', () => {
  const at = '2026-11-01T10:00:00.000Z';
  const entry = (text: string) => ({ at, by: 'owner', text, via: 'reply' });

  it('reads every fragment through the cursor and joins an entry that arrived in pieces', async () => {
    const asked: string[] = [];
    const pages: Record<string, unknown> = {
      'index=0&offset=0': { total: 2, index: 0, offset: 0, entry: entry('Hello, '), next: { index: 0, offset: 7 } },
      'index=0&offset=7': { total: 2, index: 0, offset: 7, entry: entry('world.'), next: { index: 1, offset: 0 } },
      'index=1&offset=0': { total: 2, index: 1, offset: 0, entry: entry('Second.') },
    };

    const got = await fetchAgendaConversation(daemonA, scopeA, 'A1', undefined, async input => {
      const url = String(input);
      asked.push(url.replace('https://a.example.test', ''));
      return response(pages[url.split('?')[1] ?? ''] ?? {});
    });

    should(got.entries.map(each => each.text)).deepEqual(['Hello, world.', 'Second.']);
    should(got.capped).equal(false);
    should(asked[0]).equal('/v1/ferrets/same%2Fsession/agenda/A1/conversation?index=0&offset=0');
  });

  it('reads a frozen earlier thread by its version, and a thread with no entries as empty', async () => {
    const asked: string[] = [];
    const got = await fetchAgendaConversation(daemonA, scopeA, 'A1', { version: 3 }, async input => {
      asked.push(String(input));
      return response({ total: 0, index: 0, offset: 0 });
    });

    should(got).deepEqual({ entries: [], capped: false });
    should(asked).have.length(1);
    should(asked[0]).containEql('version=3');
  });

  it('reads only the entries from where it starts to where it stops', async () => {
    const asked: string[] = [];
    const got = await fetchAgendaConversation(daemonA, scopeA, 'A1', { from: 2, until: 4 }, async input => {
      const url = new URL(String(input));
      asked.push(`${url.searchParams.get('index')}.${url.searchParams.get('offset')}`);
      const index = Number(url.searchParams.get('index'));
      return response({
        total: 6,
        index,
        offset: 0,
        entry: entry(`e${index}`),
        next: { index: index + 1, offset: 0 },
      });
    });

    should(asked).deepEqual(['2.0', '3.0']);
    should(got.entries.map(each => each.text)).deepEqual(['e2', 'e3']);
    should(got.capped).equal(false);
  });

  it('says it was capped, and gives only whole entries, when the thread is longer than one read takes', async () => {
    let calls = 0;
    const got = await fetchAgendaConversation(daemonA, scopeA, 'A1', undefined, async input => {
      calls += 1;
      const url = new URL(String(input));
      const index = Number(url.searchParams.get('index'));
      const offset = Number(url.searchParams.get('offset'));
      return response({ total: 3, index, offset, entry: entry('x'), next: { index, offset: offset + 1 } });
    });

    should(calls).equal(MAX_CONVERSATION_FRAGMENTS);
    should(got.capped).equal(true);
    should(got.entries).deepEqual([]);
  });
});
