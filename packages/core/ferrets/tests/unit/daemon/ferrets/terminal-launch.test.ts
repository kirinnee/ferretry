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
  expect(response.json<{ code: string }>().code).toBe('grant_not_granted');
  expect(demands).toEqual([{ capability: 'terminal', axis: 'use' }]);
  expect(runner.starts).toBe(0);
});

test('R-0332 a terminal-class launch returns the actionable step-up refusal and demand', async () => {
  const h = await host([], {
    harness: new FakeHarness(),
    runner: new FakeRunner(),
    standing: () => ({
      ...deviceStanding('phone'),
      governance: {
        governed: true,
        decide: () => ({ allowed: false, refusal: 'step-up-required' }),
      },
    }),
  });
  const response = await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': 'proof' },
    body: { folder: '/work/a', harnessFlags: ['--verbose'] },
  });
  expect(response.status).toBe(403);
  expect(response.json()).toMatchObject({
    code: 'grant_step_up_required',
    demand: { capability: 'terminal', axis: 'use' },
  });
});

test('R-0332 an allowed terminal-class launch spends the proof once; a local owner launch needs none', async () => {
  let spent = 0;
  const governed = await host([], {
    harness: new FakeHarness(),
    runner: new FakeRunner(),
    standing: () => ({
      ...deviceStanding('phone'),
      governance: {
        governed: true,
        decide: () => ({ allowed: true, refusal: 'granted' }),
      },
      spendStepUp: () => {
        spent += 1;
      },
    }),
  });
  const request = {
    headers: { 'x-fy-request-id': 'allowed' },
    body: { folder: '/work/a', harnessFlags: ['--verbose'] },
  };
  expect((await governed.request('POST', '/v1/ferrets', request)).status).toBe(201);
  expect(spent).toBe(1);
  const local = await host([], { harness: new FakeHarness(), runner: new FakeRunner() });
  expect((await local.request('POST', '/v1/ferrets', request)).status).toBe(201);
  expect(spent).toBe(1);
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
