import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeGate, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { type TestHost, testHost } from '@ferretry/kernel/testing';
import { err } from '@ferretry/std';
import { Harnesses, Runners } from '../../../../contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../contract/testing/index.ts';
import ferrets, { TURN_WATCH_JOB } from '../../../../daemon/index.ts';

/**
 * BG-036: a session's `environment.json` (its plaintext `fys_` credential) is deleted when the session ends, on every
 * end path the registry writes (a polite stop, a kill, a launch that fails) and, for what a crash left behind, by the
 * sweep at the next boot. Fixture values only: the file's text is a fake, never a credential.
 */

const FAKE_ENVIRONMENT = '{"FY_FIXTURE":"not-a-credential"}';
const environmentOf = (id: string): string => `${id}/environment.json`;

/** A harness that seeds the ferret's environment file in `prepareHome` (as a launch would have written it) and can refuse. */
class SeedingHarness extends FakeHarness {
  seed: ((ferret: string) => void) | undefined;
  refuse = false;
  override async prepareHome(spec: Parameters<FakeHarness['prepareHome']>[0]) {
    this.seed?.(spec.ferret);
    return await super.prepareHome(spec);
  }
  override async start(...args: Parameters<FakeHarness['start']>) {
    if (this.refuse) return err('failed' as const);
    return await super.start(...args);
  }
}

const harnessPlugin = (harness: FakeHarness) =>
  implementDaemon(
    definePlugin({
      id: 'claude-code',
      title: 'Claude Code (fake)',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: Harnesses, key: 'claude-code' }] },
    }),
    { build: () => ({ hooks: { 'harnesses:claude-code': harness } }) },
  );
const runnerPlugin = (runner: FakeRunner) =>
  implementDaemon(
    definePlugin({
      id: 'terminals',
      title: 'Terminals (fake)',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: Runners, key: 'tmux' }] },
    }),
    { build: () => ({ hooks: { 'runners:tmux': runner } }) },
  );

async function boot(harness: SeedingHarness): Promise<TestHost> {
  const host = await testHost({
    plugins: [ferrets, harnessPlugin(harness), runnerPlugin(new FakeRunner())],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: { gate: new FakeGate(), vault: new FakeVault(), asks: new FakeAsks() },
  });
  harness.seed = ferret => host.putRoot('sessions', environmentOf(ferret), FAKE_ENVIRONMENT);
  return host;
}

const start = async (h: TestHost) =>
  await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': randomUUID() },
    body: { folder: '/work/a', prompt: 'Work.' },
  });

const held = (h: TestHost, id: string) => h.rootText('sessions', environmentOf(id));

describe('BG-036 a session’s environment.json is deleted when it ends', () => {
  for (const how of ['polite', 'now'] as const)
    test(`BG-036 a ${how} stop deletes it`, async () => {
      // Arrange: a running ferret whose launch left its environment file.
      const h = await boot(new SeedingHarness());
      const started = await start(h);
      expect(started.status).toBeLessThan(300);
      const { id } = started.json<{ id: string }>();
      await h.settle();
      expect(held(h, id)).toBe(FAKE_ENVIRONMENT);

      // Act
      const stopped = await h.request('POST', `/v1/ferrets/${id}/stop`, { query: { how }, body: {} });
      await h.settle();

      // Assert
      expect(stopped.status).toBeLessThan(300);
      expect(held(h, id)).toBeUndefined();
    });

  test('BG-036 a launch that fails deletes it', async () => {
    // Arrange: the harness leaves the file, then refuses to start.
    const harness = new SeedingHarness();
    harness.refuse = true;
    const h = await boot(harness);
    const seeded: string[] = [];
    const seed = harness.seed;
    harness.seed = ferret => (seeded.push(ferret), seed?.(ferret));

    // Act
    const started = await start(h);
    await h.settle();

    // Assert: the start failed, and the file the failed launch wrote is gone.
    expect(started.status).toBeGreaterThanOrEqual(400);
    expect(seeded).toHaveLength(1);
    expect(held(h, seeded[0] as string)).toBeUndefined();
  });

  test('BG-036 a leftover of an ended session is removed by the sweep at the next boot', async () => {
    // Arrange: a ferret that ended, and then its file reappeared (a crash between the end and the delete).
    const first = await boot(new SeedingHarness());
    const started = await start(first);
    const { id } = started.json<{ id: string }>();
    await first.settle();
    await first.request('POST', `/v1/ferrets/${id}/stop`, { query: { how: 'now' }, body: {} });
    await first.settle();
    first.putRoot('sessions', environmentOf(id), FAKE_ENVIRONMENT);
    expect(held(first, id)).toBe(FAKE_ENVIRONMENT);

    // Act: the daemon restarts.
    const second = await first.restart();
    await second.settle();
    await second.runJob(TURN_WATCH_JOB);
    await second.settle();
    await new Promise(resolve => setTimeout(resolve, 20));

    // Assert
    expect(held(second, id)).toBeUndefined();
  });
});

describe('M20 the boot reconcile never revives an ended document', () => {
  test('M20 a held ferret the registry left starting whose document says failed stays failed after a restart and the turn-watch job', async () => {
    // Arrange: a ferret whose document is made `failed` as a lifecycle failure would, and whose registry record a crash
    // left `starting`. `starting` is the only registry state where the arm's `'reconcile'` and a lifecycle edge differ
    // (`lifecycleStatus` revives an ended document only on a lifecycle `starting`); at `working` both leave it alone.
    const first = await boot(new SeedingHarness());
    const started = await start(first);
    expect(started.status).toBeLessThan(300);
    const { id } = started.json<{ id: string }>();
    await first.settle();
    const files = first.state('ferrets').files;
    const statusOf = (host: TestHost): unknown =>
      JSON.parse(host.state('ferrets').files.get(`${id}/state.json`) as string).status;
    const raw = JSON.parse(files.get(`${id}/state.json`) as string);
    files.set(`${id}/state.json`, JSON.stringify({ ...raw, status: 'failed' }));
    const record = JSON.parse(files.get(`${id}/ferret.json`) as string);
    files.set(`${id}/ferret.json`, JSON.stringify({ ...record, state: 'starting' }));
    expect(statusOf(first)).toBe('failed');

    // Act: the daemon restarts holding the registry's record, and the arm job reconciles every held document.
    const second = await first.restart();
    await second.settle();
    const listed = await second.request('GET', '/v1/ferrets', {});
    await second.runJob(TURN_WATCH_JOB);
    await second.settle();
    // The status lane is fire-and-forget: give the reconcile its turn before looking.
    await new Promise(resolve => setTimeout(resolve, 20));

    // Assert: the restarted registry still says `starting` (so the reconcile ran on the one state a lifecycle edge
    // would revive from), and the document was not brought back.
    expect(JSON.stringify(listed.json())).toContain(`"id":"${id}"`);
    expect(JSON.stringify(listed.json())).toContain('"state":"starting"');
    expect(statusOf(second)).toBe('failed');
  });
});
