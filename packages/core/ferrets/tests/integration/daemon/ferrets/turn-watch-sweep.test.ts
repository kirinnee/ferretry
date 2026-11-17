import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeGate, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { type TestHost, testHost } from '@ferretry/kernel/testing';
import { Harnesses, Runners } from '../../../../contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../contract/testing/index.ts';
import ferrets, { TURN_WATCH_JOB } from '../../../../daemon/index.ts';

/**
 * The 30 s gone sweep, through the real daemon half and the kernel's driven clock: it exists the moment the turn-watch
 * job starts (not only after the registry has loaded), and a ferret whose terminal vanished is settled by it. CI only
 * (integration tier). Fixture values only.
 */

const SWEEP_MS = 30_000;

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

const boot = async (runner: FakeRunner): Promise<TestHost> =>
  await testHost({
    everyDirectory: true,
    plugins: [ferrets, harnessPlugin(new FakeHarness()), runnerPlugin(runner)],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: { gate: new FakeGate(), vault: new FakeVault(), asks: new FakeAsks() },
  });

const stateOf = async (h: TestHost, id: string): Promise<{ state: string; cause?: { kind: string } }> =>
  (await h.request('GET', `/v1/ferrets/${id}`)).json();

describe('the 30 s gone sweep', () => {
  test('W4 it is registered the moment the job starts, before anything is awaited (not only once the registry is ready)', async () => {
    const h = await boot(new FakeRunner());
    const before = h.clock.pending();

    // Not awaited: the job runs up to its first await synchronously, which is where the sweep must already be armed.
    const running = h.runJob(TURN_WATCH_JOB);
    const armed = h.clock.pending();
    await running;

    expect(armed).toBeGreaterThan(before);
  });

  test('W4 a ferret whose terminal vanished while the daemon was down is settled by the first sweep tick', async () => {
    const runner = new FakeRunner();
    const first = await boot(runner);
    const made = await first.request('POST', '/v1/ferrets', {
      headers: { 'x-fy-request-id': randomUUID() },
      body: { folder: '/work/a', prompt: 'Work.' },
    });
    expect(made.status).toBeLessThan(300);
    const { id } = made.json<{ id: string }>();
    await first.settle();
    runner.reboot();

    const second = await first.restart();
    await second.settle();
    expect((await stateOf(second, id)).state).not.toBe('stopped');
    // The job is started and NOT waited for: the tick must not depend on it having finished.
    const running = second.runJob(TURN_WATCH_JOB);
    await second.clock.advance(SWEEP_MS);
    await running;
    await second.settle();
    await new Promise(resolve => setTimeout(resolve, 20));

    const settled = await stateOf(second, id);
    expect(settled.state).toBe('stopped');
    expect(settled.cause).toEqual({ kind: 'terminal_gone' });
  });
});
