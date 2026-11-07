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
