import { PERSON_ORIGIN } from '../../../../contract/index.ts';
import { expect, test } from 'bun:test';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { FerretsPort, FerretTokensFile, StartDecide } from '../../../../contract/index.ts';
import { FakeHarness, FakeRunner, ferretId } from '../../../../contract/testing/index.ts';
import { HELPER_ADMISSION_ANSWERER } from '../../../../daemon/lib/ferrets/helper-admission.ts';
import { fakePacks, host as plainHost, portConsumer, record } from './route-fixture.ts';

/**
 * RULING #43: a helper's admission is Packs' OWN answer on the kernel's `start.decide`; Ferrets only consumes it. No
 * answer from Packs (absent, a hang, a throw, garbage) is 503 `helper_admission_unavailable`, never an allow.
 */

test("the answerer a helper's admission is read from is Packs' manifest id, 'packs'", () => {
  // The fake Packs in this tier and the integration tier write `'packs'` out; Packs' own tests pin its manifest id to the same literal.
  expect(HELPER_ADMISSION_ANSWERER).toBe('packs');
});

/** The route fixture with readable (empty) credential state, so a start or resume can issue a token. */
const host = async (...args: Parameters<typeof plainHost>) => {
  const h = await plainHost(...args);
  h.state('ferrets').plant(FerretTokensFile, JSON.stringify({ format: 1, tokens: [] }));
  return await h.restart();
};

const childStart = async (h: Awaited<ReturnType<typeof host>>) =>
  await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': 'helper' },
    body: { parent: 'lead', folder: '/work/child' },
  });

/** Another plugin taking `start.decide` (not Packs), answering `answer` at `priority`. */
const otherTaker = (id: string, answer: unknown, priority?: number) =>
  implementDaemon(
    definePlugin({
      id,
      title: `${id} (fake)`,
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: StartDecide, ...(priority === undefined ? {} : { priority }) }] },
    }),
    { build: () => ({ hooks: { 'start.decide': async () => answer as never } }) },
  );

const expectUnanswered = (answer: { status: number; json: <T>() => T }) => {
  expect(answer.status).toBe(503);
  expect(answer.json<{ code: string }>().code).toBe('helper_admission_unavailable');
};

test('G12 R-0332 helper starts fail closed when Packs is absent, including the provided port', async () => {
  const runner = new FakeRunner();
  // Packs is absent, but a consumer named packs is there to take the port as (a pack start is Packs' alone to make).
  const h = await host([record('lead')], { harness: new FakeHarness(), runner, plugins: [portConsumer('packs')] });
  expectUnanswered(await childStart(h));
  await expect(
    h.provided(FerretsPort, 'packs').start(
      {
        folder: '/work/child',
        parent: ferretId('lead'),
        by: 'pack',
      },
      PERSON_ORIGIN,
    ),
  ).rejects.toMatchObject({ status: 503, code: 'helper_admission_unavailable' });
  expect(runner.starts).toBe(0);
  expect((await h.request('GET', '/v1/ferrets')).json<unknown[]>()).toHaveLength(1);
});

test("G12 R-0332 a child starts on Packs' own yes on start.decide, which saw the child with its parent", async () => {
  // Arrange
  const runner = new FakeRunner();
  const packs = fakePacks();
  const h = await host([record('lead')], { harness: new FakeHarness(), runner, plugins: [packs.plugin] });

  // Act
  const answer = await childStart(h);

  // Assert
  expect(answer.status).toBeLessThan(300);
  expect(packs.asked).toHaveLength(1);
  expect(packs.asked[0]).toMatchObject({ parent: 'lead', role: 'helper', by: 'owner', folder: '/work/child' });
  expect(runner.starts).toBe(1);
});

