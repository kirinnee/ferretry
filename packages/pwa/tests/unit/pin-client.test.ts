import { describe, expect, it } from 'bun:test';
import { FY_REQUEST_ID_HEADER, MAX_PIN_NOTE_LENGTH, type PinActionRequest } from '@ferretry/protocol';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import { applyPinAction, DaemonPinClient, fetchPinSnapshot, pinPath } from '../../src/lib/pin-client.ts';
import { DaemonResponseError } from '../../src/lib/runtime-models.ts';

const daemonA = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceToken: 'token-a' });
const daemonB = daemonConnection({ daemonId: 'daemon-b', baseUrl: 'https://b.example.test', deviceToken: 'token-b' });
const scopeA = daemonSessionScope(daemonA, 'same/session');
const scopeB = daemonSessionScope(daemonB, 'same/session');
const NOTE_ID = '11111111-1111-4111-8111-111111111111';

const snapshot = (sessionId: string, updatedAt = '2026-07-31T00:00:00.000Z', text = 'before') => ({
  v: 1,
  sessionId,
  pins: [
    {
      id: NOTE_ID,
      at: 1,
      kind: 'note' as const,
      text,
      by: 'human' as const,
      createdBy: null,
      createdByName: null,
    },
  ],
  updatedAt,
});

const response = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>(next => {
    resolve = next;
  });
  return { promise, resolve };
};

const firstNoteText = (client: DaemonPinClient, scope: typeof scopeA): string | undefined => {
  const pin = client.store.pins(scope)?.pins[0];
  return pin?.kind === 'note' ? pin.text : undefined;
};

describe('pin transport', () => {
  it('binds reads and mutations to the paired daemon with bearer auth and idempotency headers', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), init: init ?? {} });
      return response(snapshot('same/session'));
    };
    const action: PinActionRequest = { action: 'edit', id: NOTE_ID, text: 'after' };

    await fetchPinSnapshot(daemonA, scopeA, fetcher);
    await applyPinAction(daemonA, scopeA, action, fetcher);

    expect(pinPath(scopeA)).toBe('/v1/sessions/same%2Fsession/pins');
    expect(calls.map(call => call.url)).toEqual([
      'https://a.example.test/v1/sessions/same%2Fsession/pins',
      'https://a.example.test/v1/sessions/same%2Fsession/pins',
    ]);
    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe('Bearer token-a');
    expect(new Headers(calls[0]?.init.headers).get(FY_REQUEST_ID_HEADER)).toBeNull();
    expect(calls[0]?.init.credentials).toBe('include');
    expect(calls[1]?.init.method).toBe('POST');
    expect(new Headers(calls[1]?.init.headers).get('content-type')).toBe('application/json');
    expect(new Headers(calls[1]?.init.headers).get(FY_REQUEST_ID_HEADER)).toMatch(/^[0-9a-f-]{36}$/u);
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual(action);
  });

  it('rejects crossed scopes, invalid responses, mismatched sessions, and daemon errors', async () => {
    await expect(fetchPinSnapshot(daemonA, scopeB, async () => response(snapshot('same/session')))).rejects.toThrow(
      'pin scope must belong to the requested daemon',
    );
    await expect(
      fetchPinSnapshot(daemonA, scopeA, async () => response(snapshot('other-session'))),
    ).rejects.toMatchObject({
      status: 502,
    });
    await expect(fetchPinSnapshot(daemonA, scopeA, async () => response({ nope: true }))).rejects.toThrow();
    const failure = fetchPinSnapshot(daemonA, scopeA, async () => response({ error: 'offline', code: 'offline' }, 503));
    await expect(failure).rejects.toMatchObject({ status: 503, message: 'offline', code: 'offline' });
    await failure.catch(error => expect(error).toBeInstanceOf(DaemonResponseError));
    await expect(
      fetchPinSnapshot(daemonA, scopeA, async () => new Response('bad', { status: 500 })),
    ).rejects.toMatchObject({
      message: 'HTTP 500',
    });
  });
});

