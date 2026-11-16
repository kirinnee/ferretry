import { describe, expect, test } from 'bun:test';
import type { ApiRequest, FerretId } from '@ferretry/kernel/contract';
import { device, owner, testArrival } from '@ferretry/kernel/testing';
import type { Instant } from '@ferretry/std';
import { RENDER_META_STATE, RENDER_PAYLOAD_STATE, buildRenders } from '../../../daemon/renders/index.ts';
import { SVG } from '../../support/renders.ts';
import { memoryStatePort } from '../../support/state.ts';

const built = buildRenders({
  state: memoryStatePort([RENDER_META_STATE, RENDER_PAYLOAD_STATE]),
  clock: { now: () => '2026-11-07T00:00:00.000Z' as Instant },
});

type Caller = 'ferret' | 'admin-local' | 'device';

const call = (
  caller: Caller,
  body: unknown,
  params: Record<string, string> = {},
  headers: Record<string, string> = {},
) => {
  const arrival = testArrival(caller === 'device' ? device('d1') : owner());
  const request = {
    method: 'POST',
    path: '/v1/renders',
    query: new Map(),
    headers: new Map(Object.entries(headers)),
    arrival,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as ApiRequest;
  const credential =
    caller === 'ferret'
      ? { kind: 'authenticated', tokenClass: 'ferret', ferret: 'f1' as FerretId }
      : caller === 'admin-local'
        ? { kind: 'authenticated', tokenClass: 'admin' }
        : { kind: 'authenticated', tokenClass: 'device' };
  return { request, params: new Map(Object.entries(params)), credential } as never;
};

const save = { kind: 'svg', alt: 'A circle', payload: SVG };

describe('the render routes', () => {
  test('a ferret saves a picture and every answer is marked nosniff', async () => {
    const response = await built.routes['POST /v1/renders'](call('ferret', save));
    expect(response.status).toBe(201);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const body = JSON.parse(response.body) as { id: string; meta: { author: { ferret?: string } } };
    expect(body.meta.author).toEqual({ ferret: 'f1' });
    const again = await built.routes['POST /v1/renders'](call('ferret', save));
    expect(again.status).toBe(200);
  });

  test('the owner at the machine saves with no ferret behind it', async () => {
    const response = await built.routes['POST /v1/renders'](call('admin-local', { ...save, alt: 'Host circle' }));
    expect(response.status).toBe(201);
    expect((JSON.parse(response.body) as { meta: { author: object } }).meta.author).toEqual({});
  });

  test('a device that is not the host cannot save, and learns nothing about its payload', async () => {
    const response = await built.routes['POST /v1/renders'](call('device', 'not even json'));
    expect(response.status).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({ code: 'render_save_host_only' });
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('a refused save is a render refusal with its status and the header', async () => {
    const response = await built.routes['POST /v1/renders'](call('ferret', { ...save, payload: '<svg onload' }));
    expect(response.status).toBe(422);
    expect(JSON.parse(response.body)).toMatchObject({ code: 'render_invalid' });
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('the payload is immutable, tagged by its digest, and a matching tag is a 304', async () => {
    const saved = JSON.parse((await built.routes['POST /v1/renders'](call('ferret', save))).body) as {
      id: string;
      meta: { sha256: string };
    };
    const read = await built.routes['GET /v1/renders/:id'](call('device', {}, { id: saved.id }));
    expect(read.status).toBe(200);
    expect(read.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(read.headers.get('etag')).toBe(`"${saved.meta.sha256}"`);
    const cached = await built.routes['GET /v1/renders/:id'](
      call('device', {}, { id: saved.id }, { 'if-none-match': `"${saved.meta.sha256}"` }),
    );
    expect(cached.status).toBe(304);
    expect(cached.body).toBe('');
  });

  test('a path id outside the grammar is a 400 and an unknown one a 404', async () => {
    expect((await built.routes['GET /v1/renders/:id/meta'](call('device', {}, { id: '../x' }))).status).toBe(400);
    expect((await built.routes['GET /v1/renders/:id/meta'](call('device', {}, { id: 'abcdef' }))).status).toBe(404);
  });
});
