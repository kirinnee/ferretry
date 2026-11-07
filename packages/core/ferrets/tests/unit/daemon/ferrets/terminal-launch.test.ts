import { expect, test } from 'bun:test';
import { deviceStanding } from '@ferretry/core-gate/contract/testing';
import { FakeHarness, FakeRunner } from '../../../../contract/testing/index.ts';
import { host } from './route-fixture.ts';

test('R-0332 custom harness flags consult terminal.use before launching a governed caller', async () => {
  const demands: unknown[] = [];
  const runner = new FakeRunner();
  const h = await host([], {
    harness: new FakeHarness(),
    runner,
    standing: () => ({
      ...deviceStanding('phone'),
      governance: {
        governed: true,
        decide: demand => {
          demands.push(demand);
          return { allowed: false, refusal: 'not-granted' };
        },
      },
    }),
  });
  const response = await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': 'flags' },
    body: { folder: '/work/a', harnessFlags: ['--settings=hook.json'] },
  });
  expect(response.status).toBe(403);
  expect(demands).toEqual([{ capability: 'terminal', axis: 'use' }]);
  expect(runner.starts).toBe(0);
});

test('R-0332 governed starts fail closed when known project roots are unbound', async () => {
  const runner = new FakeRunner();
  const h = await host([], { harness: new FakeHarness(), runner, standing: () => deviceStanding('phone') });
  const response = await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': 'outside' },
    body: { folder: '/unknown' },
  });
  expect(response.status).toBe(503);
  expect(response.json<{ code: string }>().code).toBe('launch_roots_unavailable');
  expect(runner.starts).toBe(0);
});
