/** The relay-protocol compression rows the kernel dispatcher owns (today's compression.ts, copied). */
import { describe, expect, test } from 'bun:test';
import { gunzipSync } from 'node:zlib';
import type { ApiRequest, ApiResponse } from '../../../contract/http.ts';
import { headersFrom, jsonResponse } from '../../../contract/http.ts';
import { NodeGzip } from '../../../host/adapters/node-gzip.ts';
import { acceptsGzip, COMPRESS_MIN_BYTES, compressed } from '../../../host/compression.ts';
import { responseRecords } from '../../../host/session/wire/records.ts';
import { request } from './fixtures.ts';

const big = (): ApiResponse => jsonResponse({ items: 'x'.repeat(COMPRESS_MIN_BYTES) });
const asking = (method = 'GET', encoding: string | null = 'gzip'): ApiRequest => ({
  ...request(method, '/v1/sessions'),
  headers: headersFrom(encoding === null ? {} : { 'accept-encoding': encoding }),
});
const gzip = new NodeGzip();

describe('compression rows', () => {
  test('R504 a request that names no accept-encoding is never answered compressed', async () => {
    expect((await compressed(asking('GET', null), big(), gzip, true)).gzip).toBeUndefined();
    expect(acceptsGzip(undefined)).toBe(false);
    expect(acceptsGzip('gzip;q=0')).toBe(false);
    expect(acceptsGzip('br, *')).toBe(true);
    expect(acceptsGzip('*, gzip;q=0')).toBe(false);
  });

  test('R505 compression adds no envelope key: res stays strict and the encoding rides in its headers', async () => {
    const packed = await compressed(asking(), big(), gzip, true);
    if (packed.gzip === undefined) throw new Error('not compressed');
    const records = responseRecords(1, { ...packed.response, gzip: packed.gzip } as ApiResponse);
    const res = records[0] as Record<string, unknown>;
    expect(Object.keys(res).sort()).toEqual(['body', 'headers', 'id', 'status', 't']);
    expect((res['headers'] as Record<string, string>)['content-encoding']).toBe('gzip');
  });

  test('R509 R512 the body (what an etag digests) stays plain; an eligible answer always carries Vary: Accept-Encoding', async () => {
    const answer = big();
    const packed = await compressed(asking(), answer, gzip, true);
    expect(packed.response.body).toBe(answer.body);
    expect(new TextDecoder().decode(gunzipSync(packed.gzip as Uint8Array))).toBe(answer.body);
    expect(packed.response.headers.get('vary')).toBe('Accept-Encoding');
    const plainCaller = await compressed(asking('GET', 'identity'), answer, gzip, true);
    expect(plainCaller.gzip).toBeUndefined();
    expect(plainCaller.response.headers.get('vary')).toBe('Accept-Encoding');
    const notModified: ApiResponse = { status: 304, headers: new Map([['etag', '"e"']]), body: '' };
    expect((await compressed(asking(), notModified, gzip, true)).gzip).toBeUndefined();
  });

  test('R511 only an opted-in GET 200 application/json of at least 8 KiB is compressed', async () => {
    expect((await compressed(asking(), big(), gzip, true)).gzip).toBeDefined();
    const small = jsonResponse({ items: 'x' });
    const text: ApiResponse = {
      status: 200,
      headers: new Map([['content-type', 'text/plain']]),
      body: 'x'.repeat(9000),
    };
    const error: ApiResponse = { ...big(), status: 500 };
    for (const [req, answer] of [
      [asking(), small],
      [asking(), text],
      [asking(), error],
      [asking('POST'), big()],
    ] as const)
      expect((await compressed(req, answer, gzip, true)).gzip).toBeUndefined();
  });

  test('R513 compression is off by default: a route that did not opt in answers plain', async () => {
    const packed = await compressed(asking(), big(), gzip, false);
    expect(packed.gzip).toBeUndefined();
    expect(packed.response.headers.has('vary')).toBe(false);
  });

  test('R514 R565 a POST answer (every minted credential) and an answer with a late check are never compressed', async () => {
    expect((await compressed(asking('POST'), big(), gzip, true)).gzip).toBeUndefined();
    const late: ApiResponse = { ...big(), late: () => ({ ...big(), gzip: undefined }) as never };
    expect((await compressed(asking(), late, gzip, true)).gzip).toBeUndefined();
    // streams never pass through the dispatcher's answer path, so they have no gzip form at all
  });
});
