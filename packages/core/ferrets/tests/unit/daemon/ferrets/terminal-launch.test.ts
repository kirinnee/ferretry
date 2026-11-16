import { expect, test } from 'bun:test';
import type { GrantDecision } from '@ferretry/core-gate/contract';
import type { CallStanding } from '@ferretry/kernel/contract';
import { deviceStanding } from '@ferretry/core-gate/contract/testing';
import { FakeHarness, FakeRunner } from '../../../../contract/testing/index.ts';
import { as, fakeLaunchRoots, host, record } from './route-fixture.ts';

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

const device = (decide: (demand: unknown) => GrantDecision, onDecide?: () => void) => (): CallStanding => ({
  ...deviceStanding('phone'),
  governance: {
    governed: true,
    decide: (demand: unknown) => {
      onDecide?.();
      return decide(demand);
    },
  },
});

test('R-0332 a governed start fails closed (503) when the known-projects list cannot be read', async () => {
  const runner = new FakeRunner();
  const h = await host([], {
    harness: new FakeHarness(),
    runner,
    standing: device(() => ({ allowed: true, refusal: 'granted' })),
    plugins: [
      fakeLaunchRoots({
        roots: async () => {
          throw new Error('registry damaged');
        },
      }),
    ],
  });
  const response = await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': 'outside' },
    body: { folder: '/unknown' },
  });
  expect(response.status).toBe(503);
  expect(response.json<{ code: string }>().code).toBe('launch_roots_unavailable');
  expect(runner.starts).toBe(0);
});

test('R-0332 a governed device starting inside a known project is an ordinary act: no terminal.use is asked', async () => {
  const demands: unknown[] = [];
  const runner = new FakeRunner();
  const h = await host([], {
    harness: new FakeHarness(),
    runner,
    standing: device(demand => {
      demands.push(demand);
      return { allowed: false, refusal: 'not-granted' };
    }),
    plugins: [fakeLaunchRoots({ roots: async () => ['/work/alpha', '/work/beta'] })],
  });
  const inside = await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': 'inside' },
    body: { folder: '/work/alpha/packages/x' },
  });
  expect(inside.status).toBe(201);
  expect(demands).toEqual([]);
  // A sibling that only shares a prefix is NOT inside the project.
  const sibling = await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': 'sibling' },
    body: { folder: '/work/alpha-other' },
  });
  expect(sibling.status).toBe(403);
  expect(demands).toEqual([{ capability: 'terminal', axis: 'use' }]);
});

test('R-0332 a governed device starting outside every project is terminal access: step-up is demanded when the grant refuses', async () => {
  const runner = new FakeRunner();
  const h = await host([], {
    harness: new FakeHarness(),
    runner,
    standing: device(() => ({ allowed: false, refusal: 'step-up-required' })),
    plugins: [fakeLaunchRoots({ roots: async () => ['/work/alpha'] })],
  });
  const response = await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': 'outside' },
    body: { folder: '/elsewhere' },
  });
  expect(response.status).toBe(403);
  expect(response.json()).toMatchObject({
    code: 'grant_step_up_required',
    demand: { capability: 'terminal', axis: 'use' },
  });
  expect(runner.starts).toBe(0);
});

test('R-0332 with Projects off, every governed start is outside every root (narrower, never wider)', async () => {
  const demands: unknown[] = [];
  const h = await host([], {
    harness: new FakeHarness(),
    runner: new FakeRunner(),
    standing: device(demand => {
      demands.push(demand);
      return { allowed: false, refusal: 'not-granted' };
    }),
  });
  const response = await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': 'no-projects' },
    body: { folder: '/work/alpha' },
  });
  expect(response.status).toBe(403);
  expect(demands).toEqual([{ capability: 'terminal', axis: 'use' }]);
});

test('R-0332 a ferret token is local: the known projects are never consulted', async () => {
  let asked = 0;
  const h = await host([record('lead')], {
    harness: new FakeHarness(),
    runner: new FakeRunner(),
    plugins: [
      fakeLaunchRoots({
        roots: async () => {
          asked += 1;
          return [];
        },
      }),
    ],
  });
  const response = await h.request('POST', '/v1/ferrets', {
    ...as('lead'),
    headers: { ...as('lead').headers, 'x-fy-request-id': 'local' },
    body: { folder: '/work/anywhere' },
  });
  expect(asked).toBe(0);
  // (an agent start is judged by the state-home fence, which the kernel's `paths` answers: not this test's subject)
  expect(response.status).not.toBe(403);
});
