import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeGate, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { type TestHost, testHost } from '@ferretry/kernel/testing';
import { AutoResumeDecide, AutoResumeSummaryFile, Harnesses, Runners } from '../../../../contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../contract/testing/index.ts';
import { AUTO_RESUME_JOB } from '../../../../daemon/modules/auto-resume.ts';
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

/** Runtimes' stand-in: the machine's auto-resume switch is on, and every ferret's own runtime says no (so a pass SKIPS it, in the summary). */
const runtimesPlugin = () =>
  implementDaemon(
    definePlugin({
      id: 'runtimes',
      title: 'Runtimes (fake)',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: AutoResumeDecide }] },
    }),
    {
      build: () => ({
        hooks: {
          'auto-resume.decide': async (input: { ask: string }) =>
            (input.ask === 'switch' ? { allow: true } : { allow: false, reason: 'no login' }) as never,
        },
      }),
    },
  );

const boot = async (runner: FakeRunner): Promise<TestHost> =>
  await testHost({
    everyDirectory: true,
    plugins: [ferrets, harnessPlugin(new FakeHarness()), runnerPlugin(runner), runtimesPlugin()],
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

  test('W4 a ferret whose terminal vanished while the daemon was down is left to the BOOT pass: sweep ticks settle nothing until it has closed its recorder, and the pass owns the ferret', async () => {
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
    // The turn watch is up and its sweep ticks (more than once), the boot pass has NOT run: nothing is settled by the sweep,
    // or the ferret would be stopped without being recorded as owed a resume.
    const watching = second.runJob(TURN_WATCH_JOB);
    await second.clock.advance(SWEEP_MS);
    await watching;
    await second.clock.advance(SWEEP_MS);
    await second.settle();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect((await stateOf(second, id)).state).not.toBe('stopped');
    expect(second.state('ferrets').raw(AutoResumeSummaryFile)).toBeUndefined();

    // The boot pass runs: IT settles the vanished ferret, and records it (no Runtimes answers here, so it is skipped and
    // told so in the summary: proof the pass, not the sweep, owned it).
    let done = false;
    const pass = second.runJob(AUTO_RESUME_JOB).finally(() => {
      done = true;
    });
    for (let step = 0; step < 60 && !done; step += 1) await second.clock.advance(1_000);
    await pass;
    await second.settle();

    const settled = await stateOf(second, id);
    expect(settled.state).toBe('stopped');
    expect(settled.cause).toEqual({ kind: 'terminal_gone' });
    const summary = JSON.parse(second.state('ferrets').raw(AutoResumeSummaryFile) ?? '{}') as {
      skipped?: { sessionId: string }[];
    };
    expect(summary.skipped?.map(entry => entry.sessionId)).toEqual([id]);
  });
});
