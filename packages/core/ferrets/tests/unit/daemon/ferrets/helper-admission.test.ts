import { expect, test } from 'bun:test';
import type { HookDecision } from '@ferretry/kernel/contract';
import { FerretsPort, FerretTokensFile, type StartDecideInput } from '../../../../contract/index.ts';
import { FakeHarness, FakeRunner, ferretId } from '../../../../contract/testing/index.ts';
import type { HelperAdmission } from '../../../../daemon/lib/ferrets/helper-admission.ts';
import { host as plainHost, record } from './route-fixture.ts';

/** The route fixture with readable (empty) credential state, so a start or resume can issue a token. */
const host = async (...args: Parameters<typeof plainHost>) => {
  const h = await plainHost(...args);
  h.state('ferrets').plant(FerretTokensFile, JSON.stringify({ format: 1, tokens: [] }));
  return await h.restart();
};

/** An injected admission that records what it was asked and answers `answer`. */
const admission = (answer: HookDecision = { allow: true }) => {
  const asked: StartDecideInput[] = [];
  const seam: HelperAdmission = {
    admit: async input => {
      asked.push(input);
      return answer;
    },
  };
  return { asked, seam };
};

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

test('G12 R-0332 a child start is asked of the injected helper admission, and starts when it admits', async () => {
  // Arrange
  const runner = new FakeRunner();
  const { asked, seam } = admission();
  const h = await host([record('lead')], { harness: new FakeHarness(), runner, helperAdmission: seam });

  // Act
  const answer = await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': 'helper' },
    body: { parent: 'lead', folder: '/work/child' },
  });

  // Assert: admitted, so the child starts; the admission saw the child with its parent.
  expect(answer.status).toBeLessThan(300);
  expect(asked).toHaveLength(1);
  expect(asked[0]).toMatchObject({ parent: 'lead', role: 'helper', by: 'owner', folder: '/work/child' });
  expect(runner.starts).toBe(1);
});

test('G12 R-0332 an injected admission that says no refuses the child with its reason and launches nothing', async () => {
  // Arrange
  const runner = new FakeRunner();
  const { seam } = admission({ allow: false, reason: 'the lead has as many helpers as it may' });
  const h = await host([record('lead')], { harness: new FakeHarness(), runner, helperAdmission: seam });

  // Act
  const answer = await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': 'helper' },
    body: { parent: 'lead', folder: '/work/child' },
  });

  // Assert
  expect(answer.status).toBeGreaterThanOrEqual(400);
  expect(JSON.stringify(answer.json())).toContain('the lead has as many helpers as it may');
  expect(runner.starts).toBe(0);
  expect((await h.request('GET', '/v1/ferrets')).json<unknown[]>()).toHaveLength(1);
});

test('G12 a lead start never asks the helper admission', async () => {
  // Arrange
  const { asked, seam } = admission({ allow: false, reason: 'never asked' });
  const h = await host([], { harness: new FakeHarness(), runner: new FakeRunner(), helperAdmission: seam });

  // Act
  const answer = await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': 'lead' },
    body: { folder: '/work/lead' },
  });

  // Assert
  expect(answer.status).toBeLessThan(300);
  expect(asked).toHaveLength(0);
});

test('G12 a Warden resume of a child goes through the same helper admission (unbound: 503; injected: asked, then relaunched)', async () => {
  // Arrange: a stopped child under a lead, once with nothing bound and once with an admitting seam.
  const child = { ...record('child', 'lead'), state: 'stopped' as const };
  const unboundRunner = new FakeRunner();
  const unbound = await host([record('lead'), child], { harness: new FakeHarness(), runner: unboundRunner });
  const runner = new FakeRunner();
  const { asked, seam } = admission();
  const bound = await host([record('lead'), child], { harness: new FakeHarness(), runner, helperAdmission: seam });
  const warden = { automatic: true, actor: 'warden' } as const;

  // Act
  const refused = unbound.provided(FerretsPort).resume(ferretId('child'), 'carry on', warden);
  const resumed = await bound.provided(FerretsPort).resume(ferretId('child'), 'carry on', warden);

  // Assert: unbound, the resume fails closed before any launch; bound, the admission is asked as a resume, then it runs.
  await expect(refused).rejects.toMatchObject({ status: 503, code: 'helper_admission_unavailable' });
  expect(unboundRunner.starts).toBe(0);
  expect(resumed.ok).toBe(true);
  expect(asked).toHaveLength(1);
  expect(asked[0]).toMatchObject({ ferret: 'child', parent: 'lead', role: 'helper', by: 'resume' });
  expect(runner.starts).toBe(1);
});
