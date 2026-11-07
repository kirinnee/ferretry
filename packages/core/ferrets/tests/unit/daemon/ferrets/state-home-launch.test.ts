import { expect, test } from 'bun:test';
import { FakeHarness, FakeRunner } from '../../../../contract/testing/index.ts';
import { as, host, record } from './route-fixture.ts';

test('S47 R-0332 an agent launch fails closed before token issuance while the state-home identity fence is unbound', async () => {
  const runner = new FakeRunner();
  const h = await host([record('lead')], { harness: new FakeHarness(), runner });
  for (const folder of ['/state/ferretry', '/work/project', '/link-to-state']) {
    const answer = await h.request('POST', '/v1/ferrets', {
      ...as('lead'),
      body: { folder },
      headers: { ...as('lead').headers, 'x-fy-request-id': folder },
    });
    expect(answer.status).toBe(503);
    expect(answer.json<{ code: string }>().code).toBe('state_home_unresolved');
  }
  expect(runner.starts).toBe(0);
  expect((await h.request('GET', '/v1/ferrets')).json<unknown[]>()).toHaveLength(1);
});