test("G12 R-0332 Packs' own no refuses the child with its reason and launches nothing", async () => {
  // Arrange
  const runner = new FakeRunner();
  const packs = fakePacks(() => ({ allow: false, reason: 'the lead has as many helpers as it may' }));
  const h = await host([record('lead')], { harness: new FakeHarness(), runner, plugins: [packs.plugin] });

  // Act
  const answer = await childStart(h);

  // Assert
  expect(answer.status).toBeGreaterThanOrEqual(400);
  expect(answer.status).toBeLessThan(500);
  expect(JSON.stringify(answer.json())).toContain('the lead has as many helpers as it may');
  expect(runner.starts).toBe(0);
  expect((await h.request('GET', '/v1/ferrets')).json<unknown[]>()).toHaveLength(1);
});

test('G12 R-0332 a yes from any other start.decide taker never admits a child: only Packs answers for it', async () => {
  // Arrange: no Packs; a plugin that is not Packs says yes.
  const runner = new FakeRunner();
  const h = await host([record('lead')], {
    harness: new FakeHarness(),
    runner,
    plugins: [otherTaker('board', { allow: true })],
  });

  // Act + Assert
  expectUnanswered(await childStart(h));
  expect(runner.starts).toBe(0);
});

test("G12 R-0332 Packs' yes does not outvote a later taker's no, and a no asked before Packs stands", async () => {
  // Arrange: Packs admits; a lower-priority taker refuses (one host), a higher-priority one refuses (another).
  const later = await host([record('lead')], {
    harness: new FakeHarness(),
    runner: new FakeRunner(),
    plugins: [fakePacks().plugin, otherTaker('usage', { allow: false, reason: 'over budget' }, 10)],
  });
  const earlierPacks = fakePacks();
  const earlier = await host([record('lead')], {
    harness: new FakeHarness(),
    runner: new FakeRunner(),
    plugins: [earlierPacks.plugin, otherTaker('board', { allow: false, reason: 'the card is closed' }, 90)],
  });

  // Act
  const afterPacks = await childStart(later);
  const beforePacks = await childStart(earlier);

  // Assert: both are refused with the refusing taker's reason; Packs was never asked behind the earlier no.
  expect(afterPacks.status).toBeGreaterThanOrEqual(400);
  expect(afterPacks.status).toBeLessThan(500);
  expect(JSON.stringify(afterPacks.json())).toContain('over budget');
  expect(beforePacks.status).toBeGreaterThanOrEqual(400);
  expect(beforePacks.status).toBeLessThan(500);
  expect(JSON.stringify(beforePacks.json())).toContain('the card is closed');
  expect(earlierPacks.asked).toHaveLength(0);
});

test("G12 R-0332 a start cast to by:'resume' through the provided port is refused before start.decide, so it never skips Packs' limits", async () => {
  // Arrange: Packs admits anything, so only Ferrets' own run-time check can stop it. `by` is closed by the type only.
  const runner = new FakeRunner();
  const packs = fakePacks();
  const h = await host([record('lead')], { harness: new FakeHarness(), runner, plugins: [packs.plugin] });
  const port = h.provided(FerretsPort);
  const cast = (by: string) =>
    port.start({ folder: '/work/child', parent: ferretId('lead'), by: by as 'pack' }, PERSON_ORIGIN);

  // Act
  const resumeCast = await cast('resume');
  const unknown = await cast('nobody');
  const lead = await port.start({ folder: '/work/lead', by: 'resume' as 'owner' }, PERSON_ORIGIN);

  // Assert: the port's own refusal shape, nothing asked, nothing written or launched.
  for (const answer of [resumeCast, unknown, lead]) {
    expect(answer.ok).toBe(false);
    if (!answer.ok) {
      expect(answer.error.code).toBe('refused');
      expect(answer.error.reason).toContain('a resume is asked for through resume');
    }
  }
  expect(packs.asked).toHaveLength(0);
  expect(runner.starts).toBe(0);
  expect((await h.request('GET', '/v1/ferrets')).json<unknown[]>()).toHaveLength(1);
});

