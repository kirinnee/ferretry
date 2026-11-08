import { expect, test } from 'bun:test';
import type { HookDecision } from '@ferretry/kernel/contract';
import { FerretsPort, FerretTokensFile, StartDecide, type StartDecideInput } from '../../../../contract/index.ts';
import { FakeHarness, FakeRunner, ferretId } from '../../../../contract/testing/index.ts';
import { HELPER_ADMISSION_SENTENCES, type HelperAdmission } from '../../../../daemon/lib/ferrets/helper-admission.ts';
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

/** An admission that answers whatever it is given (garbage included), and says when it was asked. */
const answering = (answer: () => unknown) => {
  let asked!: () => void;
  const wasAsked = new Promise<void>(resolve => {
    asked = resolve;
  });
  const seam = {
    admit: async () => {
      asked();
      return (await answer()) as HookDecision;
    },
  } satisfies HelperAdmission;
  return { seam, wasAsked };
};

const childStart = async (h: Awaited<ReturnType<typeof host>>) =>
  await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': 'helper' },
    body: { parent: 'lead', folder: '/work/child' },
  });

for (const [name, garbage] of [
  ["{ allow: 'yes' }", { allow: 'yes' }],
  ['{ allow: 1 }', { allow: 1 }],
  ['{}', {}],
  ['undefined', undefined],
  ['null', null],
  ["'allow'", 'allow'],
] as const) {
  test(`G12 R-0332 an admission that answers ${name} refuses the child with the fixed sentence and launches nothing`, async () => {
    // Arrange: an admission whose answer is not a decision (truthy garbage included).
    const runner = new FakeRunner();
    const { seam } = answering(() => garbage);
    const h = await host([record('lead')], { harness: new FakeHarness(), runner, helperAdmission: seam });

    // Act
    const answer = await childStart(h);

    // Assert: only `allow === true` admits; anything else is a no with the kernel's sentence.
    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(answer.status).toBeLessThan(500);
    expect(JSON.stringify(answer.json())).toContain(HELPER_ADMISSION_SENTENCES.refused);
    expect(runner.starts).toBe(0);
    expect((await h.request('GET', '/v1/ferrets')).json<unknown[]>()).toHaveLength(1);
  });
}

test('G12 R-0332 an admission that throws refuses the child with the fixed sentence, never its own message', async () => {
  // Arrange
  const runner = new FakeRunner();
  const { seam } = answering(() => {
    throw new Error('internal detail that must not be served');
  });
  const h = await host([record('lead')], { harness: new FakeHarness(), runner, helperAdmission: seam });

  // Act
  const answer = await childStart(h);

  // Assert
  expect(answer.status).toBeGreaterThanOrEqual(400);
  expect(answer.status).toBeLessThan(500);
  const served = JSON.stringify(answer.json());
  expect(served).toContain(HELPER_ADMISSION_SENTENCES.threw);
  expect(served).not.toContain('internal detail');
  expect(runner.starts).toBe(0);
});

test('G12 R-0332 a no keeps only a string reason and a string code', async () => {
  // Arrange: a no whose reason is not a string and whose code is a number.
  const runner = new FakeRunner();
  const { seam } = answering(() => ({ allow: false, reason: { nested: 'object' }, code: 7 }));
  const h = await host([record('lead')], { harness: new FakeHarness(), runner, helperAdmission: seam });

  // Act
  const answer = await childStart(h);

  // Assert
  const served = JSON.stringify(answer.json());
  expect(answer.status).toBeGreaterThanOrEqual(400);
  expect(served).toContain(HELPER_ADMISSION_SENTENCES.refused);
  expect(served).not.toContain('nested');
  expect(runner.starts).toBe(0);
});

test('G12 R-0332 an admission that never answers refuses the child once StartDecide bound passes', async () => {
  // Arrange: an admission that hangs for ever.
  const runner = new FakeRunner();
  const { seam, wasAsked } = answering(async () => await new Promise<never>(() => {}));
  const h = await host([record('lead')], { harness: new FakeHarness(), runner, helperAdmission: seam });

  // Act: the start waits on the admission; the kernel's clock passes the start.decide bound.
  const pending = childStart(h);
  await wasAsked;
  await h.clock.advance(StartDecide.timeoutMs);
  const answer = await pending;

  // Assert
  expect(answer.status).toBeGreaterThanOrEqual(400);
  expect(answer.status).toBeLessThan(500);
  expect(JSON.stringify(answer.json())).toContain(HELPER_ADMISSION_SENTENCES.timeout);
  expect(runner.starts).toBe(0);
  expect((await h.request('GET', '/v1/ferrets')).json<unknown[]>()).toHaveLength(1);
});

test('G12 R-0332 a resume whose admission hangs is refused at the bound, so a stop queued behind it still answers', async () => {
  // Arrange: a stopped child; its resume holds the child's queue while the admission hangs.
  const child = { ...record('child', 'lead'), state: 'stopped' as const };
  const runner = new FakeRunner();
  const { seam, wasAsked } = answering(async () => await new Promise<never>(() => {}));
  const h = await host([record('lead'), child], { harness: new FakeHarness(), runner, helperAdmission: seam });
  const port = h.provided(FerretsPort);

  // Act: a Warden revive waits on the admission; a stop of the same ferret queues behind it.
  const resumed = port.resume(ferretId('child'), 'carry on', { automatic: true, actor: 'warden' });
  await wasAsked;
  let stopped = false;
  const stop = port.stop(ferretId('child'), 'now').then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  await h.clock.advance(StartDecide.timeoutMs);

  // Assert: the resume is a refusal (nothing relaunched), and the stop behind it ran.
  const result = await resumed;
  await stop;
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.reason).toBe(HELPER_ADMISSION_SENTENCES.timeout);
  expect(stopped).toBe(true);
  expect(runner.starts).toBe(0);
});

test('G12 R-0332 only allow === true admits: an allow with extra fields still starts the child', async () => {
  // Arrange
  const runner = new FakeRunner();
  const { seam } = answering(() => ({ allow: true, reason: 'ignored' }));
  const h = await host([record('lead')], { harness: new FakeHarness(), runner, helperAdmission: seam });

  // Act
  const answer = await childStart(h);

  // Assert
  expect(answer.status).toBeLessThan(300);
  expect(runner.starts).toBe(1);
});
