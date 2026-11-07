import { expect, test } from 'bun:test';
import { FakeHarness, FakeRunner } from '../../../../contract/testing/index.ts';
import { host } from './route-fixture.ts';

test('R-0332 a start must carry x-fy-request-id before a process or token is created', async () => {
  const runner = new FakeRunner();
  const h = await host([], { harness: new FakeHarness(), runner });
  const missing: readonly Readonly<Record<string, string>>[] = [
    {},
    { 'x-fy-request-id': '' },
    { 'x-fy-request-id': '   ' },
  ];
  for (const headers of missing) {
    const answer = await h.request('POST', '/v1/ferrets', { headers, body: { folder: '/work/a' } });
    expect(answer.status).toBe(400);
    expect(answer.json<{ code: string }>().code).toBe('missing_request_id');
  }
  expect(runner.starts).toBe(0);
  expect((await h.request('GET', '/v1/ferrets')).json<unknown[]>()).toHaveLength(0);
});

test('V-start-no-folder a start that names no folder is refused with today’s sentence before anything launches', async () => {
  const runner = new FakeRunner();
  const h = await host([], { harness: new FakeHarness(), runner });
  const answer = await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': 'no-folder-1' },
    body: { name: 'wren' },
  });
  expect(answer.status).toBe(400);
  expect(answer.json<{ code: string; error?: string; message?: string }>().code).toBe('invalid_request');
  expect(JSON.stringify(answer.json())).toContain('a start must name the absolute working directory to run in');
  expect(runner.starts).toBe(0);
});
