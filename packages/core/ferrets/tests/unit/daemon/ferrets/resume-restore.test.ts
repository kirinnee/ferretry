import { expect, test } from 'bun:test';
import { deviceStanding, ownerStanding } from '@ferretry/core-gate/contract/testing';
import type { CallStanding } from '@ferretry/kernel/contract';
import { FakeHarness, FakeRunner } from '../../../../contract/testing/index.ts';
import { FerretTokensFile } from '../../../../contract/index.ts';
import { as, host, record } from './route-fixture.ts';

async function cutOff(standing?: CallStanding) {
  const runner = new FakeRunner();
  let h = await host([], {
    harness: new FakeHarness(),
    runner,
    ...(standing === undefined
      ? {}
      : {
          standing: request => (request.headers.get('x-test-caller') === 'device' ? standing : ownerStanding()),
        }),
  });
  const created = await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': 'restore-test' },
    body: { folder: '/work/a' },
  });
  expect(created.status).toBe(201);
  const id = created.json<{ id: string }>().id;
  expect((await h.request('POST', `/v1/ferrets/${id}/revoke-credential`)).status).toBe(200);
  expect((await h.request('POST', `/v1/ferrets/${id}/stop`)).status).toBe(200);
  h = await h.restart();
  return { h, id, runner };
}

test('R-0363 owner revoke survives stop and daemon restart; an agent cannot restore itself', async () => {
  const { h, id, runner } = await cutOff();
  const answer = await h.request('POST', `/v1/ferrets/${id}/resume`, as(id));
  expect(answer.status).toBe(403);
  expect(answer.json<{ code: string }>().code).toBe('owner_only');
  expect(runner.starts).toBe(1);
});

test('R-0363 a lead cannot restore a helper the owner cut off, even after another daemon restart', async () => {
  const runner = new FakeRunner();
  let h = await host([record('lead'), record('child', 'lead')], { harness: new FakeHarness(), runner });
  h.state('ferrets').plant(FerretTokensFile, JSON.stringify({ format: 1, tokens: [] }));
  h = await h.restart();
  await h.request('POST', '/v1/ferrets/child/revoke-credential');
  await h.request('POST', '/v1/ferrets/child/stop');
  h = await h.restart();
  const answer = await h.request('POST', '/v1/ferrets/child/resume', as('lead'));
  expect(answer.status).toBe(403);
  expect(answer.json<{ code: string }>().code).toBe('owner_only');
  expect(runner.starts).toBe(0);
});

test('R-0363 missing or damaged credential state cannot erase an owner cutoff at load', async () => {
  for (const damaged of [false, true]) {
    const { h, id, runner } = await cutOff();
    if (damaged) h.state('ferrets').plant(FerretTokensFile, '{damaged');
    else h.state('ferrets').files.delete(FerretTokensFile.path);
    const again = await h.restart();
    const answer = await again.request('POST', `/v1/ferrets/${id}/resume`);
    expect(answer.status).toBe(503);
    expect(answer.json<{ code: string }>().code).toBe('credential_state_unavailable');
    expect(runner.starts).toBe(1);
  }
});

test('R-0363 a governed restore needs fleet.configure before asking for its fresh proof', async () => {
  let claims = 0;
  const demands: unknown[] = [];
  const { h, id, runner } = await cutOff({
    ...deviceStanding('phone'),
    governance: {
      governed: true,
      decide: demand => {
        demands.push(demand);
        return { allowed: false, refusal: 'not-granted' };
      },
    },
    claimFreshStepUp: () => {
      claims += 1;
      return true;
    },
  });
  const answer = await h.request('POST', `/v1/ferrets/${id}/resume`, { headers: { 'x-test-caller': 'device' } });
  expect(answer.status).toBe(403);
  expect(answer.json<{ code: string }>().code).toBe('grant_not_granted');
  expect(demands).toEqual([{ capability: 'fleet', axis: 'configure' }]);
  expect(claims).toBe(0);
  expect(runner.starts).toBe(1);
});

test('R-0363 a refused fresh restore leaves the durable cutoff intact; the host owner may then restore', async () => {
  const acts: unknown[] = [];
  const { h, id } = await cutOff({
    ...deviceStanding('phone'),
    governance: {
      governed: true,
      decide: () => ({ allowed: false, refusal: 'step-up-required' }),
    },
    claimFreshStepUp: (act?: unknown) => {
      acts.push(act);
      return false;
    },
  });
  const refused = await h.request('POST', `/v1/ferrets/${id}/resume`, { headers: { 'x-test-caller': 'device' } });
  expect(refused.status).toBe(403);
  expect(refused.json<{ code: string }>().code).toBe('grant_step_up_required');
  expect(acts).toEqual(['resume-cut-off']);
  const again = await h.restart();
  const restored = await again.request('POST', `/v1/ferrets/${id}/resume`);
  expect(restored.status).toBe(200);
});

test('R-0363 a governed owner restore consumes the resume-cut-off proof once', async () => {
  const acts: unknown[] = [];
  const { h, id, runner } = await cutOff({
    ...deviceStanding('phone'),
    governance: {
      governed: true,
      decide: () => ({ allowed: true, refusal: 'granted' }),
    },
    claimFreshStepUp: (act?: unknown) => {
      acts.push(act);
      return acts.length === 1;
    },
  });
  const restored = await h.request('POST', `/v1/ferrets/${id}/resume`, { headers: { 'x-test-caller': 'device' } });
  expect(restored.status).toBe(200);
  expect(acts).toEqual(['resume-cut-off']);
  expect(runner.starts).toBe(2);
});
