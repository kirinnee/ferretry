import { describe, expect, test } from 'bun:test';
import { ApiError, jsonResponse } from '../../../contract/http.ts';
import type { PluginId } from '../../../contract/ids.ts';
import { Dispatcher, type MountedRoute, type Owner } from '../../../host/dispatch.ts';
import type { Log, LogFields } from '../../../contract/ports.ts';
import { onceEach, REFUSAL_WINDOW_MS } from '../../../host/refusal-log.ts';
import { describeFailure, failureKey, type FailureNote } from '../../../host/responses.ts';
import { recordingAdmission, request } from './fixtures.ts';

const owner: Owner = { plugin: 'board' as PluginId, title: 'Board', serving: () => ({ kind: 'serving' }) };

const route = (handle: MountedRoute['handle']): MountedRoute => ({
  method: 'GET',
  path: '/v1/board/:id',
  minimum: 'authenticated',
  caller: 'any',
  audit: { skip: 'test' },
  guard: { none: 'test' },
  owner,
  handle,
});

function dispatcherOf(handle: MountedRoute['handle'], failures: FailureNote[]): Dispatcher {
  return new Dispatcher(
    {
      admission: () => recordingAdmission(),
      outputGuard: () => undefined,
      version: '5.0.0',
      failed: note => failures.push(note),
    },
    { routes: [route(handle)], sockets: [], memberRoutes: [] },
  );
}

describe('every 500 says why in the daemon log', () => {
  test('a throw that is not an ApiError answers 500 and is reported with its route template and error', async () => {
    const failures: FailureNote[] = [];
    const boom = new Error('the session folder could not be read');
    const response = await dispatcherOf(async () => {
      throw boom;
    }, failures).dispatch(request('GET', '/v1/board/abc'));

    expect(response.status).toBe(500);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ method: 'GET', route: '/v1/board/:id', error: boom });
  });

  test('a typed refusal below 500 is not a failure, and a typed 5xx is', async () => {
    const failures: FailureNote[] = [];
    await dispatcherOf(async () => {
      throw new ApiError(404, 'no such thing', 'not_found');
    }, failures).dispatch(request('GET', '/v1/board/abc'));
    expect(failures).toHaveLength(0);

    await dispatcherOf(async () => {
      throw new ApiError(503, 'not now', 'busy');
    }, failures).dispatch(request('GET', '/v1/board/abc'));
    expect(failures).toHaveLength(1);
  });

  test('a handler that answers normally reports nothing', async () => {
    const failures: FailureNote[] = [];
    await dispatcherOf(async () => jsonResponse({}), failures).dispatch(request('GET', '/v1/board/abc'));
    expect(failures).toHaveLength(0);
  });

  test('the line names the route template and the error, never the caller path, and is one short line', () => {
    const line = describeFailure({
      table: 'route',
      method: 'GET',
      route: '/v1/board/:id',
      error: new TypeError(`bad\nthing ${'x'.repeat(400)}`),
      secretGuarded: false,
    });
    expect(line.message.startsWith('failed GET /v1/board/:id (500): TypeError: bad thing ')).toBe(true);
    expect(line.message).not.toContain('\n');
    expect(line.message.length).toBeLessThan(400);
  });

  test('a secret-guarded route logs the error class only, never its message', () => {
    const line = describeFailure({
      table: 'route',
      method: 'GET',
      route: '/v1/vault/:id',
      error: new Error('token=fys_TOPSECRET'),
      secretGuarded: true,
    });
    expect(line.message).toBe('failed GET /v1/vault/:id (500): Error');
  });
});

describe('a route that throws on every poll does not flood the log', () => {
  const said: Array<{ level: string; message: string; fields?: LogFields }> = [];
  const log: Log = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (message, fields) =>
      void said.push({ level: 'error', message, ...(fields === undefined ? {} : { fields }) }),
    child: () => log,
  };
  const note = (route: string, error: unknown): FailureNote => ({
    table: 'route',
    method: 'GET',
    route,
    error,
    secretGuarded: false,
  });

  test('1000 identical 500s say one line, then one line carrying how many were held back', () => {
    said.length = 0;
    let now = 0;
    const say = onceEach(log, 'error', () => now);
    const fail = (n: FailureNote): void => {
      const line = describeFailure(n);
      say(failureKey(n), line.message, line.fields);
    };
    // The message changes every call (an id in it): the key is method + template + class, so it is still one failure.
    for (let index = 0; index < 1000; index += 1) fail(note('/v1/board/:id', new Error(`row ${index} unreadable`)));
    expect(said).toHaveLength(1);
    expect(said[0]?.fields?.['suppressed']).toBeUndefined();

    now += REFUSAL_WINDOW_MS;
    fail(note('/v1/board/:id', new Error('row 1000 unreadable')));
    expect(said).toHaveLength(2);
    expect(said[1]?.fields).toMatchObject({ suppressed: 999 });
  });

  test('a different template or a different error class still logs at once', () => {
    said.length = 0;
    const say = onceEach(log, 'error', () => 0);
    const fail = (n: FailureNote): void => {
      const line = describeFailure(n);
      say(failureKey(n), line.message, line.fields);
    };
    fail(note('/v1/board/:id', new Error('a')));
    fail(note('/v1/board/:id', new Error('a again')));
    fail(note('/v1/agenda/:id', new Error('a')));
    fail(note('/v1/board/:id', new TypeError('a')));
    expect(said).toHaveLength(3);
  });
});
