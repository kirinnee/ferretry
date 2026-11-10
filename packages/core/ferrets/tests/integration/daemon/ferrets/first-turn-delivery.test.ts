import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeGate, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { type TestHost, testHost } from '@ferretry/kernel/testing';
import { Harnesses, Runners } from '../../../../contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../contract/testing/index.ts';
import ferrets from '../../../../daemon/index.ts';

/**
 * M3, through the real daemon half: today's `deliverFirstTurn`. A ferret started with a task by the ordinary start
 * route has its assigned task written as its `turns/turn-001.md` and the ONE pointer to it typed into its new pane,
 * exactly once, by the runner's own delivery (admitted by the effect ledger right before the first key). The harness
 * gets no prompt on its command line as well, a daemon restart types nothing again, and a start with no task types
 * nothing at all.
 *
 * CI only (integration tier). Fixture values only.
 */

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

async function boot(runner: FakeRunner): Promise<TestHost> {
  return await testHost({
    plugins: [ferrets, harnessPlugin(new FakeHarness()), runnerPlugin(runner)],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: { gate: new FakeGate(), vault: new FakeVault(), asks: new FakeAsks() },
  });
}

const start = async (h: TestHost, body: Record<string, unknown>) =>
  await h.request('POST', '/v1/ferrets', { headers: { 'x-fy-request-id': randomUUID() }, body });

/** What was typed into a pane that points at a turn-one document. */
const firstTurnPointers = (runner: FakeRunner) =>
  runner.deliveries.filter(delivery => delivery.delivery.text.includes('/turns/turn-001.md'));

describe('M3 F-0344 a started ferret is handed its task once (today’s deliverFirstTurn)', () => {
  test('M3 F-0344 a started ferret’s pane receives the first-turn pointer EXACTLY ONCE, and a restart types nothing again', async () => {
    const runner = new FakeRunner();
    const first = await boot(runner);

    const started = await start(first, { folder: '/work/a', prompt: 'Build the thing.' });
    expect(started.status).toBeLessThan(300);
    const { id } = started.json<{ id: string }>();
    await first.settle();

    // Exactly one delivery into exactly this ferret's pane, and it is the pointer to its own turn one.
    expect(runner.deliveries).toHaveLength(1);
    expect(firstTurnPointers(runner)).toHaveLength(1);
    const [pointer] = firstTurnPointers(runner);
    // The pointer names the ABSOLUTE path the kernel resolved for this ferret's own `sessions` handle, where its turn
    // document was written: the test host resolves that root at `/sessions/<ferret>` (production at
    // `state/ferrets/sessions/<ferret>`, `internalRootFolder`), so a ferret reads exactly the file it was handed.
    expect(pointer?.delivery.text.startsWith(`Read the file /sessions/${id}/turns/turn-001.md `)).toBe(true);
    // Admitted by the effect ledger before the first key: the runner was handed the pre-write step.
    expect(pointer?.delivery.beforeWrite).toBeDefined();
    // (That no harness ALSO gets the task on its command line is pinned per harness: Codex's argv unit tests.)

    // A daemon restart replays nothing into the pane.
    const second = await first.restart();
    await second.settle();
    expect(firstTurnPointers(runner)).toHaveLength(1);
  });

  test('a start with no task types nothing into its pane', async () => {
    const runner = new FakeRunner();
    const host = await boot(runner);

    const started = await start(host, { folder: '/work/a' });
    expect(started.status).toBeLessThan(300);
    await host.settle();

    expect(runner.deliveries).toEqual([]);
  });
});