test('G12 a lead start needs no helper admission: it starts with Packs absent', async () => {
  // Arrange
  const h = await host([], { harness: new FakeHarness(), runner: new FakeRunner() });

  // Act
  const answer = await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': 'lead' },
    body: { folder: '/work/lead' },
  });

  // Assert
  expect(answer.status).toBeLessThan(300);
});

test('G12 R-0332 a parentless role:helper start needs Packs too: 503 with Packs absent, started on its yes', async () => {
  // Arrange: no parent, only `role: 'helper'` (the owner route takes `role`; Packs' clean-up builder starts this way).
  const request = { headers: { 'x-fy-request-id': 'helper-role' }, body: { role: 'helper', folder: '/work/role' } };
  const absentRunner = new FakeRunner();
  const absent = await host([], { harness: new FakeHarness(), runner: absentRunner });
  const runner = new FakeRunner();
  const packs = fakePacks();
  const present = await host([], { harness: new FakeHarness(), runner, plugins: [packs.plugin] });

  // Act
  const refused = await absent.request('POST', '/v1/ferrets', request);
  const admitted = await present.request('POST', '/v1/ferrets', request);

  // Assert
  expectUnanswered(refused);
  expect(absentRunner.starts).toBe(0);
  expect((await absent.request('GET', '/v1/ferrets')).json<unknown[]>()).toHaveLength(0);
  expect(admitted.status).toBeLessThan(300);
  expect(packs.asked[0]).toMatchObject({ role: 'helper', folder: '/work/role' });
  expect(packs.asked[0]?.parent).toBeUndefined();
  expect(runner.starts).toBe(1);
});

test('G12 a Warden resume of a child goes through the same admission (Packs absent: 503; present: asked, then relaunched)', async () => {
  // Arrange: a stopped child under a lead, once with no Packs and once with an admitting one.
  const child = { ...record('child', 'lead'), state: 'stopped' as const };
  const absentRunner = new FakeRunner();
  const absent = await host([record('lead'), child], {
    harness: new FakeHarness(),
    runner: absentRunner,
    plugins: [portConsumer('warden')],
  });
  const runner = new FakeRunner();
  const packs = fakePacks();
  const present = await host([record('lead'), child], {
    harness: new FakeHarness(),
    runner,
    plugins: [packs.plugin, portConsumer('warden')],
  });
  const warden = { origin: PERSON_ORIGIN, automatic: true, actor: 'warden' } as const;

  // Act
  const refused = absent.provided(FerretsPort, 'warden').resume(ferretId('child'), 'carry on', warden);
  const resumed = await present.provided(FerretsPort, 'warden').resume(ferretId('child'), 'carry on', warden);

  // Assert
  await expect(refused).rejects.toMatchObject({ status: 503, code: 'helper_admission_unavailable' });
  expect(absentRunner.starts).toBe(0);
  expect(resumed.ok).toBe(true);
  expect(packs.asked).toHaveLength(1);
  expect(packs.asked[0]).toMatchObject({ ferret: 'child', parent: 'lead', role: 'helper', by: 'resume' });
  expect(runner.starts).toBe(1);
});

for (const [name, garbage] of [
  ["{ allow: 'yes' }", { allow: 'yes' }],
  ['{ allow: 1 }', { allow: 1 }],
  ['{}', {}],
  ['undefined', undefined],
  ['null', null],
  ["'allow'", 'allow'],
] as const) {
  test(`G12 R-0332 a Packs that answers ${name} is no answer: the child is refused 503 and nothing launches`, async () => {
    // Arrange
    const runner = new FakeRunner();
    const packs = fakePacks(() => garbage);
    const h = await host([record('lead')], { harness: new FakeHarness(), runner, plugins: [packs.plugin] });

    // Act + Assert
    expectUnanswered(await childStart(h));
    expect(runner.starts).toBe(0);
    expect((await h.request('GET', '/v1/ferrets')).json<unknown[]>()).toHaveLength(1);
  });
}

