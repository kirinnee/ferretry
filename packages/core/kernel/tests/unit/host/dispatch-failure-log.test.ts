import { describe, expect, test } from 'bun:test';
import { ApiError, jsonResponse } from '../../../contract/http.ts';
import type { PluginId } from '../../../contract/ids.ts';
import { Dispatcher, type MountedRoute, type Owner } from '../../../host/dispatch.ts';
import { describeFailure, type FailureNote } from '../../../host/responses.ts';
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