describe('DaemonPinClient', () => {
  it('coalesces one scope but keeps same-named sessions on other daemons independent', async () => {
    const a = deferred<Response>();
    const b = deferred<Response>();
    let calls = 0;
    const client = new DaemonPinClient(undefined, async input => {
      calls += 1;
      return String(input).startsWith('https://a.') ? a.promise : b.promise;
    });
    const first = client.hydrate(daemonA, scopeA);
    const same = client.hydrate(daemonA, scopeA);
    const other = client.hydrate(daemonB, scopeB);
    expect(first).toBe(same);
    expect(calls).toBe(2);

    b.resolve(response(snapshot('same/session', '2026-07-31T02:00:00.000Z', 'b')));
    await other;
    a.resolve(response(snapshot('same/session', '2026-07-31T01:00:00.000Z', 'a')));
    await first;
    expect(firstNoteText(client, scopeA)).toBe('a');
    expect(firstNoteText(client, scopeB)).toBe('b');
    await client.hydrate(daemonA, scopeA);
    expect(calls).toBe(2);
  });

  it('optimistically applies every action and reconciles only its current echo', async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const client = new DaemonPinClient(undefined, async () => first.promise);
    client.store.applySnapshot(scopeA, snapshot('same/session'));
    const pending = client.editNote(daemonA, scopeA, NOTE_ID, 'first');
    expect(firstNoteText(client, scopeA)).toBe('first');

    const superseding = new DaemonPinClient(client.store, async () => second.promise);
    const next = superseding.editNote(daemonA, scopeA, NOTE_ID, 'second');
    expect(firstNoteText(client, scopeA)).toBe('second');
    second.resolve(response(snapshot('same/session', '2026-07-31T02:00:00.000Z', 'authoritative second')));
    await next;
    first.resolve(response(snapshot('same/session', '2026-07-31T01:00:00.000Z', 'stale first')));
    await pending;
    expect(firstNoteText(client, scopeA)).toBe('authoritative second');

    const requests: PinActionRequest[] = [];
    const actions = new DaemonPinClient(client.store, async (_input, init) => {
      const action = JSON.parse(String(init?.body)) as PinActionRequest;
      requests.push(action);
      return response(snapshot('same/session', '2026-07-31T03:00:00.000Z', 'after actions'));
    });
    await actions.add(daemonA, scopeA, { action: 'add', kind: 'note', text: 'new note' });
    await actions.add(daemonA, scopeA, {
      action: 'add',
      kind: 'message',
      blockId: 'block-1',
      blockKind: 'assistant',
      preview: 'answer',
    });
    await actions.remove(daemonA, scopeA, NOTE_ID);
    expect(requests.map(action => action.action)).toEqual(['add', 'add', 'remove']);
  });

  it('rolls current echoes back on failure, fences unloaded work, and rejects long notes synchronously', async () => {
    const client = new DaemonPinClient(undefined, async () => response({ error: 'down' }, 503));
    client.store.applySnapshot(scopeA, snapshot('same/session'));
    await expect(client.editNote(daemonA, scopeA, NOTE_ID, 'temporary')).rejects.toThrow('down');
    expect(firstNoteText(client, scopeA)).toBe('before');

    const loadingFailure = new DaemonPinClient(undefined, async () => response({ error: 'down' }, 503));
    await expect(loadingFailure.hydrate(daemonA, scopeA)).rejects.toThrow('down');
    expect(loadingFailure.store.status(scopeA)).toBe('error');

    const empty = new DaemonPinClient(undefined, async () =>
      response(snapshot('same/session', '2026-07-31T01:00:00.000Z', 'loaded')),
    );
    await empty.add(daemonA, scopeA, { action: 'add', kind: 'note', text: 'from empty' });
    expect(firstNoteText(empty, scopeA)).toBe('loaded');

    let called = false;
    const noNetwork = new DaemonPinClient(undefined, async () => {
      called = true;
      return response(snapshot('same/session'));
    });
    expect(() => noNetwork.editNote(daemonA, scopeA, NOTE_ID, 'x'.repeat(MAX_PIN_NOTE_LENGTH + 1))).toThrow(
      `may not exceed ${MAX_PIN_NOTE_LENGTH}`,
    );
    expect(called).toBe(false);
  });

  it('never lets a hydrate that predates a mutation overwrite that mutation in either completion order', async () => {
    const staleFirst = deferred<Response>();
    const mutationSecond = deferred<Response>();
    let calls = 0;
    const client = new DaemonPinClient(undefined, async () => {
      calls += 1;
      return calls === 1 ? staleFirst.promise : mutationSecond.promise;
    });
    const hydrate = client.hydrate(daemonA, scopeA);
    const mutation = client.add(daemonA, scopeA, { action: 'add', kind: 'note', text: 'new' });
    staleFirst.resolve(response(snapshot('same/session', '2026-07-31T01:00:00.000Z', 'stale')));
    await hydrate;
    expect(client.store.pins(scopeA)).toBeUndefined();
    mutationSecond.resolve(response(snapshot('same/session', '2026-07-31T02:00:00.000Z', 'authoritative')));
    await mutation;
    expect(firstNoteText(client, scopeA)).toBe('authoritative');

    const staleLast = deferred<Response>();
    const mutationFirst = deferred<Response>();
    calls = 0;
    const reversed = new DaemonPinClient(undefined, async () => {
      calls += 1;
      return calls === 1 ? staleLast.promise : mutationFirst.promise;
    });
    const oldHydrate = reversed.hydrate(daemonA, scopeA);
    const newMutation = reversed.add(daemonA, scopeA, { action: 'add', kind: 'note', text: 'new' });
    mutationFirst.resolve(response(snapshot('same/session', '2026-07-31T03:00:00.000Z', 'newer')));
    await newMutation;
    staleLast.resolve(response(snapshot('same/session', '2026-07-31T04:00:00.000Z', 'older')));
    await oldHydrate;
    expect(firstNoteText(reversed, scopeA)).toBe('newer');
  });

  it('fences old loads across unpair and same-id token rotation without touching another daemon', async () => {
    const old = deferred<Response>();
    const fresh = deferred<Response>();
    const other = deferred<Response>();
    const rotated = daemonConnection({
      daemonId: 'daemon-a',
      baseUrl: 'https://new-a.example.test',
      deviceToken: 'new-token',
    });
    const rotatedScope = daemonSessionScope(rotated, 'same/session');
    const client = new DaemonPinClient(undefined, async input => {
      const url = String(input);
      if (url.startsWith('https://new-a.')) return fresh.promise;
      if (url.startsWith('https://b.')) return other.promise;
      return old.promise;
    });
    const oldLoad = client.hydrate(daemonA, scopeA);
    const bLoad = client.hydrate(daemonB, scopeB);
    const newLoad = client.hydrate(rotated, rotatedScope);
    old.resolve(response(snapshot('same/session', '2026-07-31T01:00:00.000Z', 'old')));
    other.resolve(response(snapshot('same/session', '2026-07-31T02:00:00.000Z', 'b')));
    fresh.resolve(response(snapshot('same/session', '2026-07-31T03:00:00.000Z', 'fresh')));
    await Promise.all([oldLoad, bLoad, newLoad]);
    expect(firstNoteText(client, rotatedScope)).toBe('fresh');
    expect(firstNoteText(client, scopeB)).toBe('b');
    client.clearDaemon(rotated.daemonId);
    expect(client.store.pins(rotatedScope)).toBeUndefined();
    expect(client.store.pins(scopeB)).toBeDefined();
  });
});