test('G12 R-0332 a Packs that throws is no answer: 503 with the fixed sentence, never its own message', async () => {
  // Arrange
  const runner = new FakeRunner();
  const packs = fakePacks(() => {
    throw new Error('internal detail that must not be served');
  });
  const h = await host([record('lead')], { harness: new FakeHarness(), runner, plugins: [packs.plugin] });

  // Act
  const answer = await childStart(h);

  // Assert
  expectUnanswered(answer);
  expect(JSON.stringify(answer.json())).not.toContain('internal detail');
  expect(runner.starts).toBe(0);
});

test("G12 R-0332 Packs' own no keeps only a string reason and a string code", async () => {
  // Arrange: a no whose reason is not a string and whose code is a number.
  const runner = new FakeRunner();
  const packs = fakePacks(() => ({ allow: false, reason: { nested: 'object' }, code: 7 }));
  const h = await host([record('lead')], { harness: new FakeHarness(), runner, plugins: [packs.plugin] });

  // Act
  const answer = await childStart(h);

  // Assert
  const served = JSON.stringify(answer.json());
  expect(answer.status).toBeGreaterThanOrEqual(400);
  expect(answer.status).toBeLessThan(500);
  expect(served).toContain('packs refused.');
  expect(served).not.toContain('nested');
  expect(runner.starts).toBe(0);
});

test('G12 R-0332 a Packs that never answers is no answer once the start.decide bound passes', async () => {
  // Arrange
  const runner = new FakeRunner();
  const packs = fakePacks(async () => await new Promise<never>(() => {}));
  const h = await host([record('lead')], { harness: new FakeHarness(), runner, plugins: [packs.plugin] });

  // Act
  const answer = await childStart(h);

  // Assert
  expectUnanswered(answer);
  expect(packs.asked).toHaveLength(1);
  expect(runner.starts).toBe(0);
  expect((await h.request('GET', '/v1/ferrets')).json<unknown[]>()).toHaveLength(1);
});

test('G12 R-0332 a resume whose Packs hangs is refused at the bound, so a stop queued behind it still answers', async () => {
  // Arrange: a stopped child; its resume holds the child's queue while Packs hangs.
  const child = { ...record('child', 'lead'), state: 'stopped' as const };
  const runner = new FakeRunner();
  let asked!: () => void;
  const wasAsked = new Promise<void>(resolve => {
    asked = resolve;
  });
  const packs = fakePacks(async () => {
    asked();
    return await new Promise<never>(() => {});
  });
  const h = await host([record('lead'), child], {
    harness: new FakeHarness(),
    runner,
    plugins: [packs.plugin, portConsumer('warden')],
  });
  const port = h.provided(FerretsPort, 'warden');

  // Act: a Warden revive waits on Packs; a stop of the same ferret queues behind it.
  const settled: string[] = [];
  const resumed = port.resume(ferretId('child'), 'carry on', {
    origin: PERSON_ORIGIN,
    automatic: true,
    actor: 'warden',
  });
  const resumeEnded = resumed.then(
    () => settled.push('resume'),
    () => settled.push('resume'),
  );
  await wasAsked;
  const stop = port.stop(ferretId('child'), 'now').then(() => settled.push('stop'));

  // Assert: the resume fails closed (nothing relaunched), and the stop behind it ran only AFTER the resume ended: its
  // order proves the queue, where a single awaited microtask would prove next to nothing.
  await expect(resumed).rejects.toMatchObject({ status: 503, code: 'helper_admission_unavailable' });
  await Promise.all([resumeEnded, stop]);
  expect(settled).toEqual(['resume', 'stop']);
  expect(runner.starts).toBe(0);
});

test('G12 R-0332 only allow === true admits: an allow with extra fields still starts the child', async () => {
  // Arrange
  const runner = new FakeRunner();
  const packs = fakePacks(() => ({ allow: true, reason: 'ignored' }));
  const h = await host([record('lead')], { harness: new FakeHarness(), runner, plugins: [packs.plugin] });

  // Act + Assert
  expect((await childStart(h)).status).toBeLessThan(300);
  expect(runner.starts).toBe(1);
});
