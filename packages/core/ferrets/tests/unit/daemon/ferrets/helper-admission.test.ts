import { expect, test } from 'bun:test';
import { FerretsPort } from '../../../../contract/index.ts';
import { FakeHarness, FakeRunner, ferretId } from '../../../../contract/testing/index.ts';
import { host, record } from './route-fixture.ts';

test('G12 R-0332 helper starts fail closed when Packs admission is absent, including the provided port', async () => {
  const runner = new FakeRunner();
  const h = await host([record('lead')], { harness: new FakeHarness(), runner });
  const answer = await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': 'helper' },
    body: { parent: 'lead', folder: '/work/child' },
  });
  expect(answer.status).toBe(503);
  expect(answer.json<{ code: string }>().code).toBe('helper_admission_unavailable');
  await expect(
    h.provided(FerretsPort).start({
      folder: '/work/child',
      parent: ferretId('lead'),
      by: 'pack',
    }),
  ).rejects.toMatchObject({ status: 503, code: 'helper_admission_unavailable' });
  expect(runner.starts).toBe(0);
  expect((await h.request('GET', '/v1/ferrets')).json<unknown[]>()).toHaveLength(1);
});
