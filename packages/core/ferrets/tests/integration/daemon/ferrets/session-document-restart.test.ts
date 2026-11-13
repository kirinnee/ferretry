import { PERSON_ORIGIN } from '../../../../contract/index.ts';
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeGate, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { type TestHost, testHost } from '@ferretry/kernel/testing';
import type { HookDecision } from '@ferretry/kernel/contract';
import { FerretsPort, Harnesses, Runners, StartDecide, type StartDecideInput } from '../../../../contract/index.ts';
import { FakeHarness, FakeRunner, ferretId } from '../../../../contract/testing/index.ts';
import ferrets from '../../../../daemon/index.ts';
import { SessionConfigSchema } from '../../../../daemon/lib/protocol/session.ts';

/**
 * RULING #31b, through the real daemon half: a ferret started by the ordinary start route gets its session document
 * (config.json) with its spawn stamp, the daemon restarts, and the next starts are still stamped, because the strict
 * spawn-ancestry rule (unchanged: an indexed ferret with no document refuses every stamp) finds a document for every
 * ferret the fleet holds, including one that ran before the writer existed and holds only its journal.
 *
 * A CHILD start needs the helper admission: Packs' OWN yes on `start.decide` (RULING #43; no Packs answer is 503
 * `helper_admission_unavailable`, pinned by `routes.test.ts` and `helper-admission.test.ts`). Here a stand-in with
 * Packs' id answers yes (G12): after the restart the child is admitted, and the strict ancestry stamps it with the
 * lead as its parent. A Warden resume of that child is asked of the same `start.decide` (as a `resume`). The real
 * Packs half, present and absent, is `kernel/tests/integration/host/helper-admission.test.ts`.
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

/** A stand-in for Ferretry's Warden (its real id): the only consumer that may resume as `actor: 'warden'`, so a test takes the port as it. */
const wardenPlugin = implementDaemon(
  definePlugin({
    id: 'warden',
    title: 'Warden (fake)',
    version: '5.0.0',
    api: 5,
    core: false,
    kinds: [],
    needs: { ferrets: FerretsPort },
  }),
  { build: () => ({}) },
);

/** A stand-in for Packs (its real id) that admits every child on `start.decide` and records what it was asked. */
const admitting = () => {
  const asked: StartDecideInput[] = [];
  const plugin = implementDaemon(
    definePlugin({
      // Packs' manifest id, written out rather than read from the constant under test.
      id: 'packs',
      title: 'Packs (fake)',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: StartDecide }] },
    }),
    {
      build: () => ({
        hooks: {
          'start.decide': async (input: StartDecideInput): Promise<HookDecision> => {
            asked.push(input);
            return { allow: true };
          },
        },
      }),
    },
  );
  return { asked, plugin };
};

async function boot(packs: ReturnType<typeof admitting>['plugin']): Promise<TestHost> {
  return await testHost({
    everyDirectory: true,
    plugins: [ferrets, harnessPlugin(new FakeHarness()), runnerPlugin(new FakeRunner()), packs, wardenPlugin],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: { gate: new FakeGate(), vault: new FakeVault(), asks: new FakeAsks() },
  });
}

const start = async (h: TestHost, body: Record<string, unknown>) =>
  await h.request('POST', '/v1/ferrets', { headers: { 'x-fy-request-id': randomUUID() }, body });

/** The ferret's session document as it is on disk, parsed with the protocol's own schema. */
const document = (h: TestHost, id: string) => {
  const raw = h.state('ferrets').files.get(`${id}/config.json`);
  return raw === undefined ? undefined : SessionConfigSchema.parse(JSON.parse(raw as string));
};

describe('ruling #31b: the session-document writer, across a daemon restart', () => {
  test('G12 a started ferret is documented and stamped; after a restart the fleet still stamps, and an admitted child is stamped under its lead', async () => {
    // Arrange: a lead started through the real start route, then stopped (its journal is written).
    const admission = admitting();
    const first = await boot(admission.plugin);
    const started = await start(first, { folder: '/work/a', prompt: 'Lead the work.' });
    expect(started.status).toBeLessThan(300);
    const { id: lead } = started.json<{ id: string }>();
    await first.settle();
    expect(document(first, lead)?.provenance).toBeDefined();
    expect(
      (await first.request('POST', `/v1/ferrets/${lead}/stop`, { query: { how: 'now' }, body: {} })).status,
    ).toBeLessThan(300);

    // A ferret from before the writer, INDEXED: started and stopped through the real routes (so the session store
    // indexed its journal as it wrote it), then its session document taken away, leaving the journal alone — exactly
    // what a ferret that ran before the writer is. Today's strict ancestry refuses every stamp while such a ferret
    // has no document (the unit test shows the refusal); only the boot backfill can lift that here.
    const made = await start(first, { folder: '/work/older', prompt: 'Older work.' });
    expect(made.status).toBeLessThan(300);
    const { id: olderId } = made.json<{ id: string }>();
    await first.settle();
    expect(
      (await first.request('POST', `/v1/ferrets/${olderId}/stop`, { query: { how: 'now' }, body: {} })).status,
    ).toBeLessThan(300);
    await first.settle();
    const files = first.state('ferrets').files;
    files.delete(`${olderId}/config.json`);
    files.delete(`${olderId}/state.json`);
    expect(document(first, olderId)).toBeUndefined();
    const older = { id: olderId };

    // Act: restart the daemon, then start again.
    const second = await first.restart();
    await second.settle();
    const next = await start(second, { folder: '/work/b', prompt: 'Another lead.' });
    const child = await start(second, { folder: '/work/a', prompt: 'Help.', parent: lead });

    // Assert: the backfill documented the older ferret; the strict ancestry accepted the fleet and stamped the start.
    expect(document(second, older.id)).toMatchObject({ id: older.id, cwd: '/work/older' });
    expect(next.status).toBeLessThan(300);
    const { id: other } = next.json<{ id: string }>();
    expect(document(second, other)?.provenance).toBeDefined();
    // Packs was asked of the child (it is asked of every start), admitted it, and the strict ancestry stamped it.
    const helperAsks = () => admission.asked.filter(input => input.parent !== undefined);
    expect(helperAsks()).toHaveLength(1);
    expect(helperAsks()[0]).toMatchObject({ parent: lead, role: 'helper', by: 'owner' });
    expect(child.status).toBeLessThan(300);
    const { id: childId } = child.json<{ id: string }>();
    await second.settle();
    const stamped = document(second, childId);
    expect(stamped?.parent).toBe(lead);
    expect(stamped?.provenance).toBeDefined();

    // A Warden resume of the stopped child is asked of Packs on start.decide, as a resume, and relaunches it.
    expect(
      (await second.request('POST', `/v1/ferrets/${childId}/stop`, { query: { how: 'now' }, body: {} })).status,
    ).toBeLessThan(300);
    await second.settle();
    const resumed = await second
      .provided(FerretsPort, 'warden')
      .resume(ferretId(childId), 'carry on', { origin: PERSON_ORIGIN, automatic: true, actor: 'warden' });
    expect(resumed.ok).toBe(true);
    expect(helperAsks()).toHaveLength(2);
    expect(helperAsks()[1]).toMatchObject({ ferret: childId, parent: lead, role: 'helper', by: 'resume' });
  });
});
